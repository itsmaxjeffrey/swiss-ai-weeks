"""Feature analysis for the LEASH merchant-trust dataset (v2).

Answers: which features are actually usable for a risk-score model, and
which ones separate malicious from legitimate entities?

Usage:
    python3 explore_dataset.py
"""

import numpy as np
import pandas as pd

CSV_PATH = "data/processed/dataset_features.csv"

# Features worth analyzing, by type (from schemas/canonical_schema.py).
NUMERIC = [
    "company_age_days", "domain_age_days", "domain_typo_score",
    "brand_name_similarity", "name_registry_similarity",
    "label_confidence",
]
BOOL = [
    "registry_found", "website_reachable", "https_enabled", "tls_valid",
    "dns_a_exists", "dns_mx_exists", "dns_txt_exists", "domain_privacy_proxy",
    "openphish_hit", "urlhaus_hit", "known_bad_domain",
    "possible_brand_impersonation", "homoglyph_detected",
    "punycode_domain", "suspicious_subdomain_pattern",
    "impressum_present", "privacy_policy_present", "terms_present",
    "contact_page_present",
]
CATEGORICAL = ["entity_type", "legal_form", "registrar", "company_status",
               "label"]


def header(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def main() -> None:
    df = pd.read_csv(CSV_PATH, low_memory=False)
    print(f"Shape: {df.shape[0]} rows x {df.shape[1]} columns")

    # ---- 1. Overall label distribution ---------------------------------
    header("1. Label distribution")
    print(df["label"].value_counts(dropna=False).to_string())

    # ---- 2. Feature availability by entity type ------------------------
    # A feature is only useful if it's populated where it matters.
    header("2. Feature fill rate (%) by entity_type")
    et = df["entity_type"].fillna("<missing>")
    fill = df.drop(columns=["entity_type"]).notna().groupby(et).mean().T * 100
    fill["ALL"] = df.drop(columns=["entity_type"]).notna().mean() * 100
    interesting = [c for c in fill.index
                   if fill.loc[c].max() > 0 and c not in
                   ("merchant_id", "entity_key", "raw_json", "sources",
                    "source_urls", "collected_at", "last_verified_at",
                    "collector_version", "data_license", "label_source",
                    "label_reason")]
    # Show columns sorted by ALL fill rate, top 45
    print(fill.loc[interesting].sort_values("ALL", ascending=False)
          .head(45).round(1).to_string())

    # ---- 3. Label-conditional stats for numeric features ----------------
    # Compare malicious vs likely_legitimate to see separation power.
    header("3. Numeric features: malicious vs likely_legitimate")
    num_rows = []
    for c in NUMERIC:
        if c not in df.columns:
            continue
        mal = pd.to_numeric(df.loc[df.label == "confirmed_malicious", c],
                            errors="coerce")
        legit = pd.to_numeric(
            df.loc[df.label == "likely_legitimate", c], errors="coerce")
        if mal.notna().sum() == 0 and legit.notna().sum() == 0:
            continue
        num_rows.append({
            "feature": c,
            "mal_fill%": 100 * mal.notna().mean(),
            "mal_mean": mal.mean(),
            "mal_median": mal.median(),
            "legit_fill%": 100 * legit.notna().mean(),
            "legit_mean": legit.mean(),
            "legit_median": legit.median(),
        })
    num_df = pd.DataFrame(num_rows).set_index("feature")
    if not num_df.empty:
        print(num_df.round(2).to_string())
    print("\nInterpretation: large gap between mal_* and legit_* stats "
          "= strong signal. Different fill rates are themselves a signal "
          "(e.g. registry fields exist only for legitimate entities).")

    # ---- 4. Boolean features: positive rate by label --------------------
    header("4. Boolean features: % True by label")
    bool_rows = []
    for c in BOOL:
        if c not in df.columns:
            continue
        col = df[c]
        if col.dtype == object:  # mixed types from CSV
            col = col.map(lambda v: v if isinstance(v, bool) else np.nan)
        mal = col[df.label == "confirmed_malicious"]
        legit = col[df.label == "likely_legitimate"]
        if mal.notna().sum() == 0 and legit.notna().sum() == 0:
            continue
        bool_rows.append({
            "feature": c,
            "mal_fill%": 100 * mal.notna().mean(),
            "mal_True%": 100 * mal.mean() if mal.notna().any() else np.nan,
            "legit_fill%": 100 * legit.notna().mean(),
            "legit_True%": 100 * legit.mean() if legit.notna().any() else np.nan,
        })
    bool_df = pd.DataFrame(bool_rows).set_index("feature")
    if not bool_df.empty:
        print(bool_df.round(1).to_string())
    print("\nInterpretation: a feature is useful when True% differs a lot "
          "between labels, OR when fill% differs (feature itself only "
          "exists for one class). All-zero columns can be dropped.")

    # ---- 5. Categorical highlights --------------------------------------
    header("5. Categorical: registrar / legal_form / entity_type by label")
    for c in ["entity_type", "legal_form", "registrar"]:
        if c not in df.columns:
            continue
        ct = pd.crosstab(df[c].fillna("<missing>"), df["label"],
                         normalize="columns") * 100
        print(f"\n{c} (% of each label):")
        print(ct.round(1).to_string())

    # ---- 6. Usability verdict -------------------------------------------
    header("6. Verdict: features usable for a risk-score model")
    filled = (df.notna().mean() * 100).round(1)
    empty = filled[filled == 0].index.tolist()
    print(f"EMPTY (drop or collect later, {len(empty)} cols): "
          f"{', '.join(empty)}")
    usable = filled[(filled > 50) & ~filled.index.isin(
        ["merchant_id", "entity_key", "raw_json"])].index.tolist()
    print(f"WELL-FILLED >50% ({len(usable)} cols): {', '.join(usable)}")


if __name__ == "__main__":
    main()
