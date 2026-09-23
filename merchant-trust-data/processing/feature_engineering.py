"""Derived feature construction: RDAP parsing, DNS merge, lookalike, ages."""

from __future__ import annotations

import datetime as dt


def parse_rdap_doc(doc: dict) -> dict:
    """Extract registration metadata from an RDAP domain response."""
    out = {
        "domain_creation_date": None,
        "domain_expiry_date": None,
        "registrar": None,
        "nameservers": None,
        "rdap_available": True,
        "rdap_status": doc.get("rdap_status"),
        "country_from_domain_registration": None,
    }
    if doc.get("rdap_status"):  # not_found / http_x / error
        # False = confirmed unregistered; None = lookup failed/unknown
        out["rdap_available"] = False if doc["rdap_status"] == "not_found" else None
        return out
    events = {e.get("eventAction"): e.get("eventDate") for e in (doc.get("events") or [])}
    out["domain_creation_date"] = (events.get("registration") or "")[:10] or None
    out["domain_expiry_date"] = (events.get("expiration") or "")[:10] or None

    # registrar: entity with role 'registrar' -> vcard fn
    for ent in (doc.get("entities") or []):
        roles = ent.get("roles") or []
        if "registrar" in roles:
            vcard = ent.get("vcardArray") or []
            if len(vcard) > 1:
                for item in vcard[1]:
                    if isinstance(item, list) and len(item) >= 4 and item[0] == "fn":
                        out["registrar"] = item[3]
                        break
            if not out["registrar"]:
                out["registrar"] = ent.get("handle")
            break

    ns = [((n.get("ldhName") or "")).lower() for n in (doc.get("nameservers") or []) if n.get("ldhName")]
    out["nameservers"] = ";".join(sorted(set(ns))) or None

    # country from registrant address if exposed
    for ent in (doc.get("entities") or []):
        if "registrant" in (ent.get("roles") or []):
            vcard = ent.get("vcardArray") or []
            if len(vcard) > 1:
                for item in vcard[1]:
                    if isinstance(item, list) and item[0] == "adr" and isinstance(item[3], list) and len(item[3]) > 6:
                        out["country_from_domain_registration"] = item[3][6]
    return out


def domain_age_days(creation_date, as_of: dt.date | None = None) -> float | None:
    if creation_date is None or isinstance(creation_date, float) or not isinstance(creation_date, str):
        return None
    if not creation_date:
        return None
    try:
        d = dt.date.fromisoformat(creation_date[:10])
    except ValueError:
        return None
    as_of = as_of or dt.date.today()
    return max(float((as_of - d).days), 0.0)


def company_age_days(incorporation_date: str | None, as_of: dt.date | None = None) -> float | None:
    return domain_age_days(incorporation_date, as_of)
