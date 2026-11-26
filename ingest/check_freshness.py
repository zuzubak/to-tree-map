"""Decide whether the scheduled run has anything to do.

The City refreshes Street Tree Data "as available" -- months can pass between updates, then
one lands on an arbitrary day. So the workflow checks daily, the way the multiplex map runs
daily, but only rebuilds when the City's `last_refreshed` stamp differs from the one baked
into the live site's `trees.meta.json`.

Comparing against the live site rather than a cached value means a run that built but
failed to deploy is retried the next morning instead of being marked done.

Writes `stale=true|false` to $GITHUB_OUTPUT when it is set, and prints the reasoning.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from utils.ckan import package_show  # noqa: E402

PACKAGE_ID = "street-tree-data"
DEFAULT_META_URL = "https://malcolmkennedy.com/to-tree-map/data/trees.meta.json"


def live_stamp(meta_url: str) -> str | None:
    """The City stamp the deployed payload was built from, or None if it can't be read."""
    try:
        resp = requests.get(meta_url, timeout=30)
        resp.raise_for_status()
        return resp.json().get("city_last_refreshed")
    except (requests.RequestException, ValueError) as exc:
        print(f"Couldn't read the live payload's stamp ({exc}); treating it as stale")
        return None


def main() -> None:
    meta_url = os.environ.get("LIVE_META_URL") or DEFAULT_META_URL
    metadata = package_show(PACKAGE_ID)
    # Same expression fetch_trees.py records, so the two strings compare like for like.
    city = str(metadata.get("last_refreshed") or metadata.get("metadata_modified"))
    live = live_stamp(meta_url)

    stale = live != city
    print(f"City last_refreshed: {city}")
    print(f"Live site built from: {live}")
    print("Rebuilding." if stale else "Live site is current; nothing to do.")

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"stale={'true' if stale else 'false'}\n")


if __name__ == "__main__":
    main()
