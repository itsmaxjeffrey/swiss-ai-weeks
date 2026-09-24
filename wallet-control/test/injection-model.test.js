// LEASH wallet-control — prompt-injection model: parity + engine integration.
// Run: node test/injection-model.test.js
//
// The scorer must stay in lockstep with the Python trainer
// (merchant-trust-data/models/prompt_injection/train_detector.py), which also
// emits parity_vectors.json and the deployment fixtures used here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../lib/engine.js';
import { scoreInjectionText, scanInjectionModel, getInjectionModel } from '../lib/injection-model.js';
import { HistoryProfiles } from '../lib/history.js';
import { buildTrustIndex } from '../lib/signals.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(ROOT, '../data/pack');
const MT = path.join(ROOT, '../../merchant-trust-data/models/prompt_injection');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const profiles = HistoryProfiles.load(path.join(PACK, 'authorization_history.csv'));
const trust = buildTrustIndex({ malicious_domains: {}, legit_companies: [] });

const knownProfiles = new HistoryProfiles([{ customer_id: 'CU_T', merchant_id: 'ME_T1', merchant_name: 'Test Merchant', status: 'approved', timestamp: '2026-08-01T10:00:00Z', customer_device_id: 'DVC_KNOWN' }]);

const emptyState = {
  approvedSpendInWindow: () => 0,
  inRunApprovedMerchant: () => false,
  findDuplicate: () => null,
  priorDecisions: () => new Map(),
};

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

// ---------------------------------------------------------------------------
console.log('\n— injection model: artifact + parity —');

const model = getInjectionModel();
test('model artifact deployed and well-formed', () => {
  assert.ok(model, 'injection-model.json not found (checked lib/ and merchant-trust-data)');
  assert.equal(model.schema, 'openclaw.injection-model/1');
  assert.ok(model.threshold > 0 && model.threshold < 1);
  assert.ok(Object.keys(model.weights).length > 1000, 'suspiciously few exported features');
});

const parity = JSON.parse(readFileSync(path.join(MT, 'parity_vectors.json'), 'utf8')).parity;
test(`score parity with Python trainer (${parity.length} vectors, ±1e-6)`, () => {
  for (const p of parity) {
    const r = scoreInjectionText(p.text);
    assert.ok(r, 'scorer returned null — artifact missing?');
    assert.ok(Math.abs(r.score - p.p) < 1e-6,
      `score drift on "${p.text.slice(0, 60)}…": js ${r.score} vs py ${p.p}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n— injection model: deployment behaviour —');

const fixtures = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/injection_cases.json'), 'utf8'));

test(`model catches ${fixtures.injection_cases.length} real attacks that the regex scan misses (engine escalates)`, () => {
  for (const c of fixtures.injection_cases) {
    const r = scoreInjectionText(c.text);
    assert.ok(r.score >= model.threshold,
      `fixture below threshold: ${r.score} < ${model.threshold} on "${c.text.slice(0, 60)}…"`);
    const ev = baseEvent({ authorization: { items: [{ line_no: 1, item_id: 'IT1', item_name: 'Fresh produce', item_category: 'groceries', quantity: 1, unit_price: 20, currency: 'CHF', item_details: c.text }] } });
    const out = evaluate(ev, emptyState, knownProfiles, trust);
    assert.equal(out.decision, 'step_up', `expected step_up for "${c.text.slice(0, 60)}…"`);
    assert.ok(out.reason_codes.includes('INJECTION_ATTEMPT'));
    assert.ok(out.flags.manipulation.some(m => m.code === 'INJ_MODEL'));
  }
});

test(`benign product text stays quiet (${fixtures.benign_cases.length} cases, score < suspect band)`, () => {
  const suspect = Math.min(0.6, model.threshold * 0.55);
  for (const c of fixtures.benign_cases) {
    const r = scoreInjectionText(c.text);
    assert.ok(r.score < suspect,
      `benign text scored ${r.score} >= suspect band ${suspect.toFixed(3)}: "${c.text.slice(0, 60)}…"`);
    const ev = baseEvent({ authorization: { items: [{ line_no: 1, item_id: 'IT1', item_name: 'Fresh produce', item_category: 'groceries', quantity: 1, unit_price: 20, currency: 'CHF', item_details: c.text }] } });
    const out = evaluate(ev, emptyState, knownProfiles, trust);
    assert.equal(out.decision, 'approve', `benign text escalated: "${c.text.slice(0, 60)}…"`);
    assert.ok(!out.reason_codes.includes('INJECTION_SUSPECT'));
  }
});

test('scanInjectionModel returns per-field scores + evidence snippet', () => {
  const scan = scanInjectionModel([
    { field: 'item_details', text: 'Seasonal fruit and vegetables, a weekly produce basket.' },
    { field: 'purchase_description', text: fixtures.injection_cases[0].text },
  ]);
  assert.ok(scan);
  assert.equal(scan.best.field, 'purchase_description');
  assert.ok(scan.best.score >= scan.threshold);
  assert.ok(scan.best.snippet.length > 0);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
