"""Pull the City's Street Tree Data inventory (~690k rows) into DuckDB.

Two routes to the same resource, in order:

1. The dataset's bulk CSV resource, read straight into DuckDB. Takes about 20 seconds.
2. The CKAN datastore API, paginated 20k rows at a time. Takes about 35 minutes.

The CSV is the fast path, but its URL is *resolved from `package_show` on every run* rather
than hardcoded -- the sibling `to-housing` project died precisely because it depended on a
one-off static export URL that stopped existing. If the resource is renamed or dropped, the
resolver raises and we fall back to the API, which is slow but structurally stable.

Geometry arrives as a JSON string per row rather than as real columns, and the two routes
disagree on its shape: the CSV emits `MultiPoint` with a nested coordinate pair, the API
emits a flat `Point`. Both are unpacked to plain lon/lat doubles here.

The City also writes literal "None" strings into text columns instead of nulls; those are
normalised so the dbt models can trust `IS NULL`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ckan_client import TIMEOUT_SECONDS, datastore_pages, package_show  # noqa: E402

PACKAGE_ID = "street-tree-data"
RESOURCE_ID = "3dafa392-c6ab-4f37-9bf9-21ddf7308eaf"  # datastore mirror, for the fallback path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "warehouse.duckdb"
CSV_PATH = ROOT / "data" / "street_trees.csv"

API_FIELDS = [
    "OBJECTID", "STRUCTID", "ADDRESS", "STREETNAME", "CROSSSTREET1", "CROSSSTREET2",
    "SUFFIX", "UNIT_NUMBER", "TREE_POSITION_NUMBER", "SITE", "WARD",
    "BOTANICAL_NAME", "COMMON_NAME", "DBH_TRUNK", "geometry",
]

TABLE_DDL = """
CREATE TABLE raw.street_trees (
    object_id BIGINT,
    struct_id VARCHAR,
    address INTEGER,
    street_name VARCHAR,
    cross_street_1 VARCHAR,
    cross_street_2 VARCHAR,
    suffix VARCHAR,
    unit_number VARCHAR,
    tree_position_number INTEGER,
    site VARCHAR,
    ward VARCHAR,
    botanical_name VARCHAR,
    common_name VARCHAR,
    dbh_trunk_cm INTEGER,
    lon DOUBLE,
    lat DOUBLE
)
"""

# Values the City writes as text in place of a null.
NULLISH = ("", "none", "null", "n/a", "na", "unknown")


def resolve_csv_url(metadata: dict) -> str:
    """Find the WGS84 bulk CSV on the package. Raises if it isn't there any more."""
    candidates = [
        r for r in metadata["resources"]
        if (r.get("format") or "").lower() == "csv" and "4326" in (r.get("name") or "")
    ]
    if not candidates:
        raise RuntimeError("No 4326 CSV resource on the package")
    resource = candidates[0]
    url = resource.get("url")
    if not url:
        raise RuntimeError(f"CSV resource {resource.get('id')} has no download URL")
    return url


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=TIMEOUT_SECONDS) as resp:
        resp.raise_for_status()
        with dest.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    print(f"  downloaded {dest.stat().st_size / 1e6:.0f} MB to {dest.relative_to(ROOT)}")


def load_from_csv(con: duckdb.DuckDBPyConnection, csv_path: Path) -> None:
    """Read the bulk CSV into raw.street_trees, unpacking geometry and nullish text."""
    con.execute(
        """
        INSERT INTO raw.street_trees
        WITH src AS (
            SELECT *, json(geometry) AS geom FROM read_csv(
                ?, header = true, all_varchar = true
            )
        ),
        cleaned AS (
            SELECT
                TRY_CAST(OBJECTID AS BIGINT) AS object_id,
                nullif_blank(STRUCTID) AS struct_id,
                TRY_CAST(ADDRESS AS INTEGER) AS address,
                nullif_blank(STREETNAME) AS street_name,
                nullif_blank(CROSSSTREET1) AS cross_street_1,
                nullif_blank(CROSSSTREET2) AS cross_street_2,
                nullif_blank(SUFFIX) AS suffix,
                nullif_blank(UNIT_NUMBER) AS unit_number,
                TRY_CAST(TREE_POSITION_NUMBER AS INTEGER) AS tree_position_number,
                nullif_blank(SITE) AS site,
                nullif_blank(WARD) AS ward,
                nullif_blank(BOTANICAL_NAME) AS botanical_name,
                nullif_blank(COMMON_NAME) AS common_name,
                TRY_CAST(DBH_TRUNK AS INTEGER) AS dbh_trunk_cm,
                -- MultiPoint nests the pair one level deeper than Point does.
                CASE WHEN json_extract_string(geom, '$.type') = 'Point'
                     THEN TRY_CAST(json_extract_string(geom, '$.coordinates[0]') AS DOUBLE)
                     ELSE TRY_CAST(json_extract_string(geom, '$.coordinates[0][0]') AS DOUBLE)
                END AS lon,
                CASE WHEN json_extract_string(geom, '$.type') = 'Point'
                     THEN TRY_CAST(json_extract_string(geom, '$.coordinates[1]') AS DOUBLE)
                     ELSE TRY_CAST(json_extract_string(geom, '$.coordinates[0][1]') AS DOUBLE)
                END AS lat
            FROM src
        )
        SELECT * FROM cleaned
        """,
        [str(csv_path)],
    )


def clean_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return None if text.lower() in NULLISH else text


def clean_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def load_from_api(con: duckdb.DuckDBPyConnection) -> None:
    """Fallback: paginate the datastore API. Slow, but doesn't depend on a bulk file."""
    def progress(done: int, total: int) -> None:
        print(f"  fetched {done:,} / {total:,} ({done / total * 100 if total else 0:.0f}%)", flush=True)

    for page in datastore_pages(RESOURCE_ID, fields=API_FIELDS, on_progress=progress):
        rows = []
        for rec in page:
            lon = lat = None
            raw_geom = rec.get("geometry")
            if raw_geom:
                try:
                    coords = json.loads(raw_geom)["coordinates"]
                    if coords and isinstance(coords[0], (list, tuple)):
                        coords = coords[0]  # MultiPoint
                    lon, lat = float(coords[0]), float(coords[1])
                except (ValueError, KeyError, IndexError, TypeError):
                    pass
            rows.append((
                clean_int(rec.get("OBJECTID")), clean_text(rec.get("STRUCTID")),
                clean_int(rec.get("ADDRESS")), clean_text(rec.get("STREETNAME")),
                clean_text(rec.get("CROSSSTREET1")), clean_text(rec.get("CROSSSTREET2")),
                clean_text(rec.get("SUFFIX")), clean_text(rec.get("UNIT_NUMBER")),
                clean_int(rec.get("TREE_POSITION_NUMBER")), clean_text(rec.get("SITE")),
                clean_text(rec.get("WARD")), clean_text(rec.get("BOTANICAL_NAME")),
                clean_text(rec.get("COMMON_NAME")), clean_int(rec.get("DBH_TRUNK")),
                lon, lat,
            ))
        con.executemany(
            "INSERT INTO raw.street_trees VALUES (" + ", ".join(["?"] * 16) + ")", rows
        )


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    con.execute("CREATE SCHEMA IF NOT EXISTS raw")
    con.execute("DROP TABLE IF EXISTS raw.street_trees")
    con.execute(TABLE_DDL)

    # Shared by every text column in the CSV path. Cast first: the City's columns are
    # read as text, but DuckDB will still hand this macro a number if a column happens to
    # be all-numeric in a given refresh.
    nullish_sql = ", ".join(f"'{v}'" for v in NULLISH)
    con.execute(
        f"CREATE OR REPLACE MACRO nullif_blank(s) AS "
        f"CASE WHEN lower(trim(CAST(s AS VARCHAR))) IN ({nullish_sql}) THEN NULL "
        f"ELSE trim(CAST(s AS VARCHAR)) END"
    )

    metadata = package_show(PACKAGE_ID)
    city_last_refreshed = metadata.get("last_refreshed") or metadata.get("metadata_modified")
    print(f"Street Tree Data -- City last_refreshed: {city_last_refreshed}")

    source = "bulk_csv"
    try:
        url = resolve_csv_url(metadata)
        print(f"Bulk CSV: {url}")
        download(url, CSV_PATH)
        load_from_csv(con, CSV_PATH)
    except Exception as exc:  # noqa: BLE001 -- any failure here means: use the slow path
        print(f"Bulk CSV unavailable ({exc}); falling back to the datastore API")
        con.execute("DELETE FROM raw.street_trees")
        source = "datastore_api"
        load_from_api(con)

    con.execute("DROP TABLE IF EXISTS raw.source_metadata")
    con.execute(
        """
        CREATE TABLE raw.source_metadata AS
        SELECT ? AS package_id, ? AS city_last_refreshed, ? AS ingest_route,
               now()::TIMESTAMP AS pipeline_ran_at
        """,
        [PACKAGE_ID, str(city_last_refreshed), source],
    )

    total, geocoded, named = con.execute(
        "SELECT count(*), count(lon), count(botanical_name) FROM raw.street_trees"
    ).fetchone()
    print(f"Loaded {total:,} trees via {source} ({geocoded:,} with coordinates, {named:,} identified)")
    if total == 0:
        raise SystemExit("Refusing to continue: no tree rows loaded")
    con.close()


if __name__ == "__main__":
    main()
