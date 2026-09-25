// LEASH wallet-control — Trusted Shops checker + engine-integration invariants.
// Hermetic: all HTTP is a stubbed fetchImpl; run: node test/trustedshops.test.js
// Live smoke against the real sites: LEASH_TS_LIVE=1 node test/trustedshops.test.js
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

// ---- fixtures ----------------------------------------------------------------
const DIGITEC = { profileType: 'non-member', accountName: 'Digitec Galaxus AG', tsID: 'X2EAB51093C8C38277A55239953A06E4D', shopDescription: null, shopName: 'digitec.ch', shopUrl: 'digitec.ch', shopCategories: [], averageRating: 0, reviewCount: 0, profileUrl: 'www.trustedshops.ch/bewertung/digitec.ch' };
const SODAPOP = { profileType: 'member', accountName: 'Sodapop GmbH', tsID: 'XD5F5F3F77B2CA95BDD8D9095B5B7DEBE', shopName: 'sodapop.ch', shopUrl: 'sodapop.ch', averageRating: 4.8, reviewCount: 212, profileUrl: 'www.trustedshops.de/bewertung/sodapop.ch' };
const MEMBER_ENTRY = tsId => ({ tsId, url: 'www.conrad.de', name: 'Conrad Electronic', languageISO2: 'de', targetMarketISO3: 'DEU' });
const QUALITY_BODY = {
  response: { code: 200, data: { shop: { qualityIndicators: { reviewIndicator: {
    overallMark: 4.79, overallMarkDescription: 'EXCELLENT', totalReviewCount: 1703,
    activeReviewCount: 95, reviewsCountedSince: '2012-04-12' } } } }, status: 'SUCCESS' },
};
const MEMBER_LOOKUP_BODY = tsId => ({ response: { code: 200, data: { shops: [MEMBER_ENTRY(tsId)] }, status: 'SUCCESS' } });
const searchPage = shops => `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { shops } } })}</script></body></html>`;
const warningPage = entries => `<!doctype html><html><body>${entries.map(e => `<div class="warning-card"><p class="save-info">Diese Information hat schon ${e.n || 3} Personen geschützt. War diese Warnung hilfreich?</p> Fake ${e.type} ${e.domain} ${e.date} <p>Diese Information hat schon ${e.n || 3} Personen geschützt.</p></div>`).join('')}</body></html>`;
const isSearch = u => /trustedshops\.[a-z.]+\/shops\/\?q=/.test(u);
const isMemberLookup = u => u.includes('/shops.json?url=');
const isFakeShops = u => u.includes('/fake-shops/');

/** Stub fetch with route table [{match(url), status, body, delayMs}]; needs json() + text(). */
function stubFetch(routes = []) {
  const calls = [];
  let inflight = 0, peak = 0;
  const fn = async (url, opts = {}) => {
    calls.push(url);
    inflight++; peak = Math.max(peak, inflight);
    try {
      const route = routes.find(r => r.match(url));
      if (!route) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      if (route.delayMs) await new Promise(r => setTimeout(r, route.delayMs));
      const status = route.status ?? 200;
      const body = typeof route.body === 'function' ? route.body(url) : route.body;
      return {
        ok: status >= 200 && status < 300, status,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    } finally { inflight--; }
  };
  fn.calls = calls;
  fn.peak = () => peak;
  return fn;
}

/** Routes: everything not found → 404 (REST) / empty search + empty fake-shop lists (country sites). */
function defaultRoutes(over = []) {
  return [
    ...over,
    { match: isFakeShops, body: warningPage([]) },
    { match: isSearch, body: searchPage([]) },
  ]; // anything else (REST member lookup) falls through to 404
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
});

await test('names, localhost, bare IPs are not domains (never invented into one)', () => {
  assert.equal(normalizeDomain('Alpine Basket'), null);
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain('192.168.1.1'), null);
  const p = parseMerchantInput({ name: 'PixelHarbour', country: 'CH' });
  assert.equal(p.domain, null);
  assert.equal(p.name, 'PixelHarbour');
});

await test('market labels map to the country Trusted Shops sites', () => {
  assert.match(marketLabel('CHE'), /trustedshops\.ch/);
  assert.match(marketLabel('BEL'), /trustedshops\.be/);
  assert.match(marketLabel('PRT'), /trustedshops\.pt/);
});

console.log('\n— checker: country-domain search (v2) —');

await test('non-member profile found via country search (the digitec case)', async () => {
  const f = stubFetch(defaultRoutes([
    { match: u => u.includes('trustedshops.ch/'), body: searchPage([DIGITEC]) },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('digitec.ch');
  assert.equal(r.listed, true, 'digitec must be LISTED via the .ch search');
  assert.equal(r.resolvedDomain, 'digitec.ch');
  assert.deepEqual(r.found_on, ['trustedshops.ch']);
  assert.equal(r.profiles.length, 1);
  assert.equal(r.profiles[0].profileType, 'non-member');
  assert.equal(r.profiles[0].accountName, 'Digitec Galaxus AG');
  assert.equal(r.profiles[0].domain, 'trustedshops.ch');
  assert.equal(r.primary.profileUrl, 'https://www.trustedshops.ch/bewertung/digitec.ch');
  assert.equal(r.shops.length, 0, 'member registry lookup 404s for non-members');
  assert.match(describeResult(r), /profile on trustedshops\.ch \(non-member: Digitec Galaxus AG/);
});

await test('fuzzy search near-misses never count (exact domain match only)', async () => {
  const f = stubFetch(defaultRoutes([
    { match: u => u.includes('trustedshops.de/'), body: searchPage([SODAPOP]) }, // wrong shop
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('brack.ch');
  assert.equal(r.listed, false, 'sodapop.ch must not count as brack.ch');
  assert.deepEqual(r.found_on, []);
});

await test('www input matches non-www registration', async () => {
  const f = stubFetch(defaultRoutes([
    { match: u => u.includes('trustedshops.ch/'), body: searchPage([DIGITEC]) },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('https://www.digitec.ch/de/shop');
  assert.equal(r.listed, true);
  assert.equal(r.profiles.length, 1);
});

await test('member via registry: rating merged, market mapped into found_on', async () => {
  const f = stubFetch(defaultRoutes([
    { match: isMemberLookup, body: MEMBER_LOOKUP_BODY('XCONRAD') },
    { match: u => u.includes('/XCONRAD/quality.json'), body: QUALITY_BODY },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('conrad.de');
  assert.equal(r.listed, true);
  assert.equal(r.member.tsId, 'XCONRAD');
  assert.equal(r.member.rating.overallMark, 4.79);
  assert.ok(r.found_on.includes('trustedshops.de'), 'DEU market maps to trustedshops.de');
  assert.match(describeResult(r), /4\.79\/5\.00 "EXCELLENT"/);
});

await test('one country site failing is tolerated (noted in search_errors)', async () => {
  const f = stubFetch([
    { match: u => u.includes('trustedshops.pl/'), status: 503, body: 'boom' },
    { match: isSearch, body: searchPage([DIGITEC]) },
  ]);
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('digitec.ch');
  assert.equal(r.listed, true);
  assert.equal(r.search_errors.length, 1);
  assert.match(r.search_errors[0], /\.pl: HTTP 503/);
});

await test('total failure (registry + all country sites) degrades to listed:null', async () => {
  const f = async () => { throw new Error('network down'); };
  const c = new TrustedShopsChecker({ fetchImpl: f, timeoutMs: 50 });
  const r = await c.checkOne('anything.ch');
  assert.equal(r.listed, null);
  assert.match(r.reason, /all Trusted Shops checks failed/);
  assert.equal(describeResult(r).includes('unavailable'), true);
});

await test('hung search: own deadline fires even though AbortSignal alone would not', async () => {
  const f = (url, opts = {}) => new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
  const c = new TrustedShopsChecker({ fetchImpl: f, timeoutMs: 30 });
  const r = await c.checkOne('slow.ch');
  assert.equal(r.listed, null);
  assert.match(r.reason, /all Trusted Shops checks failed/);
});

await test('cache: repeat check does not re-fetch; fromCache flagged; hits counted', async () => {
  const f = stubFetch(defaultRoutes([{ match: u => u.includes('trustedshops.ch/'), body: searchPage([DIGITEC]) }]));
  const c = new TrustedShopsChecker({ fetchImpl: f, timeoutMs: 300 });
  const a = await c.checkOne('cached-shop.ch');
  const searchesAfterFirst = f.calls.filter(isSearch).length;
  const b = await c.checkOne('cached-shop.ch');
  assert.ok(searchesAfterFirst >= 1);
  assert.equal(f.calls.filter(isSearch).length, searchesAfterFirst, 'second check must not re-fetch');
  assert.equal(a.fromCache, false);
  assert.equal(b.fromCache, true);
  assert.equal(c.stats.cacheHits, 1);
});

await test('registry store-page entries without quality data: rating rescued from country-site hit', async () => {
  const STORE_ENTRY = { tsId: 'XSTORE', url: 'www.conrad.de/de/filialen/filiale-berlin.html', name: 'Conrad Berlin', languageISO2: 'de', targetMarketISO3: 'DEU' };
  const MAIN_ENTRY = { tsId: 'XMAIN', url: 'www.conrad.de/de/branch', name: 'Conrad Electronic', languageISO2: 'de', targetMarketISO3: 'DEU' };
  const MAIN_SSR = { profileType: 'member', accountName: 'Conrad Electronic', tsID: 'XMAIN', shopName: 'conrad.de', shopUrl: 'conrad.de', averageRating: 4.6, reviewCount: 24500, profileUrl: 'www.trustedshops.de/bewertung/conrad.de' };
  const f = stubFetch(defaultRoutes([
    { match: isMemberLookup, body: { response: { code: 200, data: { shops: [STORE_ENTRY, MAIN_ENTRY] }, status: 'SUCCESS' } } },
    { match: u => u.includes('/XSTORE/quality.json'), status: 404, body: {} },
    { match: u => u.includes('/XMAIN/quality.json'), status: 404, body: {} },
    { match: u => u.includes('trustedshops.de/'), body: searchPage([MAIN_SSR]) },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('conrad.de');
  assert.equal(r.listed, true);
  assert.equal(r.primary.tsId, 'XMAIN', 'rated exact profile must win over unrated store pages');
  assert.equal(r.primary.rating.overallMark, 4.6);
  assert.equal(r.primary.rating.source, 'country-site');
});

await test('batch: results in input order, concurrency cap respected', async () => {
  const f = stubFetch([{ match: isSearch, delayMs: 25, body: searchPage([]) }]);
  const c = new TrustedShopsChecker({ fetchImpl: f, concurrency: 6, timeoutMs: 500 });
  const inputs = ['a.ch', 'b.ch', 'c.ch', 'd.ch', 'e.ch', 'f.ch', 'g.ch', 'h.ch'];
  const out = await c.check(inputs);
  assert.equal(out.results.length, 8);
  assert.deepEqual(out.results.map(r => r.resolvedDomain), inputs);
  assert.ok(f.peak() <= 6, `peak in-flight ${f.peak()} exceeded cap 6`);
});

await test('name-only merchant: unanswered honestly, no invented domain', async () => {
  const f = stubFetch(defaultRoutes());
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne({ name: 'Alpine Basket' });
  assert.equal(r.listed, null);
  assert.match(r.reason, /no domain supplied/);
  assert.equal(f.calls.length, 0);
});

console.log('\n— checker: fake-shop warning lists —');

await test('domain on a country fake-shops list is flagged with site, type + date', async () => {
  const f = stubFetch(defaultRoutes([
    { match: u => u.includes('trustedshops.de/fake-shops/'), body: warningPage([{ type: 'Identity', domain: 'scam-shop.xyz', date: '17.09.2026' }]) },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('scam-shop.xyz');
  assert.equal(r.fake_shop.flagged, true);
  assert.equal(r.fake_shop.matches[0].site, 'trustedshops.de');
  assert.equal(r.fake_shop.matches[0].type, 'Identity');
  assert.equal(r.fake_shop.matches[0].date, '17.09.2026');
  assert.equal(r.listed, false, 'a fake-shop flag does not make the shop TS-listed');
  assert.match(describeResult(r), /FAKE SHOP WARNING: scam-shop\.xyz appears on trustedshops\.de's fake-shop list \(Identity\), warning dated 17\.09\.2026/);
});

await test('subdomain of a flagged fake-shop domain is also flagged', async () => {
  const f = stubFetch(defaultRoutes([
    { match: u => u.includes('trustedshops.de/fake-shops/'), body: warningPage([{ type: 'Trustmark', domain: 'scam-shop.xyz', date: '01.01.2026' }]) },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('shop.scam-shop.xyz');
  assert.equal(r.fake_shop.flagged, true);
});

await test('warnings for other domains never flag; page chrome (trustedshops/CDNs) is excluded', async () => {
  const page = warningPage([{ type: 'Identity', domain: 'someone-else.shop', date: '02.02.2026' }])
    + ' Mehr Informationen über trustedshops.de und cloudflare.com und hubspot.com finden Sie hier.';
  const f = stubFetch(defaultRoutes([
    { match: u => u.includes('trustedshops.de/fake-shops/'), body: page },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  const r = await c.checkOne('digitec.ch');
  assert.equal(r.fake_shop.flagged, false);
  assert.deepEqual(r.fake_shop.matches, []);
  assert.equal(r.fake_shop.warnings_total, 1, 'chrome domains must not become warnings');
});

await test('fake-shop lists are fetched once per TTL and shared across merchants', async () => {
  const f = stubFetch(defaultRoutes([
    { match: u => u.includes('trustedshops.de/fake-shops/'), body: warningPage([{ type: 'Identity', domain: 'scam-shop.xyz', date: '17.09.2026' }]) },
  ]));
  const c = new TrustedShopsChecker({ fetchImpl: f });
  await c.checkOne('one.ch');
  const afterFirst = f.calls.filter(isFakeShops).length;
  assert.ok(afterFirst >= 1);
  await c.checkOne('two.ch');
  assert.equal(f.calls.filter(isFakeShops).length, afterFirst, 'second merchant must reuse the cached lists');
});

console.log('\n— engine integration (advisory evidence only) —');

const tsListed = { resolvedDomain: 'www.testshop.ch', listed: true, checkedAt: '2026-09-25T01:00:00Z',
  shops: [{ tsId: 'XT1', name: 'Testshop AG', registeredUrl: 'www.testshop.ch', targetMarket: 'CHE', market: 'Switzerland (trustedshops.ch)',
    rating: { overallMark: 4.79, description: 'EXCELLENT', totalReviewCount: 1703, activeReviewCount: 95, reviewsCountedSince: '2012-04-12' } }],
  profiles: [], found_on: ['trustedshops.ch'],
  member: { tsId: 'XT1', name: 'Testshop AG', targetMarket: 'CHE', market: 'Switzerland (trustedshops.ch)',
    rating: { overallMark: 4.79, description: 'EXCELLENT', totalReviewCount: 1703, activeReviewCount: 95, reviewsCountedSince: '2012-04-12' } },
  primary: { tsId: 'XT1', name: 'Testshop AG', registeredUrl: 'www.testshop.ch', targetMarket: 'CHE', market: 'Switzerland (trustedshops.ch)',
    rating: { overallMark: 4.79, description: 'EXCELLENT', totalReviewCount: 1703, activeReviewCount: 95, reviewsCountedSince: '2012-04-12' } } };
const tsUnlisted = { resolvedDomain: 'digitec-nope.ch', listed: false, shops: [], profiles: [], found_on: [], checkedAt: '2026-09-25T01:00:00Z' };
const tsProfileOnly = { resolvedDomain: 'digitec.ch', listed: true, shops: [], found_on: ['trustedshops.ch'], checkedAt: '2026-09-25T01:00:00Z',
  profiles: [{ domain: 'trustedshops.ch', profileType: 'non-member', tsId: 'X2EAB51093C8C38277A55239953A06E4D', accountName: 'Digitec Galaxus AG', shopName: 'digitec.ch', averageRating: 0, reviewCount: 0, profileUrl: 'https://www.trustedshops.ch/bewertung/digitec.ch' }],
  primary: { profileType: 'non-member', accountName: 'Digitec Galaxus AG', reviewCount: 0 } };
const tsFailed = { resolvedDomain: 'slow.ch', listed: null, shops: [], profiles: [], found_on: [], reason: 'check failed: timeout', checkedAt: '2026-09-25T01:00:00Z' };
const tsFakeFlagged = { resolvedDomain: 'scam-shop.xyz', listed: false, shops: [], profiles: [], found_on: [], checkedAt: '2026-09-25T01:00:00Z',
  fake_shop: { flagged: true, matches: [{ site: 'trustedshops.de', type: 'Identity', date: '17.09.2026' }] } };

await test('listed member adds positive evidence but never changes an approval', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null, { trustedShops: tsListed });
  assert.equal(out.decision, 'approve');
  assert.ok(out.evidence.some(e => e.label === 'Trusted Shops' && /4\.79/.test(e.value)));
  assert.ok(out.flags.positive.some(p => p.code === 'TRUSTEDSHOPS_LISTED'));
});

await test('profile-only listing (non-member) renders and stays advisory', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null, { trustedShops: tsProfileOnly });
  assert.equal(out.decision, 'approve');
  assert.ok(out.evidence.some(e => e.label === 'Trusted Shops' && /trustedshops\.ch/.test(e.value)));
  assert.ok(out.flags.positive.some(p => p.code === 'TRUSTEDSHOPS_LISTED'));
});

await test('absence from Trusted Shops is neutral evidence — never a fail or uncertainty', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null, { trustedShops: tsUnlisted });
  assert.equal(out.decision, 'approve');
  assert.ok(out.evidence.some(e => e.label === 'Trusted Shops' && /not listed/.test(e.value)));
  assert.equal(out.flags.positive.some(p => p.code === 'TRUSTEDSHOPS_LISTED'), false);
  assert.equal(out.uncertainties.some(u => /trusted shops/i.test(u.detail)), false);
  assert.equal(out.reason_codes.includes('TRUSTEDSHOPS_FAKE_SHOP'), false);
});

await test('a fake-shop warning is a hard decline (TRUSTEDSHOPS_FAKE_SHOP)', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null, { trustedShops: tsFakeFlagged });
  assert.equal(out.decision, 'decline');
  assert.ok(out.reason_codes.includes('TRUSTEDSHOPS_FAKE_SHOP'));
  assert.ok(out.evidence.some(e => e.label === 'Fake-shop check' && /FAKE SHOP WARNING/.test(e.value)));
  assert.ok(out.customer_message.includes('fake shop'));
  assert.equal(out.flags.positive.some(p => p.code === 'TRUSTEDSHOPS_LISTED'), false);
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
});

await test('omitting extras entirely keeps the old 4-arg call signature working', () => {
  const out = evaluate(baseEvent(), emptyState, knownProfiles, null);
  assert.equal(out.decision, 'approve');
  assert.equal(out.evidence.some(e => e.label === 'Trusted Shops'), false);
});

console.log('\n— optional live smoke (LEASH_TS_LIVE=1) —');

if (process.env.LEASH_TS_LIVE) {
  await test('live: digitec listed via .ch (non-member), conrad.de member, unlisted stays unlisted', async () => {
    const c = new TrustedShopsChecker({});
    const out = await c.check(['digitec.ch', 'conrad.de', 'this-domain-should-not-exist-xyz123.ch']);
    const byDomain = Object.fromEntries(out.results.map(r => [r.resolvedDomain, r]));
    assert.equal(byDomain['digitec.ch'].listed, true, 'digitec must be found via country search');
    assert.deepEqual(byDomain['digitec.ch'].found_on, ['trustedshops.ch']);
    assert.equal(byDomain['digitec.ch'].profiles[0].accountName, 'Digitec Galaxus AG');
    assert.equal(byDomain['conrad.de'].listed, true);
    const pr = byDomain['conrad.de'].primary;
    assert.ok(pr && ((pr.rating?.overallMark != null) || (pr.reviewCount ?? 0) > 0), 'conrad rating evidence present (quality API or country-site data)');
    assert.equal(byDomain['this-domain-should-not-exist-xyz123.ch'].listed, false);
    console.log(`    live batch took ${out.tookMs} ms; digitec: ${describeResult(byDomain['digitec.ch'])}`);
  });

  await test('live fake-shop lists: parse on country sites, digitec clean, real warnings self-flag', async () => {
    const c = new TrustedShopsChecker({});
    const r = await c.checkOne('digitec.ch');
    assert.equal(r.fake_shop.flagged, false);
    assert.ok(r.fake_shop.warnings_total >= 1, `expected real warnings on the live lists, got ${r.fake_shop.warnings_total}`);
    console.log(`    live: ${r.fake_shop.warnings_total} warnings across ${r.fake_shop.sites_checked} sites${r.fake_shop.list_errors.length ? `; errors: ${r.fake_shop.list_errors.join('; ')}` : '; no fetch errors'}`);
    const first = [...c.fakeShopCache.byDomain.keys()][0];
    if (first) {
      const r2 = await c.checkOne(first);
      assert.equal(r2.fake_shop.flagged, true, 'a domain that is on the list must come back flagged');
      console.log(`    live: ${first} correctly flagged (${r2.fake_shop.matches[0].type || 'warning'}, dated ${r2.fake_shop.matches[0].date || 'n/a'})`);
    }
  });
} else {
  console.log('  (skipped — set LEASH_TS_LIVE=1 to run)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
