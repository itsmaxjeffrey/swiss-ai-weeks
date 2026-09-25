#!/usr/bin/env python3
"""Train the LEASH user-behavior model on the Viseca-2026 challenge data pack.

Learns per-customer spending behavior from data/pack/authorization_history.csv
(the challenge pack's 4,565 purchase rows, 2025-09..2026-07) and exports:

  behavior-model.json   canonical artifact (tracked)
  parity_vectors.json   JS/Python parity cases (tracked)
  EVAL.md               training/calibration report

HONEST SCOPE (read this): the pack's historical `status` is the authorization
outcome observed at the time -- it is NOT a fraud label and NOT an answer key
for the 45 purchase attempts (pack README says so explicitly). This model is a
*behavioral-deviation prior*: features describe how different a purchase is
from the customer's own past behavior; the classifier is trained on the past
outcome (declined vs approved) purely to weight those deviations. At decision
time the deployed scorer is ADVISORY ONLY: it may add evidence/uncertainty and
escalate to the customer, never approve, decline, or loosen anything on its
own (same contract as the prompt-injection detector).

Feature contract (identical in wallet-control/lib/behavior-model.js; asserted
by wallet-control/test/behavior-model.test.js against parity_vectors.json):

  All features are chronology-safe: when featurizing a HISTORY row, only
  strictly-earlier rows of the same customer feed the baselines. At inference
  the profile contains the full history (which is entirely in the past relative
  to live attempts: history ends 2026-07-31, attempts start 2026-08-09).

  0  log_amount_z      (log1p(amount_chf) - mean_prior) / std_prior
                       over prior APPROVED purchases; 0 when < 3 priors;
                       std floored at 0.25
  1  amount_p95_ratio  amount_chf / p95(prior approved amounts), capped 10;
                       0 when < 10 priors
  2  merchant_log_count    log1p(prior approved count at this merchant_id)
  3  merchant_unfamiliar   1 when that count is 0
  4  category_unfamiliar   1 when merchant_category never approved before
  5  country_unfamiliar    1 when merchant_country never approved before
  6  channel_unfamiliar    1 when channel never approved before
  7  currency_unfamiliar   1 when currency never in prior approved purchases
  8  device_unfamiliar     1 when customer_device_id never approved before
  9  hour_unobserved       1 when UTC hour never in prior approved purchases
  10 velocity_10m         min(3, prior same-card purchase attempts in 600 s);
                          at inference: event.recent_attempt_count_10m capped 3
  11 customer_log_total   log1p(total prior approved purchases)
  12 night_hour           1 when UTC hour is in 21:00-06:59 (generic night
                          window, NOT personalized; 0 when hour unreadable)
  13 log_item_qty_max     log1p(max line quantity in the basket); 0 when the
                          event carries no item lines. Zero-variance in the
                          history training rows (authorization_history has no
                          item lines), so it ships with weight exactly 0 and
                          only gains weight when retrained on data with real
                          quantity variance.
  14 qty_over_class_cap   1 when the max line quantity exceeds the category's
                          plausible cap (CATEGORY_CLASS/BASE_CAPS below,
                          mirrored in wallet-control/lib/item-classes.js;
                          raised to 3x the customer's observed per-category
                          max when profile.qty_max_by_category has data)

  p95 uses nearest-rank: sorted[idx], idx = clamp(ceil(0.95*n)-1, 0, n-1).

Model: standardized features, L2 logistic regression (class-balanced), pure
numpy Adam, seed 20260924. L2 3e-2 tuned by leave-one-customer-out sweep
(experiment.py, 2026-09-24: LOCO plateaus 0.7844-0.7850 for l2 3e-3..1e-1 on
the v1+night feature set; 1e-3 leaves ~0.4pt on the table, 1.0 over-shrinks).
Calibration: escalation threshold = 97th percentile of approved-history
probabilities (~3% friction on known-good activity); suspect band =
min(0.5, escalate * 0.55) mirroring the injection model.

Usage: python3 train_behavior.py [--pack ../../wallet-control/data/pack]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import platform
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

SEED = 20260924
NIGHT_HOURS = frozenset({21, 22, 23, 0, 1, 2, 3, 4, 5, 6})

# Category-conditional basket-quantity plausibility — mirrors
# wallet-control/lib/item-classes.js (keep the two in lockstep).
CATEGORY_CLASS = {
    "bulk": ("groceries", "household", "home_improvement"),
    "gift": ("gift_card", "subscriptions", "membership"),
    "finite": ("clothing", "electronics", "sporting_goods", "cosmetics", "books"),
    "service": ("dining", "food_delivery", "fuel", "hotel", "transport"),
}
BASE_CAPS = {"bulk": 500.0, "gift": 2.0, "finite": 12.0, "service": 20.0}
_CLASS_OF = {cat: cls for cls, cats in CATEGORY_CLASS.items() for cat in cats}


def base_qty_cap(category):
    return BASE_CAPS[_CLASS_OF.get(str(category or "").strip().lower(), "finite")]


def qty_cap(category, qty_max_by_category):
    """Adaptive cap: class base, or 3x the customer's observed per-category max."""
    base = base_qty_cap(category)
    observed = float((qty_max_by_category or {}).get(category, 0) or 0)
    return max(base, 3.0 * observed)


def qty_features(items, qty_max_by_category):
    """Features 13-14: log max line quantity + over-cap flag (mirrors JS scorer)."""
    max_qty, worst_cat = 0.0, None
    for it in (items or []):
        try:
            q = float(it.get("quantity", 1) or 1)
        except (TypeError, ValueError):
            q = 1.0
        q = max(1.0, q)
        if q > max_qty:
            max_qty, worst_cat = q, (it.get("item_category") or it.get("category"))
    if max_qty <= 0:
        return 0.0, 0.0
    return (math.log1p(max_qty),
            1.0 if max_qty > qty_cap(worst_cat, qty_max_by_category) else 0.0)
FEATURES = [
    "log_amount_z", "amount_p95_ratio", "merchant_log_count", "merchant_unfamiliar",
    "category_unfamiliar", "country_unfamiliar", "channel_unfamiliar",
    "currency_unfamiliar", "device_unfamiliar", "hour_unobserved",
    "velocity_10m", "customer_log_total", "night_hour",
    "log_item_qty_max", "qty_over_class_cap",
]
FEATURE_LABELS = {
    "log_amount_z": "amount far outside your usual range",
    "amount_p95_ratio": "larger than 95% of your past purchases",
    "merchant_log_count": "little history at this shop",
    "merchant_unfamiliar": "shop you have never bought from",
    "category_unfamiliar": "product category you never buy",
    "country_unfamiliar": "seller country you never bought from",
    "channel_unfamiliar": "purchase channel you never use",
    "currency_unfamiliar": "currency you never spend",
    "device_unfamiliar": "device never seen in your history",
    "hour_unobserved": "hour of day you never buy at",
    "velocity_10m": "burst of attempts within 10 minutes",
    "customer_log_total": "little overall history",
    "night_hour": "purchase in the middle of the night",
    "log_item_qty_max": "unusually large quantity of one basket line",
    "qty_over_class_cap": "quantity beyond what is plausible for this product type",
}

SCHEMA = "openclaw.behavior-model/1"


def p95_nearest_rank(sorted_vals):
    n = len(sorted_vals)
    if n == 0:
        return None
    idx = min(n - 1, max(0, math.ceil(0.95 * n) - 1))
    return sorted_vals[idx]


def parse_ts(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Pack loading
# ---------------------------------------------------------------------------

def load_pack(pack_dir: Path):
    def rows(name):
        with open(pack_dir / name, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))

    history = rows("authorization_history.csv")
    merchants = {m["merchant_id"]: m for m in rows("merchants.csv")}
    attempts = rows("purchase_attempts.csv")
    # attempts carry only merchant_id: join the merchant catalogue exactly like
    # the live platform event does (merchant_category/country are required
    # authorization fields; parity + friction checks must see them)
    items_by_auth = {}
    for it in rows("purchase_attempt_items.csv"):
        items_by_auth.setdefault(it["authorization_id"], []).append(
            {"item_name": it.get("item_name"), "item_category": it.get("item_category"),
             "quantity": it.get("quantity")})
    attempts = [{**a,
                 "merchant_category": merchants.get(a["merchant_id"], {}).get("merchant_category"),
                 "merchant_country": merchants.get(a["merchant_id"], {}).get("merchant_country"),
                 "items": items_by_auth.get(a["authorization_id"], [])}
                for a in attempts]
    return history, attempts


def extract_examples(history):
    """Per-customer chronologically sorted purchase rows + chronology-safe features.

    Returns (examples, profiles) where examples = list of dicts with feature
    vectors from PRIOR-rows-only baselines, and profiles = per-customer
    FULL-history baselines (for inference).
    """
    purchases = [r for r in history if r["transaction_type"] == "purchase"]
    purchases.sort(key=lambda r: (r["timestamp"], r["authorization_id"]))

    # running per-customer baselines from strictly-prior APPROVED rows
    run = {}  # customer -> dict of accumulators
    examples = []
    for r in purchases:
        cust = r["customer_id"]
        st = run.setdefault(cust, {
            "amounts": [], "log_amounts": [], "merchants": {}, "categories": set(),
            "countries": set(), "channels": set(), "currencies": set(),
            "devices": set(), "hours": set(), "card_purchases": [],
            "total_approved": 0,
        })
        amt = float(r["billing_amount_chf"])
        ts = parse_ts(r["timestamp"])
        log_amt = math.log1p(amt)
        dt = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None

        # -- features from strictly-prior approved history -------------------
        approved_amounts = st["amounts"]
        if len(st["log_amounts"]) >= 3:
            mu = sum(st["log_amounts"]) / len(st["log_amounts"])
            var = sum((x - mu) ** 2 for x in st["log_amounts"]) / len(st["log_amounts"])
            sd = max(0.25, math.sqrt(var))
            f0 = (log_amt - mu) / sd
        else:
            f0 = 0.0
        if len(approved_amounts) >= 10:
            p95 = p95_nearest_rank(sorted(approved_amounts))
            f1 = min(10.0, amt / p95) if p95 and p95 > 0 else 0.0
        else:
            f1 = 0.0
        mcount = st["merchants"].get(r["merchant_id"], 0)
        feats = [
            f0,
            f1,
            math.log1p(mcount),
            1.0 if mcount == 0 else 0.0,
            0.0 if r["merchant_category"] in st["categories"] else 1.0,
            0.0 if r["merchant_country"] in st["countries"] else 1.0,
            0.0 if r["channel"] in st["channels"] else 1.0,
            0.0 if r["currency"] in st["currencies"] else 1.0,
            0.0 if r["customer_device_id"] in st["devices"] else 1.0,
            0.0 if ts and int(datetime.fromtimestamp(ts, tz=timezone.utc).hour) in st["hours"] else 1.0,
            float(min(3, sum(1 for t in st["card_purchases"] if t is not None and 0 <= ts - t <= 600))),
            math.log1p(st["total_approved"]),
            1.0 if dt is not None and dt.hour in NIGHT_HOURS else 0.0,
            *qty_features(r.get("items"), None),
        ]
        examples.append({
            "customer_id": cust, "card_id": r["card_id"], "authorization_id": r["authorization_id"],
            "status": r["status"], "features": feats, "amount_chf": amt, "ts": ts,
        })

        # -- advance baselines with THIS row ---------------------------------
        if r["status"] == "approved":
            st["amounts"].append(amt)
            st["log_amounts"].append(log_amt)
            st["total_approved"] += 1
            st["categories"].add(r["merchant_category"])
            st["countries"].add(r["merchant_country"])
            st["channels"].add(r["channel"])
            st["currencies"].add(r["currency"])
            st["devices"].add(r["customer_device_id"])
            if ts:
                st["hours"].add(int(datetime.fromtimestamp(ts, tz=timezone.utc).hour))
        st["merchants"][r["merchant_id"]] = st["merchants"].get(r["merchant_id"], 0) + (1 if r["status"] == "approved" else 0)
        st["card_purchases"].append(ts if r["card_id"] else None)

    # full-history inference profiles
    profiles = {}
    for cust, st in run.items():
        profiles[cust] = {
            "log_mean": (sum(st["log_amounts"]) / len(st["log_amounts"])) if st["log_amounts"] else 0.0,
            "log_std": None,  # filled below
            "amount_p95": p95_nearest_rank(sorted(st["amounts"])) if st["amounts"] else None,
            "merchants": dict(st["merchants"]),
            "categories": sorted(st["categories"]),
            "countries": sorted(st["countries"]),
            "channels": sorted(st["channels"]),
            "currencies": sorted(st["currencies"]),
            "devices": sorted(st["devices"]),
            "hours": sorted(st["hours"]),
            "total_approved": st["total_approved"],
            # Item-line quantity baselines. authorization_history carries no
            # item lines, so this starts empty; a deployment that records
            # approved-order line items can fill it (keyed by item_category)
            # and the engine's quantity caps + feature 14 adapt automatically.
            "qty_max_by_category": {},
            # Per-category quantity SAMPLE (last ≤64 line quantities, oldest
            # first) for the engine's statistical tail fits — GEV / GPD-POT /
            # robust MAD in wallet-control/lib/evstats.js. Same seam as above:
            # empty until a deployment records approved-order line items; the
            # engine uses it only when a category has enough samples.
            "qty_hist_by_category": {},
        }
        mu = profiles[cust]["log_mean"]
        n = len(st["log_amounts"])
        var = sum((x - mu) ** 2 for x in st["log_amounts"]) / n if n else 0.0
        profiles[cust]["log_std"] = max(0.25, math.sqrt(var)) if n >= 3 else 0.0
        profiles[cust]["n_amount_samples"] = n

    return examples, profiles


def profile_features(auth: dict, profile: dict):
    """Features for an inference-time authorization dict (mirrors JS scorer)."""
    amt = float(auth["billing_amount_chf"])
    log_amt = math.log1p(amt)
    if profile["n_amount_samples"] >= 3 and profile["log_std"] > 0:
        f0 = (log_amt - profile["log_mean"]) / profile["log_std"]
    else:
        f0 = 0.0
    if profile["n_amount_samples"] >= 10 and profile["amount_p95"]:
        f1 = min(10.0, amt / profile["amount_p95"]) if profile["amount_p95"] > 0 else 0.0
    else:
        f1 = 0.0
    mcount = profile["merchants"].get(auth.get("merchant_id"), 0)
    hour = int(auth["ts_hour_utc"])
    return [
        f0, f1,
        math.log1p(mcount),
        1.0 if mcount == 0 else 0.0,
        0.0 if auth.get("merchant_category") in profile["categories"] else 1.0,
        0.0 if auth.get("merchant_country") in profile["countries"] else 1.0,
        0.0 if auth.get("channel") in profile["channels"] else 1.0,
        0.0 if auth.get("currency") in profile["currencies"] else 1.0,
        0.0 if auth.get("customer_device_id") in profile["devices"] else 1.0,
        0.0 if hour in profile["hours"] else 1.0,
        float(min(3, int(auth.get("recent_attempt_count_10m") or 0))),
        math.log1p(profile["total_approved"]),
        1.0 if hour in NIGHT_HOURS else 0.0,
        *qty_features(auth.get("items"), profile.get("qty_max_by_category")),
    ]


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

def fit_logistic(X, y, l2=3e-2, lr=0.05, iters=4000, seed=SEED):
    """Class-balanced L2 logistic regression via full-batch Adam (pure numpy).

    l2=3e-2: LOCO-tuned (see module docstring); do not silently revert to 1e-3.
    """
    rng = np.random.default_rng(seed)
    n, d = X.shape
    pos = max(1, int(y.sum()))
    neg = n - pos
    sw = np.where(y == 1, n / (2.0 * pos), n / (2.0 * neg))

    w = np.zeros(d)
    b = 0.0
    mw = np.zeros(d); vw = np.zeros(d)
    mb = vb = 0.0
    b1, b2, eps = 0.9, 0.999, 1e-8
    for t in range(1, iters + 1):
        z = X @ w + b
        p = 1.0 / (1.0 + np.exp(-np.clip(z, -60, 60)))
        g = (p - y) * sw
        gw = (X.T @ g) / n + l2 * w
        gb = g.sum() / n
        mw = b1 * mw + (1 - b1) * gw
        vw = b2 * vw + (1 - b2) * gw * gw
        mb = b1 * mb + (1 - b1) * gb
        vb = b2 * vb + (1 - b2) * gb * gb
        mw_hat = mw / (1 - b1 ** t)
        vw_hat = vw / (1 - b2 ** t)
        mb_hat = mb / (1 - b1 ** t)
        vb_hat = vb / (1 - b2 ** t)
        w -= lr * mw_hat / (np.sqrt(vw_hat) + eps)
        b -= lr * mb_hat / (math.sqrt(vb_hat) + eps)
    return w, b


def predict_proba(X, w, b):
    z = np.clip(X @ w + b, -60, 60)
    return 1.0 / (1.0 + np.exp(-z))


def auc(y, s):
    y = np.asarray(y); s = np.asarray(s)
    pos = s[y == 1]; neg = s[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    gt = (pos[:, None] > neg[None, :]).sum()
    eq = (pos[:, None] == neg[None, :]).sum()
    return (gt + 0.5 * eq) / (len(pos) * len(neg))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=str(Path(__file__).resolve().parents[3] / "wallet-control" / "data" / "pack"))
    args = ap.parse_args()
    pack = Path(args.pack).resolve()
    here = Path(__file__).resolve().parent

    history, attempts = load_pack(pack)
    examples, profiles = extract_examples(history)
    print(f"pack: {pack}")
    print(f"purchase examples: {len(examples)}  declined: {sum(1 for e in examples if e['status'] == 'declined')}")
    print(f"customers with profiles: {len(profiles)}")

    X = np.array([e["features"] for e in examples], dtype=float)
    y = np.array([1 if e["status"] == "declined" else 0 for e in examples], dtype=float)
    customers = np.array([e["customer_id"] for e in examples])

    mu = X.mean(axis=0)
    sd = np.maximum(X.std(axis=0), 1e-8)
    Xs = (X - mu) / sd

    w, b = fit_logistic(Xs, y)
    p_in = predict_proba(Xs, w, b)
    print(f"\nin-sample AUC: {auc(y, p_in):.4f}")

    # leave-one-customer-out AUC (group-honest)
    uniq = sorted(set(customers.tolist()))
    oof = np.zeros(len(y))
    for c in uniq:
        tr = customers != c
        te = ~tr
        wc, bc = fit_logistic(Xs[tr], y[tr])
        oof[te] = predict_proba(Xs[te], wc, bc)
    print(f"leave-one-customer-out AUC: {auc(y, oof):.4f}")

    # calibration on in-sample approved distribution (profile baselines are
    # full-history at inference; running baselines make training scores
    # slightly noisier, which is the conservative direction for a threshold)
    approved_p = p_in[y == 0]
    declined_p = p_in[y == 1]
    q = 0.97
    escalate = float(np.quantile(approved_p, q))
    suspect = min(0.5, escalate * 0.55)
    fric_ok = float((approved_p >= escalate).mean())
    fric_bad = float((declined_p >= escalate).mean())
    print(f"\ncalibration: escalate τ={escalate:.4f} (q{int(q*100)} of approved)  suspect={suspect:.4f}")
    print(f"  approved rows ≥ τ: {fric_ok*100:.2f}%   declined rows ≥ τ: {fric_bad*100:.2f}%")

    # score the 45 real attempts with full-history profiles (friction check)
    cust_by_card = {}
    with open(pack / "scenario_authorities.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            cust_by_card[r["card_id"]] = r["customer_id"]
    att = [{**a, "ts_hour_utc": int(datetime.fromisoformat(a["timestamp"].replace("Z", "+00:00")).hour),
            "customer_id": cust_by_card.get(a["card_id"])}
           for a in attempts]
    bands = {"normal": 0, "suspect": 0, "escalate": 0}
    att_scores = []
    for a in att:
        prof = profiles.get(a["customer_id"])
        if prof is None:
            continue
        f = profile_features(a, prof)
        s = float(predict_proba((np.array(f) - mu) / sd, w, b))
        band = "escalate" if s >= escalate else ("suspect" if s >= suspect else "normal")
        bands[band] += 1
        att_scores.append({"authorization_id": a["authorization_id"], "score": round(s, 4), "band": band})
    print(f"attempt bands: {bands}")

    top = sorted(zip(FEATURES, w.tolist()), key=lambda t: -abs(t[1]))[:6]
    print("top weights:", ", ".join(f"{n}={v:+.3f}" for n, v in top))

    parity = []
    picks = [att[0], att[5], att[12], att[20], att[28], att[36], att[44]]
    synthetic = [
        {"authorization_id": "PARITY_TINY", "card_id": "CA0001", "billing_amount_chf": "2.00",
         "currency": "CHF", "merchant_id": "ME0001", "merchant_category": "groceries",
         "merchant_country": "CH", "channel": "ecommerce", "customer_device_id": "DVC-13A598",
         "timestamp": "2026-08-10T10:00:00Z", "recent_attempt_count_10m": "0",
         "items": [{"item_name": "Fresh produce selection", "item_category": "groceries", "quantity": 2}]},
        {"authorization_id": "PARITY_HUGE", "card_id": "CA0001", "billing_amount_chf": "5000.00",
         "currency": "USD", "merchant_id": "ME9999", "merchant_category": "electronics",
         "merchant_country": "US", "channel": "app", "customer_device_id": "DVC-NEW",
         "timestamp": "2026-08-10T03:00:00Z", "recent_attempt_count_10m": "4",
         "items": [{"item_name": "Wireless headphones", "item_category": "electronics", "quantity": 500}]},
    ]
    for a in picks + synthetic:
        a = dict(a)
        a.setdefault("ts_hour_utc", int(datetime.fromisoformat(a["timestamp"].replace("Z", "+00:00")).hour))
        prof = profiles[cust_by_card[a["card_id"]]]
        f = profile_features(a, prof)
        s = float(predict_proba((np.array(f) - mu) / sd, w, b))
        parity.append({
            "case": a["authorization_id"], "customer_id": cust_by_card[a["card_id"]],
            "inputs": {k: a.get(k) for k in ("billing_amount_chf", "currency", "merchant_id",
                        "merchant_category", "merchant_country", "channel", "customer_device_id",
                        "timestamp", "recent_attempt_count_10m", "ts_hour_utc", "items")},
            "features": [round(v, 12) for v in f],
            "expected_score": s,
        })

    artifact = {
        "schema": SCHEMA,
        "version": "behavior-model-v3",
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "semantics": "advisory-only: may add evidence/uncertainty and escalate to the customer; never approves, declines, or loosens",
        "label_caveat": "trained on historical authorization outcomes, which are not fraud labels and not an answer key for attempts",
        "features": FEATURES,
        "feature_labels": FEATURE_LABELS,
        "weights": {n: float(v) for n, v in zip(FEATURES, w)},
        "intercept": float(b),
        "standardization": {"mean": mu.tolist(), "std": sd.tolist()},
        "thresholds": {"escalate": escalate, "suspect": suspect},
        "profiles": profiles,
        "calibration": {
            "approved_rows": int(len(approved_p)), "declined_rows": int(len(declined_p)),
            "escalate_quantile": q,
            "approved_escalation_rate": fric_ok, "declined_escalation_rate": fric_bad,
            "auc_insample": float(auc(y, p_in)), "auc_leave_customer_out": float(auc(y, oof)),
            "attempt_bands": bands, "attempt_scores": att_scores,
        },
        "provenance": {
            "pack_files": {p.name: sha256(p) for p in sorted(pack.glob("*.csv"))},
            "python": platform.python_version(), "numpy": np.__version__, "seed": SEED,
            "trainer": "merchant-trust-data/models/behavior/train_behavior.py",
        },
    }
    (here / "behavior-model.json").write_text(json.dumps(artifact, indent=1))
    (here / "parity_vectors.json").write_text(json.dumps(parity, indent=1))
    print(f"\nwrote {here/'behavior-model.json'} ({(here/'behavior-model.json').stat().st_size//1024} KB)")
    print(f"wrote {here/'parity_vectors.json'} ({len(parity)} cases)")


if __name__ == "__main__":
    main()
