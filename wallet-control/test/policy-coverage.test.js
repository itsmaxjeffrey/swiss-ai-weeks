import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy } from '../lib/policy-compiler.js';
import { loadCsv } from '../lib/util.js';
import { evaluate } from '../lib/engine.js';
import { HistoryProfiles } from '../lib/history.js';
import { buildTrustIndex } from '../lib/signals.js';

const rules = (draft, field) => draft.hard_rules.filter(r => r.field === field);
const review = draft => {
  assert.ok(draft.open_questions.length, 'Unsupported restriction must be visible');
  assert.equal(rules(draft, 'policy.requires_review').length, 1, 'Visible questions must block automatic approval');
};
const catalogue = loadCsv(new URL('../data/pack/scenario_catalogue.csv', import.meta.url));
for (const scenario of catalogue) {
  test(`current catalogue ${scenario.scenario_id}: supported caps retained; remaining details reviewable`, () => {
    const d = compilePolicy(scenario.cardholder_instruction);
    const caps = { SCEN0101: 20, SCEN0135: 100, SCEN0130: 180, SCEN0106: 300, SCEN0122: 900, SCEN0104: 190, SCEN0113: 40, SCEN0117: 100 };
    if (caps[scenario.scenario_id]) assert.ok(rules(d, 'authorization.billing_amount_chf').some(r => r.value === caps[scenario.scenario_id]));
    if (scenario.scenario_id === 'SCEN0101') assert.deepEqual(d.open_questions, []);
    else review(d);
    if (scenario.scenario_id === 'SCEN0135') assert.ok(rules(d, 'period.approved_spend_chf').some(r => r.value === 250 && r.period_days === 7));
    if (scenario.scenario_id === 'SCEN0130') assert.ok(rules(d, 'basket.return_window_days_min').some(r => r.value === 14));
    if (scenario.scenario_id === 'SCEN0124') {
      assert.ok(rules(d, 'booking.nightly_amount_chf').some(r => r.value === 200));
      assert.deepEqual(rules(d, 'basket.categories')[0].value, ['hotel']);
    }
  });
}
for (const instruction of [
  'Buy groceries up to CHF 100. No alcohol. Approve when uncertain.',
  'Buy groceries up to CHF 100. Only on weekdays.',
  'Buy groceries up to CHF 100. Maximum CHF 200 per month.',
  'Buy groceries up to CHF 100. Deliver before Friday.',
  'Buy groceries up to CHF 100 from Migros.',
  'Buy a waterproof jacket for CHF 100 or less.',
  'Buy new hiking boots size 42 for CHF 100 or less.',
  'Buy groceries for CHF 100 or less and no more than two orders a day.',
  'Buy a 27-inch monitor and a 32-inch monitor for CHF 500 or less.',
  'Buy hiking boots size 42 or size 43 for CHF 100 or less.',
  '',
]) test(`unresolved restriction cannot silently vanish: ${instruction || '(empty)'}`, () => review(compilePolicy(instruction)));

test('fully supported grocery instructions preserve low-friction automatic policy', () => {
  for (const instruction of ['Buy groceries up to CHF 100. Ask me when uncertain.', 'Buy groceries up to 100. Ask me when uncertain.', 'Buy one ordinary grocery item for CHF 20 or less from a shop I use regularly. Ask me when uncertain.']) {
    const d = compilePolicy(instruction);
    assert.deepEqual(d.open_questions, []);
    assert.equal(rules(d, 'policy.requires_review').length, 0);
  }
});
test('currency conversion, decimal and thousands amounts preserve purchasing limits', () => {
  for (const [amount, expected] of [['EUR 200', 190], ['USD 100', 87], ['GBP 100', 112], ['CHF 1,200.50', 1200.5], ['EUR 20,50', 19.48]]) {
    const d = compilePolicy(`Buy groceries up to ${amount}.`);
    assert.equal(rules(d, 'authorization.billing_amount_chf')[0]?.value, expected);
    assert.deepEqual(d.open_questions, []);
  }
});
test('both rolling budget word orders remain enforced', () => {
  for (const instruction of ['Buy groceries up to CHF 100 per order and CHF 250 in any 7-day window.', 'Order groceries. Keep the total across any seven days at or below CHF 300.']) {
    assert.ok(rules(compilePolicy(instruction), 'period.approved_spend_chf').some(r => r.period_days === 7));
  }
});
test('single item enforces quantity as well as line count', () => {
  const d = compilePolicy('Buy one grocery item for CHF 20 or less.');
  assert.equal(rules(d, 'basket.total_quantity')[0]?.value, 1);
});
test('unknown product remains reviewable even with a recognized budget', () => review(compilePolicy('Buy a zephyr blade for CHF 50 or less.')));

test('unresolved restrictions force human review despite approve-on-uncertainty', () => {
  const d = compilePolicy('Buy groceries up to CHF 100. No alcohol. Approve when uncertain.');
  const authorization = {
    authorization_id: 'COVERAGE_AUTH', source_authorization_id: 'COVERAGE_AUTH', mandate_id: 'COVERAGE_M',
    merchant: { merchant_id: 'M1', merchant_name: 'Test Grocer', merchant_category: 'groceries', merchant_country: 'CH', merchant_mcc: '5411' },
    timestamp: '2026-08-10T10:00:00Z', amount: 10, billing_amount_chf: 10, currency: 'CHF', items_subtotal: 10, delivery_fee: 0,
    channel: 'ecommerce', customer_device_id: 'D1', authority_status: 'active', card_status_at_attempt: 'active', recent_attempt_count_10m: 0,
    fulfillment_method: 'delivery', items: [{ item_id: 'I1', item_name: 'Fresh produce', item_category: 'groceries', quantity: 1, unit_price: 10, currency: 'CHF', item_details: 'fruit and vegetables' }],
  };
  const event = { type: 'authorization.request', request_id: 'COVERAGE_REQ', authorization, mandate: { ...d, mandate_id: 'COVERAGE_M', customer_id: 'C1', status: 'active' }, context: { approved_spend_in_period_chf: 0, recent_authorizations: [] }, runtime: { received_at: new Date().toISOString() } };
  const state = { approvedSpendInWindow: () => 0, inRunApprovedMerchant: () => false, findDuplicate: () => null, priorDecisions: () => new Map() };
  const profiles = new HistoryProfiles([{ customer_id: 'C1', merchant_id: 'M1', merchant_name: 'Test Grocer', status: 'approved', timestamp: '2026-08-01T10:00:00Z', customer_device_id: 'D1' }]);
  const result = evaluate(event, state, profiles, buildTrustIndex({ malicious_domains: {}, legit_companies: [] }));
  assert.equal(result.decision, 'step_up');
});
