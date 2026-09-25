// LEASH wallet-control — sustainability lookup + offer ranking. Run: node test/sustainability.test.js
// Covers lib/sustainability.js: static index loading (missing/broken file
// degrades to "unknown", never crashes), domain lookup (URL-shaped input),
// basic risk scoring from local signals, and preference-aware offer ranking
// (sustainability breaks ties only WITHIN a risk band, never across bands).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSustainabilityIndex, lookupSustainability, scoreMerchantRisk, rankOffers } from '../lib/sustainability.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const REAL_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'sustainability.json');

await test('loads the real dataset: known domain returns score + band + note', () => {
  const index = loadSustainabilityIndex(REAL_FILE);
  const r = lookupSustainability('digitec.ch', index);
  assert.equal(r.band, 'good');
  assert.equal(r.score, 78);
  assert.ok(r.note.length > 3);
});

await test('URL-shaped and www-prefixed inputs resolve to the bare domain', () => {
  const index = loadSustainabilityIndex(REAL_FILE);
  for (const input of ['https://www.brack.ch/whatever?x=1', 'WWW.BRACK.CH', 'http://brack.ch']) {
    const r = lookupSustainability(input, index);
    assert.equal(r.score, 58, `input ${input}`);
    assert.equal(r.band, 'medium', `input ${input}`);
  }
});

await test('unknown shop degrades honestly to band "unknown", score null', () => {
  const index = loadSustainabilityIndex(REAL_FILE);
  const r = lookupSustainability('some-obscure-shop.example', index);
  assert.equal(r.score, null);
  assert.equal(r.band, 'unknown');
  assert.match(r.note, /no data/);
});

await test('missing dataset file → empty index, lookups stay "unknown", no crash', () => {
  const index = loadSustainabilityIndex(path.join(os.tmpdir(), `leash-nope-${Date.now()}.json`));
  assert.equal(index.size, 0);
  assert.equal(lookupSustainability('digitec.ch', index).band, 'unknown');
});

await test('broken dataset file → empty index, no crash; malformed entries skipped, not guessed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-sus-'));
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{not json');
  assert.equal(loadSustainabilityIndex(broken).size, 0);
  const partial = path.join(dir, 'partial.json');
  fs.writeFileSync(partial, JSON.stringify({ merchants: { 'a.ch': { score: 80 }, 'b.ch': { score: 'high' }, 'c.ch': {} } }));
  const idx = loadSustainabilityIndex(partial);
  assert.equal(idx.size, 1); // only a.ch survives; b/c skipped
});

await test('risk: malicious infrastructure → 90/high regardless of other signals', () => {
  const r = scoreMerchantRisk({ malicious: true, trusted: true, trustedShopsResult: { listed: true, primary: { rating: { overallMark: 4.9 } } } });
  assert.equal(r.score, 90);
  assert.equal(r.band, 'high');
});

await test('risk: trusted + good Trusted Shops rating → low', () => {
  const r = scoreMerchantRisk({ trusted: true, trustedShopsResult: { listed: true, primary: { rating: { overallMark: 4.8 } } } });
  assert.equal(r.score, 0); // 55 - 35 - 20, clamped at 0
  assert.equal(r.band, 'low');
  assert.ok(r.reasons.some(x => x.includes('trusted merchants list')));
});

await test('risk: unverified shop (no signals) → 55/medium with explicit reasons', () => {
  const r = scoreMerchantRisk({ trustedShopsResult: { listed: false } });
  assert.equal(r.score, 55);
  assert.equal(r.band, 'medium');
  assert.ok(r.reasons.includes('no Trusted Shops profile'));
});

await test('risk: TS check unavailable → medium, never silently blank', () => {
  const r = scoreMerchantRisk({});
  assert.equal(r.band, 'medium');
  assert.ok(r.reasons.length > 0);
});

await test('rankOffers prefer=on: within the same risk band, more sustainable first', () => {
  const offers = [
    { merchant: 'sportxx.ch', risk: { score: 55, band: 'medium' }, sustainability: { score: 48, band: 'medium' } },
    { merchant: 'decathlon.ch', risk: { score: 55, band: 'medium' }, sustainability: { score: 66, band: 'good' } },
  ];
  const ranked = rankOffers(offers, { prefer: true });
  assert.equal(ranked[0].merchant, 'decathlon.ch');
  assert.equal(ranked[1].merchant, 'sportxx.ch');
});

await test('rankOffers prefer=on: never promotes an offer past a strictly safer band', () => {
  const offers = [
    { merchant: 'safe-unknown.ch', risk: { score: 55, band: 'medium' }, sustainability: { score: null, band: 'unknown' } },
    { merchant: 'risky-green.ch', risk: { score: 80, band: 'high' }, sustainability: { score: 95, band: 'good' } },
  ];
  const ranked = rankOffers(offers, { prefer: true });
  assert.equal(ranked[0].merchant, 'safe-unknown.ch');
});

await test('rankOffers prefer=on: within a band, shops with data sort before unknown ones', () => {
  const offers = [
    { merchant: 'unknown.ch', risk: { score: 55, band: 'medium' }, sustainability: { score: null, band: 'unknown' } },
    { merchant: 'known.ch', risk: { score: 55, band: 'medium' }, sustainability: { score: 60, band: 'medium' } },
  ];
  const ranked = rankOffers(offers, { prefer: true });
  assert.equal(ranked[0].merchant, 'known.ch');
});

await test('rankOffers prefer=off: pure risk order, sustainability ignored', () => {
  const offers = [
    { merchant: 'green.ch', risk: { score: 60, band: 'medium' }, sustainability: { score: 90, band: 'good' } },
    { merchant: 'plain.ch', risk: { score: 20, band: 'low' }, sustainability: { score: 10, band: 'poor' } },
  ];
  const ranked = rankOffers(offers, { prefer: false });
  assert.equal(ranked[0].merchant, 'plain.ch');
  assert.equal(rankOffers(offers, {})[0].merchant, 'plain.ch'); // default off
});

await test('rankOffers does not mutate the input array', () => {
  const offers = [
    { merchant: 'a.ch', risk: { score: 60, band: 'medium' }, sustainability: { score: 90, band: 'good' } },
    { merchant: 'b.ch', risk: { score: 20, band: 'low' }, sustainability: { score: 10, band: 'poor' } },
  ];
  rankOffers(offers, { prefer: true });
  assert.equal(offers[0].merchant, 'a.ch');
});

// ---- Demo cap: comparisons return only the top N offers (server passes 3) ----

await test('rankOffers limit=3 keeps only the top 3, in rank order', () => {
  const offers = [
    { merchant: 'a.ch', risk: scoreMerchantRisk({ trusted: true }), sustainability: { score: null, band: 'unknown' } },
    { merchant: 'b.ch', risk: scoreMerchantRisk({}), sustainability: { score: null, band: 'unknown' } },
    { merchant: 'c.ch', risk: scoreMerchantRisk({}), sustainability: { score: 80, band: 'good' } },
    { merchant: 'd.ch', risk: scoreMerchantRisk({ malicious: true }), sustainability: { score: null, band: 'unknown' } },
    { merchant: 'e.ch', risk: scoreMerchantRisk({}), sustainability: { score: null, band: 'unknown' } },
  ];
  const ranked = rankOffers(offers, { prefer: true, limit: 3 });
  assert.equal(ranked.length, 3);
  assert.deepEqual(ranked.map((o) => o.merchant), ['a.ch', 'c.ch', 'b.ch']);
  assert.equal(offers.length, 5, 'input array not mutated');
});

await test('rankOffers limit beyond list length, or absent, returns everything', () => {
  const offers = [
    { merchant: 'a.ch', risk: scoreMerchantRisk({ trusted: true }), sustainability: { score: null, band: 'unknown' } },
    { merchant: 'b.ch', risk: scoreMerchantRisk({}), sustainability: { score: null, band: 'unknown' } },
  ];
  assert.equal(rankOffers(offers, { limit: 9 }).length, 2);
  assert.equal(rankOffers(offers, {}).length, 2);
});

console.log(`\nsustainability: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
