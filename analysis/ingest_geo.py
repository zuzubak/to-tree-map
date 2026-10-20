"""Load the street network and census geography, and attach every tree to both.

Two spatial joins, both done here rather than in dbt so the expensive part runs once:

  trees -> dissemination area   point in polygon
  trees -> centreline segment   nearest segment within MAX_SNAP_M

Everything is projected to UTM 17N first. Lengths and distances in degrees are
meaningless, and at Toronto's latitude a degree of longitude is about 0.72 of a
degree of latitude, so even relative comparisons come out wrong.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

from utils import DATA, METRIC_CRS, WGS84  # noqa: E402
from utils.ckan import package_show  # noqa: E402
from utils.census import da_population, download as download_census  # noqa: E402
from utils.geo import MAX_SNAP_M, STREET_CLASSES  # noqa: E402
from utils.warehouse import connect  # noqa: E402

CENTRELINE_PACKAGE = "toronto-centreline-tcl"
DA_GEOJSON = Path(__file__).resolve().parent / "reference" / "toronto_das.geojson"
CENTRELINE_FILE = DATA / "centreline.geojson"


def centreline_url() -> str:
    """Resolve the 4326 GeoJSON from the package, rather than hardcoding a URL."""
    for r in package_show(CENTRELINE_PACKAGE)["resources"]:
        name, fmt = r.get("name") or "", (r.get("format") or "").lower()
        if fmt == "geojson" and "4326" in name and "Version 2" in name:
            return r["url"]
    raise RuntimeError("No 4326 GeoJSON on the centreline package")


def fetch_centreline() -> Path:
    if CENTRELINE_FILE.exists() and CENTRELINE_FILE.stat().st_size > 10_000_000:
        print(f"  centreline already present ({CENTRELINE_FILE.stat().st_size/1e6:.0f} MB)")
        return CENTRELINE_FILE
    url = centreline_url()
    print(f"  downloading centreline: {url}")
    CENTRELINE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=600) as resp:
        resp.raise_for_status()
        with CENTRELINE_FILE.open("wb") as fh:
            for chunk in resp.iter_content(1 << 20):
                fh.write(chunk)
    print(f"  downloaded {CENTRELINE_FILE.stat().st_size/1e6:.0f} MB")
    return CENTRELINE_FILE


def main() -> None:
    con = connect(spatial=True)
    con.execute("CREATE SCHEMA IF NOT EXISTS geo")
    metric = lambda g: f"st_transform({g}, '{WGS84}', '{METRIC_CRS}', always_xy := true)"

    print("Street segments")
    path = fetch_centreline()
    classes = ", ".join(f"'{c}'" for c in STREET_CLASSES)
    con.execute("DROP TABLE IF EXISTS geo.street_segments")
    con.execute(
        f"""
        CREATE TABLE geo.street_segments AS
        SELECT
            CAST(CENTRELINE_ID AS BIGINT)        AS centreline_id,
            LINEAR_NAME_FULL                     AS street_name,
            FEATURE_CODE_DESC                    AS street_class,
            {metric('geom')}                     AS geom_m,
            st_length({metric('geom')})          AS length_m,
            geom                                 AS geom_wgs
        FROM st_read('{path}')
        WHERE FEATURE_CODE_DESC IN ({classes})
          AND geom IS NOT NULL
        """
    )
    n, km = con.execute(
        "SELECT count(*), sum(length_m)/1000 FROM geo.street_segments"
    ).fetchone()
    print(f"  {n:,} segments, {km:,.0f} km of street")

    # ---- what each segment runs between ---------------------------------------
    #
    # A centreline segment is one block of one street, so naming it means naming the
    # cross streets at its two ends. Those come from the centreline's own topology
    # rather than from the trees' cross_street fields: a segment that shares an
    # endpoint with a differently-named segment is, by definition, meeting it at an
    # intersection. The tree attributes would give the same pair of names with no way
    # to tell which end each one is at, which is the half that makes a label useful.
    #
    # Direction comes from the segment's own run -- a mostly north-south block gets
    # N/S labels, a mostly east-west one E/W -- so "Albion Rd, N: Finch Ave,
    # S: Sheppard Ave" says where on Albion Rd you are.
    print("Cross streets")
    con.execute("DROP TABLE IF EXISTS geo.segment_crossings")
    con.execute(
        """
        CREATE TABLE geo.segment_crossings AS
        WITH ls AS (
            -- The centreline ships single-part MULTILINESTRINGs, and st_startpoint
            -- returns NULL on a multi; linemerge reduces each to the LINESTRING it
            -- already is.
            SELECT centreline_id, street_name, st_linemerge(geom_wgs) AS g
            FROM geo.street_segments
        ),
        ends AS (
            SELECT centreline_id, street_name, 'a' AS side,
                   round(st_x(st_startpoint(g)), 7) AS x,
                   round(st_y(st_startpoint(g)), 7) AS y
            FROM ls
            UNION ALL
            SELECT centreline_id, street_name, 'b',
                   round(st_x(st_endpoint(g)), 7),
                   round(st_y(st_endpoint(g)), 7)
            FROM ls
        ),
        -- The cross street at one end. mode() because a four-way intersection
        -- contributes the crossing street twice, once per arm, which outvotes any
        -- single oddly-named stub meeting the same corner.
        named AS (
            SELECT e.centreline_id, e.side, mode(o.street_name) AS cross_name
            FROM ends e
            JOIN ends o
              ON o.x = e.x AND o.y = e.y
             AND o.centreline_id <> e.centreline_id
             AND o.street_name IS DISTINCT FROM e.street_name
            WHERE o.street_name IS NOT NULL
            GROUP BY 1, 2
        ),
        run AS (
            SELECT a.centreline_id, a.x AS ax, a.y AS ay, b.x AS bx, b.y AS b_y
            FROM (SELECT * FROM ends WHERE side = 'a') a
            JOIN (SELECT * FROM ends WHERE side = 'b') b USING (centreline_id)
        )
        SELECT
            r.centreline_id,
            abs(r.b_y - r.ay) >= abs(r.bx - r.ax) AS north_south,
            -- "high" is the north or east end, "low" the south or west one.
            CASE WHEN abs(r.b_y - r.ay) >= abs(r.bx - r.ax)
                 THEN CASE WHEN r.ay >= r.b_y THEN na.cross_name ELSE nb.cross_name END
                 ELSE CASE WHEN r.ax >= r.bx THEN na.cross_name ELSE nb.cross_name END
            END AS high_cross,
            CASE WHEN abs(r.b_y - r.ay) >= abs(r.bx - r.ax)
                 THEN CASE WHEN r.ay >= r.b_y THEN nb.cross_name ELSE na.cross_name END
                 ELSE CASE WHEN r.ax >= r.bx THEN nb.cross_name ELSE na.cross_name END
            END AS low_cross
        FROM run r
        LEFT JOIN named na ON na.centreline_id = r.centreline_id AND na.side = 'a'
        LEFT JOIN named nb ON nb.centreline_id = r.centreline_id AND nb.side = 'b'
        """
    )
    both, one = con.execute(
        """SELECT count(*) FILTER (WHERE high_cross IS NOT NULL AND low_cross IS NOT NULL),
                  count(*) FILTER (WHERE high_cross IS NULL AND low_cross IS NULL)
           FROM geo.segment_crossings"""
    ).fetchone()
    print(f"  both ends named: {both:,} of {n:,} ({both/n*100:.1f}%); neither end: {one:,}")

    print("Dissemination areas")
    zipf = download_census(DATA / "census_98100015.zip")
    pops = da_population(zipf)
    con.execute("DROP TABLE IF EXISTS geo.dissemination_areas")
    con.execute(
        f"""
        CREATE TABLE geo.dissemination_areas AS
        SELECT dauid, blocks,
               {metric('geom')}            AS geom_m,
               st_area({metric('geom')})   AS area_m2,
               geom                        AS geom_wgs
        FROM st_read('{DA_GEOJSON}')
        """
    )
    con.execute("ALTER TABLE geo.dissemination_areas ADD COLUMN population INTEGER")
    con.execute("ALTER TABLE geo.dissemination_areas ADD COLUMN dwellings INTEGER")
    con.executemany(
        "UPDATE geo.dissemination_areas SET population = ?, dwellings = ? WHERE dauid = ?",
        [(v["population"], v["dwellings"], k) for k, v in pops.items()],
    )
    n, pop = con.execute(
        "SELECT count(*), sum(population) FROM geo.dissemination_areas"
    ).fetchone()
    print(f"  {n:,} areas, {pop:,} residents")

    # raw.street_trees, not the dbt model of the same name. The analysis models read
    # these geo tables, so reading a dbt model here would make the two steps circular
    # and leave a fresh warehouse unbuildable. The raw table carries the same 688,335
    # rows with identical coordinates and street names -- the model adds parsed taxa,
    # which the spatial joins do not use.
    print("Attaching trees")
    con.execute("DROP TABLE IF EXISTS geo.tree_location")
    con.execute(
        f"""
        CREATE TABLE geo.tree_location AS
        SELECT object_id, {metric('st_point(lon, lat)')} AS geom_m
        FROM raw.street_trees
        """
    )
    # Schema-qualified: an unqualified DROP INDEX looks in main and silently does
    # nothing to an index that lives in geo, which then makes the CREATE fail on any
    # second run against an existing warehouse.
    for name, table in [("tl_idx", "geo.tree_location"),
                        ("da_idx", "geo.dissemination_areas"),
                        ("ss_idx", "geo.street_segments")]:
        con.execute(f"DROP INDEX IF EXISTS geo.{name}")
        con.execute(f"CREATE INDEX {name} ON {table} USING RTREE (geom_m)")

    con.execute("DROP TABLE IF EXISTS geo.tree_area")
    con.execute(
        """
        CREATE TABLE geo.tree_area AS
        SELECT t.object_id, d.dauid
        FROM geo.tree_location t
        JOIN geo.dissemination_areas d ON st_within(t.geom_m, d.geom_m)
        """
    )
    got = con.execute("SELECT count(*) FROM geo.tree_area").fetchone()[0]
    total = con.execute("SELECT count(*) FROM raw.street_trees").fetchone()[0]
    print(f"  in a dissemination area: {got:,} of {total:,} ({got/total*100:.1f}%)")

    # Nearest street segment, name first.
    #
    # The obvious form -- join on st_dwithin and take the minimum -- never finishes:
    # DuckDB's RTree does not accelerate st_dwithin, so it degrades to 688k x 45k
    # distance computations. Matching on street name first cuts the candidate set for
    # most trees from every segment in the city to the handful carrying that name,
    # which is also the semantically right answer: a tree addressed to Bay St belongs
    # to a segment of Bay St, and distance only decides which block of it.
    #
    # Former-municipality suffixes are stripped from both sides ("Morningside Ave
    # Scarborough" is "Morningside Ave" in the centreline). The regex only fires at the
    # end of the string, so "York St" and "York Mills Rd" are untouched.
    norm = (
        r"regexp_replace(upper(trim({c})), "
        r"'\s+(SCARBOROUGH|NORTH YORK|EAST YORK|ETOBICOKE|YORK|TORONTO)$', '')"
    )
    con.execute("DROP TABLE IF EXISTS geo.tree_segment")
    con.execute(
        f"""
        CREATE TABLE geo.tree_segment AS
        WITH tree AS (
            SELECT t.object_id, {norm.format(c='t.street_name')} AS nm, l.geom_m
            FROM raw.street_trees t JOIN geo.tree_location l USING (object_id)
            WHERE t.street_name IS NOT NULL
        ),
        seg AS (
            SELECT centreline_id, {norm.format(c='street_name')} AS nm, geom_m
            FROM geo.street_segments WHERE street_name IS NOT NULL
        ),
        cand AS (
            SELECT tr.object_id, s.centreline_id,
                   st_distance(tr.geom_m, s.geom_m) AS dist_m,
                   row_number() OVER (PARTITION BY tr.object_id
                                      ORDER BY st_distance(tr.geom_m, s.geom_m)) AS rn
            FROM tree tr JOIN seg s USING (nm)
        )
        SELECT object_id, centreline_id, dist_m
        FROM cand WHERE rn = 1 AND dist_m <= {MAX_SNAP_M}
        """
    )
    by_name = con.execute("SELECT count(*) FROM geo.tree_segment").fetchone()[0]
    print(f"  matched on street name: {by_name:,} ({by_name/total*100:.1f}%)")

    # Whatever is left gets a bounded spatial search. st_intersects against a buffered
    # point DOES use the RTree built above, so this stays tractable on the remainder.
    con.execute(
        f"""
        INSERT INTO geo.tree_segment
        WITH missing AS (
            SELECT l.object_id, l.geom_m
            FROM geo.tree_location l
            LEFT JOIN geo.tree_segment ts USING (object_id)
            WHERE ts.object_id IS NULL
        ),
        cand AS (
            SELECT m.object_id, s.centreline_id,
                   st_distance(m.geom_m, s.geom_m) AS dist_m,
                   row_number() OVER (PARTITION BY m.object_id
                                      ORDER BY st_distance(m.geom_m, s.geom_m)) AS rn
            FROM missing m
            JOIN geo.street_segments s
              ON st_intersects(s.geom_m, st_buffer(m.geom_m, {MAX_SNAP_M}))
        )
        SELECT object_id, centreline_id, dist_m FROM cand WHERE rn = 1
        """
    )
    got, med = con.execute(
        "SELECT count(*), median(dist_m) FROM geo.tree_segment"
    ).fetchone()
    print(f"  snapped to a street segment: {got:,} of {total:,} ({got/total*100:.1f}%), "
          f"median {med:.0f} m from the centreline")
    con.close()


if __name__ == "__main__":
    main()
