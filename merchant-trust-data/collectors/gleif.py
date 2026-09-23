"""GLEIF LEI-record collector (authoritative legal-entity registry).

API: https://api.gleif.org/api/v1/lei-records
License: GLEIF data is free and open under GLEIF terms of use (attribution).
Country-filtered pagination; per-page raw JSON caching makes it resumable.
"""

from __future__ import annotations

import json
import sys

import requests

from collectors import common


def collect(country: str) -> list[dict]:
    cfg = common.CONFIG["gleif"]
    page_size = int(cfg.get("page_size", 200))
    max_pages = int(cfg.get("max_pages", 30))
    sleep_s = float(cfg.get("sleep_seconds", 0.35))

    session = requests.Session()
    records: list[dict] = []
    page = 1
    while page <= max_pages:
        filename = f"gleif_{country.lower()}_p{page:04d}.json"
        params = {
            "filter[entity.legalAddress.country]": country,
            "page[size]": page_size,
            "page[number]": page,
        }
        path, meta, cached = common.get(
            cfg["api_base"], "gleif", filename,
            params=params, session=session, sleep_seconds=sleep_s,
        )
        doc = json.loads(path.read_text(encoding="utf-8"))
        rows = doc.get("data", []) or []
        records.extend(rows)
        pagination = (doc.get("meta") or {}).get("pagination") or {}
        total_pages = int(pagination.get("lastPage") or pagination.get("totalPages") or 1)
        if not cached:
            print(
                json.dumps({
                    "source": "gleif", "country": country, "page": page,
                    "rows": len(rows), "total_pages": total_pages,
                    "total_records": pagination.get("total"),
                }),
                file=sys.stderr,
            )
        if not rows or page >= min(total_pages, max_pages):
            break
        page += 1
    return records
