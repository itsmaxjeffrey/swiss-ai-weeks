"""Plain linear risk-score model (0-100), optimized for interpretability.

risk = clip(100 * (b0 + sum(c_i * x_i)), 0, 100)

Trained with ordinary least squares on y = 1 (confirmed_malicious) /
0 (likely_legitimate). Coefficients read directly as risk points.

Usage:
    .venv/bin/python train_risk_model_linear.py
"""

import json

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

CSV_PATH = "data/processed/dataset_features.csv"
MODEL_OUT = "models/risk_score_linear_points.json"

NUMERIC = ["company_age_days", "domain_age_days",
           "domain_typo_score", "brand_name_similarity"]
BOOL = ["registry_found", "website_reachable", "https_enabled", "tls_valid",
        "dns_a_exists", "dns_mx_exists", "dns_txt_exists",
        "domain_privacy_proxy", "urlhaus_hit", "possible_brand_impersonation"]


def engineer(df: pd.DataFrame, medians: dict | None = None):
    X = pd.DataFrame(index=df.index)
    meds = medians or {}
    for c in NUMERIC:
        v = pd.to_numeric(df[c], errors="coerce")
        med = meds.get(c, float(v.median()))
        X[c] = v.fillna(med)
        X[f"{c}_missing"] = v.isna().astype(int)
    for c in BOOL:
        v = df[c]
        if v.dtype == object:
            v = v.map(lambda x: x if isinstance(x, (bool, np.bool_))
                      else np.nan)
        X[c] = v.astype(float).fillna(0.5)  # 0.5 = unknown
    return X, meds


def main() -> None:
    df = pd.read_csv(CSV_PATH, low_memory=False)
    df = df[df["label"].isin(["confirmed_malicious",
                              "likely_legitimate"])].copy()
    y = (df["label"] == "confirmed_malicious").astype(int)

    X, meds = engineer(df)
    Xtr, Xte, ytr, yte = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y)

    lin = LinearRegression()
    lin.fit(Xtr, ytr)

    score = np.clip(100 * lin.predict(Xte), 0, 100)
    print(f"Test ROC-AUC (score vs label): {roc_auc_score(yte, score):.4f}")
    print(f"Malicious: median {np.median(score[yte == 1]):.1f}, "
          f"10th pct {np.percentile(score[yte == 1], 10):.1f}")
    print(f"Legit:     median {np.median(score[yte == 0]):.1f}, "
          f"90th pct {np.percentile(score[yte == 0], 90):.1f}")

    coefs = pd.Series(lin.coef_, index=X.columns)
    print("\nFORMULA: risk = clip(100 * (b0 + sum(c_i * x_i)), 0, 100)")
    print("Each c_i is in label-probability units; multiply by 100 for "
          "risk points per unit of the feature.")
    print(f"\nb0 = {lin.intercept_:.4f}")
    pts = (100 * coefs).round(2)
    print("\nContribution per unit feature (risk points):")
    print(pts.sort_values(key=abs, ascending=False).to_string())

    out = {
        "formula": "risk = clip(100 * (b0 + sum(c_i * x_i)), 0, 100)",
        "intercept": float(lin.intercept_),
        "coefficients_risk_points": pts.to_dict(),
        "median_impute": meds,
        "encoding": ("booleans: 1=True, 0=False, 0.5=unknown; numeric "
                     "missing -> median impute + _missing indicator = 1"),
        "test_auc": float(roc_auc_score(yte, score)),
    }
    with open(MODEL_OUT, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved -> {MODEL_OUT}")


if __name__ == "__main__":
    main()
