"""Quick look at the LEASH merchant-trust dataset (v2).

Usage:
    python3 explore_dataset.py
"""

import pandas as pd

CSV_PATH = "data/processed/dataset_features.csv"


def main() -> None:
    df = pd.read_csv(CSV_PATH)
    print(f"Shape: {df.shape[0]} rows x {df.shape[1]} columns\n")

    # Label distribution
    print("Label distribution:")
    print(df["label"].value_counts(dropna=False).to_string(), "\n")

    # First rows
    print("head():")
    # Show a manageable subset of the most interesting columns
    interesting = [
        "merchant_name", "entity_type", "country", "label",
        "registry_found", "company_age_days",
        "domain", "domain_age_days", "tls_valid", "dns_mx_exists",
        "impressum_present", "name_registry_similarity",
        "openphish_hit", "urlhaus_hit", "known_bad_domain",
        "possible_brand_impersonation", "brand_name_similarity",
    ]
    cols = [c for c in interesting if c in df.columns]
    print(df[cols].head(10).to_string(), "\n")

    # Missingness per column (top 40 most complete)
    miss = df.isna().mean().sort_values()
    print("Column fill rates (share of rows present), top 40:")
    print((1 - miss.head(40)).round(3).to_string(), "\n")
    print("Column fill rates, 20 emptiest:")
    print((1 - miss.tail(20)).round(3).to_string())


if __name__ == "__main__":
    main()
