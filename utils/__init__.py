"""Shared helpers for every pipeline in this repo.

Pulled out of ingest/ when the block-level analyses needed the same CKAN client,
the same warehouse path and the same metric CRS. Anything used by more than one
pipeline belongs here; anything specific to one stays beside it.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WAREHOUSE = DATA / "warehouse.duckdb"
SITE_DATA = ROOT / "site" / "data"

# UTM zone 17N. Lengths and areas have to be computed in metres, not degrees, and
# this is the zone Toronto sits in -- the same projection street-density uses.
METRIC_CRS = "EPSG:32617"
WGS84 = "EPSG:4326"
