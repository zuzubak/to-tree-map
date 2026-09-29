"""Turn the dbt marts into the static payload the map downloads.

Why binary columns instead of GeoJSON: there are ~690k trees, and the map's whole point is
showing all of them at once, coloured by species. As GeoJSON that's ~150 MB; as one
attribute-per-file typed array it's about 7 MB over the wire, and the browser can hand the
arrays straight to the renderer without parsing anything.

Layout -- one file per attribute, row i of every file describing the same tree:

    coords.u32.gz   2 x uint32, planar (all lons, then all lats), scaled by 1e7 from an
                    origin in trees.meta.json. Exact to ~1 cm, and planar order keeps each
                    axis's high bytes together, which is what makes it compress.
    taxon.u16.gz    index into meta.taxa -- genus, species, native status and colour all
                    derive from this one value, so they cost no extra bytes
    dbh.u16.gz      trunk diameter in cm, 0 = not recorded
    addr.u16.gz     street number, 0 = not recorded
    street.u16.gz   index into meta.streets, 0 = not recorded
    cross1.u16.gz   index into meta.streets for the first cross street
    cross2.u16.gz   index into meta.streets for the second cross street
    ward.u8.gz      1-25, 0 = not recorded

Everything is gzipped here and inflated in the browser with DecompressionStream. GitHub
Pages won't negotiate gzip for application/octet-stream, so compressing in the file itself
is the only way to avoid shipping 20 MB.

Rows arrive already sorted spatially by the street_trees model; that ordering is what makes
the street-name and taxon columns compress well, so don't re-sort here.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "warehouse.duckdb"
OUT_DIR = ROOT / "site" / "data"

COORD_SCALE = 10_000_000  # 1e7 -> ~1 cm
U16_MAX = 65_535

# Genera that get their own colour on the map; everything else falls into "Other". Twelve
# covers about three quarters of the inventory, which is as many hues as stay distinguishable
# as 2 px dots.
COLOURED_GENERA = 12


def write_column(name: str, array: np.ndarray) -> dict:
    """Gzip one typed array into site/data and describe it for the manifest."""
    raw = array.tobytes()
    path = OUT_DIR / f"{name}.gz"
    with gzip.open(path, "wb", compresslevel=9) as fh:
        fh.write(raw)
    size = path.stat().st_size
    print(f"  {name:<16} {len(raw) / 1e6:>6.2f} MB raw -> {size / 1e6:>5.2f} MB gz")
    return {"file": f"{name}.gz", "dtype": str(array.dtype), "bytes": size, "raw_bytes": len(raw)}


def build_dictionary(values: list[str | None]) -> tuple[list[str], dict[str, int]]:
    """Map street names to small ids, id 0 reserved for 'not recorded'."""
    unique = sorted({v for v in values if v})
    lookup = {name: i + 1 for i, name in enumerate(unique)}
    return [""] + unique, lookup


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH), read_only=True)

    trees = con.execute(
        """
        select taxon_id, dbh_cm, lon, lat, address, street_name,
               cross_street_1, cross_street_2, ward
        from street_trees
        """
    ).arrow()
    n = trees.num_rows
    print(f"Exporting {n:,} trees")

    lon = np.asarray(trees["lon"], dtype=np.float64)
    lat = np.asarray(trees["lat"], dtype=np.float64)
    origin_lon = float(np.floor(lon.min() * 100) / 100)
    origin_lat = float(np.floor(lat.min() * 100) / 100)

    coords = np.empty(n * 2, dtype=np.uint32)
    coords[:n] = np.rint((lon - origin_lon) * COORD_SCALE).astype(np.uint32)
    coords[n:] = np.rint((lat - origin_lat) * COORD_SCALE).astype(np.uint32)

    taxon = np.asarray(trees["taxon_id"], dtype=np.uint16)

    dbh_raw = trees["dbh_cm"].to_pandas()
    dbh = dbh_raw.fillna(0).clip(0, U16_MAX).astype(np.uint16).to_numpy()

    addr_raw = trees["address"].to_pandas()
    addr = addr_raw.fillna(0).clip(0, U16_MAX).astype(np.uint16).to_numpy()

    street_names = trees["street_name"].to_pylist()
    cross1_names = trees["cross_street_1"].to_pylist()
    cross2_names = trees["cross_street_2"].to_pylist()
    streets, street_ids = build_dictionary(street_names + cross1_names + cross2_names)

    def encode(names: list[str | None]) -> np.ndarray:
        return np.fromiter(
            (street_ids.get(v, 0) if v else 0 for v in names), dtype=np.uint16, count=len(names)
        )

    ward = np.fromiter(
        (int(w) if w and w.isdigit() else 0 for w in trees["ward"].to_pylist()),
        dtype=np.uint8, count=n,
    )

    print("Columns:")
    columns = {
        "coords.u32": write_column("coords.u32", coords),
        "taxon.u16": write_column("taxon.u16", taxon),
        "dbh.u16": write_column("dbh.u16", dbh),
        "addr.u16": write_column("addr.u16", addr),
        "street.u16": write_column("street.u16", encode(street_names)),
        "cross1.u16": write_column("cross1.u16", encode(cross1_names)),
        "cross2.u16": write_column("cross2.u16", encode(cross2_names)),
        "ward.u8": write_column("ward.u8", ward),
    }

    # ---- metadata -------------------------------------------------------------------
    taxa_rows = con.execute(
        """
        select taxon_id, botanical_display, common_name, genus, genus_common, species,
               cultivar, native_status, invasive, origin, native_notes, status_basis,
               tree_count, mean_dbh_cm, max_dbh_cm
        from dim_taxa order by taxon_id
        """
    ).fetchall()

    # `where genus is not null` drops the "Unidentified" bucket: it has no genus to key a
    # filter on, and those trees are already reachable through the "not identified to
    # species" origin category.
    genus_counts = con.execute(
        """
        select genus, any_value(genus_common), sum(tree_count) c
        from dim_taxa where genus is not null group by 1 order by c desc
        """
    ).fetchall()
    coloured = {g for g, _, _ in genus_counts[:COLOURED_GENERA]}

    genera = [
        {
            "genus": g,
            "label": label,
            "count": int(c),
            "coloured": g in coloured,
        }
        for g, label, c in genus_counts
    ]

    species_rows = con.execute(
        """
        select genus || ' ' || species as species_key,
               any_value(genus) as genus,
               mode(common_name) as label,
               any_value(native_status) as native_status,
               any_value(invasive) as invasive,
               sum(tree_count) as c
        from dim_taxa where species is not null
        group by 1 order by c desc
        """
    ).fetchall()

    # DBH histogram in 5 cm bins, for the range slider's backdrop.
    hist_rows = con.execute(
        """
        select least(dbh_cm / 5, 39)::int * 5 as bin, count(*)
        from street_trees where dbh_cm is not null
        group by 1 order by 1
        """
    ).fetchall()

    ward_rows = con.execute("select * from tree_stats_by_ward order by ward").fetchall()
    ward_cols = [d[0] for d in con.description]

    overall = con.execute("select * from tree_stats_overall").fetchone()
    overall_cols = [d[0] for d in con.description]
    summary = dict(zip(overall_cols, overall))

    meta = {
        "generated_at": str(summary.pop("pipeline_ran_at")),
        "city_last_refreshed": str(summary.pop("city_last_refreshed")),
        "ingest_route": summary.pop("ingest_route"),
        "tree_count": n,
        "summary": {k: (float(v) if isinstance(v, float) else v) for k, v in summary.items()},
        "coords": {
            "origin_lon": origin_lon,
            "origin_lat": origin_lat,
            "scale": COORD_SCALE,
            "bounds": [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())],
        },
        "columns": columns,
        "taxa": [
            {
                "id": r[0], "botanical": r[1], "common": r[2], "genus": r[3],
                "genus_label": r[4], "species": r[5], "cultivar": r[6],
                "native": r[7], "invasive": bool(r[8]), "origin": r[9],
                "notes": r[10], "basis": r[11], "count": int(r[12]),
                "mean_dbh": float(r[13]) if r[13] is not None else None,
                "max_dbh": int(r[14]) if r[14] is not None else None,
            }
            for r in taxa_rows
        ],
        "genera": genera,
        "species": [
            {
                "key": r[0], "genus": r[1], "label": r[2],
                "native": r[3], "invasive": bool(r[4]), "count": int(r[5]),
            }
            for r in species_rows
        ],
        "streets": streets,
        "dbh_histogram": {"bin_width": 5, "bins": [[int(b), int(c)] for b, c in hist_rows]},
        "wards": [
            {k: (float(v) if isinstance(v, float) else v) for k, v in zip(ward_cols, row)}
            for row in ward_rows
        ],
    }

    meta_path = OUT_DIR / "trees.meta.json"
    meta_path.write_text(json.dumps(meta, separators=(",", ":")))
    print(f"\n  trees.meta.json  {meta_path.stat().st_size / 1e6:.2f} MB")

    total = sum(c["bytes"] for c in columns.values()) + meta_path.stat().st_size
    print(f"\nTotal payload: {total / 1e6:.2f} MB over the wire")
    con.close()


if __name__ == "__main__":
    main()
