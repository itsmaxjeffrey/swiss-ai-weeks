"""Entity resolution v0:

- Threat-feed records aggregate to one entity per root domain, preserving
  per-source context (threat_sources, first/last seen, sample URLs).
- GLEIF companies are unique by LEI.
- Deterministic merchant_id: sha1 of entity key.
"""

from __future__ import annotations

import hashlib


def merchant_id_for(entity_key: str) -> str:
    return "md_" + hashlib.sha1(entity_key.encode()).hexdigest()[:12]


def merge_threat_records(records: list[dict]) -> list[dict]:
    """records: parsed feed rows with keys root_domain, source, url, threat_type,
    first_seen, url_source. Returns one merged dict per root domain."""
    by_root: dict[str, dict] = {}
    for r in records:
        root = r["root_domain"]
        if not root:
            continue
        agg = by_root.setdefault(root, {
            "entity_key": root,
            "root_domain": root,
            "sources": set(),
            "threat_types": set(),
            "urls": [],
            "url_sources": [],
            "first_seen": None,
            "last_seen": None,
        })
        agg["sources"].add(r["source"])
        if r.get("threat_type"):
            agg["threat_types"].add(r["threat_type"])
        if r.get("url"):
            if len(agg["urls"]) < 3:
                agg["urls"].append(r["url"])
        if r.get("url_source"):
            if len(agg["url_sources"]) < 5:
                agg["url_sources"].append(r["url_source"])
        fs, ls = r.get("first_seen"), r.get("last_seen")
        if fs and (agg["first_seen"] is None or fs < agg["first_seen"]):
            agg["first_seen"] = fs
        if ls and (agg["last_seen"] is None or ls > agg["last_seen"]):
            agg["last_seen"] = ls
    for agg in by_root.values():
        agg["sources"] = sorted(agg["sources"])
        agg["threat_types"] = sorted(agg["threat_types"])
    return list(by_root.values())


def dedupe_by_entity_key(rows: list[dict]) -> list[dict]:
    """Final safety net: one row per entity_key (keeps the first)."""
    seen: dict[str, dict] = {}
    for row in rows:
        key = row.get("entity_key")
        if key and key not in seen:
            seen[key] = row
    return list(seen.values())
