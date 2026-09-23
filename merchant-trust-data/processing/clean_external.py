"""External dataset cleaning pipeline (Phase-2 sources).

Cleans and normalizes the 11 external datasets collected by
collectors/{tranco,majestic,google_taxonomy,viseca,tabformer,ieee_cis,
ulb_creditcard,hackaprompt,bipia,agentdojo,tensortrust}.py.

Usage:
  python -m processing.clean_external              # all collected sources
  python -m processing.clean_external tabformer    # a single source

Memory contract (host has ~2GB available): every large file is processed
chunk-streamed (CSV chunks, bz2 line streaming, ARFF direct read); nothing
big is fully materialized in RAM.

Outputs:
  data/processed/external/<source>/...  full cleaned parquet (gitignored,
                                        reproducible via `make clean-external`)
  data/exports/external/<source>/...    compact tracked exports (csv.gz/json)
  data/exports/external/stats/*.json    per-source cleaning stats
  data/exports/external/EXTERNAL_QUALITY_REPORT.md   generated summary
"""

from __future__ import annotations

import bz2
import csv
import datetime as dt
import io
import json
import pathlib
import re
import sys
import zipfile

import numpy as np
import pandas as pd

from collectors import common

ROOT = common.ROOT
RAW = ROOT / "data" / "raw"
PEXT = ROOT / "data" / "processed" / "external"
EXPORTS = ROOT / "data" / "exports" / "external"
STATS = EXPORTS / "stats"

SEED = 42
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


def _fresh(path: pathlib.Path) -> pathlib.Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _newest(pattern: str) -> pathlib.Path | None:
    hits = sorted(RAW.glob(pattern))
    return hits[-1] if hits else None


def _bool_series(s: pd.Series) -> pd.Series:
    return s.map({"True": True, "False": False, True: True, False: False}).astype("boolean")


# ----------------------------------------------------------------- domains

def clean_tranco() -> dict:
    src = _newest("tranco/tranco_top1m_*.zip")
    if not src:
        return {"status": "missing_raw"}
    out = _fresh(PEXT / "tranco")
    with zipfile.ZipFile(src) as zf:
        with zf.open(zf.namelist()[0]) as f:
            df = pd.read_csv(f, header=None, names=["rank", "domain"])
    n_raw = len(df)
    df["domain"] = df["domain"].str.strip().str.lower()
    bad = ~df["domain"].str.match(DOMAIN_RE)
    n_bad = int(bad.sum())
    df = df[~bad]
    dup = int(df["domain"].duplicated().sum())
    df = df.drop_duplicates("domain").sort_values("rank")
    df.to_parquet(out / "tranco_top1m.parquet", index=False)
    df.to_csv(_fresh(EXPORTS / "tranco") / "tranco_top1m.csv.gz", index=False, compression="gzip")
    return {"status": "ok", "rows_raw": n_raw, "rows_clean": len(df),
            "invalid_domains": n_bad, "dup_domains": dup,
            "list_date": src.stem.removeprefix("tranco_top1m_")}


def clean_majestic() -> dict:
    src = _newest("majestic/majestic_million_*.csv")
    if not src:
        return {"status": "missing_raw"}
    out = _fresh(PEXT / "majestic")
    df = pd.read_csv(src)
    n_raw = len(df)
    df["Domain"] = df["Domain"].str.strip().str.lower()
    bad = ~df["Domain"].str.match(DOMAIN_RE)
    n_bad = int(bad.sum())
    df = df[~bad].drop_duplicates("Domain")
    keep = ["GlobalRank", "TldRank", "Domain", "TLD", "RefSubNets", "RefIPs",
            "PrevGlobalRank", "PrevTldRank", "PrevRefSubNets", "PrevRefIPs"]
    df = df[keep].astype({c: "int64" for c in keep if c not in ("Domain", "TLD")})
    df.to_parquet(out / "majestic_million.parquet", index=False)
    df.to_csv(_fresh(EXPORTS / "majestic") / "majestic_million.csv.gz",
              index=False, compression="gzip")
    return {"status": "ok", "rows_raw": n_raw, "rows_clean": len(df),
            "invalid_domains": n_bad}


def clean_google_taxonomy() -> dict:
    src = _newest("google_taxonomy/taxonomy_en-US_*.txt")
    if not src:
        return {"status": "missing_raw"}
    rows = []
    for line in src.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        tid, _, path = line.partition(" - ")
        if not tid.isdigit():
            continue
        parts = [p.strip() for p in path.split(" > ")]
        rows.append({"taxonomy_id": int(tid), "path": path, "depth": len(parts), **{
            f"level_{i+1}": parts[i] if i < len(parts) else None for i in range(5)}})
    df = pd.DataFrame(rows)
    df.to_parquet(_fresh(PEXT / "google_taxonomy") / "google_product_taxonomy.parquet", index=False)
    df.to_csv(_fresh(EXPORTS / "google_taxonomy") / "google_product_taxonomy.csv", index=False)
    return {"status": "ok", "rows": len(df), "max_depth": int(df["depth"].max()),
            "distinct_l1": int(df["level_1"].nunique())}


# ------------------------------------------------------------------ viseca

def _viseca_clean_table(df: pd.DataFrame) -> pd.DataFrame:
    for c in df.columns:
        if c == "timestamp":
            df[c] = pd.to_datetime(df[c], utc=True, errors="coerce")
            continue
        vals = df[c].dropna().unique()[:8]
        if all(isinstance(v, str) and v in ("true", "false") for v in vals) and len(vals):
            df[c] = df[c].map({"true": True, "false": False}).astype("boolean")
        elif all(isinstance(v, str) and re.fullmatch(r"-?\d+(\.\d+)?", v or "x") for v in vals) and len(vals):
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.convert_dtypes()


def clean_viseca() -> dict:
    data_dir = next((RAW / "viseca" / "extracted").glob("*/data"), None)
    if not data_dir:
        return {"status": "missing_raw"}
    out = _fresh(PEXT / "viseca")
    exp = _fresh(EXPORTS / "viseca")
    # integrity: verify extracted CSVs against the pack's own sha256 manifest
    meta = json.loads((data_dir / "metadata.json").read_text())
    hashes = {f["path"]: f.get("sha256") for f in meta.get("files", []) if f.get("format") == "csv"}
    import hashlib
    verified, mismatched = 0, []
    for rel, want in hashes.items():
        p = data_dir / rel
        if not p.exists():
            mismatched.append(f"{rel}: missing")
            continue
        got = hashlib.sha256(p.read_bytes()).hexdigest()
        if got == want:
            verified += 1
        else:
            mismatched.append(rel)
    stats: dict = {"status": "ok", "sha256_verified": verified,
                   "sha256_mismatch": mismatched, "tables": {}}
    for p in sorted(data_dir.glob("*.csv")):
        df = _viseca_clean_table(pd.read_csv(p))
        name = p.stem
        df.to_parquet(out / f"{name}.parquet", index=False)
        df.to_csv(exp / f"{name}.csv.gz", index=False, compression="gzip")
        stats["tables"][name] = {"rows": len(df), "cols": int(df.shape[1])}
    return stats


# --------------------------------------------------------------- tabformer

_TAB_SCHEMA = {
    "User": "int16", "Card": "int16", "Year": "int16", "Month": "int8", "Day": "int8",
    "Time": "string", "Amount": "string", "Use Chip": "string",
    "Merchant Name": "string", "Merchant City": "string", "Merchant State": "string",
    "Zip": "string", "MCC": "string", "Errors?": "string", "Is Fraud?": "string",
}


def clean_tabformer() -> dict:
    import tarfile
    import pyarrow as pa
    import pyarrow.parquet as pq

    src = RAW / "tabformer" / "tabformer_transactions.tgz"
    if not src.exists():
        return {"status": "missing_raw"}
    out_dir = _fresh(PEXT / "tabformer")
    csv_path = out_dir / "card_transaction.v1.csv"
    if not csv_path.exists():
        with tarfile.open(src, "r:gz") as tf:
            tf.extractall(out_dir, filter="data")

    cols = list(_TAB_SCHEMA)
    fraud_rate_warn = []
    stats = {"status": "ok", "rows": 0, "frauds": 0, "nulls_errors": 0,
             "users": set(), "years": set(), "use_chip": {}}
    rng = np.random.default_rng(SEED)
    samples: list[pd.DataFrame] = []
    writer = None
    target = out_dir / "tabformer_clean.parquet"
    try:
        for chunk in pd.read_csv(csv_path, chunksize=500_000, dtype=_TAB_SCHEMA,
                                 na_values=[""], keep_default_na=True):
            chunk["Amount"] = (chunk["Amount"].astype("string").str.replace("$", "", regex=False)
                               .astype("float32"))
            fraud = (chunk["Is Fraud?"] == "Yes")
            stats["rows"] += len(chunk)
            stats["frauds"] += int(fraud.sum())
            stats["nulls_errors"] += int(chunk["Errors?"].isna().sum())
            stats["users"].update(pd.unique(chunk["User"]).tolist())
            stats["years"].update(pd.unique(chunk["Year"]).tolist())
            for k, v in chunk["Use Chip"].value_counts().items():
                stats["use_chip"][k] = stats["use_chip"].get(k, 0) + int(v)
            clean = chunk.copy()
            clean["Is Fraud?"] = fraud.astype("int8")
            table = pa.Table.from_pandas(clean, preserve_index=False)
            if writer is None:
                writer = pq.ParquetWriter(target, table.schema, compression="zstd")
            writer.write_table(table)
            # stratified sample: all frauds + ~0.5% of legit rows (cap 120k)
            legit = clean[~fraud]
            take = legit.loc[rng.random(len(legit)) < 0.005]
            samples.append(clean[fraud])
            samples.append(take)
    finally:
        if writer:
            writer.close()

    sample = pd.concat(samples, ignore_index=True)
    if len(sample) > 130_000:
        sample = sample.iloc[rng.choice(len(sample), 130_000, replace=False)]
    sample.to_csv(_fresh(EXPORTS / "tabformer") / "tabformer_sample.csv.gz",
                  index=False, compression="gzip")
    csv_path.unlink()  # 2.7GB intermediate; tgz stays cached in raw/
    if stats["rows"] and stats["frauds"] / stats["rows"] > 0.02:
        fraud_rate_warn.append("fraud rate implausible — verify parse")
    return {"status": "ok", "rows": stats["rows"], "frauds": stats["frauds"],
            "fraud_rate": round(stats["frauds"] / max(stats["rows"], 1), 6),
            "unique_users": len(stats["users"]),
            "years": f"{min(stats['years'])}-{max(stats['years'])}" if stats["years"] else None,
            "nulls_errors": stats["nulls_errors"], "use_chip": stats["use_chip"],
            "sample_rows": len(sample), "warnings": fraud_rate_warn}


# ---------------------------------------------------------------- ieee-cis

def clean_ieee_cis() -> dict:
    import pyarrow as pa
    import pyarrow.parquet as pq

    tx = RAW / "ieee_cis" / "ieee_cis_train_transaction.csv"
    ident = RAW / "ieee_cis" / "ieee_cis_train_identity.csv"
    if not tx.exists():
        return {"status": "missing_raw"}

    # identity is small (144k x 41): load once, downcast, merge per chunk
    idf = pd.read_csv(ident)
    id_obj = {c: "float32" for c in idf.columns if c.startswith("id_") and
              pd.api.types.is_numeric_dtype(idf[c])}
    idf = idf.astype(id_obj)
    for c in idf.columns:
        if c not in ("TransactionID",) and not pd.api.types.is_numeric_dtype(idf[c]):
            mcol = idf[c].map({"T": True, "F": False, "True": True, "False": False})
            if mcol.notna().mean() > 0.9:  # T/F-typed strings -> boolean
                idf[c] = mcol.astype("boolean")
    for c in ("id_01", "id_02", "id_03", "id_05"):
        if c in idf:  # spot null-rate stats
            pass

    vcols = [f"V{i}" for i in range(1, 340)]
    ccols = [f"C{i}" for i in range(1, 15)]
    dcols = [f"D{i}" for i in range(1, 16)]
    mcols = [f"M{i}" for i in range(1, 10)]
    out_dir = _fresh(PEXT / "ieee_cis")
    writer = None
    stats = {"rows": 0, "frauds": 0, "with_identity": 0, "null_V": 0}
    rng = np.random.default_rng(SEED)
    samples: list[pd.DataFrame] = []
    target = out_dir / "ieee_cis_train_clean.parquet"
    try:
        for chunk in pd.read_csv(tx, chunksize=100_000):
            stats["rows"] += len(chunk)
            chunk["isFraud"] = chunk["isFraud"].astype("int8")
            stats["frauds"] += int(chunk["isFraud"].sum())
            for c in vcols + ccols + dcols + ["addr1", "addr2", "dist1", "dist2",
                                              "TransactionAmt"]:
                if c in chunk:
                    chunk[c] = chunk[c].astype("float32")
            stats["null_V"] += int(chunk[vcols].isna().any(axis=1).sum())
            for c in mcols:
                if c in chunk:
                    chunk[c] = chunk[c].map({"T": True, "F": False}).astype("boolean")
            merged = chunk.merge(idf, on="TransactionID", how="left")
            stats["with_identity"] += int(merged["id_01"].notna().sum() if "id_01" in merged else 0)
            table = pa.Table.from_pandas(merged, preserve_index=False)
            if writer is None:
                writer = pq.ParquetWriter(target, table.schema, compression="zstd")
            writer.write_table(table)
            fraud = merged["isFraud"] == 1
            samples.append(merged[fraud])
            legit = merged[~fraud]
            samples.append(legit.loc[rng.random(len(legit)) < 0.05])
    finally:
        if writer:
            writer.close()

    sample = pd.concat(samples, ignore_index=True)
    sample.to_csv(_fresh(EXPORTS / "ieee_cis") / "ieee_cis_train_sample.csv.gz",
                  index=False, compression="gzip")
    expected = {"rows": 590540, "frauds": 20663}  # verified vs Kaggle kernels: isFraud 0:569877, 1:20663
    checks = {
        "rows_ok": stats["rows"] == expected["rows"],
        "frauds_ok": stats["frauds"] == expected["frauds"],
    }
    return {"status": "ok", **stats, "expected": expected,
            "integrity_checks": checks,
            "fraud_rate": round(stats["frauds"] / max(stats["rows"], 1), 6),
            "sample_rows": len(sample)}


# ------------------------------------------------------------- ulb (OpenML)

def clean_ulb_creditcard() -> dict:
    src = _newest("ulb_creditcard/ulb_creditcard_*.arff")
    if not src:
        return {"status": "missing_raw"}
    names: list[str] = []
    with src.open(encoding="utf-8", errors="replace") as f:
        header_lines = 0
        for line in f:
            header_lines += 1
            s = line.strip().lower()
            if s.startswith("@attribute"):
                names.append(line.split()[1])
            elif s.startswith("@data"):
                break
    df = pd.read_csv(src, skiprows=header_lines, header=None, names=names, quotechar="'")
    n_raw = len(df)
    dup = int(df.duplicated().sum())
    df["Class"] = df["Class"].astype("int8")
    df["Amount"] = df["Amount"].astype("float32")
    df.to_parquet(_fresh(PEXT / "ulb_creditcard") / "ulb_creditcard_clean.parquet", index=False)
    fraud = df[df["Class"] == 1]
    legit = df[df["Class"] == 0].sample(min(20_000, (df["Class"] == 0).sum()),
                                        random_state=SEED)
    pd.concat([fraud, legit]).to_csv(
        _fresh(EXPORTS / "ulb_creditcard") / "ulb_creditcard_fraud_plus_sample.csv.gz",
        index=False, compression="gzip")
    checks = {"rows_ok": n_raw == 284807, "frauds_ok": int((df["Class"] == 1).sum()) == 492}
    return {"status": "ok", "rows": n_raw, "duplicates_kept": dup,
            "frauds": int((df["Class"] == 1).sum()),
            "fraud_rate": round(float((df["Class"] == 1).mean()), 6),
            "integrity_checks": checks}


# ------------------------------------------------------------------ bipia

def clean_bipia() -> dict:
    bench = next((RAW / "bipia" / "extracted").glob("*/benchmark"), None)
    if not bench:
        return {"status": "missing_raw"}
    rows: list[dict] = []

    def add_text_attacks(path: pathlib.Path, domain: str):
        data = json.loads(path.read_text())
        split = "train" if "train" in path.name else "test"
        for attack_type, texts in data.items():
            for t in texts:
                rows.append({"domain": domain, "split": split, "attack_type": attack_type,
                             "kind": "attack_text", "text": t, "ideal": None})

    for name in ("text_attack_train.json", "text_attack_test.json"):
        add_text_attacks(bench / name, "text")
    for name in ("code_attack_train.json", "code_attack_test.json"):
        add_text_attacks(bench / name, "code")

    per_domain_counts = {}
    for sub in ("qa", "email", "table", "code"):
        d = bench / sub
        if not d.exists():
            continue
        for split in ("train", "test"):
            p = d / f"{split}.jsonl"
            if not p.exists():
                continue
            n = 0
            with p.open() as f:
                for line in f:
                    if not line.strip():
                        continue
                    rec = json.loads(line)
                    n += 1
                    rows.append({"domain": sub, "split": split, "attack_type": None,
                                 "kind": "context_pair",
                                 "text": str(rec.get("context", ""))[:8000],
                                 "ideal": str(rec.get("ideal", ""))[:500]})
            per_domain_counts[f"{sub}.{split}"] = n

    df = pd.DataFrame(rows)
    df.to_parquet(_fresh(PEXT / "bipia") / "bipia_benchmark.parquet", index=False)
    attacks = df[df["kind"] == "attack_text"][["domain", "split", "attack_type", "text"]]
    attacks.to_csv(_fresh(EXPORTS / "bipia") / "bipia_attack_texts.csv.gz",
                   index=False, compression="gzip")
    return {"status": "ok", "rows": len(df), "attack_texts": len(attacks),
            "context_pairs": per_domain_counts}


# --------------------------------------------------------------- agentdojo

def clean_agentdojo() -> dict:
    root = RAW / "agentdojo" / "extracted" / "agentdojo-main"
    if not root.exists():
        return {"status": "missing_raw"}
    out = _fresh(PEXT / "agentdojo")
    runs = root / "runs"
    results: list[dict] = []
    files = sorted(runs.glob("*/*/*/*/*.json"))
    for p in files:
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        results.append({
            "model": p.relative_to(runs).parts[0],
            "suite": d.get("suite_name") or p.relative_to(runs).parts[1],
            "task_id": d.get("user_task_id") or p.relative_to(runs).parts[2],
            "injection_task_id": d.get("injection_task_id"),
            "attack_type": d.get("attack_type") or p.relative_to(runs).parts[3],
            "attack_technique": p.stem,
            "utility": d.get("utility"),
            "security": d.get("security"),
            "error": d.get("error"),
            "duration_s": d.get("duration"),
        })
    rdf = pd.DataFrame(results)
    rdf.to_parquet(out / "agentdojo_benchmark_results.parquet", index=False)
    rdf.to_csv(_fresh(EXPORTS / "agentdojo") / "agentdojo_benchmark_results.csv.gz",
               index=False, compression="gzip")

    # suites inventory: user tasks + injection vectors per suite version
    inv = []
    for p in sorted((root / "src" / "agentdojo" / "default_suites").rglob("*.py")):
        rel = p.relative_to(root / "src" / "agentdojo" / "default_suites")
        inv.append({"suite_version": rel.parts[0], "suite": rel.parts[1] if len(rel.parts) > 1 else None,
                    "file": str(rel), "kind": "injections" if "injection" in p.name else "tasks"})
    (out / "suites_inventory.jsonl").write_text(
        "\n".join(json.dumps(r) for r in inv))
    (_fresh(EXPORTS / "agentdojo") / "suites_inventory.jsonl").write_text(
        "\n".join(json.dumps(r) for r in inv))

    util = pd.to_numeric(rdf["utility"], errors="coerce")
    sec = pd.to_numeric(rdf["security"], errors="coerce")
    return {"status": "ok", "result_files": len(rdf), "models": int(rdf["model"].nunique()),
            "suites": sorted(rdf["suite"].dropna().unique().tolist()),
            "utility_true_rate": round(float(util.mean()), 4) if len(rdf) else None,
            "security_true_rate": round(float(sec.mean()), 4) if len(rdf) else None,
            "suite_files": len(inv)}


# -------------------------------------------------------------- tensortrust

import pyarrow as pa
import pyarrow.parquet as pq

_TT_ATTACKS_SCHEMA = pa.schema([
    ("attack_id", pa.int64()), ("attacker_id_anonymized", pa.int64()),
    ("defender_id_anonymized", pa.int64()), ("defense_id", pa.int64()),
    ("attacker_balance_before", pa.float64()), ("defender_balance_before", pa.float64()),
    ("attacker_balance_gain", pa.int64()), ("defender_balance_gain", pa.int64()),
    ("opening_defense", pa.string()), ("attacker_input", pa.string()),
    ("closing_defense", pa.string()), ("access_code", pa.string()),
    ("llm_choice", pa.string()), ("llm_output", pa.string()),
    ("output_is_access_granted", pa.bool_()), ("is_self_attack", pa.bool_()),
    ("timestamp", pa.string()),
])
_TT_DEFENSES_SCHEMA = pa.schema([
    ("defense_id", pa.int64()), ("defender_id_anonymized", pa.int64()),
    ("opening_defense", pa.string()), ("closing_defense", pa.string()),
    ("access_code", pa.string()), ("llm_choice", pa.string()),
    ("llm_output", pa.string()), ("output_is_access_granted", pa.bool_()),
    ("timestamp", pa.string()),
])


def _tt_coerce(v, dtype):
    if v is None or (isinstance(v, str) and v.strip() in ("", "nan", "None")):
        return None
    try:
        if pa.types.is_boolean(dtype):
            return v if isinstance(v, bool) else str(v).strip().lower() == "true"
        if pa.types.is_integer(dtype):
            return int(float(v))
        if pa.types.is_floating(dtype):
            return float(v)
        return str(v)
    except (TypeError, ValueError):
        return None


def _tt_clean_stream(bz2_path: pathlib.Path, target: pathlib.Path,
                     schema: pa.Schema) -> tuple[int, pd.DataFrame]:
    """Stream a Tensor Trust raw jsonl.bz2 dump into a typed parquet file.

    Raw values arrive as JSON strings ("True"/"nan"/"1234"); every field is
    coerced to an explicit schema so leading nulls can't poison inference.
    """
    writer = pq.ParquetWriter(target, schema, compression="zstd")
    n = 0
    samples: list[dict] = []
    sample_rng = np.random.default_rng(SEED)
    batch: list[dict] = []
    names = [f.name for f in schema]
    with bz2.open(bz2_path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            clean = {name: _tt_coerce(rec.get(name), schema.field(name).type)
                     for name in names}
            batch.append(clean)
            n += 1
            if len(batch) >= 5_000:
                writer.write_table(pa.Table.from_pylist(batch, schema=schema))
                batch = []
            if sample_rng.random() < 0.05 and len(samples) < 15_000:
                samples.append({k: (str(v)[:200] if isinstance(v, str) else v)
                                for k, v in clean.items()})
    if batch:
        writer.write_table(pa.Table.from_pylist(batch, schema=schema))
    writer.close()
    return n, pd.DataFrame(samples)


def clean_tensortrust() -> dict:
    out = _fresh(PEXT / "tensortrust")
    exp = _fresh(EXPORTS / "tensortrust")
    attacks_raw = RAW / "tensortrust" / "raw-data__v2__raw_dump_attacks.jsonl.bz2"
    defenses_raw = RAW / "tensortrust" / "raw-data__v2__raw_dump_defenses.jsonl.bz2"
    stats: dict = {"status": "ok"}
    if attacks_raw.exists():
        n, sample = _tt_clean_stream(attacks_raw, out / "attacks_v2_clean.parquet",
                                     _TT_ATTACKS_SCHEMA)
        sample.to_csv(exp / "tensortrust_attacks_sample.csv.gz", index=False, compression="gzip")
        granted = sample["output_is_access_granted"]
        stats["attacks"] = {"rows": n, "sample_rows": len(sample),
                            "granted_rate_sample": round(float(granted.mean()), 4)}
    if defenses_raw.exists():
        n, sample = _tt_clean_stream(defenses_raw, out / "defenses_v2_clean.parquet",
                                     _TT_DEFENSES_SCHEMA)
        sample.to_csv(exp / "tensortrust_defenses_sample.csv.gz", index=False, compression="gzip")
        stats["defenses"] = {"rows": n, "sample_rows": len(sample)}
    for rel in ("benchmarks__hijacking-robustness__v1__hijacking_robustness_dataset.jsonl",
                "benchmarks__extraction-robustness__v1__extraction_robustness_dataset.jsonl",
                "detecting-extractions__v1__prompt_extraction_detection.jsonl"):
        src = RAW / "tensortrust" / rel
        if src.exists():
            n = sum(1 for line in src.open() if line.strip())
            import shutil
            shutil.copy(src, exp / rel.replace("__", "/").replace("/", "_"))
            stats.setdefault("benchmarks", {})[rel] = n
    return stats


# -------------------------------------------------------------- hackaprompt

def clean_hackaprompt() -> dict:
    blocked = _newest("hackaprompt/blocked_*.json")
    if blocked:
        return {"status": "blocked", "reason": json.loads(blocked.read_text())["reason"]}
    src = RAW / "hackaprompt" / "hackaprompt.parquet"
    if not src.exists():
        return {"status": "missing_raw"}
    df = pd.read_parquet(src)
    df.to_parquet(_fresh(PEXT / "hackaprompt") / "hackaprompt_clean.parquet", index=False)
    return {"status": "ok", "rows": len(df), "cols": int(df.shape[1])}


# -------------------------------------------------------------------- main

CLEANERS = {
    "tranco": clean_tranco,
    "majestic": clean_majestic,
    "google_taxonomy": clean_google_taxonomy,
    "viseca": clean_viseca,
    "tabformer": clean_tabformer,
    "ieee_cis": clean_ieee_cis,
    "ulb_creditcard": clean_ulb_creditcard,
    "bipia": clean_bipia,
    "agentdojo": clean_agentdojo,
    "tensortrust": clean_tensortrust,
    "hackaprompt": clean_hackaprompt,
}

_LICENSES = {
    "tranco": "Tranco (research, attribution)",
    "majestic": "Majestic Million (attribution)",
    "google_taxonomy": "Google Merchant product taxonomy",
    "viseca": "Viseca public synthetic pack (SYNTHETIC TEST DATA)",
    "tabformer": "IBM TabFormer synthetic credit-card transactions (research)",
    "ieee_cis": "IEEE-CIS Fraud Detection via public HF mirror (competition data; unofficial mirror)",
    "ulb_creditcard": "ULB Credit Card Fraud via OpenML did 1597",
    "bipia": "Microsoft BIPIA (MIT)",
    "agentdojo": "AgentDojo (ETH; MIT)",
    "tensortrust": "Tensor Trust (HumanCompatibleAI; permissive)",
    "hackaprompt": "HackAPrompt (MIT; gated access)",
}


def write_report(all_stats: dict[str, dict]) -> None:
    lines = [
        "# External data quality report",
        "",
        f"Generated: {common.utcnow()} · cleaner: processing/clean_external.py · "
        f"raw cached in data/raw/<source>/ with provenance sidecars.",
        "",
        "| source | status | key numbers | license |",
        "|---|---|---|---|",
    ]
    for src, st in all_stats.items():
        key = {k: v for k, v in st.items()
               if k not in ("status",) and not isinstance(v, (dict, list)) and v is not None}
        # flatten one level of nested stat dicts (e.g. tensortrust attacks/defenses)
        for k, v in st.items():
            if isinstance(v, dict):
                for k2, v2 in v.items():
                    if not isinstance(v2, (dict, list)) and v2 is not None:
                        key[f"{k}.{k2}"] = v2
        keys = "; ".join(f"{k}={v}" for k, v in list(key.items())[:9])
        extra = ""
        if st.get("integrity_checks") is not None:
            ok = all(st["integrity_checks"].values())
            extra = " integrity=" + ("PASS" if ok else "FAIL")
        lines.append(f"| {src} | {st.get('status','?')}{extra} | {keys} | {_LICENSES[src]} |")
    if all_stats.get("hackaprompt", {}).get("status") == "blocked":
        lines += ["",
                  "**HackAPrompt is gated on Hugging Face** (auto-approved terms). "
                  "Export `LEASH_HF_TOKEN` with accepted terms, then rerun "
                  "`make collect-external SRC=hackaprompt` and `make clean-external SRC=hackaprompt`."]
    lines += ["",
              "Full cleaned parquet: `data/processed/external/<source>/` (gitignored, reproducible). "
              "Tracked exports: `data/exports/external/<source>/` (samples / compact full sets).",
              "",
              "Integrity semantics: `integrity=PASS` verifies publisher-published constants "
              "(IEEE-CIS 590,540 rows / 20,663 frauds — expected count corrected from 20,661 after "
              "the mirror matched published Kaggle kernel value-counts exactly; ULB 284,807 rows / "
              "492 frauds; Viseca sha256 vs pack manifest).",
              ]
    (_fresh(EXPORTS) / "EXTERNAL_QUALITY_REPORT.md").write_text("\n".join(lines) + "\n")


def main(argv: list[str]) -> int:
    sources = argv or list(CLEANERS)
    all_stats: dict[str, dict] = {}
    if (EXPORTS / "stats").exists():
        for p in (EXPORTS / "stats").glob("*.json"):
            all_stats[p.stem] = json.loads(p.read_text())
    for src in sources:
        if src not in CLEANERS:
            print(f"unknown source: {src}", file=sys.stderr)
            return 2
        print(f"[clean] {src} ...", file=sys.stderr, flush=True)
        try:
            st = CLEANERS[src]()
        except Exception as e:  # noqa: BLE001 — report and continue
            st = {"status": "error", "error": f"{type(e).__name__}: {e}"}
        all_stats[src] = st
        _fresh(STATS).joinpath(f"{src}.json").write_text(json.dumps(st, indent=2, default=str))
        print(json.dumps({"source": src, "status": st.get("status")}), file=sys.stderr, flush=True)
    write_report(all_stats)
    print(json.dumps({"cleaned": sources, "report": str(EXPORTS / 'EXTERNAL_QUALITY_REPORT.md')}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
