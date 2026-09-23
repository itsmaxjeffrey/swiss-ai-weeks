"""Company-name normalization for entity resolution and matching."""

from __future__ import annotations

import re
import unicodedata

# legal-form suffix tokens (accent-stripped, lowercase); stripped repeatedly
LEGAL_SUFFIXES = {
    "gmbh", "ag", "sa", "sarl", "sarl", "sarl", "sasu", "sas", "srl", "spa",
    "ltd", "limited", "llc", "llp", "lp", "inc", "incorporated", "plc",
    "corp", "corporation", "bv", "nv", "ug", "se", "oy", "oyj", "ab", "as",
    "asa", "aps", "gk", "kg", "ohg", "gbr", "ek", "eg", "eir", "scs",
    "stiftung", "verein", "societe", "society", "ans", "co", "company",
    "holdings", "holding", "group", "gruppe", "international",
    "pvt", "pty", "srl", "sarl", "sl", "srls", "ooo", "zao", "kk", "pt",
}


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def normalize_company_name(name: str | None) -> str | None:
    """'ACME Electronics GmbH' / 'Acme Electronics' / 'ACME ELECTRONICS GMBH'
    all -> 'acme electronics'. Preserves the original alongside; caller's job.
    """
    if not name or not isinstance(name, str):
        return None
    s = strip_accents(name).lower()
    s = s.replace("&", " and ")
    # dots removed WITHOUT introducing spaces so legal forms like
    # "S.A.", "s.à r.l.", "b.v." collapse to sa / sarl / bv before suffix-strip
    s = s.replace(".", "")
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    tokens = [t for t in s.split() if t]
    while tokens and tokens[-1] in LEGAL_SUFFIXES:
        tokens.pop()
    if tokens and tokens[0] == "the":
        tokens = tokens[1:]
    return " ".join(tokens) or None
