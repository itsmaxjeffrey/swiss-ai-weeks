"""Domain normalization: URLs/domains -> normalized registrable form."""

from __future__ import annotations

import re
import unicodedata

# common multi-part public suffixes (small pragmatic list; full PSL is a
# Phase-2 upgrade via publicsuffix2)
MULTI_SUFFIXES = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk",
    "com.au", "net.au", "org.au", "co.nz", "net.nz", "org.nz",
    "co.jp", "ne.jp", "or.jp", "ac.jp",
    "com.br", "com.mx", "com.ar", "com.co", "com.pe",
    "com.tr", "com.cn", "com.tw", "com.hk", "com.sg", "com.my",
    "co.in", "co.za", "com.pl", "com.ua", "co.kr", "com.vn",
    "com.ph", "com.gr", "co.il", "com.pt", "com.es", "com.se",
    "co.at", "or.at", "ac.at", "com.hr", "com.ee",
}


def normalize_domain(raw: str | None) -> str | None:
    """Return lowercase registrable-format domain (host) from a URL/domain."""
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip().lower()
    if "://" in s:
        s = s.split("://", 1)[1]
    s = s.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    if "@" in s:
        s = s.rsplit("@", 1)[1]
    s = s.split(":", 1)[0]          # strip port
    s = s.rstrip(".")
    s = unicodedata.normalize("NFKC", s)
    if not s or " " in s:
        return None
    if "xn--" in s:
        try:
            decoded = s.encode("ascii").decode("idna")
            s = decoded.lower()
        except Exception:
            pass
    if not re.fullmatch(r"[a-z0-9\.\-]+", s):
        return None
    if s.startswith("www.") and len(s) > len("www."):
        s = s[len("www."):]
    return s or None


def root_domain(domain: str | None) -> str | None:
    """Registrable root domain (eTLD+1, pragmatic suffix list)."""
    if not domain:
        return None
    parts = domain.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in MULTI_SUFFIXES:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else domain


def is_punycode(domain: str | None) -> bool:
    return bool(domain) and "xn--" in domain.lower()
