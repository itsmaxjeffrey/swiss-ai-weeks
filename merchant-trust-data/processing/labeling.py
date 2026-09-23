"""Labeling rules (v0): conservative, provenance-first.

- confirmed_malicious requires an authoritative threat-intel hit
  (OpenPhish confirmed feed / URLhaus).
- GLEIF-registered active entities are likely_legitimate at registry level
  ONLY; website identity is not verified in Phase 1, so they never get
  verified_legitimate without the Phase-2 identity-consistency evidence.
- unknown is never suspicious.
"""

from __future__ import annotations

OPENPHISH_CONF = 0.95
URLHAUS_CONF = 0.90
MULTI_CONF = 0.98
GLEIF_ACTIVE_CONF = 0.70


def label_threat(sources: set[str]) -> tuple[str, float, str, str]:
    ordered = sorted(sources)
    if {"openphish", "urlhaus"} <= sources:
        conf = MULTI_CONF
    elif "openphish" in sources:
        conf = OPENPHISH_CONF
    else:
        conf = URLHAUS_CONF
    src = ";".join(ordered)
    reason = (
        "Domain present in confirmed threat-intel feed(s): "
        f"{src} (verified phishing/malware-distribution as of collection date). "
        "Registry identity not investigated; label reflects threat-intel evidence."
    )
    return "confirmed_malicious", conf, src, reason


def label_gleif(entity_status: str | None) -> tuple[str, float, str, str]:
    if (entity_status or "").upper() == "ACTIVE":
        return (
            "likely_legitimate", GLEIF_ACTIVE_CONF, "gleif",
            "Active legal entity in GLEIF (authoritative registry). Registry-level "
            "evidence only: website identity not yet verified (Phase 2), so not "
            "verified_legitimate.",
        )
    return (
        "unknown", 0.5, "gleif",
        f"LEI record exists but entity status is {entity_status or 'UNKNOWN'}; "
        "registry identity exists but activity/website unverified.",
    )
