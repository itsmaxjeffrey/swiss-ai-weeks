#!/usr/bin/env node
// Build data/gleif_ch_ages.json — UID → company creation date from the local
// GLEIF-CH raw chunks (merchant-trust-data pipeline output). Zero-dep.
// Usage: node scripts/build-gleif-ages.mjs   (GLEIF_RAW_DIR overrides source)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // wallet-control/
const SRC = process.env.GLEIF_RAW_DIR || path.join(ROOT, '..', 'merchant-trust-data', 'data', 'raw', 'gleif');
const OUT = path.join(ROOT, 'data', 'gleif_ch_ages.json');

const files = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json')) : [];
if (!files.length) { console.error(`no GLEIF chunks found in ${SRC}`); process.exit(1); }

const UID_RE = /CHE\s*-?\s*(\d{3})\s*[.\s]?\s*(\d{3})\s*[.\s]?\s*(\d{3})/;
const ages = {};
let scanned = 0, withDate = 0;

for (const f of files) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')); } catch { continue; }
  const items = Array.isArray(data) ? data : (data.data || []);
  for (const it of items) {
    const a = it.attributes || {};
    const e = a.entity || {};
    scanned++;
    const cd = e.creationDate;
    if (!cd) continue;
    const m = String(e.registeredAs || '').match(UID_RE);
    if (!m) continue;
    const uid = `CHE${m[1]}${m[2]}${m[3]}`;
    if (ages[uid]) continue;
    const ts = Date.parse(cd);
    if (!Number.isFinite(ts)) continue;
    withDate++;
    ages[uid] = {
      name: String(e.legalName?.name || e.legalName || '').slice(0, 80),
      creationDate: cd.slice(0, 10),
    };
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(ages, null, 0));
console.log(`scanned ${scanned} GLEIF records from ${files.length} chunks → ${withDate} UIDs with creation dates → ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
