// Market-intel integration tests: popularity ranks (Tranco ∪ Majestic),
// sanctions screen (SECO/OFAC/UN), MCC fraud priors (TabFormer), and their
// engine wiring. Run: node test/market-intel.test.js
import assert from 'node:assert/strict';
import { evaluate } from '../lib/engine.js';
import { HistoryProfiles } from '../lib/history.js';
import { buildTrustIndex, hydrateMarketIntel, popularityLookup, sanctionsLookup, mccRiskLookup } from '../lib/signals.js';
import { readJsonIfExists } from '../lib/util.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const emptyState = {
  approvedSpendInWindow: () => 0,
  inRunApprovedMerchant: () => false,
  findDuplicate: () => null,
  priorDecisions: () => new Map(),
};
const strangerProfiles = new HistoryProfiles([]); // customer has never bought anywhere
const knownProfiles = new HistoryProfiles([
  { customer_id: 'CU_T', merchant_id: 'ME_T1', merchant_name: 'Test Merchant', status: 'approved', timestamp: '2026-08-01T10:00:00Z', customer_device_id: 'DVC_KNOWN' },
]);

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

// deterministic market-intel fixture (no network, no real data files needed)
const mccFixture = {
  base_rate: 0.19715, sample_median_mcc_rate: 0.1669,
  mccs: {
    '5411': { n: 13098, frauds: 812, rate: 0.062, high: false },
    '5732': { n: 784, frauds: 731, rate: 0.932, high: true },
  },
};
const trust = hydrateMarketIntel(buildTrustIndex({ malicious_domains: { 'evil-phish-site.example': 'phishing' }, legit_companies: [] }), {
  popularity: { domains: { 'google.com': { r: 1, s: 'tranco' }, 'example.co.uk': { r: 4200, s: 'majestic' } } },
  sanctions: { names: { aerocaribbeanairlines: { n: 'AEROCARIBBEAN AIRLINES', s: 'ofac' } } },
  mccRisk: mccFixture,
});

console.log('\n— popularity lookup —');
test('exact domain hit', () => {
  assert.deepEqual(popularityLookup('google.com', trust), { domain: 'google.com', rank: 1, source: 'tranco' });
});
test('www prefix stripped', () => {
  assert.equal(popularityLookup('www.google.com', trust).rank, 1);
});
test('falls back to registrable base domain', () => {
  assert.equal(popularityLookup('shop.example.co.uk', trust).rank, 4200);
});
test('miss returns null; absent dataset returns null; empty domain safe', () => {
  assert.equal(popularityLookup('unknown-shop.ch', trust), null);
  assert.equal(popularityLookup('google.com', null), null);
  assert.equal(popularityLookup('', trust), null);
});

console.log('— sanctions lookup —');
test('exact normalized match, case/whitespace insensitive', () => {
  assert.deepEqual(sanctionsLookup('AEROCARIBBEAN   airlines', trust), { source: 'ofac', name: 'AEROCARIBBEAN AIRLINES' });
});
test('no fuzzy matching: partial names never hit', () => {
  assert.equal(sanctionsLookup('Aerocaribbean Airlines of Switzerland', trust), null);
});
test('miss / empty / absent dataset are null', () => {
  assert.equal(sanctionsLookup('Test Merchant', trust), null);
  assert.equal(sanctionsLookup('', trust), null);
  assert.equal(sanctionsLookup('AEROCARIBBEAN AIRLINES', null), null);
});

console.log('— MCC risk lookup —');
test('high-risk MCC returns entry; low-risk MCC returns null', () => {
  assert.equal(mccRiskLookup('5732', trust).rate, 0.932);
  assert.equal(mccRiskLookup('5411', trust), null);
});
test('missing MCC / absent dataset are null', () => {
  assert.equal(mccRiskLookup(null, trust), null);
  assert.equal(mccRiskLookup('5732', null), null);
});

console.log('— engine wiring —');
test('SANCTIONS_MATCH declines an otherwise clean purchase', () => {
  const ev = baseEvent({ authorization: { merchant: { merchant_id: 'ME_NEW', merchant_name: 'Aerocaribbean Airlines', merchant_category: 'travel', merchant_mcc: '4722', merchant_country: 'CU', merchant_city: 'Havana' } } });
  const out = evaluate(ev, emptyState, strangerProfiles, trust);
  assert.equal(out.decision, 'decline');
  assert.ok(out.reason_codes.includes('SANCTIONS_MATCH'), `reason_codes: ${out.reason_codes}`);
});
test('malicious merchant IP (FeodoTracker/AbuseIPDB) declines as TRUSTLIST_HIT', () => {
  const t2 = hydrateMarketIntel(buildTrustIndex({ malicious_domains: {}, legit_companies: [] }), {});
  t2.malicious_ips = { '185.220.101.5': 'feodo:Emotet' };
  const ev = baseEvent({ authorization: { merchant: { merchant_id: 'ME_NEW', merchant_name: 'Sneaky Shop', merchant_category: 'electronics', merchant_mcc: '5732', merchant_ip: '185.220.101.5' } } });
  const out = evaluate(ev, emptyState, strangerProfiles, t2);
  assert.equal(out.decision, 'decline');
  assert.ok(out.reason_codes.includes('TRUSTLIST_HIT'));
});
test('first purchase at an unfamiliar shop in a high-fraud MCC escalates', () => {
  const ev = baseEvent({ authorization: { merchant: { merchant_id: 'ME_NEW', merchant_name: 'New Electronics Store', merchant_category: 'electronics', merchant_mcc: '5732' } } });
  const out = evaluate(ev, emptyState, strangerProfiles, trust);
  assert.equal(out.decision, 'step_up');
  assert.ok(out.uncertainties.some(u => u.code === 'MCC_FRAUD_PATTERN'), JSON.stringify(out.uncertainties));
  assert.ok(out.uncertainties.find(u => u.code === 'MCC_FRAUD_PATTERN').detail.includes('TabFormer'));
});
test('same MCC at a shop the customer already uses stays frictionless', () => {
  const ev = baseEvent(); // ME_T1 is familiar via knownProfiles
  const out = evaluate(ev, emptyState, knownProfiles, trust);
  assert.equal(out.decision, 'approve');
  assert.ok(!out.uncertainties.some(u => u.code === 'MCC_FRAUD_PATTERN'));
});
test('popularity is evidence only: decision unchanged, evidence cited', () => {
  const ev = baseEvent({ authorization: { merchant: { merchant_id: 'ME_T1', merchant_name: 'Test Merchant', merchant_category: 'groceries', merchant_mcc: '5411', merchant_url: 'https://www.google.com/' } } });
  const out = evaluate(ev, emptyState, knownProfiles, trust);
  assert.equal(out.decision, 'approve');
  assert.ok(out.evidence.some(e => e.label === 'Merchant popularity' && /#1/.test(e.value)));
  assert.ok(out.flags.positive.some(p => p.code === 'POPULAR_DOMAIN'));
});

console.log('— real built datasets (repo files) —');
{
  const real = hydrateMarketIntel(buildTrustIndex(readJsonIfExists(path.join(ROOT, '..', 'data', 'leash_trust.json')) || {}), {
    popularity: readJsonIfExists(path.join(ROOT, '..', 'data', 'popularity.json')),
    sanctions: readJsonIfExists(path.join(ROOT, '..', 'data', 'sanctions_names.json')),
    mccRisk: readJsonIfExists(path.join(ROOT, '..', 'data', 'mcc_risk.json')),
  });
  test('popularity index has the global top site at #1', () => {
    assert.equal(popularityLookup('www.google.com', real).rank, 1);
  });
  test('sanctions index contains a known OFAC entry', () => {
    assert.equal(sanctionsLookup('AEROCARIBBEAN AIRLINES', real).source, 'ofac');
  });
  test('TabFormer MCC priors flag electronics (5732) as high-risk', () => {
    assert.equal(mccRiskLookup('5732', real).mcc, '5732');
  });
  test('trust v2 carries malicious IPs and 10k+ bad domains', () => {
    assert.ok(Object.keys(real.malicious_ips || {}).length >= 100);
    assert.ok(Object.keys(real.malicious_domains || {}).length >= 10000);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
