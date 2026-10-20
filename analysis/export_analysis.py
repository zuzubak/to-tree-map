"""Write the three analysis payloads the web pages read.

Two GeoJSON files carry geometry plus the numbers that colour it, because at this
size the geometry is the payload and splitting it into binary columns would save
nothing: 3,727 areas and 45,007 segments are three orders of magnitude fewer
objects than the 688,335 trees the main map ships as typed arrays.

Geometry is simplified for the web. The committed reference boundaries keep
surveyor precision; a choropleth at city zoom cannot show it, and shipping it would
triple the download for pixels nobody sees.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import SITE_DATA, WGS84  # noqa: E402
from utils.warehouse import connect  # noqa: E402

OUT = SITE_DATA / "analysis"
# ~10 m at this latitude. Block edges stay recognisable against the basemap.
SIMPLIFY_AREAS = 0.0001
SIMPLIFY_SEGMENTS = 0.00005


def round_coords(obj, places: int = 5):
    """Trim GeoJSON coordinate precision in place.

    st_asgeojson emits full double precision -- fifteen or so decimal places, which
    is nanometres. Five places is about a metre at this latitude, finer than the
    simplification already applied and far finer than a street line can be read at.
    Most of the file is digits nobody can see.
    """
    if isinstance(obj, list):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, places) for v in obj]
        return [round_coords(v, places) for v in obj]
    return obj


def write(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"  {path.name:<28} {path.stat().st_size/1e6:>6.2f} MB")


AGE_BINS = 15  # 0-9, 10-19, ... 130-139, 140+


def dense_hist(pairs: list[list[int]]) -> list[int]:
    """Ten-year age bins as a count array, trailing zeros trimmed.

    Sparse [bin, count] pairs name a bin start that is always a multiple of ten, so
    every pair spends eight-odd characters restating the index. Positional counts are
    shorter on the wire and are what the page wants to draw.

    Trailing zeros come off because most blocks hold nothing older than eighty years,
    and the page pads back to fifteen bins. An empty list is a block with no aged
    trees at all, which is a case the page already has to handle.
    """
    out = [0] * AGE_BINS
    for bin_start, n in pairs:
        out[min(AGE_BINS - 1, bin_start // 10)] += n
    while out and out[-1] == 0:
        out.pop()
    return out


def prune(props: dict) -> dict:
    """Drop null properties. A segment with no cross street recorded would otherwise
    ship two `null`s, and most of them do."""
    return {k: v for k, v in props.items() if v is not None}


def shrink(geom: dict) -> dict:
    geom["coordinates"] = round_coords(geom["coordinates"])
    return geom


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    con = connect(read_only=False, spatial=True)

    # ---- blocks: one feature per dissemination area, both block metrics on it ----
    # A popup headed "35200907" tells a reader nothing, so each area carries the ward
    # its trees sit in. Taken as the modal ward of the trees inside rather than by a
    # second spatial join: areas nest inside wards almost everywhere, the trees already
    # carry a ward, and the handful that straddle a boundary only need a label.
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE area_export AS
        SELECT m.dauid, m.population, m.tree_count, m.trees_with_age,
               m.median_age, m.mean_age, m.trees_per_1000, m.trees_per_ha, m.area_ha,
               w.ward_name,
               st_simplify(d.geom_wgs, {SIMPLIFY_AREAS}) AS geom
        FROM da_metrics m
        JOIN geo.dissemination_areas d USING (dauid)
        LEFT JOIN (
            SELECT a.dauid, mode(t.ward_name) AS ward_name
            FROM geo.tree_area a JOIN street_trees t USING (object_id)
            GROUP BY a.dauid
        ) w USING (dauid)
        """
    )
    rows = con.execute(
        "SELECT dauid, population, tree_count, trees_with_age, median_age, mean_age,"
        " trees_per_1000, trees_per_ha, area_ha, st_asgeojson(geom), ward_name"
        " FROM area_export"
    ).fetchall()

    hist: dict[str, list] = {}
    for dauid, b, n in con.execute(
        "SELECT dauid, bin_start, n FROM da_age_histogram ORDER BY dauid, bin_start"
    ).fetchall():
        hist.setdefault(dauid, []).append([int(b), int(n)])

    features = []
    for r in rows:
        features.append({
            "type": "Feature",
            "geometry": shrink(json.loads(r[9])),
            "properties": prune({
                "id": r[0], "pop": r[1], "n": r[2], "aged": r[3],
                "med": r[4], "mean": r[5], "per1k": r[6], "perha": r[7],
                "ha": r[8], "ward": r[10],
            }) | prune({"hist": dense_hist(hist.get(r[0], [])) or None}),
        })
    summary = dict(zip(
        [d[0] for d in con.execute("""
            SELECT count(*) areas, sum(tree_count) trees, sum(population) people,
                   round(median(median_age),1) med_age,
                   round(median(trees_per_1000),1) med_per1k,
                   round(sum(tree_count)*1000.0/sum(population),1) city_per1k
            FROM da_metrics""").description],
        con.execute("""
            SELECT count(*), sum(tree_count), sum(population),
                   round(median(median_age),1), round(median(trees_per_1000),1),
                   round(sum(tree_count)*1000.0/sum(population),1)
            FROM da_metrics""").fetchone()))

    write(OUT / "blocks.geojson",
          {"type": "FeatureCollection", "summary": summary, "features": features})

    # ---- streets: one feature per centreline segment ----
    #
    # Both the age map and the street-density map draw this payload: a centreline
    # segment is one block of one street, which is the unit the reader clicks on, so
    # it carries the age summary and the density figure together rather than being
    # exported twice.
    seg = con.execute(
        f"""
        SELECT m.centreline_id, m.street_name, m.length_m, m.tree_count,
               m.trees_with_age, m.trees_per_100m, m.median_age, m.mean_age,
               m.north_south, m.high_cross, m.low_cross, m.cross_a, m.cross_b,
               st_asgeojson(st_simplify(s.geom_wgs, {SIMPLIFY_SEGMENTS}))
        FROM segment_metrics m
        JOIN geo.street_segments s USING (centreline_id)
        WHERE m.trees_per_100m IS NOT NULL
        """
    ).fetchall()

    seg_hist: dict[int, list] = {}
    for cid, b, n in con.execute(
        "SELECT centreline_id, bin_start, n FROM segment_age_histogram"
        " ORDER BY centreline_id, bin_start"
    ).fetchall():
        seg_hist.setdefault(cid, []).append([int(b), int(n)])

    seg_features = [{
        "type": "Feature",
        "geometry": shrink(json.loads(r[13])),
        "properties": prune({
            "id": r[0], "name": r[1], "len": round(r[2]), "n": r[3], "aged": r[4],
            "per100": r[5], "med": r[6], "mean": r[7],
            # ns tells the page whether the cross streets are north/south or
            # east/west ends; hc is the north or east one, lc the south or west.
            "ns": r[8], "hc": r[9], "lc": r[10], "ca": r[11], "cb": r[12],
        }) | prune({"hist": dense_hist(seg_hist.get(r[0], [])) or None}),
    } for r in seg]
    seg_summary = dict(zip(
        ["segments", "km", "trees", "median_per_100m", "med_age"],
        con.execute("""SELECT count(*), round(sum(length_m)/1000), sum(tree_count),
                       round(median(trees_per_100m),2), round(median(median_age),1)
                       FROM segment_metrics WHERE trees_per_100m IS NOT NULL""").fetchone()))
    write(OUT / "streets.geojson",
          {"type": "FeatureCollection", "summary": seg_summary, "features": seg_features})

    # ---- shared metadata: provenance of the age estimate ----
    basis = con.execute(
        "SELECT basis, count(*) FROM tree_age WHERE plausible GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall()
    meta = {
        "as_of": str(con.execute(
            "SELECT city_last_refreshed FROM raw.source_metadata").fetchone()[0])[:10],
        "trees_aged": con.execute(
            "SELECT count(*) FROM tree_age WHERE plausible").fetchone()[0],
        "trees_total": con.execute("SELECT count(*) FROM street_trees").fetchone()[0],
        "implausible": con.execute(
            "SELECT count(*) FROM tree_age WHERE NOT plausible").fetchone()[0],
        "unsnapped": con.execute("""
            SELECT (SELECT count(*) FROM street_trees)
                 - (SELECT count(*) FROM geo.tree_segment)""").fetchone()[0],
        "basis": {b: n for b, n in basis},
        # City-wide figures for the page headlines, plus the city's own age
        # distribution -- the block histograms are unreadable without something to
        # be compared against, and a block median only means "older" or "younger"
        # relative to this.
        "city_median_age": con.execute(
            "SELECT round(median(age_years),1) FROM tree_age WHERE plausible").fetchone()[0],
        "city_mean_age": con.execute(
            "SELECT round(avg(age_years),1) FROM tree_age WHERE plausible").fetchone()[0],
        "city_hist": dense_hist([
            [int(b), int(n)] for b, n in con.execute("""
                SELECT least(floor(age_years / 10) * 10, 140)::int AS bin_start, count(*)
                FROM tree_age WHERE plausible GROUP BY 1 ORDER BY 1""").fetchall()
        ]),
        "factors": [
            {"taxon": t, "rank": r, "factor": f, "basis": b}
            for t, r, f, b in con.execute(
                "SELECT taxon, rank, growth_factor, basis FROM growth_factors ORDER BY taxon"
            ).fetchall()
        ],
    }
    write(OUT / "analysis.meta.json", meta)
    con.close()


if __name__ == "__main__":
    main()
