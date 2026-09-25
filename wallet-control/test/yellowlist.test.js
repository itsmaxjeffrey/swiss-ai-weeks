// LEASH wallet-control — yellow-list dossier, trusted-domain store, engine and
// worker wiring. Run: node test/yellowlist.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluate } from '../lib/engine.js';
import { Store } from '../lib/store.js';
import { Worker } from '../lib/worker.js';
import {
  extractSocials, extractPayments, brandHintFromHtml, zefixQuery,
  compareImprintToRegistry, summarize, tsShopRating, zefixAuthHeader,
} from '../lib/yellowlist.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ---------------------------------------------------------------------------
console.log('\n— social / payment / brand extraction (pure) —');

test('extractSocials finds LinkedIn company + Instagram profile, ignores posts', () => {
  const html = `<a href="https://www.linkedin.com/company/acme-ag/">LinkedIn</a>
    <a href="https://instagram.com/acme.swiss">IG</a>
    <a href="https://www.instagram.com/p/ABC123/">a post</a>`;
  const s = extractSocials(html);
  assert.equal(s.linkedin, 'https://www.linkedin.com/company/acme-ag');
  assert.equal(s.instagram, 'https://instagram.com/acme.swiss');
  assert.ok(!s.instagram.includes('/p/'));
});

test('extractSocials returns nulls when absent', () => {
  assert.deepEqual(extractSocials('<html><body>nothing here</body></html>'), { linkedin: null, instagram: null });
});

test('extractPayments detects methods from shop text', () => {
  const html = '<div>Wir akzeptieren Visa, Mastercard, TWINT und PostFinance. Kauf auf Rechnung möglich. Apple Pay und Google Pay.</div>';
  const m = extractPayments(html);
  for (const want of ['Visa', 'Mastercard', 'TWINT', 'PostFinance', 'Invoice (Rechnung)', 'Apple Pay', 'Google Pay']) {
    assert.ok(m.includes(want), `missing ${want} in ${JSON.stringify(m)}`);
  }
  assert.ok(!m.includes('Klarna'));
});

test('extractPayments returns empty (not garbage) on plain text', () => {
  assert.deepEqual(extractPayments('<p>Best shop ever</p>'), []);
});

test('brandHintFromHtml prefers og:site_name, falls back to title', () => {
  assert.equal(brandHintFromHtml('<meta property="og:site_name" content="Acme AG">'), 'Acme AG');
  assert.equal(brandHintFromHtml('<title>Acme AG | Startseite</title>'), 'Acme AG');
  assert.equal(brandHintFromHtml('<title></title>'), null);
});

test('zefixQuery builds exact / contains / UID filters', () => {
  const q1 = zefixQuery({ exact: 'Denner AG' });
  assert.ok(q1.includes('?legalName = "Denner AG"'));
  const q2 = zefixQuery({ contains: 'denner' });
  assert.ok(q2.includes('CONTAINS(LCASE(?legalName), "denner")'));
  const q3 = zefixQuery({ uidContains: '105904292' });
  assert.ok(q3.includes('CONTAINS(STR(?id), "105904292")'));
  assert.throws(() => zefixQuery({}));
});

test('tsShopRating flattens the member-shaped primary (rating is an object)', () => {
  const out = tsShopRating({
    listed: true,
    primary: { tsId: 'X', name: 'Shop', profileUrl: 'https://trustedshops.ch/bewertung/shop', rating: { overallMark: 4.62, totalReviewCount: 17419 } },
  });
  assert.equal(out.rating, 4.62);
  assert.equal(out.review_count, 17419);
  assert.equal(out.profile_url, 'https://trustedshops.ch/bewertung/shop');
  assert.equal(tsShopRating({ listed: true, primary: { rating: null } }).rating, null);
  assert.equal(tsShopRating({ listed: false, primary: null }).rating, null);
});

// ---------------------------------------------------------------------------
console.log('\n— Zefix ↔ imprint comparison (pure) —');

const imprintDenner = {
  company_name: 'Denner AG', address: { street: 'Grubenstrasse 10', postal_code: '8045', city: 'Zürich', country: null }, uid: null,
};
const zefixDenner = {
  company_name: 'Denner AG', uid: 'CHE-105.904.292',
  address: { street: 'Grubenstrasse 10', postal_code: '8045', city: 'Zürich', region: 'ZH' },
};

test('identical imprint + registry → strong', () => {
  const c = compareImprintToRegistry(imprintDenner, zefixDenner);
  assert.equal(c.verdict, 'strong');
  assert.equal(c.city_match, true);
  assert.equal(c.postal_match, true);
});

test('UID match is decisive (strong) even when the name differs', () => {
  const c = compareImprintToRegistry({ ...imprintDenner, uid: 'CHE-105.904.292' }, { ...zefixDenner, company_name: 'Denner Zurich AG' });
  assert.equal(c.verdict, 'strong');
  assert.equal(c.uid_match, true);
});

test('same city/postal but different company name → partial', () => {
  const c = compareImprintToRegistry(
    { ...imprintDenner, company_name: 'Gruben Handel GmbH' },
    zefixDenner,
  );
  assert.equal(c.verdict, 'partial');
});

test('completely different identity → mismatch', () => {
  const c = compareImprintToRegistry(
    { company_name: 'Shady Deals Ltd', address: { street: 'Fake Lane 1', postal_code: '9999', city: 'Nowhere' } },
    zefixDenner,
  );
  assert.equal(c.verdict, 'mismatch');
});

test('missing data → unknown, never a guessed verdict', () => {
  const c = compareImprintToRegistry({ company_name: null, address: null }, { company_name: null, address: null });
  assert.equal(c.verdict, 'unknown');
});

// ---------------------------------------------------------------------------
console.log('\n— dossier summary (pure) —');

test('summarize turns a strong dossier into positives', () => {
  const d = {
    domain: 'denner.ch', product_url: null, error: null,
    imprint: { status: 'found', company_name: 'Denner AG', address: { street: 'Grubenstrasse 10', postal_code: '8045', city: 'Zürich' } },
    registry: { status: 'found', company_name: 'Denner AG', uid: 'CHE-105.904.292', address: { city: 'Zürich' }, registration_date: '1996-01-15', age_years: 30, compare: { verdict: 'strong' } },
    social: { linkedin: 'https://linkedin.com/company/denner', instagram: null },
    payments: { methods: ['Visa', 'TWINT'] },
    country: { same_country: true, merchant_country: 'CH', customer_country: 'CH' },
    reviews: { shop: { listed: true, rating: 4.5, review_count: 120 }, product: null },
    summary: null,
  };
  const s = summarize(d);
  assert.ok(s.positives.some(p => p.includes('Denner AG')));
  assert.ok(s.positives.some(p => p.includes('registered since 1996-01-15')));
  assert.ok(s.positives.some(p => p.includes('LinkedIn')));
  assert.ok(s.positives.some(p => p.includes('TWINT')));
  assert.ok(s.positives.some(p => p.includes('same country')));
  assert.ok(s.negatives.length === 0);
  assert.ok(s.unknowns.some(u => u.includes('Instagram')));
});

test('summarize flags registry miss and imprint miss as negatives', () => {
  const s = summarize({
    domain: 'x.y', imprint: { status: 'not_found' },
    registry: { status: 'not_found' }, social: {}, payments: { methods: [] },
    country: { same_country: false, merchant_country: 'DE', customer_country: 'CH' },
    reviews: { shop: { listed: false }, product: null }, summary: null,
  });
  assert.ok(s.negatives.some(p => p.includes('No Swiss commercial-register entry')));
  assert.ok(s.negatives.some(p => p.includes('No readable Impressum')));
  assert.ok(s.negatives.some(p => p.includes('Based in DE')));
});

test('zefixAuthHeader: B64 passes through verbatim (proxy-substitutable)', () => {
  assert.equal(zefixAuthHeader({ LEASH_ZEFIX_B64: '  dXNlcjpwYXNz  ' }), 'Basic dXNlcjpwYXNz');
  assert.equal(zefixAuthHeader({ LEASH_ZEFIX_B64: 'dXNlcjpwYXNz', LEASH_ZEFIX_TOKEN: 'x' }), 'Basic dXNlcjpwYXNz');
});

test('zefixAuthHeader: split username+password or combined token, else null', () => {
  const split = zefixAuthHeader({ LEASH_ZEFIX_USERNAME: 'me@example.ch', LEASH_ZEFIX_PASSWORD: 'tok123' });
  assert.equal(split, 'Basic ' + Buffer.from('me@example.ch:tok123').toString('base64'));
  const combined = zefixAuthHeader({ LEASH_ZEFIX_TOKEN: 'me@example.ch:tok123' });
  assert.equal(combined, split);
  assert.equal(zefixAuthHeader({ LEASH_ZEFIX_USERNAME: 'me@example.ch' }), null);
  assert.equal(zefixAuthHeader({}), null);
});

// ---------------------------------------------------------------------------
console.log('\n— trusted-domain store —');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-yellow-'));
const storePath = path.join(tmp, 'state.json');

test('addTrustedDomain normalizes and persists; subdomains covered', () => {
  const s = new Store(storePath);
  assert.equal(s.addTrustedDomain('https://www.Example-Shop.ch/checkout'), 'example-shop.ch');
  assert.ok(s.isTrustedDomain('example-shop.ch'));
  assert.ok(s.isTrustedDomain('shop.example-shop.ch'));
  assert.equal(s.isTrustedDomain('evil-shop.example'), null);
  const s2 = new Store(storePath); // reload from disk
  assert.ok(s2.isTrustedDomain('shop.example-shop.ch'), 'trusted domain must survive restart');
});

test('engine state adapter exposes trustedDomainCheck', () => {
  const s = new Store();
  s.addTrustedDomain('a.ch');
  const run = s.createRun({ run_id: 'R1', scenario_id: 'S', mandate_id: 'M', mandateSnapshot: {}, totalEvents: 0 });
  const st = s.runState(run);
  assert.ok(st.trustedDomainCheck('a.ch'));
  assert.equal(st.trustedDomainCheck('b.ch'), null);
});

// ---------------------------------------------------------------------------
console.log('\n— engine yellow-list paths —');

const stubProfiles = {
  merchantFamiliar: () => ({ familiar: false, approvedCount: 0 }),
  deviceKnown: () => ({ known: true }),
  hourUnusual: () => ({ unusual: false }),
  knownMerchants: () => [],
};
const baseAuth = (over = {}) => ({
  authorization_id: 'AU_Y1', replay_order: 1,
  merchant: {
    merchant_id: 'ME_Y1', merchant_name: 'Brand New Shop', merchant_category: 'groceries',
    merchant_country: 'CH', merchant_city: 'Zürich', availability: 'online',
    merchant_url: 'https://brand-new-shop.ch/product/42',
  },
  timestamp: '2026-08-10T10:00:00Z', amount: 20, currency: 'CHF', billing_amount_chf: 20,
  items_subtotal: 20, delivery_fee: 0, channel: 'ecommerce', customer_device_id: 'DVC_KNOWN',
  recent_attempt_count_10m: 0, fulfillment_method: 'delivery',
  order_returnable: 'unknown', related_authorization_status: null,
  purchase_description: 'grocery order',
  items: [{ item_id: 'IT1', item_name: 'Fresh produce', item_category: 'groceries', quantity: 1, unit_price: 20, currency: 'CHF', item_details: 'fruit and vegetables' }],
  ...over,
});
const baseEvent = (over = {}) => ({
  type: 'authorization.request',
  authorization: over.auth || baseAuth(),
  mandate: { mandate_id: 'TM_Y', status: 'active', customer_id: 'CU_Y', instruction: 'test', hard_rules: [], uncertainty_policy: 'ask', ...(over.mandate || {}) },
  context: { approved_spend_in_period_chf: 0 },
  runtime: {},
});
const cleanState = (trusted = null) => ({
  approvedSpendInWindow: () => 0,
  inRunApprovedMerchant: () => false,
  findDuplicate: () => null,
  priorDecisions: () => new Map(),
  trustedDomainCheck: (d) => (trusted && trusted.includes(d) ? { addedAt: Date.now(), note: 'customer approved' } : null),
});

test('unreviewed domain (yellow) → step_up with MERCHANT_UNREVIEWED, never auto-approved', () => {
  const out = evaluate(baseEvent(), cleanState(), stubProfiles, null, {});
  assert.equal(out.decision, 'step_up');
  assert.ok(out.reason_codes.includes('MERCHANT_UNREVIEWED'), out.reason_codes.join(','));
  assert.ok(out.customer_message.includes('dossier'));
});

test('customer-trusted domain → no yellow uncertainty, positive evidence, approves', () => {
  const out = evaluate(baseEvent(), cleanState(['brand-new-shop.ch']), stubProfiles, null, {});
  assert.equal(out.decision, 'approve', out.customer_message);
  assert.ok(!out.reason_codes.includes('MERCHANT_UNREVIEWED'));
  assert.ok(out.flags.positive.some(p => p.code === 'MERCHANT_TRUSTED'));
});

test('trusted domain satisfies merchant.familiar_to_customer', () => {
  const ev = baseEvent({ mandate: { hard_rules: [{ field: 'merchant.familiar_to_customer', operator: '=', value: 'true' }] } });
  const trusted = evaluate(ev, cleanState(['brand-new-shop.ch']), stubProfiles, null, {});
  assert.equal(trusted.decision, 'approve', trusted.customer_message);
  const untrusted = evaluate(ev, cleanState(), stubProfiles, null, {});
  assert.equal(untrusted.decision, 'decline');
  assert.ok(untrusted.reason_codes.includes('MERCHANT_UNFAMILIAR'));
});

test('blacklisted merchant declines and gets NO yellow uncertainty', () => {
  const ev = baseEvent({ auth: baseAuth({ merchant: { merchant_id: 'ME_E1', merchant_name: 'Evil Phish Site Example', merchant_url: 'https://evil-phish-site.example/pay' } }) });
  const trust = { malicious_domains: { 'evil-phish-site.example': 'phishing' }, legit_companies: [] };
  trust.legitCompanyIndex = new Map();
  const out = evaluate(ev, cleanState(), stubProfiles, trust, {});
  assert.equal(out.decision, 'decline');
  assert.ok(out.reason_codes.includes('TRUSTLIST_HIT'));
  assert.ok(!out.reason_codes.includes('MERCHANT_UNREVIEWED'));
});

test('name-only merchant (no website) → no yellow uncertainty', () => {
  const ev = baseEvent({ auth: baseAuth({ merchant: { merchant_id: 'ME_N1', merchant_name: 'Some Shop', merchant_category: 'groceries' } }) });
  const out = evaluate(ev, cleanState(), stubProfiles, null, {});
  assert.ok(!out.reason_codes.includes('MERCHANT_UNREVIEWED'));
});

// ---------------------------------------------------------------------------
console.log('\n— worker: customer approval adds the domain to the trusted list —');

await testAsync('resolveStepUp with whitelist:true persists the merchant domain', async () => {
  const store = new Store();
  const run = store.createRun({ run_id: 'R_Y', scenario_id: 'S', mandate_id: 'M', mandateSnapshot: {}, totalEvents: 1 });
  const event = { authorization: baseAuth() };
  store.recordDecision('R_Y', 'AU_Y1', {
    authorizationId: 'AU_Y1', decision: 'step_up', merchant: 'Brand New Shop',
    merchantDomain: 'brand-new-shop.ch', amount: 20,
  });
  store.addStepUp('R_Y', 'AU_Y1', event, {}, Date.now() + 60_000);
  const worker = new Worker({ client: { resolve: async () => {} }, store, profiles: stubProfiles, trust: null });
  const out = await worker.resolveStepUp('R_Y', 'AU_Y1', 'approve', 'trusted via dossier', { whitelist: true });
  assert.equal(out.whitelist_added, 'brand-new-shop.ch');
  assert.ok(store.isTrustedDomain('brand-new-shop.ch'));
  assert.ok(worker.feed.some(f => f.kind === 'trust'));
});

await testAsync('resolveStepUp without whitelist adds nothing', async () => {
  const store = new Store();
  store.createRun({ run_id: 'R_Y2', scenario_id: 'S', mandate_id: 'M', mandateSnapshot: {}, totalEvents: 1 });
  store.recordDecision('R_Y2', 'AU_Y2', { authorizationId: 'AU_Y2', decision: 'step_up', merchant: 'Other Shop', merchantDomain: 'other-shop.ch', amount: 5 });
  store.addStepUp('R_Y2', 'AU_Y2', { authorization: baseAuth() }, {}, Date.now() + 60_000);
  const worker = new Worker({ client: { resolve: async () => {} }, store, profiles: stubProfiles, trust: null });
  const out = await worker.resolveStepUp('R_Y2', 'AU_Y2', 'approve', 'one-off');
  assert.equal(out.whitelist_added, null);
  assert.equal(store.isTrustedDomain('other-shop.ch'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
