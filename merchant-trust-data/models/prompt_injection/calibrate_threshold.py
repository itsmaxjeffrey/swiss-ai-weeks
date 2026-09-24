#!/usr/bin/env python3
"""Recalibrate the deployment threshold of a trained injection-model artifact.

Training-time tau is selected on TensorTrust val negatives only (defenses +
benign names/domains). Real merchant text also includes short benign
questions/labels (BIPIA benign tasks) and product strings (Viseca pack), whose
score distributions are wider. This script re-picks tau so that the FALSE
POSITIVE RATE across the combined benign validation pool stays <= --max-fpr,
then patches both artifact copies and rewrites EVAL.md + parity vectors.

No retraining: scores are recomputed from the exported weights.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CORPUS = ROOT / "data" / "intermediate" / "prompt_injection"
WC_LIB = ROOT.parent / "wallet-control" / "lib"


def load_artifact(path: Path) -> dict:
    return json.loads(path.read_text())


def make_scorer(art: dict):
    """Artifact-faithful scorer: whole text + sliding token windows, max logit.

    Must stay in lockstep with wallet-control/lib/injection-model.js.
    """
    n_feat = art["n_features"]
    idf = np.zeros(n_feat)
    coef = np.zeros(n_feat)
    for k, (i, w) in art["weights"].items():
        idf[int(k)] = i
        coef[int(k)] = w
    keep = np.zeros(n_feat, dtype=bool)
    for k in art["weights"]:
        keep[int(k)] = True
    n_bits = int(math.log2(n_feat))
    intercept = art["intercept"]
    mode = (art.get("scoring") or {}).get("mode", "window_max")
    win = (art.get("scoring") or {}).get("window_tokens", 40)
    stride = (art.get("scoring") or {}).get("stride_tokens", 20)

    def logit_for(tokens_slice):
        counts = train.hash_features(" ".join(tokens_slice), n_bits)
        idxs, vals = train.vec_tfidf(counts, idf, keep)
        s = float(coef[idxs] @ vals) + intercept if len(idxs) else intercept
        return max(-60.0, min(60.0, s))

    def score_text(text: str) -> float:
        tokens = train.tokenize(text)
        if not tokens:
            return 1.0 / (1.0 + math.exp(-intercept))
        spans = [(0, len(tokens))]
        if mode != "full_text" and win > 0 and len(tokens) > win:
            for start in range(0, len(tokens) - win + 1, stride):
                spans.append((start, start + win))
            tail = len(tokens) - stride
            if tail > 0 and spans[-1][0] != tail:
                spans.append((tail, len(tokens)))
        best = max(logit_for(tokens[a:b]) for a, b in spans)
        return 1.0 / (1.0 + math.exp(-best))

    return score_text


# reuse the trainer's exact featurization
import importlib.util
spec = importlib.util.spec_from_file_location("train_detector", HERE / "train_detector.py")
train = importlib.util.module_from_spec(spec)
spec.loader.exec_module(train)
score_row = train.score_row


def iter_eval():
    with gzip.open(CORPUS / "eval.jsonl.gz", "rt", encoding="utf-8") as f:
        for line in f:
            yield json.loads(line)


def iter_split(name: str):
    with gzip.open(CORPUS / f"{name}.jsonl.gz", "rt", encoding="utf-8") as f:
        for line in f:
            yield json.loads(line)


def pack_challenge_texts(score):
    """Deployment ground truth: the LEASH challenge pack's own merchant texts.

    Manipulated texts come from scenarios whose control_theme/scenario_name
    mention manipulation (SCEN0004 family); all other scenarios' item_details
    and purchase_description strings count as clean.
    """
    import csv
    pack = ROOT.parent / "wallet-control" / "data" / "pack"
    with open(pack / "scenario_catalogue.csv", newline="", encoding="utf-8") as f:
        catalogue = list(csv.DictReader(f))
    manip = {r["scenario_id"] for r in catalogue
             if "manipulat" in (r.get("control_theme", "") + " " +
                                r.get("scenario_name", "")).lower()}
    with open(pack / "purchase_attempts.csv", newline="", encoding="utf-8") as f:
        attempts = list(csv.DictReader(f))
    scen_of = {r["authorization_id"]: r.get("scenario_id") for r in attempts}
    pos, neg, seen = [], [], set()

    def emit_text(text: str, scen) -> None:
        text = (text or "").strip()
        if not text or scen is None:
            return
        key = text.lower()
        if key in seen:
            return
        seen.add(key)
        (pos if scen in manip else neg).append(score(text))

    with open(pack / "purchase_attempt_items.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            emit_text(r.get("item_details"), scen_of.get(r.get("authorization_id")))
    for r in attempts:
        emit_text(r.get("purchase_description"), r.get("scenario_id"))
    return pos, neg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-fpr", type=float, default=0.005)
    ap.add_argument("--artifact", default=str(HERE / "injection-model-v2.json"))
    args = ap.parse_args()

    art = load_artifact(Path(args.artifact))
    score = make_scorer(art)
    t0 = time.time()

    # ---- combined benign validation pool --------------------------------------
    benign_scores: list[tuple[float, str]] = []  # (score, pool)
    for row in iter_split("val"):
        if row["label"] == 0:
            benign_scores.append((score(row["text"]), "tt_val_neg"))
    for row in iter_eval():
        if row["label"] == 0:
            benign_scores.append((score(row["text"]), row["source"]))
    pos_scores = [score(r["text"]) for r in iter_split("val") if r["label"] == 1]
    pos_scores += [score(r["text"]) for r in iter_split("test") if r["label"] == 1]

    all_neg = np.array([s for s, _ in benign_scores])
    # per-pool conservative policy: tau must satisfy EVERY benign pool's own
    # FPR budget; tiny pools get pinned at max+eps (a single allowed FP would
    # otherwise dominate their quantile).
    pools_all: dict[str, list[float]] = {}
    for s, pool in benign_scores:
        pools_all.setdefault(pool, []).append(s)
    tau_candidates = {}
    for pool, ss in pools_all.items():
        ss = np.array(ss)
        if len(ss) <= 100:
            tau_candidates[pool] = float(ss.max() * 1.05 + 1e-6)
        else:
            tau_candidates[pool] = float(np.quantile(ss, 1.0 - args.max_fpr))
    tau = max(tau_candidates.values())
    recall = float((np.array(pos_scores) >= tau).mean())
    print(f"benign pool: {len(all_neg)} scores | per-pool tau candidates "
          f"{ {k: round(v, 4) for k, v in tau_candidates.items()} }")
    print(f"tau {tau:.4f} | TT val+test recall {recall:.4f} | {time.time()-t0:.0f}s")

    # per-pool FPR at new tau, plus recall per attack set
    pools: dict[str, list[float]] = {}
    for s, pool in benign_scores:
        pools.setdefault(pool, []).append(s)
    report = {}
    for pool, ss in sorted(pools.items()):
        ss = np.array(ss)
        report[pool] = {"n": len(ss), "fpr_at_tau": round(float((ss >= tau).mean()), 5),
                        "p99": round(float(np.quantile(ss, 0.99)), 4),
                        "max": round(float(ss.max()), 4)}
        print(f"  {pool}: FPR {report[pool]['fpr_at_tau']}, p99 {report[pool]['p99']}, max {report[pool]['max']}")

    # cross-dataset attacks at new tau
    bipia_pos = [score(r["text"]) for r in iter_eval()
                 if r["label"] == 1 and r["source"] == "bipia_directive"]
    if bipia_pos:
        print(f"  bipia_directive recall at tau: {float((np.array(bipia_pos) >= tau).mean()):.4f}")

    # deployment ground truth: the challenge pack's own item/purchase text
    pack_pos, pack_neg = pack_challenge_texts(score)
    if pack_pos:
        pp = np.array(pack_pos)
        print(f"  challenge-pack manipulated texts: {len(pp)} rows, "
              f"recall at tau {float((pp >= tau).mean()):.4f}, "
              f"median {float(np.median(pp)):.4f}, min {float(pp.min()):.4f}")
    if pack_neg:
        pn = np.array(pack_neg)
        print(f"  challenge-pack clean texts: {len(pn)} rows, "
              f"FPR at tau {float((pn >= tau).mean()):.4f}, max {float(pn.max()):.4f}")
        report["challenge_pack_clean"] = {"n": len(pn), "fpr_at_tau": round(float((pn >= tau).mean()), 5),
                                          "max": round(float(pn.max()), 4)}
    if pack_pos:
        report["challenge_pack_manipulated"] = {"n": len(pack_pos),
                                                "recall_at_tau": round(float((np.array(pack_pos) >= tau).mean()), 4)}

    # ---- patch artifacts -------------------------------------------------------
    art["scoring"] = {"mode": "window_max", "window_tokens": 40, "stride_tokens": 20,
                      "note": "score = max(whole text, sliding token windows); defeats dilution of short embedded attacks in benign product text"}
    art["threshold"] = round(tau, 6)
    art["threshold_policy"] = (f"max recall at FPR <= {args.max_fpr:.2%} on combined benign pool "
                               f"(tt val negatives + bipia_benign_tasks + viseca_pack)")
    art["calibration"] = {"generated": time.strftime("%Y-%m-%d"),
                          "benign_pool_n": int(len(all_neg)),
                          "pools": report,
                          "tt_recall_at_tau": round(recall, 4),
                          "bipia_directive_recall_at_tau": round(float((np.array(bipia_pos) >= tau).mean()), 4) if bipia_pos else None}
    canonical = Path(args.artifact)
    canonical.write_text(json.dumps(art, separators=(",", ":")))
    (WC_LIB / "injection-model.json").write_text(json.dumps(art, separators=(",", ":")))
    print(f"patched {canonical}")
    print(f"patched {WC_LIB / 'injection-model.json'}")

    # ---- regenerate parity vectors with the same artifact -----------------------
    parity = []
    for r in iter_split("val"):
        if len(parity) >= 12:
            break
        parity.append({"text": r["text"][:300], "label": r["label"], "p": round(score(r["text"]), 6)})
    (HERE / "parity_vectors.json").write_text(json.dumps({"parity": parity}, indent=2))
    print("parity vectors regenerated")


if __name__ == "__main__":
    main()
