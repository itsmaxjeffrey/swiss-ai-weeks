# Behavior model v1 — training & calibration report

Trained 2026-09-24 · `train_behavior.py` · artifact `behavior-model.json` (~33 KB)
Data: challenge pack `wallet-control/data/pack/` (per-file sha256 in the artifact's
`provenance.pack_files`). numpy 2.5.2, pure-numpy Adam (no sklearn on this host),
seed 20260924.

## Scope & honest caveat

The pack's historical `status` is the authorization outcome observed at the time —
**not a fraud label and not an answer key** for the 45 purchase attempts (the pack
README says so explicitly). This model is a *behavioral-deviation prior*: features
quantify how different a purchase is from the customer's own past behavior; the
classifier is trained on the past outcome purely to weight those deviations.
Deployed semantics are **advisory-only** (see bottom).

## Data

- 4,701 history rows → 4,565 purchase rows (258 declined = 5.65 %); withdrawals
  and refunds excluded from baselines and training.
- Chronology: history 2025-09-01 → 2026-07-31, live attempts 2026-08-09 →
  2026-08-22 — a clean temporal split, so full-history inference profiles contain
  no future information relative to attempts.
- 20 customer profiles (≈200–250 approved purchases each).

## Features (12, chronology-safe — see trainer docstring for the exact contract)

Running (strictly-prior) baselines when featurizing history rows; full-history
profiles at inference: `log_amount_z`, `amount_p95_ratio`, `merchant_log_count`,
`merchant_unfamiliar`, `category_unfamiliar`, `country_unfamiliar`,
`channel_unfamiliar`, `currency_unfamiliar`, `device_unfamiliar`,
`hour_unobserved`, `velocity_10m`, `customer_log_total`. p95 = nearest-rank.

## Results

- in-sample AUC **0.7733**; leave-one-customer-out AUC **0.7422** (group-honest).
- Top |weights|: `velocity_10m` +0.453, `currency_unfamiliar` +0.370,
  `country_unfamiliar` +0.261, `amount_p95_ratio` +0.258, `hour_unobserved` +0.255,
  `device_unfamiliar` **−0.226**.
- Weight honesty: univariate P(declined | device unfamiliar) = 13 % vs 5.6 % for
  known devices, but the multivariate partial weight is negative — a collinearity
  artifact (device novelty co-occurs with merchant/country novelty, which absorb
  the signal). Kept: the model is calibrated empirically, and its deployed role is
  advisory evidence, not a guarantee.

## Calibration (friction-first, on known-good history)

- escalate τ = **0.7811** = q97 of approved-row scores → **3.02 %** of known-good
  history would escalate; **42.6 %** of historically declined rows score ≥ τ
  (sensitivity is informational — declined ≠ fraud).
- suspect band = min(0.5, τ·0.55) = **0.4296**.
- The 45 real attempts: **29 normal / 16 suspect / 0 escalate**. Zero decisions
  change vs the rules-only baseline replay (verified by diffing `node cli.js`
  before/after); the 16 suspect rows surface plain-language drivers as evidence
  ("burst of attempts within 10 minutes, larger than 95 % of your past
  purchases, …").
- Sanity extremes: ordinary AU0001 → 0.29 (normal); synthetic CHF 5000 / USD /
  US merchant / 03:00 / new device / velocity 4 → 0.9999 (escalate).

## Bugs found & fixed during training

1. **Merchant join**: `purchase_attempts.csv` carries only `merchant_id`;
   without joining `merchants.csv`, every attempt looked country/category-
   unfamiliar and 44/45 landed in suspect+escalate. Live platform events always
   include these fields (nested under `merchant{}`); the JS scorer resolves both
   shapes and the parity test pins the joined inputs.

## Deployment & parity

- Canonical artifact: `merchant-trust-data/models/behavior/behavior-model.json`
  (tracked). Deployed copy: `wallet-control/lib/behavior-model.json`
  (gitignored); the loader falls back to the canonical path when the copy is
  absent. **Refresh the copy after retraining** — the parity test anchors the
  deployed artifact to the trainer-emitted vectors, so a stale copy fails CI.
- `parity_vectors.json` (9 cases): feature parity ±1e-9, score parity ±1e-6,
  asserted in `wallet-control/test/behavior-model.test.js`.

## Engine integration semantics (wallet-control)

Evidence row on every scored decision. Band `escalate` (≥ τ) adds a
`BEHAVIOR_ANOMALY` **uncertainty**, routed by the customer's own uncertainty
policy (default `ask` → step_up; `approve` → approves with the evidence noted —
the model never overrides the customer upward). Band `suspect` is evidence-only.
Inert without artifact or unknown customer. Like the injection detector, this
layer can NEVER approve, decline, or loosen anything.
