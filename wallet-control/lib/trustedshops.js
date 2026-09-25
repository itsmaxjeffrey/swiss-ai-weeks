// LEASH wallet-control — Trusted Shops merchant verification (advisory evidence).
//
// Answers one question fast: "is this merchant website listed on Trusted Shops?"
// The public REST API (api.trustedshops.com, rest/public/v2) is a single global
// registry behind all country sites (.com/.de/.ch/…): one lookup per domain
// returns every registration with its target market, and a second call per
// tsId returns the review quality. Both verified live 2026-09-25:
//   GET {api}/shops.json?url=<host>          → 200 {shops:[{tsId,url,name,targetMarketISO3,languageISO2}]}
//                                             or 404 SHOP_URL_NOT_FOUND (host genuinely not registered)
//   GET {api}/shops/<tsId>/quality.json      → 200 {shop:{qualityIndicators:{reviewIndicator:{overallMark,…}}}}
//
// Guarantees (mirror the engine's design principles):
//  - Evidence only. "Not listed" is NEVER a fail or an uncertainty — many
//    legitimate shops (digitec, brack) are not TS members. This module produces
//    facts for the decision grid; the engine alone decides what they mean.
//  - Degrades silently: timeouts/errors yield listed:null with a reason.
//  - Fast by construction: bounded concurrency, per-request timeout, TTL cache,
//    in-flight de-duplication (parallel checks of the same domain share one fetch).
import { normalizeName } from './util.js';

const MARKET_LABELS = {
  CHE: 'Switzerland (trustedshops.ch)', DEU: 'Germany (trustedshops.de)', AUT: 'Austria',
  FRA: 'France (trustedshops.fr)', ITA: 'Italy (trustedshops.it)', ESP: 'Spain (trustedshops.es)',
  NLD: 'Netherlands (trustedshops.nl)', POL: 'Poland (trustedshops.pl)', GBR: 'UK (trustedshops.co.uk)',
  USA: 'US', EUO: 'EU / international', WLD: 'international',
};

export function marketLabel(code) {
  return MARKET_LABELS[String(code || '').toUpperCase()] || (code ? `market ${code}` : 'unknown market');
}

/** Normalize any user/agent input to a bare hostname. Returns {domain} or null
 *  when the input is not domain-like (then it is treated as a merchant NAME,
 *  which the TS registry cannot be searched by — no domains are ever invented). */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || /\s/.test(s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0])) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = (u.hostname || '').toLowerCase();
  if (!host || !host.includes('.') || host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return { domain: host };
}

/** Pull one input — URL, bare domain, or {url|domain|name} — apart. */
export function parseMerchantInput(input) {
  const raw = typeof input === 'string' ? input : (input?.url || input?.domain || input?.website || input?.merchant_url || null);
  const name = typeof input === 'object' && input ? (input.name || input.merchant_name || null) : null;
  const dom = normalizeDomain(raw);
  if (dom) return { domain: dom.domain, name: name || dom.domain };
  return { domain: null, name: name || (typeof input === 'string' ? input : null) || String(input) };
}

const DEFAULTS = {
  apiBase: 'https://api.trustedshops.com/rest/public/v2',
  timeoutMs: 4000,      // per HTTP request
  concurrency: 8,       // max in-flight requests across a whole batch
  ttlMs: 6 * 60 * 60 * 1000,  // cache entries live 6h; re-checked after that
  maxQualityLookups: 3, // quality fetches per listed merchant (primary first)
  maxShopsPerMerchant: 5,
};

export class TrustedShopsChecker {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.fetchImpl = this.o.fetchImpl || globalThis.fetch.bind(globalThis);
    this.cache = new Map();   // domain -> {at, result}
    this.inflight = new Map(); // domain -> Promise (de-dupe parallel checks)
    this.stats = { lookups: 0, qualityCalls: 0, cacheHits: 0, errors: 0 };
  }

  /** Check many merchants concurrently. Returns {results, tookMs}. */
  async check(inputs) {
    const list = (Array.isArray(inputs) ? inputs : [inputs]).slice(0, 50);
    const t0 = Date.now();
    const results = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        results[i] = await this.checkOne(list[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency, list.length) }, worker));
    return { results, tookMs: Date.now() - t0 };
  }

  /** Check one merchant (by URL/domain; name-only resolves to "no domain"). */
  async checkOne(input) {
    const parsed = parseMerchantInput(input);
    const at = new Date().toISOString();
    if (!parsed.domain) {
      return { input, name: parsed.name, resolvedDomain: null, listed: null, shops: [], primary: null, reason: 'no domain supplied — Trusted Shops is verified by website, and no domain was invented from the name', checkedAt: at, fromCache: false };
    }
    const key = parsed.domain;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.o.ttlMs) {
      this.stats.cacheHits++;
      return { ...cached.result, fromCache: true, checkedAt: new Date(cached.at).toISOString() };
    }
    const pending = this.inflight.get(key);
    if (pending) return { ...(await pending), fromCache: false };
    const p = this.#fetchAndRate(key, input, at).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return { ...(await p), fromCache: false };
  }

  async #fetchAndRate(domain, input, at) {
    const t0 = Date.now();
    try {
      this.stats.lookups++;
      const url = `${this.o.apiBase}/shops.json?url=${encodeURIComponent(domain)}`;
      const res = await this.#deadline(
        this.fetchImpl(url, { signal: AbortSignal.timeout(this.o.timeoutMs), headers: { accept: 'application/json' } }),
        this.o.timeoutMs, 'Trusted Shops lookup',
      );
      if (res.status === 404) {
        const result = { input, name: domain, resolvedDomain: domain, listed: false, shops: [], primary: null, checkedAt: at, lookupMs: Date.now() - t0 };
        this.cache.set(domain, { at: Date.now(), result });
        return result;
      }
      if (!res.ok) throw new Error(`TS lookup HTTP ${res.status}`);
      const body = await res.json();
      const shops = (body?.response?.data?.shops || [])
        .slice(0, this.o.maxShopsPerMerchant)
        .map(s => ({
          tsId: s.tsId,
          name: s.name || domain,
          registeredUrl: s.url || domain,
          targetMarket: s.targetMarketISO3 || null,
          market: marketLabel(s.targetMarketISO3),
          language: s.languageISO2 || null,
          rating: null,
        }));
      // Review quality for the most-reviewed-looking entries (API gives no count
      // in the lookup; order is registration order — cap keeps batches fast).
      await Promise.all(shops.slice(0, this.o.maxQualityLookups).map(async s => { s.rating = await this.#quality(s.tsId); }));
      const withRating = shops.filter(s => s.rating?.overallMark != null);
      const primary = withRating.sort((a, b) => (b.rating.totalReviewCount || 0) - (a.rating.totalReviewCount || 0))[0]
        || shops[0] || null;
      const result = { input, name: primary?.name || domain, resolvedDomain: domain, listed: shops.length > 0, shops, primary, checkedAt: at, lookupMs: Date.now() - t0 };
      this.cache.set(domain, { at: Date.now(), result });
      return result;
    } catch (err) {
      this.stats.errors++;
      return { input, name: domain, resolvedDomain: domain, listed: null, shops: [], primary: null, reason: `check failed: ${err.message}`, checkedAt: at, lookupMs: Date.now() - t0 };
    }
  }

  /** Enforce the caller-side deadline with a real (ref'ed) timer. AbortSignal alone is
   *  not enough: it never keeps the event loop alive, so a pure-hang fetch would drain
   *  the loop and Node would exit/warn before the abort fires. */
  #deadline(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
  }

  async #quality(tsId) {
    try {
      this.stats.qualityCalls++;
      const res = await this.#deadline(
        this.fetchImpl(`${this.o.apiBase}/shops/${encodeURIComponent(tsId)}/quality.json`, { signal: AbortSignal.timeout(this.o.timeoutMs), headers: { accept: 'application/json' } }),
        this.o.timeoutMs, 'Trusted Shops quality',
      );
      if (!res.ok) return null;
      const body = await res.json();
      const ri = body?.response?.data?.shop?.qualityIndicators?.reviewIndicator;
      if (!ri) return null;
      return {
        overallMark: typeof ri.overallMark === 'number' ? ri.overallMark : null,
        description: ri.overallMarkDescription || null,
        totalReviewCount: ri.totalReviewCount ?? null,
        activeReviewCount: ri.activeReviewCount ?? null,
        reviewsCountedSince: ri.reviewsCountedSince || null,
      };
    } catch {
      return null; // rating is garnish; listed/not-listed already stands
    }
  }
}

/** One-line human summary used in engine evidence and step-up UI. */
export function describeResult(r) {
  if (!r) return null;
  if (r.listed === true) {
    const p = r.primary;
    if (p?.rating?.overallMark != null) {
      return `listed on Trusted Shops — ${p.rating.overallMark.toFixed(2)}/5.00 "${p.rating.description || ''}" from ${p.rating.totalReviewCount} reviews since ${p.rating.reviewsCountedSince || 'n/a'}, certified for ${p.market} (tsId ${p.tsId})`;
    }
    const markets = [...new Set(r.shops.map(s => s.market))].join(', ');
    return `listed on Trusted Shops (${markets}) — tsId ${r.shops.map(s => s.tsId).join(', ')}`;
  }
  if (r.listed === false) return `not listed on Trusted Shops (checked live ${r.checkedAt}) — neutral: many legitimate shops are not members`;
  return `Trusted Shops check unavailable: ${r.reason || 'unknown reason'}`;
}
