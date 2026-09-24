// LEASH wallet-control — user-behavior model: parity + engine integration.
// Run: node test/behavior-model.test.js
//
// The scorer must stay in lockstep with the Python trainer
// (merchant-trust-data/models/behavior/train_behavior.py), which emits
// parity_vectors.json at training time. The DEPLOYED artifact
// (lib/behavior-model.json, gitignored) must reproduce those vectors — a
// stale deploy fails here. The layer is advisory-only: evidence + uncertainty
// routed by the customer's uncertainty policy; never approves/declines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../lib/engine.js';
import { scoreBehavior, behaviorFeatures, getBehaviorModel } from '../lib/behavior-model.js';
import { HistoryProfiles } from '../lib/history.js';
import { buildTrustIndex } from '../lib/signals.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(ROOT, '../data/pack');
const MT = path.join(ROOT, '../../merchant-trust-data/models/behavior');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const profiles = HistoryProfiles.load(path.join(PACK, 'authorization_history.csv'));
const trust = buildTrustIndex({ malicious_domains: {}, legit_companies: [] });

const emptyState = {
  approvedSpendInWindow: () => 0,
  inRunApprovedMerchant: () => false,
  findDuplicate: () => null,
  priorDecisions: () => new Map(),
};

console.log('\n— behavior model artifact —');

const model = getBehaviorModel();
test('artifact deployed and schema-valid', () => {
  assert.ok(model, 'no behavior-model artifact found (deploy lib/behavior-model.json)');
  assert.equal(model.schema, 'openclaw.behavior-model/1');
  assert.equal(model.features.length, 13);
  assert.ok(model.thresholds.escalate > model.thresholds.suspect);
  assert.ok(model.profiles.CU0001, 'pack customer CU0001 has a learned profile');
});

const parity = JSON.parse(readFileSync(path.join(MT, 'parity_vectors.json'), 'utf8'));

console.log('\n— python/js feature parity —');
test(`feature parity on all ${parity.length} trainer vectors (±1e-9)`, () => {
  for (const c of parity) {
    const profile = model.profiles[c.customer_id];
    assert.ok(profile, `${c.customer_id} profile present`);
    const f = behaviorFeatures(c.inputs, profile);
    c.features.forEach((v, i) => {
      assert.ok(Math.abs(f[i] - v) <= 1e-9, `${c.case} feature[${i}] (${model.features[i]}): js ${f[i]} vs py ${v}`);
    });
  }
});

test(`score parity on all ${parity.length} trainer vectors (±1e-6)`, () => {
  for (const c of parity) {
    const r = scoreBehavior(c.inputs, c.customer_id);
    assert.ok(r, `${c.case} scores`);
    assert.ok(Math.abs(r.score - c.expected_score) <= 1e-6,
      `${c.case}: js ${r.score} vs py ${c.expected_score}`);
  }
});

test('band mapping: ordinary attempt normal, extreme synthetic escalates', () => {
  const ordinary = parity.find(c => c.case === 'AU0001');
  const extreme = parity.find(c => c.case === 'PARITY_HUGE');
  assert.equal(scoreBehavior(ordinary.inputs, ordinary.customer_id).band, 'normal');
  assert.equal(scoreBehavior(extreme.inputs, extreme.customer_id).band, 'escalate');
});

test('factors carry plain-language labels', () => {
  const extreme = parity.find(c => c.case === 'PARITY_HUGE');
  const r = scoreBehavior(extreme.inputs, extreme.customer_id);
  assert.ok(r.factors.length >= 1);
  assert.ok(r.factors.every(f => f.label && f.feature));
});

console.log('\n— inertness / degradation —');
test('unknown customer -> layer inert', () => {
  const c = parity[0];
  assert.equal(scoreBehavior(c.inputs, 'CU_NOBODY'), null);
});
test('missing/unreadable amount -> layer inert', () => {
  const c = parity[0];
  assert.equal(scoreBehavior({ ...c.inputs, billing_amount_chf: 'not-a-number' }, c.customer_id), null);
  assert.equal(scoreBehavior(null, c.customer_id), null);
});

console.log('\n— engine integration (advisory only) —');

const baseAuth = (over = {}) => ({
  authorization_id: 'AU_T1', source_authorization_id: 'AU_T1', scenario_id: 'SCENTEST',
  replay_order: 1, mandate_id: 'TM_T', profile_id: 'P1', card_id: 'CA0001', initiator_type: 'agent',
  merchant: { merchant_id: 'ME0001', merchant_name: 'Migros', merchant_category: 'groceries', merchant_mcc: '5411', merchant_country: 'CH', merchant_city: 'Zurich', availability: 'online', recurring_capable: 'false' },
  timestamp: '2026-08-10T10:00:00Z', amount: 20, currency: 'CHF', billing_amount_chf: 20,
  items_subtotal: 20, delivery_fee: 0, channel: 'ecommerce', customer_device_id: 'DVC-13A598',
  authority_status: 'active', card_status_at_attempt: 'active', spend_in_period_before_chf: 0,
  recent_attempt_count_10m: 0, fulfillment_method: 'delivery', delivery_by: '2026-08-11',
  order_returnable: 'unknown', order_cancellable: 'unknown', related_authorization_id: null,
  related_authorization_status: null, purchase_description: 'grocery order',
  items: [{ line_no: 1, item_id: 'IT1', item_name: 'Fresh produce', item_category: 'groceries', quantity: 1, unit_price: 20, currency: 'CHF', item_details: 'fruit and vegetables' }],
  ...over,
});
const baseEvent = (overAuth = {}, overMandate = {}) => ({
  type: 'authorization.request', request_id: 'req_t', deadline_at: new Date(Date.now() + 8000).toISOString(),
  authorization: baseAuth(overAuth),
  mandate: { mandate_id: 'TM_T', status: 'active', customer_id: 'CU0001', instruction: 'test', hard_rules: [], uncertainty_policy: 'ask', ...overMandate },
  context: { approved_spend_in_period_chf: 0, recent_authorizations: [] },
  runtime: { received_at: new Date().toISOString(), history_window_minutes: 10, context_basis: 'test' },
});

test('evidence grid carries the behavior-model row on ordinary purchases', () => {
  const out = evaluate(baseEvent(), emptyState, profiles, trust);
  const row = out.evidence.find(e => e.label === 'Behavior model');
  assert.ok(row, 'behavior evidence row present');
  assert.match(row.value, /normal/);
  assert.equal(out.decision, 'approve', 'advisory layer must not downgrade an ordinary purchase');
  assert.ok(!out.reason_codes.includes('BEHAVIOR_ANOMALY'));
});

test('escalate-band anomaly adds BEHAVIOR_ANOMALY uncertainty (ask → step_up)', () => {
  // CHF 5000 in USD from a never-seen US merchant at 03:00 on a new device,
  // burst velocity — the trainer's extreme parity case.
  const extreme = parity.find(c => c.case === 'PARITY_HUGE');
  const inp = extreme.inputs;
  const out = evaluate(baseEvent({
    billing_amount_chf: Number(inp.billing_amount_chf), amount: Number(inp.billing_amount_chf),
    currency: inp.currency, timestamp: inp.timestamp, channel: inp.channel,
    customer_device_id: inp.customer_device_id, recent_attempt_count_10m: Number(inp.recent_attempt_count_10m),
    items_subtotal: Number(inp.billing_amount_chf), delivery_fee: 0,
    merchant: { merchant_id: inp.merchant_id, merchant_name: 'ForeignGiant', merchant_category: inp.merchant_category, merchant_mcc: '9999', merchant_country: inp.merchant_country, merchant_city: 'Lima', availability: 'online', recurring_capable: 'false' },
    items: [{ line_no: 1, item_id: 'IT9', item_name: 'Unknown gadget', item_category: inp.merchant_category, quantity: 1, unit_price: Number(inp.billing_amount_chf), currency: inp.currency, item_details: 'gadget' }],
  }), emptyState, profiles, trust);
  assert.ok(out.reason_codes.includes('BEHAVIOR_ANOMALY'), `reason codes: ${out.reason_codes}`);
  assert.equal(out.decision, 'step_up', 'default uncertainty policy (ask) pauses the anomaly');
});

test('escalate-band anomaly under uncertainty_policy=approve stays approve (policy arbitrates)', () => {
  const extreme = parity.find(c => c.case === 'PARITY_HUGE');
  const inp = extreme.inputs;
  const ev = baseEvent({
    billing_amount_chf: Number(inp.billing_amount_chf), amount: Number(inp.billing_amount_chf),
    currency: inp.currency, timestamp: inp.timestamp, channel: inp.channel,
    customer_device_id: inp.customer_device_id, recent_attempt_count_10m: Number(inp.recent_attempt_count_10m),
    items_subtotal: Number(inp.billing_amount_chf), delivery_fee: 0,
    merchant: { merchant_id: inp.merchant_id, merchant_name: 'ForeignGiant', merchant_category: inp.merchant_category, merchant_mcc: '9999', merchant_country: inp.merchant_country, merchant_city: 'Lima', availability: 'online', recurring_capable: 'false' },
    items: [{ line_no: 1, item_id: 'IT9', item_name: 'Unknown gadget', item_category: inp.merchant_category, quantity: 1, unit_price: Number(inp.billing_amount_chf), currency: inp.currency, item_details: 'gadget' }],
  }, { uncertainty_policy: 'approve' });
  // strip device/hour uncertainties' trigger fields? No — policy 'approve' routes ALL uncertainties to approve.
  const out = evaluate(ev, emptyState, profiles, trust);
  assert.equal(out.decision, 'approve', 'behavior layer never overrides the customer policy upward');
  assert.ok(out.reason_codes.includes('BEHAVIOR_ANOMALY'));
});

test('layer inert for unknown-customer mandate (no profile)', () => {
  // policy=approve isolates the behavior layer: without a profile the layer
  // adds nothing at all — no evidence row, no BEHAVIOR_ANOMALY code — and the
  // event approves (device-novelty uncertainty routes to the policy, which is
  // approve here).
  const out = evaluate(baseEvent({}, { customer_id: 'CU_NOBODY', uncertainty_policy: 'approve' }), emptyState, profiles, trust);
  assert.ok(!out.evidence.some(e => e.label === 'Behavior model'));
  assert.ok(!out.reason_codes.includes('BEHAVIOR_ANOMALY'));
  assert.equal(out.decision, 'approve');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
