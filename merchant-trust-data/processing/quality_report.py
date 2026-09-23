"""Data-quality report generator.

Usage: python -m processing.quality_report
Writes reports/data_quality_report.md and prints a JSON summary.
"""

from __future__ import annotations

import json
import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
PROCESSED = ROOT / "data" / "processed"

KEY_MISSING_COLS = [
    "registry_id", "legal_company_name", "domain", "domain_creation_date",
    "registrar", "dns_a_exists", "dns_mx_exists", "company_status",
    "incorporation_date", "label_confidence",
]


def _dist(series: pd.Series, n: int = 12) -> pd.Series:
    return series.value_counts().head(n)


def main() -> None:
    df = pd.read_parquet(PROCESSED / "dataset_features.parquet")
    lines: list[str] = []
    summary: dict = {}

    def emit(s: str) -> None:
        lines.append(s)

    emit("# LEASH merchant-trust-data — Data Quality Report")
    emit("")
    emit(f"_Generated from dataset_features.parquet at build time._")
    emit("")

    summary["row_count"] = int(len(df))
    emit(f"## Row counts")
    emit(f"- rows: **{len(df)}**")
    emit(f"- unique merchant_id: **{df['merchant_id'].nunique()}**")
    emit(f"- unique entity_key: **{df['entity_key'].nunique()}**")
    emit(f"- unique companies (registry_id): **{df['registry_id'].nunique()}**")
    emit(f"- unique root domains: **{df['domain'].nunique()}**")
    emit("")

    emit("## Entity type distribution")
    for k, v in _dist(df["entity_type"]).items():
        emit(f"- {k}: {v}")
        summary.setdefault("entity_types", {})[str(k)] = int(v)
    emit("")

    emit("## Label distribution")
    for k, v in _dist(df["label"]).items():
        emit(f"- {k}: {v}")
        summary.setdefault("labels", {})[str(k)] = int(v)
    emit("")

    emit("## Country distribution (top)")
    for k, v in _dist(df["country"].fillna("(unknown)")).items():
        emit(f"- {k}: {v}")
    emit("")

    emit("## Source distribution")
    src = df["sources"].fillna("(none)").str.split(";").explode()
    for k, v in _dist(src).items():
        emit(f"- {k}: {v}")
        summary.setdefault("sources", {})[str(k)] = int(v)
    emit("")

    emit("## Missingness (key columns)")
    emit("| column | missing % |")
    emit("|---|---|")
    miss_summary = {}
    for c in KEY_MISSING_COLS:
        if c in df.columns:
            pct = round(100 * df[c].isna().mean(), 1)
            miss_summary[c] = pct
            emit(f"| {c} | {pct}% |")
    summary["missingness_pct"] = miss_summary
    emit("")
    emit("_Note: missing = unknown/not-collected (three-state convention), never negative evidence._")
    emit("")

    dupes = int(df["entity_key"].duplicated().sum())
    emit(f"## Duplicates: {dupes} duplicate entity_key rows")
    summary["duplicate_entity_keys"] = dupes
    emit("")

    emit("## Enrichment coverage")
    for c in ["rdap_available", "dns_a_exists", "dns_mx_exists"]:
        if c in df.columns:
            known = df[c].notna().sum()
            emit(f"- {c}: known for {known}/{len(df)} rows ({round(100*known/len(df),1)}%)")
    emit("")

    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "data_quality_report.md").write_text("\n".join(lines))
    print(json.dumps(summary))


if __name__ == "__main__":
    sys.exit(main())
