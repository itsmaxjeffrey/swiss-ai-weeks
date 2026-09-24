#!/usr/bin/env python3
"""Train the prompt-injection detector on the built corpus and export a portable model.

Pipeline (RAM-safe, streaming — this host has 2GB):
  1. Pass 1 over train split: hashed document-frequency counts -> smooth IDF.
  2. Phase-A training: SGD logreg (log_loss, L2) over re-streamed, buffer-shuffled
     hashed tf-idf vectors (scipy.sparse CSR chunks).
  3. Keep-set selection: features with |w| >= --min-weight (export space).
  4. Phase-B training: identical recipe restricted to the keep-set (this is the
     exact space the deployed JS scorer uses, including the L2 norm).
  5. Threshold on val: max recall subject to FPR <= --max-fpr (restricted space).
  6. Test + cross-dataset eval (BIPIA partitions, Viseca pack benign text).
  7. Export sparse weights JSON + parity vectors + EVAL.md model card.

Feature hashing (must stay in lockstep with wallet-control/lib/injection-model.js):
  tokens: lowercase, regex [a-z0-9']+
  ngrams: 1..2 joined with a single space
  hash:   md5(ngram utf-8) hex; idx = int(h[:8],16) % 2**n_bits ; sign = +1 if
          int(h[8:16],16) % 2 == 0 else -1
  vector: sign-weighted raw counts -> x idf -> L2-normalized (over active space)
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import random
import re
import time
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.linear_model import SGDClassifier
from sklearn.metrics import roc_auc_score, average_precision_score

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CORPUS = ROOT / "data" / "intermediate" / "prompt_injection"

TOKEN_RE = re.compile(r"[a-z0-9']+")


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def ngrams(tokens: list[str]) -> list[str]:
    out = list(tokens)
    for a, b in zip(tokens, tokens[1:]):
        out.append(f"{a} {b}")
    return out


def hash_features(text: str, n_bits: int) -> dict[int, float]:
    counts: dict[int, float] = {}
    for g in ngrams(tokenize(text)):
        h = hashlib.md5(g.encode("utf-8")).hexdigest()
        idx = int(h[:8], 16) % (1 << n_bits)
        sign = 1.0 if int(h[8:16], 16) % 2 == 0 else -1.0
        counts[idx] = counts.get(idx, 0.0) + sign
    return counts


def vec_tfidf(counts: dict[int, float], idf: np.ndarray,
              keep: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    """counts -> x idf -> L2 normalize; optionally restricted to keep-set indices."""
    if keep is not None:
        counts = {i: v for i, v in counts.items() if keep[i]}
    if not counts:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float64)
    idxs = np.fromiter(counts.keys(), dtype=np.int64, count=len(counts))
    vals = np.fromiter(counts.values(), dtype=np.float64, count=len(counts))
    vals = vals * idf[idxs]
    n = math.sqrt(float((vals * vals).sum()))
    if n > 0:
        vals = vals / n
    return idxs, vals


def iter_rows(name: str):
    with gzip.open(CORPUS / f"{name}.jsonl.gz", "rt", encoding="utf-8") as f:
        for line in f:
            yield json.loads(line)


def shuffled_chunks(name: str, chunk: int, buffer_size: int, seed: int):
    rng = random.Random(seed)
    buf: list = []
    for row in iter_rows(name):
        buf.append(row)
        if len(buf) >= buffer_size:
            rng.shuffle(buf)
            for i in range(0, len(buf), chunk):
                yield buf[i:i + chunk]
            buf = []
    rng.shuffle(buf)
    for i in range(0, len(buf), chunk):
        yield buf[i:i + chunk]


def train_phase(n_bits: int, idf: np.ndarray, keep: np.ndarray | None,
                epochs: int, alpha: float, eta0: float, chunk: int, buffer: int,
                t0: float, label: str) -> SGDClassifier:
    clf = SGDClassifier(loss="log_loss", penalty="l2", alpha=alpha,
                        learning_rate="constant", eta0=eta0,
                        fit_intercept=True, random_state=42)
    classes = np.array([0, 1])
    for ep in range(epochs):
        n_seen = 0
        for rows in shuffled_chunks("train", chunk, buffer, seed=1000 + ep):
            hashed = [hash_features(r["text"], n_bits) for r in rows]
            ys = np.array([r["label"] for r in rows])
            indptr = [0]
            indices: list[int] = []
            data: list[float] = []
            for c in hashed:
                idxs, vals = vec_tfidf(c, idf, keep)
                indices.extend(idxs.tolist())
                data.extend(vals.tolist())
                indptr.append(len(indices))
            X = csr_matrix((np.array(data), np.array(indices, dtype=np.int64),
                            np.array(indptr)), shape=(len(rows), 1 << n_bits))
            clf.partial_fit(X, ys, classes=classes)
            n_seen += len(rows)
        print(f"    [{label}] epoch {ep+1}/{epochs} ({n_seen} rows, {time.time()-t0:.0f}s)", flush=True)
    return clf


def score_row(text: str, n_bits: int, idf: np.ndarray, keep: np.ndarray,
              coef: np.ndarray, intercept: float) -> float:
    idxs, vals = vec_tfidf(hash_features(text, n_bits), idf, keep)
    s = float(coef[idxs] @ vals) + intercept if len(idxs) else intercept
    return 1.0 / (1.0 + math.exp(-max(min(s, 60.0), -60.0)))


def metrics(scored: list[tuple[float, dict]], tau: float) -> dict:
    n = len(scored)
    pos_n = sum(1 for _, r in scored if r["label"] == 1)
    neg_n = n - pos_n
    tp = sum(1 for s, r in scored if r["label"] == 1 and s >= tau)
    fp = sum(1 for s, r in scored if r["label"] == 0 and s >= tau)
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / pos_n if pos_n else 0.0
    return {"n": n, "positives": pos_n, "negatives": neg_n,
            "tp": tp, "fp": fp, "precision": round(prec, 4),
            "recall": round(rec, 4), "fpr": round(fp / neg_n, 5) if neg_n else None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-bits", type=int, default=19)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--alpha", type=float, default=2e-6)
    ap.add_argument("--eta0", type=float, default=0.3)
    ap.add_argument("--chunk", type=int, default=4000)
    ap.add_argument("--buffer", type=int, default=60000)
    ap.add_argument("--max-fpr", type=float, default=0.005)
    ap.add_argument("--min-weight", type=float, default=1e-4)
    ap.add_argument("--version", default="v1")
    args = ap.parse_args()

    n_feat = 1 << args.n_bits
    t0 = time.time()

    # ---- Pass 1: document-frequency -------------------------------------------
    print("[1/6] df pass …", flush=True)
    df = np.zeros(n_feat, dtype=np.int64)
    n_docs = 0
    for row in iter_rows("train"):
        for i in hash_features(row["text"], args.n_bits):
            df[i] += 1
        n_docs += 1
    idf = np.log((1.0 + n_docs) / (1.0 + df)) + 1.0
    print(f"    {n_docs} train docs, {int((df > 0).sum())} active features, "
          f"{time.time()-t0:.0f}s", flush=True)
    del df

    # ---- Phase A: full-space training ------------------------------------------
    print("[2/6] phase-A training (full space) …", flush=True)
    clf_a = train_phase(args.n_bits, idf, None, args.epochs, args.alpha,
                        args.eta0, args.chunk, args.buffer, t0, "A")

    # ---- Keep-set ---------------------------------------------------------------
    w_a = clf_a.coef_[0]
    keep = np.abs(w_a) >= args.min_weight
    print(f"[3/6] keep-set: {int(keep.sum())}/{n_feat} features (|w| >= {args.min_weight})", flush=True)

    # ---- Phase B: restricted-space training (deployment space) ------------------
    print("[4/6] phase-B training (restricted space) …", flush=True)
    clf = train_phase(args.n_bits, idf, keep, args.epochs, args.alpha,
                      args.eta0, args.chunk, args.buffer, t0, "B")

    # ---- Threshold selection on val ---------------------------------------------
    print("[5/6] validation …", flush=True)
    val_scored = [(score_row(r["text"], args.n_bits, idf, keep, clf.coef_[0],
                             float(clf.intercept_[0])), r) for r in iter_rows("val")]
    y_val = np.array([r["label"] for _, r in val_scored])
    p_val = np.array([s for s, _ in val_scored])
    auc = roc_auc_score(y_val, p_val)
    ap = average_precision_score(y_val, p_val)
    neg = p_val[y_val == 0]
    pos = p_val[y_val == 1]

    def recall_at(fpr_target: float) -> tuple[float, float]:
        tau = float(np.quantile(neg, 1.0 - fpr_target))
        return tau, float((pos >= tau).mean())

    tau, rec = recall_at(args.max_fpr)
    print(f"    val PR-AUC {ap:.4f}  ROC-AUC {auc:.4f}")
    print(f"    tau(FPR<={args.max_fpr:.2%}) = {tau:.4f} -> recall {rec:.4f}")
    sweep = {}
    for f in (0.001, 0.002, 0.005, 0.01, 0.02):
        t, r = recall_at(f)
        sweep[f] = {"tau": round(t, 5), "recall": round(r, 4)}
        print(f"      FPR<={f:.1%}: tau {t:.4f} recall {r:.4f}")

    # ---- Test + cross-dataset eval ----------------------------------------------
    print("[6/6] test + cross-dataset eval …", flush=True)

    def score_split(name: str) -> list[tuple[float, dict]]:
        return [(score_row(r["text"], args.n_bits, idf, keep, clf.coef_[0],
                           float(clf.intercept_[0])), r) for r in iter_rows(name)]

    results = {"val": {"pr_auc": round(ap, 4), "roc_auc": round(auc, 4),
                       "tau": round(tau, 5), "recall_at_tau": round(rec, 4),
                       "fpr_sweep": sweep}}
    results["test"] = metrics(score_split("test"), tau)
    print("    test:", json.dumps(results["test"]))
    by_source: dict[str, list] = {}
    for sr in score_split("eval"):
        by_source.setdefault(sr[1]["source"], []).append(sr)
    for src, rows in sorted(by_source.items()):
        results[src] = metrics(rows, tau)
        print(f"    {src}:", json.dumps(results[src]))
    results["worst_false_positives"] = [
        {"score": round(s, 4), "text": r["text"][:160]}
        for s, r in sorted(by_source.get("viseca_pack", []), key=lambda x: x[0], reverse=True)[:12]
        if r["label"] == 0 and s >= tau]
    fn = [(s, r["text"]) for src, rows in by_source.items()
          for s, r in rows if r["label"] == 1 and s < tau]
    results["worst_false_negatives_eval"] = [
        {"score": round(s, 4), "text": t[:160]} for s, t in sorted(fn, key=lambda x: x[0])[:15]]

    # ---- Export -------------------------------------------------------------------
    coef = clf.coef_[0]
    weights = {}
    for i in np.nonzero(keep)[0]:
        gi = int(i)
        weights[str(gi)] = [round(float(idf[gi]), 5), round(float(coef[gi]), 5)]
    artifact = {
        "schema": "openclaw.injection-model/1",
        "version": args.version,
        "created": time.strftime("%Y-%m-%d"),
        "n_features": n_feat,
        "ngram_min": 1, "ngram_max": 2,
        "tokenizer": "[a-z0-9']+",
        "lowercase": True,
        "smooth_idf": True, "sublinear_tf": False, "l2_normalize": True,
        "hash": "md5; idx=int(h[:8],16)%n_features; sign=+1 if int(h[8:16],16)%2==0 else -1",
        "intercept": round(float(clf.intercept_[0]), 6),
        "threshold": round(float(tau), 6),
        "threshold_policy": f"max recall at val FPR <= {args.max_fpr}",
        "train_meta": {
            "train_docs": n_docs,
            "epochs": args.epochs, "alpha": args.alpha, "eta0": args.eta0,
            "kept_features": int(keep.sum()),
            "training_sources": ["tensortrust_raw+attacks", "tensortrust_defenses"],
            "eval_only_sources": ["bipia_directive", "bipia_benign_tasks", "viseca_pack"],
        },
        "weights": weights,
    }
    art_path = HERE / f"injection-model-{args.version}.json"
    art_path.write_text(json.dumps(artifact, separators=(",", ":")))
    deploy_path = ROOT.parent / "wallet-control" / "lib" / "injection-model.json"
    deploy_path.write_text(json.dumps(artifact, separators=(",", ":")))

    parity = []
    for r in iter_rows("val"):
        if len(parity) >= 12:
            break
        parity.append({
            "text": r["text"][:300], "label": r["label"],
            "p": round(score_row(r["text"], args.n_bits, idf, keep, clf.coef_[0],
                                 float(clf.intercept_[0])), 6),
        })
    (HERE / "parity_vectors.json").write_text(json.dumps({"parity": parity}, indent=2))
    (HERE / "EVAL.md").write_text(build_card(args, results, n_docs, int(keep.sum()), tau))
    print(f"    artifact: {art_path} ({art_path.stat().st_size/1e6:.2f} MB)")
    print(f"    deployed: {deploy_path}")
    print("done in", round(time.time() - t0), "s")


def build_card(args, results, n_docs, n_kept, tau) -> str:
    lines = [
        "# Prompt-injection detector — evaluation",
        "",
        f"Model: hashed TF-IDF (2^{args.n_bits}, uni+bi-gram, md5 hashing; {n_kept} exported features) "
        f"+ SGD logreg (L2, alpha {args.alpha}, {args.epochs} epochs).",
        f"Trained on TensorTrust only ({n_docs} docs): attacks (raw dump, 20-char/5-token filter, deduped) vs defenses.",
        "Eval-only corpora: BIPIA (hand-partitioned: directive-attacks vs benign-looking tasks) "
        "+ Viseca pack deployment-domain text.",
        "",
        f"Chosen threshold tau = {tau:.4f} (max recall at val FPR <= {args.max_fpr:.2%}).",
        "",
        "| set | n | pos | neg | precision | recall | FPR |",
        "|-----|---|-----|-----|-----------|--------|-----|",
    ]
    for name, m in results.items():
        if isinstance(m, dict) and "n" in m:
            lines.append(f"| {name} | {m['n']} | {m['positives']} | {m['negatives']} | "
                         f"{m['precision']} | {m['recall']} | {m['fpr']} |")
    lines += ["", "## Val AUCs + FPR/recall sweep", "",
              f"- PR-AUC {results['val']['pr_auc']}, ROC-AUC {results['val']['roc_auc']}"]
    for f, sr in results["val"]["fpr_sweep"].items():
        lines.append(f"- FPR<={float(f):.1%}: tau {sr['tau']} recall {sr['recall']}")
    lines += ["", "## Deployment-domain false positives (Viseca pack, score >= tau)", ""]
    for fp in results["worst_false_positives"]:
        lines.append(f"- {fp['score']}: `{fp['text']}`")
    lines += ["", "## Worst cross-dataset misses (score < tau)", ""]
    for f in results["worst_false_negatives_eval"]:
        lines.append(f"- {f['score']}: `{f['text']}`")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
