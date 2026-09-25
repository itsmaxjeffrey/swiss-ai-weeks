// LEASH wallet-control — Trusted Shops checker + engine-integration invariants.
// Hermetic: all HTTP is a stubbed fetchImpl; run: node test/trustedshops.test.js
// Live smoke against the real API is separate: LEASH_TS_LIVE=1 node test/trustedshops.test.js
import assert from 'node:assert/strict';
import { normalizeDomain, parseMerchantInput, marketLabel, describeResult, TrustedShopsChecker } from '../lib/trustedshops.js';
import { evaluate } from '../lib/engine.js';
import { HistoryProfiles } from '../lib/history.js';

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(e => { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); });
}

// ---- fetch stub -------------------------------------------------------------
const LOOKUP_BODY = tsId => ({
  response: { code: 200, data: { shops: [{ tsId, url: 'www.testshop.ch', name: 'Testshop AG', languageISO2: 'de', targetMarketISO3: 'CHE' }] }, status: 'SUCCESS' },
});
const QUALITY_BODY = {
  response: { code: 200, data: { shop: { qualityIndicators: { reviewIndicator: {
    overallMark: 4.79, overallMarkDescription: 'EXCELLENT', totalReviewCount: 1703,
    activeReviewCount: 95, reviewsCountedSince: '2012-04-12' } } } }, status: 'SUCCESS' },
};

/** Stub fetch with route table [{match(url), status, body, delayMs}]; records calls and in-flight peak. */
function stubFetch(routes = []) {
  const calls = [];
  let inflight = 0, peak = 0;
  const fn = async (url, opts = {}) => {
    calls.push(url);
    inflight++; peak = Math.max(peak, inflight);
    try {
      const route = routes.find(r => r.match(url));
      if (!route) return { ok: false, status: 404, json: async () => ({}) };
      if (route.delayMs) await new Promise(r => setTimeout(r, route.delayMs));
      const status = route.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => (typeof route.body === 'function' ? route.body(url) : route.body) };
    } finally { inflight--; }
  };
  fn.calls = calls;
  fn.peak = () => peak;
  return fn;
}

// ---- engine fixtures (same shape as engine.test.js) --------------------------
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

// ---------------------------------------------------------------------------
console.log('\n— input normalization —');

await test('URL with scheme/path/query/port collapses to bare hostname', () => {
  assert.equal(normalizeDomain('https://www.brack.ch/cart?x=1').domain, 'www.brack.ch');
  assert.equal(normalizeDomain('HTTP://DIGITEC.CH:8443/a/b').domain, 'digitec.ch');
  assert.equal(normalizeDomain('m-s-v.eu').domain, 'm-s-v.eu');
  assert.equal(normalizeDomain('  https://www.rebuy.com/outlet  ').domain, 'www.rebuy.com');
});

await test('names, localhost, bare IPs are not domains (never invented into one)', () => {
  assert.equal(normalizeDomain('Alpine Basket'), null);
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain('192.168.1.1'), null);
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain(null), null);
  const p = parseMerchantInput({ name: 'PixelHarbour', country: 'CH' });
  assert.equal(p.domain, null);
  assert.equal(p.name, 'PixelHarbour');
  assert.equal(parseMerchantInput({ url: 'https://www.brack.ch/', name: 'Brack' }).domain, 'www.brack.ch');
});

await test('market labels map to the country Trusted Shops sites', () => {
  assert.match(marketLabel('CHE'), /trustedshops\.ch/);
  assert.match(marketLabel('DEU'), /trustedshops\.de/);
  assert.match(marketLabel('EUO'), /international/i);
  assert.equal(marketLabel('XYZ'), 'market XYZ');
});

console.log('\n— checker (stubbed API) —');

await test('listed merchant: lookup + quality merge into a primary with rating', async () => {
  const f = stubFetch([
    { match: u => u.includes('/shops.json?'), body: LOOKUP_BODY('XT1') },
    { match: u => u.includes('/quality.json'), body: QUALITY_BODY },
  ]);
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('https://www.testshop.ch/shop/item');
  assert.equal(r.listed, true);
  assert.equal(r.resolvedDomain, 'www.testshop.ch');
  assert.equal(r.primary.tsId, 'XT1');
  assert.equal(r.primary.rating.overallMark, 4.79);
  assert.equal(r.primary.rating.totalReviewCount, 1703);
  assert.match(r.primary.market, /Switzerland/);
  assert.ok(f.calls.some(u => u.includes('/shops.json?url=www.testshop.ch')));
  assert.ok(f.calls.some(u => u.includes('/shops/XT1/quality.json')));
});

await test('unlisted merchant: clean 404 → listed:false, no quality call', async () => {
  const f = stubFetch([{ match: u => u.includes('/shops.json?'), status: 404, body: { response: { code: 404, message: 'SHOP_URL_NOT_FOUND' } } }]);
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('digitec.ch');
  assert.equal(r.listed, false);
  assert.equal(f.calls.length, 1);
  assert.equal(describeResult(r).startsWith('not listed on Trusted Shops'), true);
});

await test('hung API: per-request timeout degrades to listed:null with reason', async () => {
  const f = (url, opts = {}) => new Promise((_, rej) => {
    opts.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted')));
  });
  const c = new TrustedShopsChecker({ fetchImpl: f, timeoutMs: 25 });
  const r = await c.checkOne('slow-shop.ch');
  assert.equal(r.listed, null);
  assert.match(r.reason, /check failed/);
  assert.equal(describeResult(r).includes('unavailable'), true);
});

await test('cache: repeat check is instant and does not re-fetch; cache misses counted', async () => {
  const f = stubFetch([{ match: u => u.includes('/shops.json?'), body: LOOKUP_BODY('XT2') }]);
  const c = new TrustedShopsChecker({ fetchImpl: f, timeoutMs: 200 });
  const a = await c.checkOne('cached-shop.ch');
  const lookupsAfterFirst = f.calls.filter(u => u.includes('/shops.json?')).length;
  const b = await c.checkOne('cached-shop.ch');
  assert.equal(lookupsAfterFirst, 1);
  assert.equal(f.calls.filter(u => u.includes('/shops.json?')).length, 1, 'second check must not re-fetch');
  assert.equal(a.fromCache, false);
  assert.equal(b.fromCache, true);
  assert.equal(c.stats.cacheHits, 1);
});

await test('batch: results in input order, concurrency cap respected', async () => {
  const f = stubFetch([{ match: u => u.includes('/shops.json?'), delayMs: 25, body: LOOKUP_BODY('XT3') }]);
  const c = new TrustedShopsChecker({ fetchImpl: f, concurrency: 4, timeoutMs: 500 });
  const inputs = ['a.ch', 'b.ch', 'c.ch', 'd.ch', 'e.ch', 'f.ch', 'g.ch', 'h.ch', 'i.ch', 'j.ch'];
  const out = await c.check(inputs);
  assert.equal(out.results.length, 10);
  assert.deepEqual(out.results.map(r => r.resolvedDomain), inputs.map(d => d));
  assert.ok(f.peak() <= 4, `peak in-flight ${f.peak()} exceeded cap 4`);
  assert.ok(out.tookMs < 10 * 25, 'batch should overlap requests');
});

await test('name-only merchant: unanswered honestly, no invented domain', async () => {
  const f = stubFetch();
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne({ name: 'Alpine Basket' });
  assert.equal(r.listed, null);
  assert.equal(r.resolvedDomain, null);
  assert.match(r.reason, /no domain supplied/);
  assert.equal(f.calls.length, 0);
});

console.log('\n— engine integration (advisory evidence only) —');

const tsListed = { resolvedDomain: 'www.testshop.ch', listed: true, checkedAt: '2026-09-25T01:00:00Z',
  shops: [], primary: { tsId: 'XT1', name: 'Testshop AG', registeredUrl: 'www.testshop.ch', targetMarket: 'CHE', market: 'Switzerland (trustedshops.ch)',
    rating: { overallMark: 4.79, description: 'EXCELLENT', totalReviewCount: 1703, activeReviewCount: 95, reviewsCountedSince: '2012-04-12' } } };
const tsUnlisted = { resolvedDomain: 'digitec.ch', listed: false, shops: [], primary: null, checkedAt: '2026-09-25T01:00:00Z' };
const tsFailed = { resolvedDomain: 'slow.ch', listed: null, shops: [], primary: null, reason: 'check failed: timeout', checkedAt: '2026-09-25T01:00:00Z' };

await test('listed merchant adds positive evidence but never changes an approval', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null, { trustedShops: tsListed });
  assert.equal(out.decision, 'approve');
  assert.ok(out.evidence.some(e => e.label === 'Trusted Shops' && /4\.79/.test(e.value)));
  assert.ok(out.flags.positive.some(p => p.code === 'TRUSTEDSHOPS_LISTED'));
});

await test('absence from Trusted Shops is neutral evidence — never a fail or uncertainty', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null, { trustedShops: tsUnlisted });
  assert.equal(out.decision, 'approve');
  assert.ok(out.evidence.some(e => e.label === 'Trusted Shops' && /not listed/.test(e.value)));
  assert.equal(out.flags.positive.some(p => p.code === 'TRUSTEDSHOPS_LISTED'), false);
  assert.equal(out.uncertainties.some(u => /trusted shops/i.test(u.detail)), false);
});

await test('failed check degrades silently — no evidence line, no flag', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null, { trustedShops: tsFailed });
  assert.equal(out.decision, 'approve');
  assert.equal(out.evidence.some(e => e.label === 'Trusted Shops'), false);
});

await test('a hard-rule decline stays declined with Trusted Shops evidence present', () => {
  const ev = baseEvent();
  ev.mandate.hard_rules = [{ field: 'authorization.billing_amount_chf', operator: '<=', value: 10 }];
  const out = evaluate(ev, emptyState, knownProfiles, null, { trustedShops: tsListed });
  assert.equal(out.decision, 'decline');
  assert.ok(out.reason_codes.includes('LIMIT_EXCEEDED'));
  assert.ok(out.evidence.some(e => e.label === 'Trusted Shops'));
});

await test('omitting extras entirely keeps the old 4-arg call signature working', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null);
  assert.equal(out.decision, 'approve');
  assert.equal(out.evidence.some(e => e.label === 'Trusted Shops'), false);
});

console.log('\n— optional live smoke (LEASH_TS_LIVE=1) —');

if (process.env.LEASH_TS_LIVE) {
  await test('live API: known-listed and known-unlisted merchants, concurrent batch', async () => {
    const c = new TrustedShopsChecker({});
    const out = await c.check(['m-s-v.eu', 'conrad.de', 'digitec.ch', 'this-domain-should-not-exist-xyz123.ch']);
    const byDomain = Object.fromEntries(out.results.map(r => [r.resolvedDomain, r]));
    assert.equal(byDomain['m-s-v.eu'].listed, true);
    assert.equal(byDomain['conrad.de'].listed, true);
    assert.equal(byDomain['digitec.ch'].listed, false, 'digitec is genuinely not a TS member');
    assert.equal(byDomain['this-domain-should-not-exist-xyz123.ch'].listed, false);
    console.log(`    live batch took ${out.tookMs} ms; m-s-v.eu: ${describeResult(byDomain['m-s-v.eu'])}`);
  });
} else {
  console.log('  (skipped — set LEASH_TS_LIVE=1 to run)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
