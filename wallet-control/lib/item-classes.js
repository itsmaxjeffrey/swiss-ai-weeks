// Category-conditional basket-quantity plausibility (deterministic, zero deps).
// ---------------------------------------------------------------------------
// Shared by the engine's ITEM_QTY_ANOMALY check (lib/engine.js) and the
// behavior scorer's qty_over_class_cap feature (lib/behavior-model.js). The
// Python trainer mirrors these tables and the qtyCap rule in
// merchant-trust-data/models/behavior/train_behavior.py — keep the three in
// lockstep.
//
// Classes:
//   bulk    consumables sold in bulk — huge line quantities are plausible
//           (a box of 500 disposable gloves is a normal household order)
//   gift    resellable/recurring value (gift cards, subscriptions) — a line
//           quantity above the base cap is a classic cash-out pattern
//   finite  durable/personal goods — 500 pairs of shoes is not a basket
//   service per-occasion services — quantity barely composes; low cap
//
// Unknown categories fall back to `finite` (conservative: flag and ask
// rather than silently allow an unclassifiable bulk order).

import { statThreshold } from './evstats.js';

export const CATEGORY_CLASS = {
  bulk: ['groceries', 'household', 'home_improvement'],
  gift: ['gift_card', 'subscriptions', 'membership'],
  finite: ['clothing', 'electronics', 'sporting_goods', 'cosmetics', 'books'],
  service: ['dining', 'food_delivery', 'fuel', 'hotel', 'transport'],
};

export const BASE_CAPS = { bulk: 500, gift: 2, finite: 12, service: 20 };

const CLASS_OF = new Map(
  Object.entries(CATEGORY_CLASS).flatMap(([cls, cats]) => cats.map(c => [c, cls]))
);

export function categoryClass(category) {
  return CLASS_OF.get(String(category ?? '').trim().toLowerCase()) ?? 'finite';
}

export function baseCap(category) {
  return BASE_CAPS[categoryClass(category)];
}

/** Adaptive cap for one line item: never below the class base, raised to
 *  3× the customer's own observed maximum in that category when the trained
 *  profile carries qty_max_by_category (self-adjusts to what the user
 *  usually orders). Returns { cap, adaptive }. */
export function qtyCap(category, qtyMaxByCategory) {
  const base = baseCap(category);
  const observed = Math.max(0, Number(qtyMaxByCategory?.[category]) || 0);
  return observed * 3 > base
    ? { cap: observed * 3, adaptive: true }
    : { cap: base, adaptive: false };
}

/** Statistically-informed cap for one line item: fits the customer's own
 *  per-category quantity sample (GEV / GPD-POT / robust MAD — lib/evstats.js)
 *  and clamps the result between the deterministic floor and a hard ceiling.
 *  Returns null when the sample is too small for any method (caller falls
 *  back to `qtyCap`). Engine-side enforcement only — the trained feature 14
 *  and the Python trainer stay on the stable `qtyCap` heuristic above. */
export function statCap(category, samples, qtyMaxByCategory) {
  const base = baseCap(category);
  const observed = Math.max(0, Number(qtyMaxByCategory?.[category]) || 0);
  const incumbent = qtyCap(category, qtyMaxByCategory).cap;
  const st = statThreshold(samples, { floor: base, observedMax: observed, heuristicFloor: incumbent });
  if (!st || !st.used.length) return null; // no fit spoke → caller keeps qtyCap
  return { cap: st.value, adaptive: true, method: st.used, n: st.n, detail: st.detail };
}
