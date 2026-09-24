"""Train a linear risk-score model (0-100) on the LEASH merchant dataset.

Model: logistic regression over engineered features (numeric + boolean
flags + missingness indicators), trained on the label
(confirmed_malicious vs likely_legitimate). The output probability is
scaled to a 0-100 risk score.

Usage:
    .venv/bin/python train_risk_model.py
"""

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

CSV_PATH = "data/processed/dataset_features.csv"
MODEL_OUT = "models/risk_score_linear.json"

# Behavioral + threat features present in the data. Registry fields are
# excluded as raw features (they only exist for companies -> the model
# would just learn entity_type). Instead, HAS_REGISTRY is one feature.
NUMERIC = ["company_age_days", "domain_age_days",
           "domain_typo_score", "brand_name_similarity"]
BOOL = ["registry_found", "website_reachable", "https_enabled", "tls_valid",
        "dns_a_exists", "dns_mx_exists", "dns_txt_exists",
        "domain_privacy_proxy", "openphish_hit", "urlhaus_hit",
        "possible_brand_impersonation"]


def engineer(df: pd.DataFrame) -> pd.DataFrame:
    """NaN-safe feature matrix: numerics imputed to median + indicator,
    booleans mapped True=1, False=0, missing=0.5 (unknown)."""
    X = pd.DataFrame(index=df.index)
    for c in NUMERIC:
        v = pd.to_numeric(df[c], errors="coerce")
        med = v.median()
        X[c] = v.fillna(med)
        X[f"{c}_missing"] = v.isna().astype(int)
    for c in BOOL:
        v = df[c]
        if v.dtype == object:
            v = v.map(lambda x: x if isinstance(x, (bool, np.bool_))
                      else np.nan)
        X[c] = v.astype(float).fillna(0.5)  # 0.5 = unknown
    # registry-based derived
    age = pd.to_numeric(df["company_age_days"], errors="coerce")
    X["young_registry"] = (age < 365).astype(float).where(age.notna(), 0.0)
    dage = pd.to_numeric(df["domain_age_days"], errors="coerce")
    X["young_domain"] = (dage < 365).astype(float).where(dage.notna(), 0.0)
    return X


def main() -> None:
    df = pd.read_csv(CSV_PATH, low_memory=False)
    df = df[df["label"].isin(["confirmed_malicious",
                              "likely_legitimate"])].copy()
    y = (df["label"] == "confirmed_malicious").astype(int)

    X = engineer(df)
    Xtr, Xte, ytr, yte = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y)

    clf = LogisticRegression(max_iter=2000)
    clf.fit(Xtr, ytr)

    p = clf.predict_proba(Xte)[:, 1]
    print(f"Test ROC-AUC: {roc_auc_score(yte, p):.4f}")
    print(f"Risk score (0-100) on test set: "
          f"malicious median={100 * np.median(p[yte == 1]):.1f}, "
          f"legit median={100 * np.median(p[yte == 0]):.1f}")

    # ---- formula ---------------------------------------------------------
    # risk = 100 * sigmoid(b0 + sum(coef_i * x_i))
    coefs = pd.Series(clf.coef_[0], index=X.columns)
    intercept = float(clf.intercept_[0])
    print("\nFORMULA: risk = 100 / (1 + exp(-(b0 + sum(c_i * x_i))))")
    print(f"b0 (intercept) = {intercept:.4f}")
    print("\nCoefficients c_i:")
    print(coefs.round(4).sort_values(key=abs, ascending=False).to_string())

    # Save model artifact
    out = {"intercept": intercept,
           "coefficients": coefs.round(6).to_dict(),
           "features_numeric": NUMERIC, "features_bool": BOOL,
           "median_impute": {c: float(pd.to_numeric(df[c], errors="coerce")
                                      .median()) for c in NUMERIC},
           "notes": "risk = 100 * sigmoid(b0 + sum(c*x)); bools: 1=True, "
                    "0=False, 0.5=unknown; numeric missing -> median "
                    "+ missing indicator."}
    import json
    with open(MODEL_OUT, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved -> {MODEL_OUT}")


if __name__ == "__main__":
    main()
