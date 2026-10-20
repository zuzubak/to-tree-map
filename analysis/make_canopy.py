"""Tree canopy area per census area, from the City's 2018 land cover study.

Run once, by hand; the output is committed as a dbt seed. Not part of the weekly
refresh, and deliberately so: the land cover study is a fixed 2018 snapshot that is
redone about every ten years, the source geodatabase is a 436 MB download, and the
intersection below takes the better part of an hour. None of that belongs in a job
that runs every week to pick up new tree records.

The study is a full-resolution land cover map -- roughly a quarter of a million
individual canopy patches, several million vertices -- carrying neighbourhood and
ward only as attributes on grouped multipolygons. So it can be cut against any
geometry; census areas are simply the unit the pages need.

Download the geodatabase first (it is not committed, at 624 MB unzipped):

    https://open.toronto.ca/dataset/forest-and-land-cover/
    -> "2018 Tree Canopy Study Geodatabase", unzip somewhere

then point this at it:

    python analysis/make_canopy.py /path/to/LandCover2018.gdb
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import METRIC_CRS  # noqa: E402
from utils.warehouse import connect  # noqa: E402

# NAD83(CSRS) / MTM zone 10, which is what the study ships in.
SOURCE_CRS = "EPSG:2952"
OUT = Path(__file__).resolve().parents[1] / "dbt" / "seeds" / "da_canopy.csv"


def main(gdb: str) -> None:
    con = connect(spatial=True)
    con.execute("SET preserve_insertion_order = false")

    # Patch by patch rather than feature by feature: a single feature here can be 1,546
    # separate crowns and 178,000 vertices, and intersecting that whole multipolygon
    # against every census area it touches does far more work than cutting the patches
    # it is made of.
    print("Unpacking canopy patches")
    con.execute(
        f"""
        CREATE OR REPLACE TABLE canopy AS
        SELECT st_transform(unnest(st_dump(Shape)).geom,
                            '{SOURCE_CRS}', '{METRIC_CRS}', always_xy := true) AS geom_m
        FROM st_read('{gdb}')
        WHERE "Desc" = 'tree'
        """
    )
    n, area = con.execute(
        "SELECT count(*), sum(st_area(geom_m))/1e6 FROM canopy"
    ).fetchone()
    print(f"  {n:,} patches, {area:,.1f} km2 of canopy")

    con.execute("CREATE INDEX canopy_idx ON canopy USING RTREE (geom_m)")

    print("Cutting against census areas")
    rows = con.execute(
        """
        SELECT a.dauid,
               round(sum(st_area(st_intersection(c.geom_m, a.geom_m)))) AS canopy_m2
        FROM geo.dissemination_areas a
        JOIN canopy c ON st_intersects(c.geom_m, a.geom_m)
        GROUP BY 1
        ORDER BY 1
        """
    ).fetchall()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dauid", "canopy_m2"])
        w.writerows(rows)
    total = sum(r[1] for r in rows)
    print(f"  {len(rows):,} areas, {total/1e6:,.1f} km2 inside them -> {OUT.name}")
    con.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
