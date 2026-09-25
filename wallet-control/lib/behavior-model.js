// Model-backed user-behavior scoring (advisory only).
// ---------------------------------------------------------------------------
// The artifact (behavior-model.json) is trained + exported by
// merchant-trust-data/models/behavior/train_behavior.py — a class-balanced L2
// logistic regression over chronology-safe behavioral-deviation features,
// learned from the challenge pack's authorization_history.csv (4,565 purchases,
// 2025-09..2026-07; historical `status` is the past authorization outcome,
// NOT a fraud label and NOT an answer key for live attempts).
//
// SEMANTICS: like the prompt-injection detector, this layer can NEVER approve,
// decline, or loosen anything. The engine may surface its score as evidence
// and route a strong anomaly to the customer's uncertainty policy. The layer
// is inert when no artifact is deployed or the customer has no profile.
//
// Feature contract (must stay in lockstep with the trainer; asserted by
// test/behavior-model.test.js against the trainer-emitted parity_vectors.json):
//
//   0  log_amount_z       (log1p(chf) - log_mean) / log_std   [n>=3]
//   1  amount_p95_ratio   min(10, chf / amount_p95)           [n>=10]
//   2  merchant_log_count log1p(approved count at merchant_id)
//   3  merchant_unfamiliar    1 when that count is 0
//   4  category_unfamiliar    1 when merchant_category never approved
//   5  country_unfamiliar     1 when merchant_country never approved
//   6  channel_unfamiliar     1 when channel never approved
//   7  currency_unfamiliar    1 when currency never approved
//   8  device_unfamiliar      1 when customer_device_id never approved
//   9  hour_unobserved        1 when UTC hour never approved
//   10 velocity_10m          min(3, recent_attempt_count_10m)
//   11 customer_log_total    log1p(total_approved)
//   12 night_hour            1 when UTC hour in 21:00-06:59 (generic night
//                            window, NOT personalized; 0 when unreadable)
//   13 log_item_qty_max      log1p(max line quantity in the basket); 0 when
//                            the event carries no item lines. Zero-variance
//                            in the history training rows (authorization
//                            history has no item lines), so it ships with
//                            weight exactly 0 and only gains weight when
//                            retrained over quantity-bearing data.
//   14 qty_over_class_cap    1 when the max line quantity exceeds the
//                            category's plausible cap (lib/item-classes.js;
//                            raised to 3x the customer's observed per-category
//                            max when profile.qty_max_by_category has data)
//
// p95 = nearest-rank; amounts are billing_amount_chf; auth fields resolve from
// the flat attempt shape or the live event's merchant{} object.

import { readFileSync } from 'node:fs';
import { qtyCap } from './item-classes.js';

// Mirrors NIGHT_HOURS in train_behavior.py — keep in lockstep.
const NIGHT_HOURS = new Set([21, 22, 23, 0, 1, 2, 3, 4, 5, 6]);

function loadModel() {
  const candidates = [
    new URL('./behavior-model.json', import.meta.url),
    new URL('../../merchant-trust-data/models/behavior/behavior-model.json', import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const m = JSON.parse(readFileSync(url, 'utf8'));
      if (m && m.schema === 'openclaw.behavior-model/1' && m.weights && m.profiles && m.thresholds) return m;
    } catch { /* try next candidate */ }
  }
  return null;
}

let cached = loadModel(); // eager: artifact parse must never sit in the decision path
export function getBehaviorModel() {
  return cached; // null when artifact is absent -> engine skips this layer
}

/** Test-only: swap the cached model (engine integration tests inject profiles
 *  with quantity history through this; product code never calls it). */
export function setBehaviorModelForTest(m) {
  cached = m;
}

/** Resolve a merchant-scoped field from either the flat attempt CSV shape or
 *  the live event's nested merchant object. */
function merchantField(auth, field) {
  return auth?.merchant?.[field] ?? auth?.[field] ?? null;
}

/** Feature vector for one authorization against a customer profile.
 *  Mirrors profile_features() in the trainer. */
export function behaviorFeatures(auth, profile) {
  const chf = Number(auth?.billing_amount_chf);
  const n = profile.n_amount_samples || 0;
  const f = [];

  // 0 log_amount_z
  if (n >= 3 && profile.log_std > 0) {
    f.push((Math.log1p(chf) - profile.log_mean) / profile.log_std);
  } else f.push(0.0);

  // 1 amount_p95_ratio
  if (n >= 10 && profile.amount_p95 > 0) {
    f.push(Math.min(10.0, chf / profile.amount_p95));
  } else f.push(0.0);

  const mid = merchantField(auth, 'merchant_id');
  const mcount = profile.merchants[mid] || 0;

  // 2 merchant_log_count, 3 merchant_unfamiliar
  f.push(Math.log1p(mcount));
  f.push(mcount === 0 ? 1.0 : 0.0);

  const inSet = (val, list) => (val != null && list.includes(val) ? 0.0 : 1.0);
  // 4-9 novelty flags
  f.push(inSet(merchantField(auth, 'merchant_category'), profile.categories));
  f.push(inSet(merchantField(auth, 'merchant_country'), profile.countries));
  f.push(inSet(auth?.channel, profile.channels));
  f.push(inSet(auth?.currency, profile.currencies));
  f.push(inSet(auth?.customer_device_id, profile.devices));
  const hour = auth?.timestamp ? new Date(auth.timestamp).getUTCHours() : null;
  f.push(hour != null && !Number.isNaN(hour) && profile.hours.includes(hour) ? 0.0 : 1.0);

  // 10 velocity_10m
  f.push(Math.min(3, Number(auth?.recent_attempt_count_10m) || 0));

  // 11 customer_log_total
  f.push(Math.log1p(profile.total_approved || 0));

  // 12 night_hour (generic window; 0 when timestamp unreadable — parity cases
  // always carry a valid timestamp, so this only affects degenerate callers)
  f.push(hour != null && !Number.isNaN(hour) && NIGHT_HOURS.has(hour) ? 1.0 : 0.0);

  // 13 log_item_qty_max, 14 qty_over_class_cap — basket line quantities
  // (resolve both the flat attempt shape and live {qty, category} items)
  let maxQty = 0, worstCat = null;
  for (const it of Array.isArray(auth?.items) ? auth.items : []) {
    const q = Math.max(1, Number(it?.quantity ?? it?.qty) || 1);
    if (q > maxQty) { maxQty = q; worstCat = it?.item_category ?? it?.category ?? null; }
  }
  f.push(maxQty > 0 ? Math.log1p(maxQty) : 0.0);
  f.push(maxQty > 0 && maxQty > qtyCap(worstCat, profile.qty_max_by_category).cap ? 1.0 : 0.0);

  return f;
}

function sigmoid(z) {
  const c = Math.max(-60, Math.min(60, z));
  return 1 / (1 + Math.exp(-c));
}

/**
 * Score one authorization against the customer's learned behavior profile.
 * Returns null when the layer is inert (no artifact, unknown customer, or
 * unreadable amount). Otherwise:
 *   { score, band: 'normal'|'suspect'|'escalate',
 *     factors: [{feature, label, contribution}],        // top positive drivers
 *     threshold, suspectThreshold }
 */
export function scoreBehavior(auth, customerId) {
  const m = getBehaviorModel();
  if (!m || !auth || !customerId) return null;
  const profile = m.profiles[customerId];
  if (!profile) return null;
  const amount = Number(auth.billing_amount_chf);
  if (!Number.isFinite(amount)) return null;

  const feats = behaviorFeatures(auth, profile);
  const { mean, std } = m.standardization;
  let z = m.intercept;
  const contribs = [];
  for (let i = 0; i < feats.length; i++) {
    const zi = (feats[i] - mean[i]) / std[i];
    const w = m.weights[m.features[i]];
    z += w * zi;
    contribs.push({ feature: m.features[i], label: m.feature_labels[m.features[i]], contribution: w * zi });
  }
  const score = sigmoid(z);
  const factors = contribs.filter(c => c.contribution > 0.01)
    .sort((a, b) => b.contribution - a.contribution).slice(0, 3);
  const band = score >= m.thresholds.escalate ? 'escalate'
    : score >= m.thresholds.suspect ? 'suspect' : 'normal';
  return {
    score,
    band,
    factors,
    threshold: m.thresholds.escalate,
    suspectThreshold: m.thresholds.suspect,
    version: m.version,
  };
}
