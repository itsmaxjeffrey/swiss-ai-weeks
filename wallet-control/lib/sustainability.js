// LEASH wallet-control — basic merchant sustainability lookup.
//
// Scope (deliberately minimal, demo-grade): a static, hand-curated score per
// shop domain in data/sustainability.json — one number + a one-line note per
// merchant. Not a certification feed. Guarantees mirror the rest of the
// evidence layer:
//  - Evidence only. Sustainability NEVER approves, declines, or reorders a
//    payment decision; it informs the customer's merchant choice when the
//    "prefer sustainable shops" option is on (offer comparison + suggestion).
//  - Never fabricated: a shop without data is reported as band "unknown",
//    never guessed from its name, category, or country.
//  - Deterministic: same input → same output, no network, no model.

import fs from 'node:fs';
import { normalizeDomain } from './trustedshops.js';

/** Load the static dataset into a Map(domain → {score, note}). A missing or
 *  broken file yields an empty index (every lookup degrades to "unknown"),
 *  never a crash. Malformed entries are skipped, not guessed. */
export function loadSustainabilityIndex(file) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = {};
  }
  const index = new Map();
  for (const [domain, entry] of Object.entries(raw.merchants || {})) {
    const score = Number(entry?.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) continue;
    index.set(String(domain).toLowerCase().replace(/^www\./, ''), {
      score,
      note: String(entry?.note || ''),
    });
  }
  return index;
}

/** Look up a shop domain (URL or bare domain accepted). Returns
 *  {score, band, note}; band ∈ good|medium|poor|unknown. */
export function lookupSustainability(domain, index) {
  const norm = normalizeDomain(domain || '');
  const d = norm?.domain || (typeof domain === 'string' ? domain.trim().toLowerCase() : '');
  if (!d || !d.includes('.')) return { score: null, band: 'unknown', note: 'no shop domain given' };
  const hit = index.get(d) || index.get(d.replace(/^www\./, ''));
  if (!hit) return { score: null, band: 'unknown', note: 'no data in the static sustainability dataset' };
  const band = hit.score >= 70 ? 'good' : hit.score >= 45 ? 'medium' : 'poor';
  return { score: hit.score, band, note: hit.note };
}

/** Basic deterministic merchant risk score (0–100, higher = riskier) from
 *  existing local signals only: customer trusted list, LEASH threat-intel
 *  malicious-domain hit, Trusted Shops listing/rating. Advisory context for
 *  the offer comparison — the decision engine's own rules are unaffected. */
export function scoreMerchantRisk({ trusted = false, malicious = false, trustedShopsResult = null } = {}) {
  if (malicious) {
    return { score: 90, band: 'high', reasons: ['merchant matches known-malicious infrastructure in the LEASH threat-intel dataset'] };
  }
  const reasons = [];
  let score = 55; // unverified baseline
  if (trusted) { score -= 35; reasons.push('on your trusted merchants list'); }
  const ts = trustedShopsResult;
  if (ts && ts.listed) {
    const mark = ts.primary?.rating?.overallMark;
    if (mark != null) { score -= 20; reasons.push(`Trusted Shops rating ${mark}/5`); }
    else { score -= 10; reasons.push('Trusted Shops profile found (no rating)'); }
  } else if (ts && ts.listed === false) {
    reasons.push('no Trusted Shops profile');
  } else {
    reasons.push('Trusted Shops check unavailable');
  }
  if (!reasons.length) reasons.push('no corroborating signals');
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = score <= 30 ? 'low' : score <= 60 ? 'medium' : 'high';
  return { score, band, reasons };
}

const RISK_BAND_ORDER = { low: 0, medium: 1, high: 2, unknown: 3 };

/** Rank offers for the comparison view. Risk band first (low < medium < high);
 *  when prefer is on, sustainability breaks ties WITHIN the same risk band
 *  only — it never promotes an offer past a strictly safer band. Within a
 *  band, shops with sustainability data sort before unknown ones, then lower
 *  absolute risk wins. `limit` (when a positive number) caps the result to the
 *  top N — the comparison endpoint compares only the top 3 by this score.
 *  Pure + deterministic. */
export function rankOffers(offers, { prefer = false, limit = null } = {}) {
  const ranked = offers.slice().sort((a, b) => {
    const r = (RISK_BAND_ORDER[a.risk?.band] ?? 3) - (RISK_BAND_ORDER[b.risk?.band] ?? 3);
    if (r !== 0) return r;
    if (prefer) {
      const sa = a.sustainability?.score ?? null;
      const sb = b.sustainability?.score ?? null;
      if (sa != null && sb != null && sa !== sb) return sb - sa; // more sustainable first
      if (sa != null && sb == null) return -1; // known data before unknown
      if (sa == null && sb != null) return 1;
    }
    return (a.risk?.score ?? 0) - (b.risk?.score ?? 0); // lower absolute risk first
  });
  return Number.isFinite(limit) && limit > 0 ? ranked.slice(0, limit) : ranked;
}
