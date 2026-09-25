#!/usr/bin/env node
// Build wallet-control datasets from the merchant-trust-data exports.
//
//   node tools/build-datasets.mjs
//
// Reads ../merchant-trust-data/data/exports/external/*.csv.gz and emits into
// wallet-control/data/:
//   leash_trust.json       v2 — malicious_domains (+threatfox), malicious_ips
//                             (FeodoTracker + AbuseIPDB), GLEIF legit lists
//   popularity.json        Tranco ∪ Majestic best-rank map (top POPULARITY_CAP)
//   sanctions_names.json   SECO + OFAC + UN normalized name index
//   mcc_risk.json          TabFormer sample: fraud rate per MCC (+ high flag)
//
// Zero runtime deps (node:zlib only). Deterministic except `generated` stamps.
// Sources & licensing: see merchant-trust-data/data/exports/external/EXTERNAL_QUALITY_REPORT.md

import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName } from '../lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EXPORTS = path.join(ROOT, '..', 'merchant-trust-data', 'data', 'exports', 'external');
const OUT = path.join(ROOT, 'data');
const POPULARITY_CAP = 200_000;      // top-N global ranks kept (JSON size vs. coverage)
const ABUSEIPDB_MIN_CONF = 80;       // IP reputation bar (median confidence in feed is 24)
// The tabformer_sample export is fraud-enriched (base rate ~20% vs ~0.12% in
// the full 24.4M-row corpus), so absolute thresholds are meaningless here.
// Calibration is therefore *within-corpus relative*: an MCC is HIGH when its
// sample fraud rate >= REL_MEDIAN_FACTOR × the median MCC rate — enrichment
// cancels out and the ranking survives.
const MCC_MIN_SUPPORT = 500;         // MCC must appear >= N times in the TabFormer sample
const REL_MEDIAN_FACTOR = 2.5;       // high = rate >= 2.5 × median MCC rate
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- tiny gz CSV reader (RFC4180-ish: quotes, CRLF, embedded commas) --
function readGzCsv(rel) {
  const file = path.join(EXPORTS, rel);
  if (!fs.existsSync(file)) return null;
  const text = gunzipSync(fs.readFileSync(file)).toString('utf8');
  return parseCsv(text);
}
function readPlainCsv(rel) {
  const file = path.join(EXPORTS, rel);
  if (!fs.existsSync(file)) return null;
  return parseCsv(fs.readFileSync(file, 'utf8'));
}
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const isDomainish = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) && !isIp(s);

const out = {};
function emit(name, obj) {
  out[name] = obj;
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
}

// ---------- 1) leash_trust.json v2 ------------------------------------------
// Preserve v1 (OpenPhish + URLhaus + GLEIF) and extend with ThreatFox domains
// and malicious IPs. Deliberate scope choice: ThreatFox *url*-type IOCs are
// skipped because their entity is a shared host (t.me, …) — only *domain*-type
// IOCs name infrastructure dedicated to the campaign.
{
  const prevPath = path.join(OUT, 'leash_trust.json');
  const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : {};
  const malicious = { ...(prev.malicious_domains || {}) };
  const sources = countSources(malicious); // v1 values: 'phishing' | 'malware'

  const tf = readGzCsv('threatfox/threatfox_recent.csv.gz');
  let tfAdded = 0;
  for (const r of tf || []) {
    if (r.ioc_type !== 'domain') continue;
    const dom = (r.entity || '').toLowerCase().trim();
    if (!isDomainish(dom)) continue;
    if (!malicious[dom]) { malicious[dom] = `threatfox:${r.threat_type || 'malware'}`; tfAdded++; }
  }
  sources.threatfox = tfAdded;

  const ips = {};
  const feodo = readGzCsv('feodotracker/feodotracker_ipblocklist.csv.gz');
  for (const r of feodo || []) {
    const ip = (r.ip_address || '').trim();
    if (isIp(ip)) ips[ip] = `feodo:${r.malware || 'malware'}`;
  }
  sources.feodotracker = Object.keys(ips).length;

  const abuse = readGzCsv('abuseipdb/abuseipdb.csv.gz');
  let abuseAdded = 0;
  for (const r of abuse || []) {
    const ip = (r.ip_address || '').trim();
    const conf = Number(r.abuse_confidence_score || 0);
    if (isIp(ip) && conf >= ABUSEIPDB_MIN_CONF && !ips[ip]) { ips[ip] = `abuseipdb:${conf}`; abuseAdded++; }
  }
  sources.abuseipdb = abuseAdded;

  emit('leash_trust.json', {
    generated: TODAY,
    source: 'merchant-trust-data exports: OpenPhish + URLhaus + ThreatFox (domains), FeodoTracker + AbuseIPDB (IPs), GLEIF-CH (legit registry)',
    sources,
    malicious_domains: malicious,
    malicious_ips: ips,
    legit_companies: prev.legit_companies || [],
    legit_domains: prev.legit_domains || {},
  });
}

function countSources(malicious) {
  const c = { openphish: 0, urlhaus: 0 };
  for (const v of Object.values(malicious)) {
    if (v === 'phishing') c.openphish++;
    else if (v === 'malware') c.urlhaus++;
  }
  return c;
}

// ---------- 2) popularity.json (Tranco ∪ Majestic) ---------------------------
{
  const best = new Map(); // domain -> {r, s}
  const add = (dom, rank, src) => {
    const d = String(dom || '').toLowerCase().replace(/^www\./, '').trim();
    if (!isDomainish(d)) return;
    const cur = best.get(d);
    if (!cur || rank < cur.r) best.set(d, { r: rank, s: cur && cur.r < rank ? cur.s : src });
  };
  const tranco = readGzCsv('tranco/tranco_top1m.csv.gz');
  for (const r of tranco || []) add(r.domain, Number(r.rank), 'tranco');
  const majestic = readGzCsv('majestic/majestic_million.csv.gz');
  for (const r of majestic || []) add(r.Domain, Number(r.GlobalRank), 'majestic');

  const domains = {};
  for (const [d, v] of best) if (v.r <= POPULARITY_CAP) domains[d] = v;
  emit('popularity.json', {
    generated: TODAY,
    sources: ['tranco_top1m', 'majestic_million'],
    cap: POPULARITY_CAP,
    note: 'best (lowest) global rank across both top-1M lists; evidence only — never changes engine decisions',
    domains,
  });
}

// ---------- 3) sanctions_names.json (SECO + OFAC + UN) -----------------------
{
  const names = {}; // normalizeName(name) -> {n: original, s: source}
  const add = (raw, src) => {
    const n = (raw || '').trim();
    if (!n) return;
    const k = normalizeName(n);
    if (!k || k.length < 4) return;      // skip initials / junk
    if (!names[k]) names[k] = { n, s: src };
  };

  let secoN = 0;
  for (const r of readGzCsv('sanctions_seco/seco_sanctions.csv.gz') || []) {
    add(r.name, 'seco'); secoN++;
    try { for (const alt of JSON.parse(r.alt_names || '[]')) add(alt, 'seco'); } catch { /* alt_names is advisory */ }
  }
  let ofacN = 0;
  for (const r of readGzCsv('sanctions_ofac/ofac_sdn.csv.gz') || []) {
    // keep individuals/entities; skip vessels & aircraft (tonnage/flag/call sign populated)
    const vessel = [r.tonnage, r.grt, r.vessel_type, r.vessel_flag, r.call_sign].some((v) => String(v || '').trim() !== '');
    if (vessel) continue;
    add(r.sdn_name, 'ofac'); ofacN++;
  }
  let unN = 0;
  for (const r of readGzCsv('sanctions_un/un_consolidated.csv.gz') || []) { add(r.name, 'un'); unN++; }

  emit('sanctions_names.json', {
    generated: TODAY,
    sources: { seco_rows: secoN, ofac_rows: ofacN, un_rows: unN },
    note: 'exact normalized-name match only (util.normalizeName) — no fuzzy matching, to keep false positives near zero',
    names,
  });
}

// ---------- 4) mcc_risk.json (TabFormer sample) -------------------------------
{
  const rows = readGzCsv('tabformer/tabformer_sample.csv.gz');
  const byMcc = new Map();
  let total = 0, frauds = 0;
  for (const r of rows || []) {
    const mcc = String(r.MCC || '').trim();
    if (!mcc || !/^\d{1,4}$/.test(mcc)) continue;
    const f = String(r['Is Fraud?']).trim() === '1' ? 1 : 0;
    total++; frauds += f;
    const e = byMcc.get(mcc) || { n: 0, frauds: 0 };
    e.n++; e.frauds += f;
    byMcc.set(mcc, e);
  }
  const base = total ? frauds / total : 0;
  const kept = [];
  for (const [mcc, e] of byMcc) {
    if (e.n >= MCC_MIN_SUPPORT) kept.push([mcc, e, e.frauds / e.n]);
  }
  const rates = kept.map(([, , r]) => r).sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
  const mccs = {};
  for (const [mcc, e, rate] of kept) {
    mccs[mcc] = {
      n: e.n, frauds: e.frauds, rate: Number(rate.toFixed(4)),
      high: median > 0 && rate >= REL_MEDIAN_FACTOR * median,
    };
  }
  emit('mcc_risk.json', {
    generated: TODAY,
    corpus: 'IBM TabFormer credit-card transactions (fraud-enriched sample export; merchant names are hashed — MCC is the join key)',
    rows_total: total,
    frauds_total: frauds,
    base_rate: Number(base.toFixed(5)),
    sample_median_mcc_rate: Number(median.toFixed(4)),
    min_support: MCC_MIN_SUPPORT,
    high_rule: `sample rate >= ${REL_MEDIAN_FACTOR}x median MCC rate (${(median * 100).toFixed(1)}%), n >= ${MCC_MIN_SUPPORT} — relative rule, robust to sample fraud-enrichment`,
    mccs,
  });
}

// ---------- summary -----------------------------------------------------------
for (const [name, obj] of Object.entries(out)) {
  const size = fs.statSync(path.join(OUT, name)).size;
  const detail = name === 'leash_trust.json'
    ? `${Object.keys(obj.malicious_domains).length} bad domains, ${Object.keys(obj.malicious_ips).length} bad IPs, ${obj.legit_companies.length} legit companies`
    : name === 'popularity.json' ? `${Object.keys(obj.domains).length} ranked domains`
    : name === 'sanctions_names.json' ? `${Object.keys(obj.names).length} sanctioned names`
    : `${Object.keys(obj.mccs).length} MCCs (base rate ${(obj.base_rate * 100).toFixed(2)}%)`;
  console.log(`  ✓ ${name}  (${(size / 1e6).toFixed(1)} MB) — ${detail}`);
}
console.log('\nDone. Restart the wallet server / rerun cli.js to pick them up.');
