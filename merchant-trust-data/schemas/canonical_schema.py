"""Canonical merchant-trust schema for LEASH (v0.1).

Conventions (critical):
- Missing information is NEVER negative evidence.
  * Boolean columns use pandas nullable BooleanDtype: True / False / NA.
    NA = "unknown / not collected yet"; False = "checked and absent".
  * Numeric columns are nullable; NA = unknown.
- Lookup failures are recorded via *_lookup_status columns:
    not_attempted | ok | failed
- Every row MUST carry provenance: sources, source_urls, collected_at,
  last_verified_at, collector_version, data_license.
- Labels: see LABELS below. `unknown` is NOT `suspicious`.
"""

ENTITY_COLS = [
    "merchant_id",
    "entity_type",          # company | domain | merchant
    "merchant_name",
    "normalized_merchant_name",
    "legal_company_name",
    "trading_name",
    "country",
    "region",
    "city",
    "street_address",
    "postal_code",
    "phone",
    "email",
]

REGISTRY_COLS = [
    "registry_found",
    "registry_lookup_status",   # not_attempted | ok | failed
    "registry_source",
    "registry_id",
    "company_status",
    "legal_form",
    "incorporation_date",       # CAVEAT: for gleif rows this is the LEI issuance
                                # date, not the company founding date; true
                                # incorporation comes from Zefix (see PROGRESS.md)
    "company_age_days",         # same caveat as incorporation_date
    "registered_address",
    "registered_country",
    "registered_city",
    "vat_uid",
    "lei",
    "parent_company",
    "registry_last_updated",
]

WEBSITE_COLS = [
    "website_url",
    "domain",
    "domain_normalized",
    "website_reachable",
    "final_redirect_domain",
    "https_enabled",
    "tls_valid",
    "http_status",
    "page_title",
    "website_language",
]

DOMAIN_COLS = [
    "domain_creation_date",
    "domain_age_days",
    "domain_expiry_date",
    "registrar",
    "rdap_available",
    "nameservers",
    "dns_a_exists",
    "dns_mx_exists",
    "dns_txt_exists",
    "dns_error",
    "domain_privacy_proxy",
    "country_from_domain_registration",
]

LEGAL_PAGE_COLS = [
    "impressum_present",
    "impressum_url",
    "privacy_policy_present",
    "terms_present",
    "contact_page_present",
    "impressum_company_name",
    "impressum_address",
    "impressum_phone",
    "impressum_email",
    "impressum_vat_uid",
    "impressum_registry_id",
]

CONSISTENCY_COLS = [
    "name_registry_similarity",
    "name_domain_similarity",
    "website_registry_name_match",
    "website_registry_address_match",
    "website_registry_phone_match",
    "website_registry_email_match",
    "website_registry_vat_match",
    "website_registry_id_match",
    "domain_company_name_similarity",
]

SOCIAL_COLS = [
    "linkedin_found",
    "linkedin_url",
    "instagram_found",
    "instagram_url",
    "facebook_found",
    "facebook_url",
    "other_social_profiles_count",
]

REPUTATION_COLS = [
    "reddit_mentions_count",
    "reddit_positive_mentions",
    "reddit_negative_mentions",
    "reddit_neutral_mentions",
    "reddit_sentiment_score",
    "scam_reports_count",
    "complaint_mentions_count",
]

THREAT_COLS = [
    "openphish_hit",
    "urlhaus_hit",
    "phishing_database_hits",
    "malware_database_hits",
    "known_bad_domain",
    "threat_sources",
    "threat_first_seen",
    "threat_last_seen",
    "threat_types",
    "threat_sample_urls",
]

LOOKALIKE_COLS = [
    "possible_brand_impersonation",
    "closest_known_brand",
    "brand_name_similarity",
    "domain_typo_score",
    "homoglyph_detected",
    "punycode_domain",
    "suspicious_subdomain_pattern",
]

TECHNICAL_COLS = [
    "domain_redirect_count",
    "external_redirect",
    "certificate_age_days",
    "security_headers_score",
    "content_length",
    "website_has_checkout",
    "website_has_contact_details",
    "website_has_physical_address",
]

LABEL_COLS = ["label", "label_confidence", "label_source", "label_reason"]

PROVENANCE_COLS = [
    "sources",
    "source_urls",
    "collected_at",
    "last_verified_at",
    "collector_version",
    "data_license",
]

INTERNAL_COLS = [
    "entity_key",   # dedupe key: root domain or registry id
    "raw_json",     # preserve raw source record (never drop raw info)
]

ALL_COLUMNS = (
    ENTITY_COLS + REGISTRY_COLS + WEBSITE_COLS + DOMAIN_COLS + LEGAL_PAGE_COLS
    + CONSISTENCY_COLS + SOCIAL_COLS + REPUTATION_COLS + THREAT_COLS
    + LOOKALIKE_COLS + TECHNICAL_COLS + LABEL_COLS + PROVENANCE_COLS + INTERNAL_COLS
)

LABELS = [
    "verified_legitimate",
    "likely_legitimate",
    "unknown",
    "suspicious",
    "confirmed_malicious",
]

THREE_STATE_NOTE = "Boolean dtype: True / False / NA(unknown). Never encode unknown as False."


def new_row(**kwargs) -> dict:
    row = {c: None for c in ALL_COLUMNS}
    row.update(kwargs)
    return row


def build_feature_object(row: dict) -> dict:
    """API-ready feature object (LEASH spec #23, v0: no model scores yet)."""
    return {
        "merchant": {
            "name": row.get("legal_company_name") or row.get("merchant_name"),
            "country": row.get("country") or row.get("registered_country"),
            "domain": row.get("domain_normalized") or row.get("domain"),
        },
        "identity": {
            "registry_verified": bool(row.get("registry_id")) if row.get("registry_id") else False,
            "registry_id": row.get("registry_id"),
            "registry_age_days": row.get("company_age_days"),
            "registry_status": row.get("company_status"),
        },
        "domain": {
            "domain_age_days": row.get("domain_age_days"),
            "registrar": row.get("registrar"),
            "tls_valid": row.get("tls_valid"),  # NA = unknown (nullable bool)
            "lookalike_score": row.get("domain_typo_score"),
            "possible_brand_impersonation": row.get("possible_brand_impersonation"),
        },
        "threat_intelligence": {
            "openphish": row.get("openphish_hit"),
            "urlhaus": row.get("urlhaus_hit"),
            "sources": row.get("threat_sources"),
        },
        "label": {
            "label": row.get("label"),
            "confidence": row.get("label_confidence"),
            "reason": row.get("label_reason"),
        },
        "provenance": {
            "sources": row.get("sources"),
            "collected_at": row.get("collected_at"),
            "data_license": row.get("data_license"),
        },
    }
