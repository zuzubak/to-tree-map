"""2021 Census population, at dissemination-area level.

Why DA and not DB: population is published down to the dissemination block only in
the Geographic Attribute File, which sits behind a WAF that refuses automated
downloads. DA is the finest geography StatCan serves through the open table
endpoint -- about 3,700 of them inside Toronto, so a few city blocks each. It also
makes for steadier ratios: a dissemination block holding four trees produces a very
noisy average, a DA does not.

The DA boundaries are not downloaded either. Dissemination blocks nest exactly
inside dissemination areas -- DBUID is the DAUID plus three digits -- so dissolving
a block layer on the first eight characters reconstructs them.
"""
from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path

import requests

# "Population and dwelling counts: Canada and dissemination areas"
TABLE_ID = "98100015"
TABLE_URL = f"https://www150.statcan.gc.ca/n1/tbl/csv/{TABLE_ID}-eng.zip"
DGUID_DA_SCHEMA = "S0512"
TIMEOUT = 300


def download(dest: Path) -> Path:
    """Fetch the table zip, once. StatCan's bulk endpoint serves it without a key."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1_000_000:
        return dest
    with requests.get(TABLE_URL, stream=True, timeout=TIMEOUT) as resp:
        resp.raise_for_status()
        with dest.open("wb") as fh:
            for chunk in resp.iter_content(1 << 20):
                fh.write(chunk)
    return dest


def _number(text: str) -> int | None:
    text = (text or "").strip().replace(",", "")
    if not text or text in {"..", "...", "F", "x"}:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def da_population(zip_path: Path) -> dict[str, dict]:
    """DAUID -> {population, dwellings}, for every DA in the country.

    The table is one row per DA with the counts in positional columns; the headers
    carry long descriptive names, so they're matched on substring rather than
    reproduced verbatim.
    """
    out: dict[str, dict] = {}
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open(f"{TABLE_ID}.csv") as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig"))
            pop_col = next(c for c in reader.fieldnames if "Population, 2021" in c)
            dwell_col = next(
                (c for c in reader.fieldnames if "private dwellings, 2021" in c), None
            )
            for row in reader:
                dguid = (row.get("DGUID") or "").strip()
                if dguid[4:9] != DGUID_DA_SCHEMA:
                    continue
                out[dguid[9:]] = {
                    "population": _number(row.get(pop_col)),
                    "dwellings": _number(row.get(dwell_col)) if dwell_col else None,
                }
    return out
