"""Thin client for the City of Toronto Open Data CKAN API.

No API key is required -- the Street Tree Data dataset is public. Note:
`datastore_search_sql` is blocked by the portal's WAF for external callers (it 403s even
on a trivial SELECT), so this client sticks to the plain `datastore_search` action,
restricting to the columns we need via `fields` and paginating with limit/offset.

Same client as the sibling `to-multiplex-map` project, minus the bits it doesn't need.
"""
from __future__ import annotations

from typing import Callable, Iterator

import requests

BASE_URL = "https://ckan0.cf.opendata.inter.prod-toronto.ca"
DEFAULT_PAGE_SIZE = 20_000
TIMEOUT_SECONDS = 180
MAX_ATTEMPTS = 4


def _get(action: str, params: dict) -> dict:
    """GET one CKAN action, retrying on transport errors and 5xx."""
    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(
                f"{BASE_URL}/api/3/action/{action}",
                params=params,
                timeout=TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
            payload = resp.json()
            if not payload.get("success"):
                raise RuntimeError(f"CKAN {action} failed: {payload}")
            return payload["result"]
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt == MAX_ATTEMPTS:
                break
            # The portal rate-limits bursts; back off rather than hammering it.
            import time

            time.sleep(2 ** attempt)
    raise RuntimeError(f"CKAN {action} failed after {MAX_ATTEMPTS} attempts") from last_error


def package_show(package_id: str) -> dict:
    """Dataset metadata -- used to record the City's own `last_refreshed` stamp."""
    return _get("package_show", {"id": package_id})


def datastore_pages(
    resource_id: str,
    fields: list[str] | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    on_progress: Callable[[int, int], None] | None = None,
) -> Iterator[list[dict]]:
    """Yield pages of records from a datastore-active resource.

    Streams a page at a time rather than returning one list: the street tree resource is
    ~690k rows, and holding every raw dict in memory at once costs far more than the
    columnar table we're building from it.
    """
    offset = 0
    total = 0
    while True:
        params = {"resource_id": resource_id, "limit": page_size, "offset": offset}
        if fields:
            params["fields"] = ",".join(fields)

        result = _get("datastore_search", params)
        batch = result["records"]
        if not batch:
            return

        yield batch

        offset += len(batch)
        total = result.get("total", 0)
        if on_progress:
            on_progress(offset, total)
        if len(batch) < page_size:
            return
