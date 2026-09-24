#!/usr/bin/env node
// Generate deployment test fixtures for wallet-control's injection-model tests.
//
// Picks, from the held-out corpus splits:
//   injection_cases : real attacks the MODEL catches at threshold but the REGEX
//                     layer misses (proves the model adds coverage end-to-end)
//   benign_cases    : benign texts (BIPIA benign tasks + Viseca pack) that must
//                     stay below the suspect band and never escalate
//
// Usage: node models/prompt_injection/make_fixtures.mjs   (from merchant-trust-data)
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CORPUS = path.join(ROOT, 'data/intermediate/prompt_injection');
const WC = path.join(ROOT, '..', 'wallet-control');

const { scoreInjectionText, scanInjectionModel } = await import(
  'file://' + path.join(WC, 'lib/injection-model.js'));

const model = JSON.parse(readFileSync(path.join(WC, 'lib/injection-model.json'), 'utf8'));
const threshold = model.threshold;
const suspect = Math.min(0.6, threshold * 0.55);

function readRows(name) {
  const raw = gunzipSync(readFileSync(path.join(CORPUS, `${name}.jsonl.gz`)), { maxBufferLength: 512 * 1024 * 1024 });
  return raw.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const wcSignals = await import('file://' + path.join(WC, 'lib/signals.js'));
const regexHits = text => wcSignals.scanInjection([{ field: 'item_details', text }]);

const injectionCases = [];
const seenTexts = new Set();
for (const split of ['val', 'test']) {
  for (const row of readRows(split)) {
    if (row.label !== 1 || seenTexts.has(row.text)) continue;
    if (regexHits(row.text).length) continue;                    // regex already catches it
    const r = scoreInjectionText(row.text);
    if (!r || r.score < threshold + 0.05) continue;              // need margin above tau
    if (r.tokens < 8) continue;                                  // deployment-realistic lengths
    seenTexts.add(row.text);
    injectionCases.push({ text: row.text, score: Number(r.score.toFixed(4)), source: row.source, split });
  }
}
// prefer longer, higher-scoring, diverse examples
injectionCases.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
const picked = [];
for (const c of injectionCases) {
  if (picked.length >= 8) break;
  if (picked.some(p => p.split === c.split && p.source === c.source && picked.filter(x => x.source === c.source).length >= 4)) continue;
  picked.push(c);
}

const benignCases = [];
for (const row of readRows('eval')) {
  if (row.label !== 0) continue;
  if (!['viseca_pack', 'bipia_benign_tasks'].includes(row.source)) continue;
  const r = scoreInjectionText(row.text);
  if (!r || r.score >= suspect * 0.8) continue;                  // keep clear margin
  benignCases.push({ text: row.text, score: Number(r.score.toFixed(4)), source: row.source });
}
benignCases.sort((a, b) => b.score - a.score);
const benignPicked = benignCases.slice(0, 16);

if (!picked.length || !benignPicked.length) {
  console.error('fixture selection came up empty — refusing to write');
  process.exit(1);
}
const out = { generated: new Date().toISOString().slice(0, 10), threshold, suspect: Number(suspect.toFixed(4)), injection_cases: picked, benign_cases: benignPicked };
mkdirSync(path.join(WC, 'test/fixtures'), { recursive: true });
writeFileSync(path.join(WC, 'test/fixtures/injection_cases.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`fixtures: ${picked.length} regex-escaping attacks (scores ${picked[picked.length-1].score}–${picked[0].score}), ${benignPicked.length} benign`);
