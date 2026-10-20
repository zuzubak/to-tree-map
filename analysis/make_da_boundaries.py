"""One-time derivation of Toronto's dissemination-area boundaries.

Run once; the result is committed as analysis/reference/toronto_das.geojson and the
weekly pipeline reads that. 2021 census geography does not change, so there is no
reason to re-derive it on a schedule -- and the source is a local file outside this
repo, which CI cannot see.

Source: a 2021 dissemination-block layer clipped to Toronto (13,190 blocks), from
the sibling street/transit work. Blocks nest exactly inside dissemination areas --
DBUID is the DAUID plus three digits -- so dissolving on the first eight characters
rebuilds the DA boundaries without downloading StatCan's own DA file, which sits
behind a WAF that refuses automated requests.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import WGS84  # noqa: E402
from utils.warehouse import connect  # noqa: E402

BLOCKS = Path.home() / "projects/personal/distance/Toronto_5pm_2Dec_census_blocks_forecasted.shp"
OUT = Path(__file__).resolve().parent / "reference" / "toronto_das.geojson"
# ~5 m. Enough to drop surveyor-grade vertices the map can never show, not enough
# to open gaps between neighbouring areas.
SIMPLIFY_DEG = 0.00005


def main() -> None:
    if not BLOCKS.exists():
        raise SystemExit(f"Source block layer not found: {BLOCKS}")
    con = connect(spatial=True)
    con.execute(
        f"""
        copy (
            select
                substr(DBUID, 1, 8) as dauid,
                count(*) as blocks,
                st_simplify(st_union_agg(geom), {SIMPLIFY_DEG}) as geom
            from st_read('{BLOCKS}')
            group by 1
            having st_area(st_union_agg(geom)) > 0
        ) to '{OUT}' with (format gdal, driver 'GeoJSON', srs '{WGS84}')
        """
    )
    n, size = (
        con.execute(f"select count(*) from st_read('{OUT}')").fetchone()[0],
        OUT.stat().st_size,
    )
    print(f"Wrote {OUT.relative_to(Path.cwd())} -- {n:,} dissemination areas, {size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
