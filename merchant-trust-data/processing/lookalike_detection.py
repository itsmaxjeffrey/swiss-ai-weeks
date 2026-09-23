"""Lookalike / impersonation risk features.

Rules:
- Similarity to a known brand is a RISK FEATURE, never a label.
- A domain equal to a brand's own domain is not impersonation.
- Homoglyph folding + punycode detection + suspicious brand-in-subdomain.
"""

from __future__ import annotations

try:  # rapidfuzz if available, pure-python fallback otherwise
    from rapidfuzz import fuzz

    def _ratio(a: str, b: str) -> float:
        return fuzz.ratio(a, b) / 100.0

    def _partial(a: str, b: str) -> float:
        return fuzz.partial_ratio(a, b) / 100.0
except ImportError:  # fallback
    def _ratio(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        # cheap levenshtein
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
            prev = cur
        return 1.0 - prev[-1] / max(len(a), len(b))

    def _partial(a: str, b: str) -> float:
        shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
        best = 0.0
        for i in range(0, max(1, len(longer) - len(shorter) + 1)):
            best = max(best, _ratio(shorter, longer[i:i + len(shorter)]))
        return best


BRANDS: dict[str, str] = {
    # brand -> known primary domain (empty = name-only signal)
    "paypal": "paypal.com", "google": "google.com", "microsoft": "microsoft.com",
    "apple": "apple.com", "amazon": "amazon.com", "netflix": "netflix.com",
    "facebook": "facebook.com", "instagram": "instagram.com",
    "whatsapp": "whatsapp.com", "linkedin": "linkedin.com", "tiktok": "tiktok.com",
    "coinbase": "coinbase.com", "binance": "binance.com", "kraken": "kraken.com",
    "metamask": "metamask.io", "revolut": "revolut.com", "wise": "wise.com",
    "dhl": "dhl.com", "fedex": "fedex.com", "ups": "ups.com", "usps": "usps.com",
    "dpd": "dpd.com", "gls": "gls-group.com", "post": "post.ch",
    "twint": "twint.ch", "postfinance": "postfinance.ch", "ubs": "ubs.com",
    "migros": "migros.ch", "coop": "coop.ch", "digitec": "digitec.ch",
    "galaxus": "galaxus.ch", "brack": "brack.ch", "microspot": "microspot.ch",
    "interdiscount": "interdiscount.ch", "fust": "fust.ch", "sbb": "sbb.ch",
    "swisscom": "swisscom.ch", "sunrise": "sunrise.ch", "salt": "salt.ch",
    "zurich": "zurich.ch", "axa": "axa.ch", "helvetia": "helvetia.ch",
    "allianz": "allianz.ch", "raiffeisen": "raiffeisen.ch",
    "americanexpress": "americanexpress.com", "zalando": "zalando.ch", "aliexpress": "aliexpress.com",
    "temu": "temu.com", "shein": "shein.com", "wish": "wish.com",
    "ebay": "ebay.com", "etsy": "etsy.com", "booking": "booking.com",
    "airbnb": "airbnb.com", "skrill": "skrill.com", "neteller": "neteller.com",
    "westernunion": "westernunion.com", "moneygram": "moneygram.com",
    "chase": "chase.com", "wellsfargo": "wellsfargo.com", "hsbc": "hsbc.com",
    "barclays": "barclays.co.uk", "lloyds": "lloydsbank.com",
    "dbs": "dbs.com.sg", "ocbc": "ocbc.com", "uob": "uob.com.sg",
}

_HOMOGLYPH_MAP = str.maketrans({
    "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
    "6": "g", "@": "a", "$": "s", "!": "i", "|": "l", "©": "c",
})


def homoglyph_fold(s: str) -> str:
    return s.translate(_HOMOGLYPH_MAP)


def _labels(domain: str) -> list[str]:
    return [p for p in domain.split(".") if p]


def analyze_domain(domain: str | None) -> dict:
    """Return lookalike feature dict for a normalized domain (or None-domain)."""
    from processing.normalize_domain import normalize_domain, root_domain

    nd = normalize_domain(domain) or (domain or "").lower() or None
    out = {
        "possible_brand_impersonation": False,
        "closest_known_brand": None,
        "brand_name_similarity": None,
        "domain_typo_score": None,
        "homoglyph_detected": False,
        "punycode_domain": bool(nd and "xn--" in nd),
        "suspicious_subdomain_pattern": False,
    }
    if not nd:
        return out

    root = root_domain(nd) or nd
    root_labels = _labels(root)
    nd_labels = _labels(nd)
    # labels left of the registrable root = subdomain labels
    sub_len = max(len(nd_labels) - len(root_labels), 0)
    sub_labels = nd_labels[:sub_len]

    best_brand, best_sim, best_root, best_embedded = None, 0.0, None, False
    for brand, brand_domain in BRANDS.items():
        brand_root = brand_domain or f"{brand}.com"
        brand_token = brand.replace(" ", "")
        first_label = root_labels[0] if root_labels else root
        # headline similarity: root-vs-brand-domain, first label vs brand token
        sim = max(
            _ratio(root, brand_root),
            _ratio(first_label, brand_token),
        )
        # exact (homoglyph-folded) containment beats fuzzy partials: brand token
        # embedded in the domain (paypal-login.com, micros0ft-support.com)
        folded_token = homoglyph_fold(brand_token)
        folded_first = homoglyph_fold(first_label)
        folded_subs = homoglyph_fold(".".join(sub_labels)) if sub_labels else ""
        embedded = False
        if folded_token in folded_first:
            sim = 1.0
            embedded = True
        if folded_subs and folded_token in folded_subs:
            if root != brand_root:
                # brand embedded left of an unrelated registrable root
                out["suspicious_subdomain_pattern"] = True
                sim = 1.0
                embedded = True
        if sim > best_sim:
            best_brand, best_sim, best_root, best_embedded = brand, sim, brand_root, embedded

    # homoglyph: folding the root makes it clearly land on a brand domain
    folded_root = homoglyph_fold(root)
    if folded_root != root:
        for brand, brand_domain in BRANDS.items():
            brand_root = brand_domain or f"{brand}.com"
            if root != brand_root and _ratio(folded_root, brand_root) >= 0.9:
                out["homoglyph_detected"] = True
                break

    out["closest_known_brand"] = best_brand
    out["brand_name_similarity"] = round(min(best_sim, 1.0), 4)
    out["domain_typo_score"] = round(1.0 - min(best_sim, 1.0), 4)

    if best_brand and best_root and root == best_root:
        # the domain IS the brand's own domain — not impersonation
        out["possible_brand_impersonation"] = False
    elif best_brand and best_root:
        close = 0.80 <= best_sim < 0.995
        out["possible_brand_impersonation"] = bool(
            best_embedded or close or out["homoglyph_detected"]
            or out["suspicious_subdomain_pattern"] or out["punycode_domain"]
        )
    return out
