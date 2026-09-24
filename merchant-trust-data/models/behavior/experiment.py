#!/usr/bin/env python3
"""Feature/hyperparameter experiments for the behavior model.

Evaluates candidate feature sets by leave-one-customer-out AUC with
FOLD-INTERNAL standardization (the trainer's current LOCO reuses global
mu/sd, which leaks the held-out customer's feature scale -- this script
measures both). Nothing here writes artifacts; the winning config gets
ported into train_behavior.py by hand.
"""
from __future__ import annotations

import csv
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_behavior import auc, fit_logistic, load_pack, parse_ts, p95_nearest_rank  # noqa: E402

PACK = Path(__file__).resolve().parents[3] / "wallet-control" / "data" / "pack"

NIGHT_HOURS = frozenset({21, 22, 23, 0, 1, 2, 3, 4, 5, 6})  # shipped v2 definition

V1 = [
    "log_amount_z", "amount_p95_ratio", "merchant_log_count", "merchant_unfamiliar",
    "category_unfamiliar", "country_unfamiliar", "channel_unfamiliar",
    "currency_unfamiliar", "device_unfamiliar", "hour_unobserved",
    "velocity_10m", "customer_log_total",
]
NEW = [
    "category_log_count", "weekend", "night_hour", "log_days_since_last",
    "ix_amount_new_merchant", "ix_amount_new_country", "ix_night_new_device",
    "merchant_share",
]


def extract_extended(history):
    """Chronology-safe feature rows over the V1+NEW vocabulary."""
    purchases = [r for r in history if r["transaction_type"] == "purchase"]
    purchases.sort(key=lambda r: (r["timestamp"], r["authorization_id"]))
    run = {}
    rows = []
    for r in purchases:
        cust = r["customer_id"]
        st = run.setdefault(cust, {
            "log_amounts": [], "amounts": [], "merchants": {}, "categories": {},
            "countries": set(), "channels": set(), "currencies": set(),
            "devices": set(), "hours": set(), "card_purchases": [],
            "total_approved": 0, "last_ts": None,
        })
        amt = float(r["billing_amount_chf"])
        ts = parse_ts(r["timestamp"])
        log_amt = math.log1p(amt)
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)

        n_log = len(st["log_amounts"])
        if n_log >= 3:
            mu = sum(st["log_amounts"]) / n_log
            var = sum((x - mu) ** 2 for x in st["log_amounts"]) / n_log
            sd = max(0.25, math.sqrt(var))
            f_amount_z = (log_amt - mu) / sd
        else:
            f_amount_z = 0.0
        if len(st["amounts"]) >= 10:
            p95 = p95_nearest_rank(sorted(st["amounts"]))
            f_p95 = min(10.0, amt / p95) if p95 and p95 > 0 else 0.0
        else:
            f_p95 = 0.0
        mcount = st["merchants"].get(r["merchant_id"], 0)
        ccount = st["categories"].get(r["merchant_category"], 0)
        days_since = ((ts - st["last_ts"]) / 86400.0) if (ts is not None and st["last_ts"] is not None) else None

        f = {
            "log_amount_z": f_amount_z,
            "amount_p95_ratio": f_p95,
            "merchant_log_count": math.log1p(mcount),
            "merchant_unfamiliar": 1.0 if mcount == 0 else 0.0,
            "category_unfamiliar": 0.0 if r["merchant_category"] in st["categories"] else 1.0,
            "country_unfamiliar": 0.0 if r["merchant_country"] in st["countries"] else 1.0,
            "channel_unfamiliar": 0.0 if r["channel"] in st["channels"] else 1.0,
            "currency_unfamiliar": 0.0 if r["currency"] in st["currencies"] else 1.0,
            "device_unfamiliar": 0.0 if r["customer_device_id"] in st["devices"] else 1.0,
            "hour_unobserved": 0.0 if dt.hour in st["hours"] else 1.0,
            "velocity_10m": float(min(3, sum(1 for t in st["card_purchases"] if t is not None and 0 <= ts - t <= 600))),
            "customer_log_total": math.log1p(st["total_approved"]),
            "category_log_count": math.log1p(ccount),
            "weekend": 1.0 if dt.weekday() >= 5 else 0.0,
            "night_hour": 1.0 if dt.hour in NIGHT_HOURS else 0.0,
            "log_days_since_last": math.log1p(min(365.0, days_since)) if days_since is not None else 0.0,
            "ix_amount_new_merchant": f_p95 * (1.0 if mcount == 0 else 0.0),
            "ix_amount_new_country": f_p95 * (0.0 if r["merchant_country"] in st["countries"] else 1.0),
            "ix_night_new_device": (1.0 if dt.hour in NIGHT_HOURS else 0.0) * (0.0 if r["customer_device_id"] in st["devices"] else 1.0),
            "merchant_share": (mcount / st["total_approved"]) if st["total_approved"] else 0.0,
        }
        rows.append({"customer_id": cust, "status": r["status"], "features": f})

        if r["status"] == "approved":
            st["amounts"].append(amt)
            st["log_amounts"].append(log_amt)
            st["total_approved"] += 1
            st["categories"][r["merchant_category"]] = st["categories"].get(r["merchant_category"], 0) + 1
            st["countries"].add(r["merchant_country"])
            st["channels"].add(r["channel"])
            st["currencies"].add(r["currency"])
            st["devices"].add(r["customer_device_id"])
            st["hours"].add(dt.hour)
            st["last_ts"] = ts
        st["merchants"][r["merchant_id"]] = st["merchants"].get(r["merchant_id"], 0) + (1 if r["status"] == "approved" else 0)
        st["card_purchases"].append(ts if r["card_id"] else None)
    return rows


def eval_config(rows, names, l2=1e-3, seed=20260924, global_std_for_loco=False):
    X = np.array([[r["features"][n] for n in names] for r in rows], dtype=float)
    y = np.array([1.0 if r["status"] == "declined" else 0.0 for r in rows])
    custs = np.array([r["customer_id"] for r in rows])

    mu, sd = X.mean(axis=0), np.maximum(X.std(axis=0), 1e-8)
    Xs = (X - mu) / sd
    w, b = fit_logistic(Xs, y, l2=l2)
    in_auc = auc(y, 1 / (1 + np.exp(-np.clip(Xs @ w + b, -60, 60))))

    oof = np.zeros(len(y))
    for c in sorted(set(custs.tolist())):
        tr, te = custs != c, custs == c
        if global_std_for_loco:
            Xtr = Xs[tr]
        else:
            m2, s2 = X[tr].mean(axis=0), np.maximum(X[tr].std(axis=0), 1e-8)
            Xtr = (X[tr] - m2) / s2
        wc, bc = fit_logistic(Xtr, y[tr], l2=l2)
        Xte = (X[te] - mu) / sd if global_std_for_loco else (X[te] - m2) / s2
        oof[te] = 1 / (1 + np.exp(-np.clip(Xte @ wc + bc, -60, 60)))
    return in_auc, auc(y, oof)


def main():
    with open(PACK / "authorization_history.csv", newline="", encoding="utf-8") as f:
        history = list(csv.DictReader(f))
    rows = extract_extended(history)
    declined = sum(1 for r in rows if r["status"] == "declined")
    print(f"rows={len(rows)} declined={declined} ({declined/len(rows)*100:.2f}%)\n")

    print(f"{'config':<58} {'in-AUC':>7} {'LOCO':>7}")
    # v1 reproduction, both standardization regimes
    for glob, tag in ((True, "global-std (trainer v1 way)"), (False, "fold-std (honest)")):
        i, o = eval_config(rows, V1, global_std_for_loco=glob)
        print(f"{'v1 ' + tag:<58} {i:7.4f} {o:7.4f}")

    # one new feature at a time (fold-std honest)
    for feat in NEW:
        i, o = eval_config(rows, V1 + [feat])
        print(f"{'v1 + ' + feat:<58} {i:7.4f} {o:7.4f}")

    # curated bundles
    bundles = {
        "v1 + cat_log_count + dsl + ix_amount_new_merchant": V1 + ["category_log_count", "log_days_since_last", "ix_amount_new_merchant"],
        "v1 + time trio (weekend/night/dsl)": V1 + ["weekend", "night_hour", "log_days_since_last"],
        "v1 + all interactions": V1 + ["ix_amount_new_merchant", "ix_amount_new_country", "ix_night_new_device"],
        "v1 + weekend/night/catlog/dsl/all-ix/share": V1 + NEW,
    }
    for name, feats in bundles.items():
        i, o = eval_config(rows, feats)
        print(f"{name:<58} {i:7.4f} {o:7.4f}")

    # drops (fold-std)
    for drop in ("device_unfamiliar", "channel_unfamiliar", "customer_log_total"):
        i, o = eval_config(rows, [f for f in V1 if f != drop])
        print(f"{'v1 - ' + drop + ' (fold-std)':<58} {i:7.4f} {o:7.4f}")

    # l2 sweep on the best-looking bundle
    best = V1 + NEW
    for l2 in (3e-4, 1e-3, 3e-3, 1e-2, 3e-2):
        i, o = eval_config(rows, best, l2=l2)
        print(f"{'v1+all l2=' + str(l2):<58} {i:7.4f} {o:7.4f}")


if __name__ == "__main__":
    main()
