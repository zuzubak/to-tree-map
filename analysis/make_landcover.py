"""Land cover area per census block, all classes, from the 2018 study.

The companion to make_canopy.py, which took only the tree class. This takes the rest
in one pass -- building, road, other paved, grass, bare, shrub -- because the
expensive part is unpacking and reprojecting the patches, and doing that once for
every class costs barely more than doing it once for one.

Why it matters: a block is divided among these classes, so what densification
displaces is visible here. Density bought with building height leaves the pervious
share alone; density bought with footprint and parking does not.

Run by hand, output committed as a dbt seed. See make_canopy.py for the download.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import METRIC_CRS  # noqa: E402
from utils.warehouse import connect  # noqa: E402

SOURCE_CRS = "EPSG:2952"
CLASSES = ["building", "road", "other", "grass", "bare", "shrub"]
OUT = Path(__file__).resolve().parents[1] / "dbt" / "seeds" / "da_landcover.csv"


def main(gdb: str) -> None:
    con = connect(spatial=True)
    con.execute("SET preserve_insertion_order = false")

    print("Unpacking patches (all classes but tree)")
    con.execute(
        f"""
        CREATE OR REPLACE TABLE cover AS
        SELECT "Desc" AS cls,
               st_transform(unnest(st_dump(Shape)).geom,
                            '{SOURCE_CRS}', '{METRIC_CRS}', always_xy := true) AS geom_m
        FROM st_read('{gdb}')
        WHERE "Desc" IN ({', '.join(f"'{c}'" for c in CLASSES)})
        """
    )
    for cls, n, km2 in con.execute(
        "SELECT cls, count(*), sum(st_area(geom_m))/1e6 FROM cover GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall():
        print(f"  {cls:<9} {n:>9,} patches  {km2:>7.1f} km2")

    con.execute("CREATE INDEX cover_idx ON cover USING RTREE (geom_m)")

    print("Cutting against census blocks")
    rows = con.execute(
        """
        SELECT a.dauid, c.cls,
               round(sum(st_area(st_intersection(c.geom_m, a.geom_m)))) AS m2
        FROM geo.dissemination_areas a
        JOIN cover c ON st_intersects(c.geom_m, a.geom_m)
        GROUP BY 1, 2
        """
    ).fetchall()

    wide: dict[str, dict[str, float]] = {}
    for dauid, cls, m2 in rows:
        wide.setdefault(dauid, {})[cls] = m2
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dauid"] + [f"{c}_m2" for c in CLASSES])
        for dauid in sorted(wide):
            w.writerow([dauid] + [wide[dauid].get(c, 0) for c in CLASSES])
    print(f"  {len(wide):,} blocks -> {OUT.name}")
    con.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
