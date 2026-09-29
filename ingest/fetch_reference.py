"""Pull the ward boundaries the map draws as an overlay.

The tree inventory already carries a `WARD` column, so no spatial join is needed -- this
only supplies the shapes and the ward names to label them with.

The City's polygons carry far more coordinate precision than a screen can show (~31 KB of
geometry per ward). They're thinned here: coordinates rounded to ~1 m and consecutive
duplicates dropped, which cuts the file by roughly two thirds with no visible difference at
city zoom.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ckan_client import datastore_pages  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "warehouse.duckdb"
SITE_DATA = ROOT / "site" / "data"

WARDS_RESOURCE = "7672dac5-b383-4d7c-90ec-291dc69d37bf"  # "City Wards Data" (datastore-active)
COORD_DECIMALS = 5  # ~1 m at this latitude


def thin_ring(ring: list) -> list:
    """Round a ring's coordinates and drop consecutive duplicates."""
    out: list[list[float]] = []
    for lon, lat in ring:
        point = [round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)]
        if not out or out[-1] != point:
            out.append(point)
    # A ring needs at least 4 positions (first == last) to stay valid GeoJSON.
    if len(out) >= 3 and out[0] != out[-1]:
        out.append(out[0])
    return out


def thin_geometry(geom: dict) -> dict:
    kind = geom["type"]
    coords = geom["coordinates"]
    if kind == "Polygon":
        rings = [thin_ring(r) for r in coords]
        return {"type": kind, "coordinates": [r for r in rings if len(r) >= 4]}
    if kind == "MultiPolygon":
        polys = []
        for poly in coords:
            rings = [thin_ring(r) for r in poly]
            rings = [r for r in rings if len(r) >= 4]
            if rings:
                polys.append(rings)
        return {"type": kind, "coordinates": polys}
    return geom


def main() -> None:
    SITE_DATA.mkdir(parents=True, exist_ok=True)

    wards = []
    for page in datastore_pages(WARDS_RESOURCE, page_size=100):
        for rec in page:
            raw_geom = rec.get("geometry")
            if not raw_geom:
                continue
            geom = json.loads(raw_geom) if isinstance(raw_geom, str) else raw_geom
            wards.append(
                {
                    "type": "Feature",
                    "geometry": thin_geometry(geom),
                    "properties": {
                        # Zero-padded to match the tree inventory's WARD column ("07").
                        "ward": str(rec["AREA_SHORT_CODE"]).strip().zfill(2),
                        "ward_name": str(rec["AREA_NAME"]).strip(),
                    },
                }
            )

    wards.sort(key=lambda f: f["properties"]["ward"])
    out_path = SITE_DATA / "wards.geojson"
    out_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": wards}, separators=(",", ":"))
    )
    print(f"Wrote {out_path.relative_to(ROOT)} -- {len(wards)} wards, {out_path.stat().st_size / 1024:.0f} KB")

    con = duckdb.connect(str(DB_PATH))
    con.execute("CREATE SCHEMA IF NOT EXISTS raw")
    con.execute("DROP TABLE IF EXISTS raw.wards")
    con.execute("CREATE TABLE raw.wards (ward VARCHAR, ward_name VARCHAR)")
    con.executemany(
        "INSERT INTO raw.wards VALUES (?, ?)",
        [(f["properties"]["ward"], f["properties"]["ward_name"]) for f in wards],
    )
    print(f"Loaded {len(wards)} wards into raw.wards")
    con.close()


if __name__ == "__main__":
    main()
