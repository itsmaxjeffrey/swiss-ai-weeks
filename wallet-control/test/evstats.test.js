// LEASH wallet-control — statistical threshold estimators (lib/evstats.js) and
// their integration into the engine's quantity cap (lib/item-classes.js §6c).
// Run: node test/evstats.test.js
import assert from 'node:assert/strict';
import {
  gammaFn, lmoments, gevLmomFit, gevQuantile, gpdLmomFit, potQuantile,
  madBaseline, cleanSamples, statThreshold,
} from '../lib/evstats.js';
import { qtyCap, statCap, baseCap } from '../lib/item-classes.js';
import { evaluate } from '../lib/engine.js';
import { getBehaviorModel, setBehaviorModelForTest } from '../lib/behavior-model.js';
import { HistoryProfiles } from '../lib/history.js';
import { buildTrustIndex } from '../lib/signals.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(ROOT, '../data/pack');
const trust = buildTrustIndex({ malicious_domains: { 'evil-phish-site.example': 'phishing' }, legit_companies: [] });

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const closeTo = (x, y, tol) => Math.abs(x - y) <= tol;

// deterministic PRNG (mulberry32) — same seed as the benchmark harness
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('\n— evstats: special functions & estimators —');

test('gammaFn exact values (Γ(1)=1, Γ(5)=24, Γ(0.5)=√π)', () => {
  assert.ok(closeTo(gammaFn(1), 1, 1e-10));
  assert.ok(closeTo(gammaFn(5), 24, 1e-9));
  assert.ok(closeTo(gammaFn(0.5), Math.sqrt(Math.PI), 1e-9));
});

test('lmoments of [1,2,3]: l1=2, l2=2/3, l3=0 (symmetric)', () => {
  const { l1, l2, l3 } = lmoments([1, 2, 3]);
  assert.ok(closeTo(l1, 2, 1e-12));
  assert.ok(closeTo(l2, 2 / 3, 1e-12));
  assert.ok(closeTo(l3, 0, 1e-12));
});

test('GEV quantile matches the closed-form Gumbel limit', () => {
  const v = gevQuantile(0.5, { mu: 10, sigma: 2, xi: 0 });
  assert.ok(closeTo(v, 10 - 2 * Math.log(Math.log(2)), 1e-12));
  const w = gevQuantile(0.999, { mu: 0, sigma: 1, xi: 0.2 });
  assert.ok(closeTo(w, (1 - Math.pow(-Math.log(0.999), 0.2)) / 0.2, 1e-12));
});

test('GEV L-moment fit recovers a known Gumbel(3,2) sample', () => {
  const r = rng(42);
  const xs = Array.from({ length: 400 }, () => 3 - 2 * Math.log(-Math.log(r()))); // x(F)=μ−σ·ln(−ln F)
  const fit = gevLmomFit(xs);
  assert.ok(fit, 'fit should succeed');
  assert.ok(Math.abs(fit.xi) < 0.15, `xi ${fit.xi} should be ~0 for Gumbel`);
  assert.ok(closeTo(fit.sigma, 2, 0.2), `sigma ${fit.sigma}`);
  assert.ok(closeTo(fit.mu, 3, 0.2), `mu ${fit.mu}`);
});

test('degenerate GEV samples refuse to fit (null, never NaN params)', () => {
  assert.equal(gevLmomFit([1, 1, 1, 1]), null, 'constant sample');
  assert.equal(gevLmomFit([1, 2, 3]), null, 'too few points');
});

test('GPD fit recovers Exp(1) exceedances and POT quantile matches xi=0 formula', () => {
  const r = rng(7);
  const exceed = Array.from({ length: 300 }, () => -Math.log(r()));
  const fit = gpdLmomFit(exceed);
  assert.ok(fit, 'fit should succeed');
  assert.ok(Math.abs(fit.xi) < 0.25, `xi ${fit.xi} should be ~0 for exponential`);
  assert.ok(closeTo(fit.sigma, 1, 0.2), `sigma ${fit.sigma}`);
  const u = 2, n = 100, nExceed = 25, k = 10;
  const v = potQuantile(u, n, nExceed, k, { sigma: 1, xi: 0 });
  assert.ok(closeTo(v, u + 1 * Math.log((n / nExceed) * (1 - 1 / (k * n))), 1e-12));
});

test('madBaseline: known sample; degenerate all-equal sample → null', () => {
  // median 3.5; abs devs sorted [0.5,0.5,1.5,1.5,2.5,96.5] → MAD = (1.5+1.5)/2 = 1.5
  const v = madBaseline([1, 2, 3, 4, 5, 100]);
  assert.ok(closeTo(v, 3.5 + 6 * 1.4826 * 1.5, 1e-9));
  assert.equal(madBaseline([7, 7, 7, 7]), null);
});

test('cleanSamples filters junk and caps length at 64 (most recent kept)', () => {
  const { xs } = cleanSamples([3, 'x', -1, 0, NaN, Infinity, 5, null, 2.5]);
  assert.deepEqual(xs, [3, 5, 2.5]);
  const long = Array.from({ length: 80 }, (_, i) => i + 1);
  assert.equal(cleanSamples(long).xs.length, 64);
  assert.equal(cleanSamples(long).xs[0], 17, 'kept the LAST 64');
});

console.log('\n— evstats: threshold semantics —');

test('statThreshold stays inert on a degenerate all-ones sample', () => {
  assert.equal(statThreshold([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { floor: 12, observedMax: 1 }), null);
});

test('statThreshold with only an incumbent rule: value == incumbent, no methods', () => {
  const st = statThreshold([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { floor: 12, observedMax: 1, heuristicFloor: 12 });
  assert.ok(st, 'incumbent alone yields a value');
  assert.equal(st.value, 12);
  assert.deepEqual(st.used, []);
});

test('statThreshold never flags below floor or observed max, never above ceiling', () => {
  const sample = [1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 6, 8, 10, 12, 15, 500];
  const obsMax = 500;
  const st = statThreshold(sample, { floor: 12, observedMax: 2 });
  assert.ok(st, 'rich sample should fit');
  assert.ok(st.value >= 12, '>= floor');
  assert.ok(st.value >= obsMax, '>= observed max');
  assert.ok(st.value <= Math.max(10 * 12, 10 * obsMax), '<= ceiling');
});

test('statistical result can only loosen: value >= incumbent heuristic cap', () => {
  const sample = [2, 4, 4, 5, 6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 25, 28, 30, 33, 36];
  const incumbent = Math.max(12, 3 * 36);
  const st = statThreshold(sample, { floor: 12, observedMax: 36, heuristicFloor: incumbent });
  assert.ok(st.value >= incumbent, `${st.value} >= ${incumbent}`);
});

console.log('\n— item-classes: statCap —');

test('statCap returns null for too-few samples (caller falls back to qtyCap)', () => {
  assert.equal(statCap('clothing', [1, 2, 3], {}), null);
  assert.equal(statCap('clothing', [], {}), null);
});

test('statCap returns a fit with method list and respects the deterministic floor', () => {
  const samples = [2, 4, 4, 5, 6, 8, 40];
  const qtyMax = { clothing: 40 };
  const st = statCap('clothing', samples, qtyMax);
  assert.ok(st, 'mad should speak for this sample');
  assert.equal(st.cap, qtyCap('clothing', qtyMax).cap, 'incumbent floor wins when fits are lower');
  assert.ok(st.method.includes('mad'));
  assert.equal(st.adaptive, true);
  assert.ok(st.n === 7);
});

test('statCap across categories keeps the deterministic base as floor', () => {
  const st = statCap('gift_card', [1, 1, 2, 1, 3, 1, 1, 2, 5, 1, 2, 1], { gift_card: 5 });
  assert.ok(st.cap >= baseCap('gift_card'), 'never below the class base cap');
});

console.log('\n— engine §6c integration (statistical path) —');

const baseAuth = (over = {}) => ({
  authorization_id: 'AU_T1', source_authorization_id: 'AU_T1', scenario_id: 'SCENTEST',
  replay_order: 1, mandate_id: 'TM_T', profile_id: 'P1', card_id: 'CA_T', initiator_type: 'agent',
  merchant: { merchant_id: 'ME_T1', merchant_name: 'Test Merchant', merchant_category: 'groceries', merchant_mcc: '5411', merchant_country: 'CH', merchant_city: 'Zurich', availability: 'online', recurring_capable: 'false' },
  timestamp: '2026-08-10T10:00:00Z', amount: 20, currency: 'CHF', billing_amount_chf: 20,
  items_subtotal: 20, delivery_fee: 0, channel: 'ecommerce', customer_device_id: 'DVC_KNOWN',
  authority_status: 'active', card_status_at_attempt: 'active', spend_in_period_before_chf: 0,
  recent_attempt_count_10m: 0, fulfillment_method: 'delivery', delivery_by: '2026-08-11',
  order_returnable: 'unknown', order_cancellable: 'unknown', related_authorization_id: null,
  related_authorization_status: null, purchase_description: 'grocery order',
  items: [{ line_no: 1, item_id: 'IT1', item_name: 'Fresh produce', item_category: 'groceries', quantity: 1, unit_price: 20, currency: 'CHF', item_details: 'fruit and vegetables' }],
  ...over,
});
const baseEvent = (over = {}) => ({
  type: 'authorization.request', request_id: 'req_t', deadline_at: new Date(Date.now() + 8000).toISOString(),
  authorization: baseAuth(over.authorization),
  mandate: { mandate_id: 'TM_T', status: 'active', customer_id: 'CU_T', instruction: 'test', hard_rules: [], uncertainty_policy: 'ask', ...(over.mandate || {}) },
  context: { approved_spend_in_period_chf: 0, recent_authorizations: [] },
  runtime: { received_at: new Date().toISOString(), history_window_minutes: 10, context_basis: 'test' },
});
const emptyState = {
  approvedSpendInWindow: () => 0,
  inRunApprovedMerchant: () => false,
  findDuplicate: () => null,
  priorDecisions: () => new Map(),
};
const knownProfiles = new HistoryProfiles([{ customer_id: 'CU_T', merchant_id: 'ME_T1', merchant_name: 'Test Merchant', status: 'approved', timestamp: '2026-08-01T10:00:00Z', customer_device_id: 'DVC_KNOWN' }]);

const shoesEvent = (qty) => baseEvent({
  authorization: {
    billing_amount_chf: qty * 100, amount: qty * 100, items_subtotal: qty * 100,
    purchase_description: 'running shoes',
    items: [{ line_no: 1, item_id: 'IT9', item_name: 'Trail running shoes', item_category: 'clothing', quantity: qty, unit_price: 100, currency: 'CHF', item_details: 'shoes' }],
  },
  mandate: { uncertainty_policy: 'approve' },
});

test('quantity history in the profile routes §6c through the statistical cap', () => {
  const real = getBehaviorModel();
  assert.ok(real, 'deployed behavior-model artifact must be present');
  const donor = Object.values(real.profiles)[0];
  const m = structuredClone(real);
  m.profiles.CU_T = {
    ...donor,
    qty_max_by_category: { clothing: 40 },
    qty_hist_by_category: { clothing: [2, 4, 4, 5, 6, 8, 40] },
  };
  setBehaviorModelForTest(m);
  try {
    const out = evaluate(shoesEvent(400), emptyState, knownProfiles, trust);
    assert.ok(out.reason_codes.includes('ITEM_QTY_ANOMALY'), JSON.stringify(out.reason_codes));
    assert.equal(out.decision, 'step_up', 'severe excess forces step-up under approve policy');
    const hay = `${out.customer_message} ${(out.evidence || []).join(' ')}`;
    assert.ok(hay.includes('statistical fit'), `expected statistical wording, got: ${hay.slice(0, 400)}`);
  } finally {
    setBehaviorModelForTest(real);
  }
});

test('without quantity history the §6c path keeps the heuristic wording', () => {
  const real = getBehaviorModel();
  const m = structuredClone(real);
  m.profiles.CU_T = { ...Object.values(real.profiles)[0], qty_max_by_category: {}, qty_hist_by_category: {} };
  setBehaviorModelForTest(m);
  try {
    const out = evaluate(shoesEvent(500), emptyState, knownProfiles, trust);
    assert.ok(out.reason_codes.includes('ITEM_QTY_ANOMALY'), JSON.stringify(out.reason_codes));
    const hay = `${out.customer_message} ${(out.evidence || []).join(' ')}`;
    assert.ok(!hay.includes('statistical fit'), 'no fit should be claimed without history');
  } finally {
    setBehaviorModelForTest(real);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
