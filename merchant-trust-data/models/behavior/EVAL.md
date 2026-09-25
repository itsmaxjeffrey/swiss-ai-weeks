# Behavior model v3 — training & calibration report

Trained 2026-09-25 (v3) · `train_behavior.py` · artifact `behavior-model.json` (~34 KB)
Data: challenge pack `wallet-control/data/pack/` (per-file sha256 in the artifact's
`provenance.pack_files`). numpy 2.5.2, pure-numpy Adam (no sklearn on this host),
seed 20260924. Feature search harness: `experiment.py` (reproduces v1 exactly).

## v3 (2026-09-25): basket-quantity features 13–14

Owner request: an order that is *behaviorally strange* (500 pairs of shoes) must
raise risk and ask the customer, while a plausible bulk order (500 disposable
gloves, category `household`) must not — including at whitelisted merchants.
Two mechanisms shipped together:

- **Deterministic engine check** `ITEM_QTY_ANOMALY` (`lib/engine.js` §6c, caps in
  `lib/item-classes.js`): category-conditional plausibility caps — bulk
  (groceries/household/home_improvement) 500, gift (gift_card/subscriptions/
  membership) 2, finite (clothing/electronics/…) 12, service 20; unknown
  categories fall back to finite. Caps adapt to the customer via
  `profile.qty_max_by_category` (cap = max(base, 3 × observed max)). A severe
  excess (>3× cap) forces step_up like detected manipulation — even under
  `uncertainty_policy: approve` (only `decline` suppresses).
- **Trained features** 13 `log_item_qty_max`, 14 `qty_over_class_cap` — the
  pack's authorization_history carries no item lines, so both columns are
  zero-variance in training and ship with weight **exactly 0.0** (verified in
  the artifact); they gain weight only when retrained over quantity-bearing
  data. Profiles carry an empty `qty_max_by_category` seam for live quantity
  baselines.

Numbers identical to v2 within float noise: LOCO **0.7849** (v2: 0.7850 —
last-digit drift from two extra zero columns' summation order; weights 0.0),
in-sample 0.8078, τ 0.7629, friction 3.02 %, attempt bands 28/15/2 (unchanged).
Parity vectors: same 9 cases, `items` added to inputs (PARITY_TINY qty 2
groceries, PARITY_HUGE qty 500 electronics → exercises both new features).
Replay regression 2026-09-25: decision lines identical to baseline.

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

## Features (13, chronology-safe — trainer docstring has the exact contract)

v1's 12 features plus one new:

- `night_hour` — 1 when the UTC hour is in **21:00–06:59**; a generic
  (not personalized) late-night window. Motivated by univariate signal in the
  declined rows and the fraud-literature prior; the single biggest AUC gain in
  the search (+3.5 pts LOCO alone). In production this is 00:00–06:00 local
  Swiss time — exactly when a cardholder is asleep and a stolen card is not.

Running (strictly-prior) baselines when featurizing history rows; full-history
profiles at inference: `log_amount_z`, `amount_p95_ratio`, `merchant_log_count`,
`merchant_unfamiliar`, `category_unfamiliar`, `country_unfamiliar`,
`channel_unfamiliar`, `currency_unfamiliar`, `device_unfamiliar`,
`hour_unobserved`, `velocity_10m`, `customer_log_total`. p95 = nearest-rank.

## Results

- in-sample AUC **0.8078** (v1: 0.7733); leave-one-customer-out AUC **0.7850**
  (v1: 0.7422) — group-honest, +4.3 pts over v1.
- Top |weights|: `velocity_10m` +0.428, `night_hour` +0.320,
  `currency_unfamiliar` +0.260, `country_unfamiliar` +0.239,
  `amount_p95_ratio` +0.207, `hour_unobserved` +0.169.
- L2 = 3e-2 (v1: 1e-3): LOCO plateau 0.7844–0.7850 for l2 3e-3…1e-1 on the
  final feature set; 1e-3 leaves ~0.4 pt on the table, 1.0 over-shrinks (0.7757).
- `device_unfamiliar` still carries a negative multivariate partial weight
  (collinearity artifact — univariate P(declined | device unfamiliar) = 13 % vs
  5.6 %); kept and documented, same reasoning as v1.

## Search trail (what was tried and rejected — don't re-run these)

All numbers are LOCO AUC on fold-internal standardization unless noted
(`experiment.py`, round 2/3 sweeps were one-off scripts, values recorded here):

- v1 features, global-std vs fold-std: 0.7422 vs 0.7421 — the old LOCO's
  standardization leakage was immaterial.
- Single additions to v1: `category_log_count` 0.7362, `weekend` 0.7417,
  `log_days_since_last` 0.7401, `merchant_share` 0.7392, `ix_amount_new_merchant`
  0.7374, `ix_amount_new_country` 0.7422, `ix_night_new_device` 0.7384 — none
  beat plain `night_hour` (0.7771 at l2 1e-3).
- Bundles: v1+all-new 0.7521, interactions-only 0.7333, time-trio
  (weekend/night/dsl) 0.7720 — every bundle with weekend or dsl underperformed
  night alone.
- Drops from v1: −`device_unfamiliar` 0.7357, −`channel_unfamiliar` 0.7434,
  −`customer_log_total` 0.7448 — no drop helps.
- Night-window sensitivity: 22–05 (v2 draft) 0.7771·l2 1e-3 → 0.7797·l2 3e-2;
  **21–06 0.7850 (shipped)**; 23–04 0.7745; 20–07 0.7757 — the 21–06 window is
  the local optimum on both sides.

## Calibration (friction-first, on known-good history)

- escalate τ = **0.7629** = q97 of approved-row scores → **3.02 %** of known-good
  history would escalate (same friction as v1); **42.6 %** of historically
  declined rows score ≥ τ (sensitivity is informational — declined ≠ fraud).
- suspect band = min(0.5, τ·0.55) = **0.4196**.
- The 45 real attempts: **28 normal / 15 suspect / 2 escalate** (v1: 29/16/0).
  The 2 escalates are AU0029 + AU0030 — card CA0023, 02:21/02:24 UTC, part of a
  3-attempt burst within 7 minutes (AU0028 at 02:17 is the matching suspect),
  one with a GBP/GB country-currency swap. This is the night-burst / card-testing
  pattern v1 scored as plain normal. Both attempts are already DECLINEd by the
  deterministic rules (VELOCITY_BURST et al.), so the advisory layer changes no
  decision — it adds strong corroborating evidence where v1 was silent.
- Sanity extremes: ordinary AU0001 → normal; synthetic CHF 5000 / USD / US
  merchant / 03:00 UTC / new device / velocity 4 → escalate.

## Deployment & parity

- Canonical artifact: `merchant-trust-data/models/behavior/behavior-model.json`
  (tracked). Deployed copy: `wallet-control/lib/behavior-model.json`
  (gitignored); the loader falls back to the canonical path when the copy is
  absent. **Refresh the copy after retraining** — the parity test anchors the
  deployed artifact to the trainer-emitted vectors, so a stale copy fails CI.
- `parity_vectors.json` (9 cases): feature parity ±1e-9, score parity ±1e-6,
  asserted in `wallet-control/test/behavior-model.test.js` (15 features).
- Replay regression 2026-09-24: all decision lines identical to the v1 baseline
  (`node cli.js` diff after stripping timings); only behavior-model evidence
  rows changed.

## Engine integration semantics (wallet-control)

Evidence row on every scored decision. Band `escalate` (≥ τ) adds a
`BEHAVIOR_ANOMALY` **uncertainty**, routed by the customer's own uncertainty
policy (default `ask` → step_up; `approve` → approves with the evidence noted —
the model never overrides the customer upward). Band `suspect` is evidence-only.
Inert without artifact or unknown customer. Like the injection detector, this
layer can NEVER approve, decline, or loosen anything.

Companion deterministic check (v3): engine §6c `ITEM_QTY_ANOMALY` — see the v3
section above. Unlike the trained score it enforces immediately: over-cap
quantity → uncertainty; severe (>3× cap) → forced step_up unless the customer's
policy is `decline`.

## Regeneration

```bash
cd merchant-trust-data
python3 models/behavior/train_behavior.py        # ~11 s, writes artifact + parity
cp models/behavior/behavior-model.json ../../wallet-control/lib/  # refresh deployed copy
cd ../../wallet-control && npm test               # parity anchors the deployed copy
python3 models/behavior/experiment.py             # feature-search harness (LOCO)
```
