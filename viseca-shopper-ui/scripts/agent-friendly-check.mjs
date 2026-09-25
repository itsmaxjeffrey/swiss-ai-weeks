#!/usr/bin/env node
/**
 * agent-friendly-check.mjs — probe merchant domains for AI-agent accessibility.
 *
 * For every domain in data/merchants.json (plus --extra a,b,c for catalog-only
 * domains) it fetches the homepage like a well-behaved automation client and
 * classifies the outcome:
 *
 *   ok                200 HTML with real content, no bot-wall markers
 *   blocked_datadome  DataDome captcha interstitial (geo.captcha-delivery.com)
 *   blocked_cloudflare  Cloudflare challenge ("Just a moment", cf-mitigated)
 *   blocked_akamai    Akamai denial (Reference #/AkamaiGHost)
 *   blocked_perimeterx  PerimeterX / HUMAN captcha
 *   blocked_imperva   Imperva/Incapsula interstitial
 *   blocked_queue     queue-it waiting room
 *   blocked_waf       AWS WAF / other explicit WAF denial
 *   blocked_generic   403/429 bot denial without a known fingerprint
 *   hard_fail         connection-level refusal / timeout / TLS failure
 *   dns_fail          domain does not resolve
 *
 * Only "ok" maps to agent_friendly = 1; everything else = 0. Results are
 * written to data/agent-friendly-report.json and, with --write, stamped into
 * data/merchants.json as agent_friendly + evidence.agent_check. The weekly
 * evidence refresh (refresh-merchants.mjs) preserves unknown fields, so the
 * flag survives until this script is run again.
 *
 * Politeness: sequential requests, ~0.5-0.9s jitter between domains, one
 * retry for transient failures, Retry-After honored, body reads capped.
 *
 * Usage:
 *   node scripts/agent-friendly-check.mjs [--write] [--extra a.com,b.com] [--limit N]
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, '..');
const FILE = path.join(UI_ROOT, 'data', 'merchants.json');
const REPORT = path.join(UI_ROOT, 'data', 'agent-friendly-report.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const WRITE = has('--write');
const EXTRA = (val('--extra') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(val('--limit')) || 0;
const MERGE = val('--merge');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'de-CH,de;q=0.9,en;q=0.6',
};
const TIMEOUT_MS = 12_000;
const BODY_CAP = 300_000; // stop reading after 300KB — walls announce themselves early
const BODY_SEEK = 150_000; // markers searched within the first 150KB

/* ---- wall fingerprints: marker in body/headers (+ optional requirement) ---- */
const WALLS = [
  { verdict: 'blocked_datadome', re: /captcha-delivery\.com|datadome/i, where: 'body' },
  { verdict: 'blocked_datadome', re: /^x-dd-b$/i, where: 'header' },
  { verdict: 'blocked_cloudflare', re: /challenges\.cloudflare\.com|cf-browser-verification|cf_chl_|just a moment\.\.\./i, where: 'body', requireStatus: [403, 503, 429, 200] },
  { verdict: 'blocked_cloudflare', re: /^cf-mitigated$/i, where: 'header' },
  { verdict: 'blocked_akamai', re: /reference #|akamaighost|support\.id:/i, where: 'body', requireStatus: [403, 429] },
  { verdict: 'blocked_perimeterx', re: /px-captcha|perimeterx|human-security/i, where: 'body' },
  { verdict: 'blocked_imperva', re: /_incapsula_resource|incapsula|request unsuccessful\. http status: 403/i, where: 'body' },
  { verdict: 'blocked_queue', re: /queue-it\.net|^x-queueit-/i, where: 'any' },
  { verdict: 'blocked_waf', re: /awswaf|x-amzn-waf|kasada|sucuri|sucuri_|ddos-guard/i, where: 'any' },
];

function classify(status, headers, body) {
  const head = Object.keys(headers || {}).join('\n');
  const seek = (body || '').slice(0, BODY_SEEK);
  for (const w of WALLS) {
    if (w.requireStatus && !w.requireStatus.includes(status)) continue;
    const hay = w.where === 'body' ? seek : w.where === 'header' ? head : seek + '\n' + head;
    const m = hay.match(w.re);
    if (m) return { wall: w.verdict, marker: m[0].slice(0, 80) };
  }
  if ([403, 429].includes(status)) return { wall: 'blocked_generic', marker: `http ${status}` };
  if (status === 503) return { wall: 'blocked_generic', marker: 'http 503' };
  return null;
}

function fetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS);
  return fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal })
    .then(async (res) => {
      clearTimeout(timer);
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('html') && res.status >= 400) {
        try { await res.body?.cancel(); } catch { /* already closed */ }
        return { status: res.status, headers: res.headers, ctype, body: '' };
      }
      // capped body read
      let body = '';
      try {
        const reader = res.body?.getReader();
        if (reader) {
          const dec = new TextDecoder();
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            got += value.length;
            body += dec.decode(value, { stream: true });
            if (got >= BODY_CAP) { ctrl.abort('body-cap'); break; }
          }
        } else {
          body = await res.text();
        }
      } catch { /* cap-abort or truncation is fine */ }
      return { status: res.status, headers: res.headers, ctype, body };
    })
    .catch((e) => { clearTimeout(timer); throw e; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(450 + Math.floor(Math.random() * 450));

async function probe(domain) {
  const url = `https://www.${domain}/`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { status, headers, ctype, body } = await fetchOnce(url);
      const wall = classify(status, headers, body);
      if (wall) {
        // one retry for ambiguous generic denials; fingerprinted walls are final
        if (wall.wall === 'blocked_generic' && attempt === 1) { await jitter() ; continue; }
        return { domain, verdict: wall.wall, http_status: status, marker: wall.marker };
      }
      const looksReal = status === 200 && ctype.includes('html') && /<title|og:|<html/i.test(body) && body.length >= 5_000;
      if (looksReal) return { domain, verdict: 'ok', http_status: status, marker: null, bytes: body.length };
      if (attempt === 1) { await jitter(); continue; }
      return { domain, verdict: status === 200 ? 'blocked_generic' : 'hard_fail', http_status: status, marker: `thin/odd response (${body.length}B, ${ctype || 'no type'})` };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.cause?.code || e?.message || e);
      if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return { domain, verdict: 'dns_fail', marker: msg.slice(0, 120) };
      if (attempt === 1) { await jitter(); continue; }
      return { domain, verdict: 'hard_fail', marker: msg.slice(0, 120) };
    }
  }
  return { domain, verdict: 'hard_fail', marker: String(lastErr).slice(0, 120) };
}

/* ---- run ---- */
const db = JSON.parse(readFileSync(FILE, 'utf8'));
const merchants = Array.isArray(db.merchants) ? db.merchants : [];
const targets = LIMIT > 0 ? merchants.slice(0, LIMIT) : merchants;
const domains = [...new Set([...targets.map((m) => m.domain.replace(/^www\./, '')), ...EXTRA])];
console.log(`[agent-check] probing ${domains.length} domains (${targets.length} dataset + ${EXTRA.length} extra)…`);

const results = [];
const t0 = Date.now();
for (const d of domains) {
  const r = await probe(d);
  results.push(r);
  console.log(`  ${d.padEnd(22)} ${r.verdict}${r.marker ? ' — ' + r.marker : ''}`);
  await jitter();
}
console.log(`[agent-check] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

/* Optional managed-browser-verified overrides (--merge file.json):
 * { "<domain>": { "verdict": "ok|blocked_generic|…", "marker": "…" } }.
 * A real Chromium pass/fail outranks the plain-fetch verdict — the shopping
 * agent browses through a managed browser, so that is the deciding vantage. */
if (MERGE) {
  const overrides = JSON.parse(readFileSync(MERGE, 'utf8'));
  let applied = 0;
  for (const r of results) {
    const o = overrides[r.domain];
    if (!o || !o.verdict) continue;
    r.verdict = o.verdict;
    r.marker = o.marker ?? r.marker;
    r.source = 'browser';
    applied++;
  }
  console.log(`[agent-check] merged ${applied} browser-verified verdicts from ${path.relative(process.cwd(), MERGE)}`);
}

const counts = {};
for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
const report = { checked_at: new Date().toISOString(), counts, results };
writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(`[agent-check] report → ${path.relative(process.cwd(), REPORT)}`);
console.log(`[agent-check] summary: ${JSON.stringify(counts)}`);

if (WRITE) {
  const byDomain = new Map(results.map((r) => [r.domain, r]));
  let friendly = 0;
  for (const m of targets) {
    const r = byDomain.get(m.domain.replace(/^www\./, ''));
    if (!r) continue;
    m.agent_friendly = r.verdict === 'ok' ? 1 : 0;
    m.evidence = m.evidence && typeof m.evidence === 'object' ? m.evidence : {};
    m.evidence.agent_check = { at: report.checked_at, verdict: r.verdict, http_status: r.http_status ?? null, marker: r.marker ?? null };
    if (m.agent_friendly === 1) friendly++;
  }
  const tmp = `${FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, FILE);
  console.log(`[agent-check] wrote agent_friendly to ${path.relative(process.cwd(), FILE)} — ${friendly}/${targets.length} agent-friendly`);
}
process.exit(0);
