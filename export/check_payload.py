"""Fail the build if the exported payload isn't something the map can actually load.

Cheap insurance: the pipeline runs unattended every week, and a silently truncated column
would render as a map that's missing a corner of the city rather than as an obvious error.
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site" / "data"

ITEM_SIZE = {"uint32": 4, "uint16": 2, "uint8": 1}


def main() -> int:
    meta_path = DATA / "trees.meta.json"
    if not meta_path.exists():
        print(f"FAIL: {meta_path} is missing")
        return 1
    meta = json.loads(meta_path.read_text())
    n = meta["tree_count"]
    problems: list[str] = []

    if n < 500_000:
        problems.append(f"only {n:,} trees -- expected ~690k, the inventory may have truncated")

    for name, col in meta["columns"].items():
        path = DATA / col["file"]
        if not path.exists():
            problems.append(f"{col['file']} is missing")
            continue
        with gzip.open(path, "rb") as fh:
            actual = len(fh.read())
        # coords carries two values per tree; every other column carries one.
        expected_items = n * 2 if name.startswith("coords") else n
        expected = expected_items * ITEM_SIZE[col["dtype"]]
        if actual != expected:
            problems.append(f"{col['file']}: {actual:,} bytes inflated, expected {expected:,}")

    if not (DATA / "wards.geojson").exists():
        problems.append("wards.geojson is missing")

    for key in ("taxa", "genera", "species", "streets", "wards"):
        if not meta.get(key):
            problems.append(f"meta.{key} is empty")

    unmatched = [t for t in meta["taxa"] if t["basis"] == "unmatched" and t["count"] > 1000]
    if unmatched:
        names = ", ".join(t["botanical"] for t in unmatched[:5])
        problems.append(f"taxa with no native-status rule and >1000 trees: {names}")

    if problems:
        print("Payload check FAILED:")
        for p in problems:
            print(f"  - {p}")
        return 1

    total = sum(c["bytes"] for c in meta["columns"].values()) + meta_path.stat().st_size
    print(f"Payload OK: {n:,} trees, {len(meta['taxa'])} taxa, {total / 1e6:.2f} MB over the wire")
    return 0


if __name__ == "__main__":
    sys.exit(main())
