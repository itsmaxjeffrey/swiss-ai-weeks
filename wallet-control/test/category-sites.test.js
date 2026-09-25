// wallet-control — refresh-category-sites.mjs offline tests.
// No network: parsing, scoring, determinism, caps, failure semantics.
// Run: node test/category-sites.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractDomain, isBlockedHost, ddgHrefToUrl, parseDdgHtml,
  collectDomainEvidence, buildArtifact, CATEGORIES,
} from '../scripts/refresh-category-sites.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

/* ---------- domain extraction ---------- */
test('extractDomain strips www/m and keeps registrable pair', () => {
  assert.equal(extractDomain('https://www.sneakerstore.ch/collections/schuh'), 'sneakerstore.ch');
  assert.equal(extractDomain('https://www.migros.ch/de/guide'), 'migros.ch');
  assert.equal(extractDomain('https://m.example.com/x?y=1'), 'example.com');
  assert.equal(extractDomain('http://SUB.Example.COM:8080/a'), 'example.com');
});
test('extractDomain handles two-part suffixes', () => {
  assert.equal(extractDomain('https://shop.example.co.uk/item'), 'example.co.uk');
  assert.equal(extractDomain('https://www.store.com.ch/p/1'), 'store.com.ch');
});
test('extractDomain rejects junk', () => {
  assert.equal(extractDomain('not a url'), null);
  assert.equal(extractDomain('ftp://files.example.com'), null);
  assert.equal(extractDomain('https://192.168.1.1/admin'), null);
  assert.equal(extractDomain('javascript:void(0)'), null);
});

/* ---------- host blocklist ---------- */
test('isBlockedHost filters comparison/media/social hosts', () => {
  for (const d of ['pinterest.ch', 'trustpilot.com', 'comparis.ch', 'idealo.ch', 'toppreise.ch', 'youtube.com', 'duckduckgo.com'])
    assert.ok(isBlockedHost(d), d);
  for (const d of ['sneakerstore.ch', 'digitec.ch', 'ochsnersport.ch', 'brack.ch'])
    assert.ok(!isBlockedHost(d), d);
});

/* ---------- DDG redirect + ad filtering ---------- */
test('ddgHrefToUrl decodes organic redirect, drops y.js ads', () => {
  const organic = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fsneakerstore.ch%2F&amp;rut=abc';
  assert.equal(ddgHrefToUrl(organic), 'https://sneakerstore.ch/');
  const ad = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dschwesternuhr.ch&amp;rut=x';
  assert.equal(ddgHrefToUrl(ad), null);
  assert.equal(ddgHrefToUrl(null), null);
});

/* ---------- page parsing ---------- */
test('parseDdgHtml extracts ordered organic results only', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dads.example&amp;rut=1">Ad first</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.brack.ch%2Fx&amp;rut=2">Brack <b>Elektronik</b></a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgalaxus.ch%2Fen&amp;rut=3">Galaxus</a>
    <a class="other" href="https://ignored.example">nope</a>`;
  const rows = parseDdgHtml(html);
  assert.equal(rows.length, 2);
  assert.equal(extractDomain(rows[0].url), 'brack.ch');
  assert.equal(rows[0].title, 'Brack Elektronik');
  assert.equal(extractDomain(rows[1].url), 'galaxus.ch');
});

/* ---------- evidence scoring ---------- */
test('collectDomainEvidence ranks by position, seeds get +1.0 once', () => {
  const results = [
    { url: 'https://www.alpha.ch/', title: 'Alpha' },
    { url: 'https://beta.com/x', title: 'Beta' },
    { url: 'https://www.alpha.ch/y', title: 'Alpha again' },
  ];
  const items = collectDomainEvidence(results, ['beta.com']);
  const by = Object.fromEntries(items.map((i) => [i.domain, i]));
  assert.equal(items.length, 2);
  // alpha: 1/1 + 1/3 = 1.3333, no seed → beats beta (1/2 + 1.0 = 1.5)? No: 1.5 > 1.3333.
  assert.equal(by['alpha.ch'].score.toFixed(4), '1.3333');
  assert.equal(by['beta.com'].score.toFixed(4), '1.5000');
  assert.equal(by['beta.com'].curated, true);
  assert.equal(by['alpha.ch'].curated, false);
});

/* ---------- artifact build: determinism, cap, failures ---------- */
test('buildArtifact is deterministic, caps at 20, lists missing queries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catsites-'));
  const lines = [];
  for (let i = 0; i < 25; i++) {
    lines.push(`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop${String(i).padStart(2, '0')}.example%2F&amp;rut=${i}">Shop ${i}</a>`);
  }
  const html = lines.join('\n');
  const cat = CATEGORIES.find((c) => c.id === 'groceries');
  cat.queries.forEach((q, qi) => {
    fs.writeFileSync(path.join(tmp, `groceries__q${qi}.json`), JSON.stringify({
      query: q.q, kl: q.kl, category: 'groceries', fetchedAt: '2026-01-01T00:00:00Z',
      results: parseDdgHtml(html).map((r, rank) => ({ rank, url: r.url, title: r.title })),
    }));
  });
  // second query file for determinism check: same content both queries
  const a = buildArtifact(tmp, '2026-01-01');
  const b = buildArtifact(tmp, '2026-01-01');
  assert.equal(JSON.stringify(a.artifact), JSON.stringify(b.artifact), 'rebuild must be byte-identical');

  const groc = a.artifact.categories.find((c) => c.id === 'groceries');
  assert.equal(groc.sites.length, 20, 'cap at top 20');
  assert.equal(groc.sites[0].rank, 1);
  assert.equal(groc.queries.length, 2);
  // schema fields
  assert.equal(a.artifact.schema, 'wallet-control.category-sites.v1');
  assert.ok(a.artifact.runDate === '2026-01-01');
  assert.ok(!JSON.stringify(a.artifact).includes('generatedAt'), 'no wall-clock time in artifact');

  // missing raw file → failure counted, category still built from the other query
  fs.rmSync(path.join(tmp, 'groceries__q1.json'));
  const c = buildArtifact(tmp, '2026-01-01');
  assert.equal(c.failures[0].category, 'groceries');
  assert.equal(c.artifact.categories.find((x) => x.id === 'groceries').queries.length, 1);
  // all 84 categories are always built; every category without raw files counts failed queries
  const expectedFailed = 1 + (CATEGORIES.length - 1) * 2;
  assert.equal(c.queriesFailed, expectedFailed);
  assert.equal(c.artifact.counts.queriesFailed, expectedFailed);

  // every category present in defined order even with zero raw files
  assert.deepEqual(c.artifact.categories.map((x) => x.id), CATEGORIES.map((x) => x.id));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ---------- full-set sanity ---------- */
test('category set is well-formed and sized sensibly', () => {
  assert.ok(CATEGORIES.length >= 50 && CATEGORIES.length <= 100, `${CATEGORIES.length} categories`);
  const ids = new Set();
  for (const c of CATEGORIES) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`); ids.add(c.id);
    assert.equal(c.queries.length, 2);
    assert.ok(c.queries[0].q.includes('Schweiz'));
    assert.ok(c.department.length > 0);
  }
  // seeds must all be registrable domains and never blocked
  for (const c of CATEGORIES) for (const s of c.seeds) {
    assert.ok(!isBlockedHost(s), `seed ${s} is blocked`);
    assert.equal(extractDomain(`https://${s}/`), s, `seed ${s} normalizes to itself`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
