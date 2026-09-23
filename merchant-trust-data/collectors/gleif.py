"""GLEIF LEI-record collector (authoritative legal-entity registry).

API: https://api.gleif.org/api/v1/lei-records
License: GLEIF data is free and open under GLEIF terms of use (attribution).
Country-filtered CURSOR pagination: page-number pagination is rejected by the
API beyond 10,000 results (page[number] * page[size] <= 10000), so full
slices (CH ≈ 28k records) must walk page[cursor]=* following links.next.
Per-page raw JSON caching keeps it resumable: the next cursor is recovered
from the cached page's `links.next` without re-fetching it.
"""

from __future__ import annotations

import json
import sys
from urllib.parse import parse_qs, urlparse

import requests

from collectors import common


def _next_cursor(doc: dict) -> str | None:
    """Next page[cursor] value from links.next; None when result set is exhausted."""
    next_url = (doc.get("links") or {}).get("next")
    if not next_url:
        return None
    vals = parse_qs(urlparse(next_url).query).get("page[cursor]")
    return vals[0] if vals else None


def collect(country: str) -> list[dict]:
    cfg = common.CONFIG["gleif"]
    page_size = int(cfg.get("page_size", 200))
    max_pages = int(cfg.get("max_pages", 200))
    sleep_s = float(cfg.get("sleep_seconds", 0.35))

    session = requests.Session()
    records: list[dict] = []
    cursor: str | None = "*"  # GLEIF: page[cursor]=* starts cursor pagination
    page = 1
    while cursor is not None and page <= max_pages:
        filename = f"gleif_{country.lower()}_c{page:04d}.json"
        path = common.raw_dir("gleif") / filename
        cached = path.exists()
        if cached:
            doc = json.loads(path.read_text(encoding="utf-8"))
        else:
            params = {
                "filter[entity.legalAddress.country]": country,
                "page[size]": page_size,
                "page[cursor]": cursor,
            }
            req_path, _meta, _hit = common.get(
                cfg["api_base"], "gleif", filename,
                params=params, session=session, sleep_seconds=sleep_s,
            )
            doc = json.loads(req_path.read_text(encoding="utf-8"))
        rows = doc.get("data", []) or []
        records.extend(rows)
        if not cached:
            pagination = (doc.get("meta") or {}).get("pagination") or {}
            print(
                json.dumps({
                    "source": "gleif", "country": country, "page": page,
                    "rows": len(rows), "total": pagination.get("total"),
                    "has_next": _next_cursor(doc) is not None,
                }),
                file=sys.stderr,
            )
        if not rows:
            break
        cursor = _next_cursor(doc)
        page += 1
    else:
        if cursor is not None:
            print(
                json.dumps({"source": "gleif", "country": country,
                            "warning": "max_pages reached with rows remaining"}),
                file=sys.stderr,
            )
    return records
