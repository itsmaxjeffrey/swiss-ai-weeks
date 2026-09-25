#!/usr/bin/env node
/**
 * refresh-merchants.mjs — weekly evidence pass over data/merchants.json.
 *
 * Reuses wallet-control's MerchantDossier service (the same evidence engine
 * the yellow-list dossier UI uses): Zefix registry (token-free Lindas SPARQL,
 * REST status when LEASH_ZEFIX_* is set), Impressum parser, Trusted Shops
 * public API, payment scan, country check. Evidence only — a merchant is
 * never auto-trusted; the dataset just records what the sources say.
 *
 * Per merchant it writes:
 *   checked_at  ISO timestamp of this pass
 *   tier        "verified"  — active Swiss register entry (Zefix found + ACTIVE)
 *               "listed"    — Trusted Shops member (no register confirmation)
 *               "reviewed"  — checked; evidence recorded, nothing conclusive
 *   evidence    compact per-source facts (+ error when the dossier failed)
 *
 * Usage:
 *   node scripts/refresh-merchants.mjs [--limit N] [--url http://host]
 *
 * Scheduled weekly via OpenClaw automations; safe to run by hand anytime.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, '..');
const FILE = path.join(UI_ROOT, 'data', 'merchants.json');
const GLEIF_FILE = path.resolve(UI_ROOT, '..', 'wallet-control', 'data', 'gleif_ch_ages.json');

const argv = process.argv.slice(2);
const limit = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? Number(argv[i + 1]) || 0 : 0; })();

// wallet-control is ESM; import the proven evidence services by relative path.
const { MerchantDossier } = await import(path.resolve(UI_ROOT, '..', 'wallet-control', 'lib', 'yellowlist.js'));
const { TrustedShopsChecker } = await import(path.resolve(UI_ROOT, '..', 'wallet-control', 'lib', 'trustedshops.js'));
const { normalizeDomain } = await import(path.resolve(UI_ROOT, '..', 'wallet-control', 'lib', 'trustedshops.js'));

let gleifAges = null;
try { gleifAges = JSON.parse(readFileSync(GLEIF_FILE, 'utf8')); } catch { /* sparse coverage is fine */ }

const trustedShops = new TrustedShopsChecker();
const dossier = new MerchantDossier({ trustedShops, gleifAges });

const db = JSON.parse(readFileSync(FILE, 'utf8'));
const merchants = Array.isArray(db.merchants) ? db.merchants : [];
const targets = limit > 0 ? merchants.slice(0, limit) : merchants;
console.log(`[refresh-merchants] checking ${targets.length}/${merchants.length} merchants…`);

const t0 = Date.now();
const out = await dossier.check(targets.map((m) => m.domain));
const results = out.results;
console.log(`[refresh-merchants] dossiers built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const tiers = { verified: 0, listed: 0, reviewed: 0 };
let errors = 0;
for (const m of targets) {
  const r = results.find((x) => x.domain === m.domain.replace(/^www\./, ''));
  m.checked_at = new Date().toISOString();
  if (!r || r.error) {
    m.evidence = { error: r?.error || 'dossier unavailable', note: 'previous evidence kept; will retry next week' };
    errors++;
    continue;
  }
  const reg = r.registry || {};
  const ts = r.reviews?.shop || {};
  const verified = reg.status === 'found' && reg.status_active === true;
  const listed = ts.listed === true;
  m.evidence = {
    registry: {
      status: reg.status ?? null,
      company: reg.company_name ?? null,
      uid: reg.uid ?? null,
      active: reg.status_active ?? null,
      age_years: reg.age_years ?? null,
      imprint_match: reg.compare?.verdict ?? null,
    },
    imprint: { status: r.imprint?.status ?? null, company: r.imprint?.company_name ?? null },
    trusted_shops: { listed: ts.listed ?? null, rating: ts.rating ?? null, review_count: ts.review_count ?? null },
    payments: r.payments?.methods ?? [],
    country: { merchant: r.country?.merchant_country ?? null, same_as_customer: r.country?.same_country ?? null },
    summary: {
      positives: r.summary?.positives?.length ?? 0,
      negatives: r.summary?.negatives?.length ?? 0,
      unknowns: r.summary?.unknowns?.length ?? 0,
    },
  };
  m.tier = verified ? 'verified' : listed ? 'listed' : 'reviewed';
  tiers[m.tier]++;
}

db.updated_at = new Date().toISOString();
db.source = `${db.source?.split(';')[0] ?? 'seeded'}; evidence refreshed ${db.updated_at} by scripts/refresh-merchants.mjs (Zefix + Impressum + Trusted Shops via wallet-control MerchantDossier)`;

// atomic write (tmp + rename), matching the repo's store conventions
const tmp = `${FILE}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(db, null, 2));
renameSync(tmp, FILE);

console.log(`[refresh-merchants] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — verified: ${tiers.verified}, listed: ${tiers.listed}, reviewed: ${tiers.reviewed}, errors: ${errors}`);
console.log(`[refresh-merchants] wrote ${path.relative(process.cwd(), FILE)}`);
process.exit(0);
