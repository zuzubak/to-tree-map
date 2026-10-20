"""One way to open the warehouse, with the spatial extension already loaded."""
from __future__ import annotations

import duckdb

from . import WAREHOUSE


def connect(read_only: bool = False, spatial: bool = True) -> duckdb.DuckDBPyConnection:
    WAREHOUSE.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(WAREHOUSE), read_only=read_only)
    if spatial:
        con.execute("INSTALL spatial; LOAD spatial;")
    return con


def to_metric(geom_sql: str) -> str:
    """Project a WGS84 geometry to metres.

    always_xy matters: DuckDB honours the authority axis order, and EPSG:4326 is
    declared lat/lon. Without it, st_transform reads a lon/lat point backwards and
    returns coordinates that look plausible but put Toronto in the Indian Ocean.
    """
    from . import METRIC_CRS, WGS84
    return f"st_transform({geom_sql}, '{WGS84}', '{METRIC_CRS}', always_xy := true)"
