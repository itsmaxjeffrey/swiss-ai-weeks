#!/usr/bin/env node
// LEASH wallet-control — integration/token readiness report.
//
//   node tools/token-status.mjs
//
// Informational only (always exit 0): shows which data integrations are LIVE
// out of the box, which optional API keys unlock more, and which are blocked
// upstream. Mirrors merchant-trust-data collectors + yellowlist.js env names.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const yes = (b) => (b ? '✓ enabled' : '· not set');

const keys = [
  {
    env: 'LEASH_ZEFIX_TOKEN', set: process.env.LEASH_ZEFIX_TOKEN,
    what: 'Zefix REST enrichment (registration dates for company age)',
    note: 'optional: registry verification already works token-free via Lindas SPARQL',
    enable: 'free registration at zefix.ch → export LEASH_ZEFIX_TOKEN="email:token"',
  },
  {
    env: 'LEASH_HF_TOKEN', set: process.env.LEASH_HF_TOKEN,
    what: 'HackAPrompt corpus (prompt-injection detector training)',
    note: 'blocked upstream: HF-gated dataset, terms must be accepted once',
    enable: 'accept terms at huggingface.co/datasets/hackaprompt/hackaprompt-dataset → export LEASH_HF_TOKEN → rerun collect in merchant-trust-data',
  },
  {
    env: 'LEASH_ABUSECH_KEY', set: process.env.LEASH_ABUSECH_KEY,
    what: 'MalwareBazaar API (extra malware IOC feed)',
    note: 'blocked upstream: abuse.ch API needs a free auth key; feed unreachable via egress proxy without it',
    enable: 'free abuse.ch account → export LEASH_ABUSECH_KEY → rerun collect in merchant-trust-data',
  },
  {
    env: 'TEAM_API_KEY', set: process.env.TEAM_API_KEY,
    what: 'Live challenge API mode (vs offline pack simulator)',
    note: 'the demo runs fully offline without it',
    enable: 'export TEAM_API_KEY + LEASH_BASE_URL from the challenge team page',
  },
  {
    env: 'SHOPPER_BRIDGE_SYNC_TOKEN', set: process.env.SHOPPER_BRIDGE_SYNC_TOKEN,
    what: 'Trusted-merchant sync to the shopper bridge on step-up approval',
    note: 'optional: approvals still work locally without the bridge',
    enable: 'export SHOPPER_BRIDGE_URL + SHOPPER_BRIDGE_SYNC_TOKEN (+ SHOPPER_BRIDGE_USER)',
  },
];

const datasets = [
  ['leash_trust.json', 'threat domains + malicious IPs + GLEIF legit registry'],
  ['popularity.json', 'Tranco ∪ Majestic top-1M ranks (evidence only)'],
  ['sanctions_names.json', 'SECO + OFAC + UN name screen (hard decline on exact hit)'],
  ['mcc_risk.json', 'TabFormer MCC fraud priors (escalation-only)'],
  ['gleif_ch_ages.json', 'GLEIF-CH company ages (dossier)'],
  ['sustainability.json', 'shop sustainability scores (advisory)'],
];

console.log('— optional API keys —');
for (const k of keys) {
  console.log(`  ${yes(k.set).padEnd(12)} ${k.env.padEnd(28)} ${k.what}`);
  if (!k.set) console.log(`${' '.repeat(15)}${k.note}\n${' '.repeat(15)}enable: ${k.enable}`);
}

console.log('\n— built datasets (tools/build-datasets.mjs) —');
for (const [f, what] of datasets) {
  const p = path.join(ROOT, 'data', f);
  if (!fs.existsSync(p)) { console.log(`  ✗ MISSING    ${f.padEnd(22)} ${what}`); continue; }
  const mb = (fs.statSync(p).size / 1e6).toFixed(1);
  console.log(`  ✓ ${(mb + ' MB').padEnd(9)} ${f.padEnd(22)} ${what}`);
}
console.log('\nBlocked-upstream feeds (code-ready, waiting on keys): Zefix REST, HackAPrompt, MalwareBazaar, EU sanctions bulk (needs EU Login).');
