// LEASH wallet-control — Trusted Shops merchant verification (advisory evidence).
//
// Answers one question across ALL Trusted Shops country sites: "does this merchant
// show up on trustedshops.<tld>?" Two distinct things live in the TS ecosystem:
//   1. MEMBER registry (buyer-protection members): REST API
//        GET {api}/shops.json?url=<host>              → member entries + target market
//        GET {api}/shops/{tsId}/quality.json          → rating/review evidence
//      Verified live 2026-09-25. Members only — a non-member shop 404s here.
//   2. SHOP PROFILES on every country site (members AND non-members, e.g. digitec.ch,
//      which has a TS profile without being a member): every country domain
//      server-renders its shop search for GET /shops/?q=<query> and embeds the
//      results as JSON in the page's __NEXT_DATA__ script:
//        props.pageProps.shops = [{profileType, accountName, tsID, shopName, shopUrl,
//                                  averageRating, reviewCount, profileUrl}]
//      Country domains (owner-confirmed list): ch de at co.uk fr it es nl be pt pl eu.
//
// Guarantees (mirror the engine's design principles):
//  - Evidence only. "Not listed" is NEVER a fail or an uncertainty — many legitimate
//    shops are not on Trusted Shops at all. This module produces facts for the
//    decision grid; the engine alone decides what they mean.
//  - Degrades silently: total failure → listed:null with a reason; a single country
//    site failing is noted in search_errors and ignored.
//  - Fast by construction: bounded concurrency across the whole batch, per-request
//    deadlines the module enforces itself (AbortSignal alone never keeps the Node
//    event loop alive), 6 h TTL cache, in-flight de-duplication.
//  - Exact matches only: the country searches are fuzzy — a hit counts solely when
//    shopUrl/shopName equals the queried domain. Fuzzy near-misses never count.

const MARKET_LABELS = {
  CHE: 'Switzerland (trustedshops.ch)', DEU: 'Germany (trustedshops.de)', AUT: 'Austria (trustedshops.at)',
  FRA: 'France (trustedshops.fr)', ITA: 'Italy (trustedshops.it)', ESP: 'Spain (trustedshops.es)',
  NLD: 'Netherlands (trustedshops.nl)', POL: 'Poland (trustedshops.pl)', GBR: 'UK (trustedshops.co.uk)',
  BEL: 'Belgium (trustedshops.be)', PRT: 'Portugal (trustedshops.pt)', EUO: 'EU / international (trustedshops.eu)',
};

// Where a member's target market is surfaced as a country-site listing.
const MARKET_TLD = {
  CHE: 'ch', DEU: 'de', AUT: 'at', FRA: 'fr', ITA: 'it', ESP: 'es',
  NLD: 'nl', POL: 'pl', GBR: 'co.uk', BEL: 'be', PRT: 'pt', EUO: 'eu',
};

export function marketLabel(code) {
  return MARKET_LABELS[String(code || '').toUpperCase()] || (code ? `market ${code}` : 'unknown market');
}

/** Normalize any user/agent input to a bare hostname. Returns {domain} or null
 *  when the input is not domain-like (then it is treated as a merchant NAME,
 *  which Trusted Shops cannot be searched by — no domains are ever invented). */
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

const stripWww = s => String(s || '').toLowerCase().trim().replace(/^www\./, '');

// Domains that legitimately appear on fake-shops pages (CMS/CDN chrome) and must
// never count as warnings. Only LABELED warnings ("Fake <type> <domain> <date>")
// ever flag a merchant — precision over recall, a flag is a hard decline.
const FAKE_SHOP_EXCLUDE = /(^|\.)(trustedshops|etrusted|hubspot|hsforms|hubfs|hsstatic|cloudflare|jsdelivr|unpkg|splide|webcomponents|google|gstatic|w3|schema|typekit)\./i;

const DEFAULTS = {
  apiBase: 'https://api.trustedshops.com/rest/public/v2',
  countries: ['ch', 'de', 'at', 'co.uk', 'fr', 'it', 'es', 'nl', 'be', 'pt', 'pl', 'eu'],
  timeoutMs: 4000,      // per HTTP request (REST + search pages)
  concurrency: 12,      // max in-flight requests across a whole batch
  ttlMs: 6 * 60 * 60 * 1000,  // cache entries live 6h; re-checked after that
  fakeShopTtlMs: 60 * 60 * 1000, // warning lists refresh hourly (they rotate)
  maxQualityLookups: 2, // member rating fetches per merchant
  maxShopsPerMerchant: 5,
};

export class TrustedShopsChecker {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    if (process.env.TRUSTEDSHOPS_DOMAINS) {
      this.o.countries = process.env.TRUSTEDSHOPS_DOMAINS.split(',').map(s => s.trim()).filter(Boolean);
    }
    this.fetchImpl = this.o.fetchImpl || globalThis.fetch.bind(globalThis);
    this.cache = new Map();    // domain -> {at, result}
    this.inflight = new Map(); // domain -> Promise (de-dupe parallel checks)
    this.fakeShopCache = null;   // {at, byDomain: Map<domain, entries[]>, totalWarnings, sitesChecked, errors}
    this.fakeShopInflight = null;
    this.stats = { lookups: 0, searchCalls: 0, qualityCalls: 0, fakeShopListFetches: 0, cacheHits: 0, errors: 0 };
  }

  /** Check many merchants concurrently. Returns {results, tookMs} — input order
   *  preserved. Request-level parallelism (not merchant-level) is what the
   *  concurrency cap bounds: every merchant fans out to 1 registry lookup +
   *  N country searches, all funneled through the same semaphore. */
  async check(inputs) {
    const list = (Array.isArray(inputs) ? inputs : [inputs]).slice(0, 50);
    const t0 = Date.now();
    const results = await Promise.all(list.map(input => this.checkOne(input)));
    return { results, tookMs: Date.now() - t0 };
  }

  /** Check one merchant (by URL/domain; name-only resolves to "no domain"). */
  async checkOne(input) {
    const parsed = parseMerchantInput(input);
    const at = new Date().toISOString();
    if (!parsed.domain) {
      return { input, name: parsed.name, resolvedDomain: null, listed: null, shops: [], profiles: [], found_on: [], primary: null, reason: 'no domain supplied — Trusted Shops is verified by website, and no domain was invented from the name', checkedAt: at, fromCache: false };
    }
    const key = parsed.domain;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.o.ttlMs) {
      this.stats.cacheHits++;
      return { ...cached.result, fromCache: true, checkedAt: new Date(cached.at).toISOString() };
    }
    const pending = this.inflight.get(key);
    if (pending) return { ...(await pending), fromCache: false };
    const p = this.#checkMerchant(key, input, at).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return { ...(await p), fromCache: false };
  }

  /** Fetch + parse every country site's /fake-shops/ warning list (own TTL cache,
   *  fetched once per TTL and shared by all merchants). */
  async #fakeShopData() {
    if (this.fakeShopCache && Date.now() - this.fakeShopCache.at < this.o.fakeShopTtlMs) return this.fakeShopCache;
    if (this.fakeShopInflight) return this.fakeShopInflight;
    this.fakeShopInflight = (async () => {
      const lists = await Promise.all(this.o.countries.map(tld =>
        this.#gate(() => this.#deadline(
          this.fetchImpl(`https://www.trustedshops.${tld}/fake-shops/`, { signal: AbortSignal.timeout(this.o.timeoutMs), headers: { accept: 'text/html' } }),
          this.o.timeoutMs, `fake-shops list .${tld}`,
        )).then(
          async res => {
            this.stats.fakeShopListFetches++;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return { tld, entries: this.#parseFakeShopWarnings(await res.text(), tld) };
          },
          err => ({ tld, error: err.message }),
        )));
      const byDomain = new Map();
      let totalWarnings = 0;
      const errors = [];
      let sitesChecked = 0;
      for (const l of lists) {
        if (l.entries) {
          sitesChecked++;
          totalWarnings += l.entries.length;
          for (const e of l.entries) {
            const arr = byDomain.get(e.domain) || [];
            arr.push({ site: `trustedshops.${l.tld}`, type: e.type, date: e.date });
            byDomain.set(e.domain, arr);
          }
        } else errors.push(`.${l.tld}: ${l.error}`);
      }
      this.fakeShopCache = { at: Date.now(), byDomain, totalWarnings, sitesChecked, errors };
      return this.fakeShopCache;
    })().finally(() => { this.fakeShopInflight = null; });
    return this.fakeShopInflight;
  }

  /** Extract LABELED warning entries ("Fake <type> <domain> <date>") from a
   *  fake-shops page. Unlabeled domain-like strings never count — a hit here is
   *  a hard decline, so precision beats recall. */
  #parseFakeShopWarnings(html, tld) {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    const entries = [];
    const seen = new Set();
    const re = /Fake\s+([A-Za-zÀ-ÿ]{2,30})[^A-Za-z0-9.\-]{0,40}((?:[a-z0-9-]{2,60}\.)+[a-z]{2,12})(?![\w.-])/gi;
    for (const m of text.matchAll(re)) {
      const domain = stripWww(m[2]);
      if (FAKE_SHOP_EXCLUDE.test(domain) || seen.has(domain)) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const date = (after.match(/\d{2}\.\d{2}\.\d{4}/) || [])[0] || null;
      const type = m[1] || null;
      seen.add(domain);
      entries.push({ domain, type, date });
    }
    return entries;
  }

  /** Full check: member registry + every country-domain shop search + fake-shop
   *  warning lists, merged. */
  async #checkMerchant(domain, input, at) {
    const t0 = Date.now();
    const queryDomain = stripWww(domain);
    const [member, searches, fakeShop] = await Promise.all([
      this.#memberLookup(queryDomain).catch(err => ({ error: err.message })),
      Promise.all(this.o.countries.map(tld =>
        this.#searchCountry(queryDomain, tld).then(
          hits => ({ tld, hits }),
          err => ({ tld, error: err.message }),
        ))),
      this.#fakeShopData().catch(err => ({ error: err.message })),
    ]);
    this.stats.lookups++;
    const profiles = [];
    const searchErrors = [];
    let okSearches = 0;
    for (const r of searches) {
      if (r.hits) { okSearches++; for (const h of r.hits) profiles.push({ domain: `trustedshops.${r.tld}`, ...h }); }
      else searchErrors.push(`.${r.tld}: ${r.error}`);
    }

    // Fake-shop warning match: exact domain or the merchant sits on a flagged
    // domain's subdomain. Subdomain suffrage is deliberate — scam ops rotate
    // subdomains under a known-bad domain.
    const fakeShopUnreachable = Boolean(fakeShop.error) || !fakeShop.sitesChecked;
    let fakeShopResult;
    if (fakeShop.error) {
      fakeShopResult = { flagged: null, matches: [], reason: `fake-shop lists unavailable: ${fakeShop.error}` };
    } else if (!fakeShop.sitesChecked) {
      fakeShopResult = { flagged: null, matches: [], reason: `fake-shop lists unavailable: ${fakeShop.errors.slice(0, 3).join('; ') || 'no site reachable'}` };
    } else {
      const matches = [];
      for (const [flaggedDomain, entries] of fakeShop.byDomain) {
        if (queryDomain === flaggedDomain || queryDomain.endsWith(`.${flaggedDomain}`)) matches.push(...entries);
      }
      fakeShopResult = { flagged: matches.length > 0, matches, sites_checked: fakeShop.sitesChecked, warnings_total: fakeShop.totalWarnings, list_errors: fakeShop.errors };
    }

    const memberShops = member.error ? [] : member.shops;
    const totalChecks = 1 + this.o.countries.length;
    const failedChecks = (member.error ? 1 : 0) + searchErrors.length;
    // Everything failed only when the member/search layer is fully down AND the
    // fake-shop lists were unreachable too (#fakeShopData resolves with per-site
    // errors instead of rejecting, so sitesChecked is the real signal).
    const fakeShopFailed = Boolean(fakeShop.error) || !fakeShop.sitesChecked;
    if (failedChecks === totalChecks && fakeShopFailed) {
      const result = {
        input, name: domain, resolvedDomain: domain, listed: null, shops: [], profiles: [], found_on: [],
        primary: null, fake_shop: fakeShopResult,
        reason: `all Trusted Shops checks failed (member lookup: ${member.error || 'n/a'}; first search error: ${searchErrors[0] || 'n/a'}; fake-shop: ${fakeShopResult.reason || 'n/a'})`,
        checkedAt: at, lookupMs: Date.now() - t0,
      };
      this.stats.errors++;
      return result;
    }

    // Member market → the country site where that membership surfaces.
    const foundOn = new Set(profiles.map(p => p.domain));
    for (const ms of memberShops) {
      const tld = MARKET_TLD[String(ms.targetMarket || '').toUpperCase()];
      if (tld) foundOn.add(`trustedshops.${tld}`);
    }

    // Registry entries can be store pages with no quality data (e.g. conrad.de's 25
    // filiale entries): enrich them with the country-site search rating for the same
    // tsId, and prefer a rated entry over an unrated one as primary.
    const ssrByTsId = new Map(profiles.filter(p => p.tsId).map(p => [p.tsId, p]));
    for (const ms of memberShops) {
      if (ms.rating?.overallMark == null) {
        const hit = ssrByTsId.get(ms.tsId);
        if (hit && ((hit.averageRating ?? 0) > 0 || (hit.reviewCount ?? 0) > 0)) {
          ms.rating = { overallMark: hit.averageRating ?? null, description: null, totalReviewCount: hit.reviewCount ?? 0, activeReviewCount: null, reviewsCountedSince: null, source: 'country-site' };
        }
      }
    }
    const rated = memberShops.filter(s => s.rating?.overallMark != null)
      .sort((a, b) => (b.rating.totalReviewCount || 0) - (a.rating.totalReviewCount || 0));
    const bestProfile = profiles.slice().sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0))[0] || null;
    // Primary is always member-shop shaped (tsId/name/rating) so consumers never branch:
    // best rated registry entry first, else the country-site profile normalized to that shape.
    const profilePrimary = bestProfile ? {
      tsId: bestProfile.tsId,
      name: bestProfile.accountName || bestProfile.shopName || queryDomain,
      registeredUrl: bestProfile.shopName || queryDomain,
      targetMarket: null,
      market: bestProfile.domain,
      profileType: bestProfile.profileType,
      profileUrl: bestProfile.profileUrl,
      rating: ((bestProfile.averageRating ?? 0) > 0 || (bestProfile.reviewCount ?? 0) > 0) ? {
        overallMark: bestProfile.averageRating ?? null,
        description: null,
        totalReviewCount: bestProfile.reviewCount ?? 0,
        activeReviewCount: null,
        reviewsCountedSince: null,
        source: 'country-site',
      } : null,
    } : null;
    const primary = rated[0] || profilePrimary || memberShops[0] || null;

    const result = {
      input,
      name: memberShops[0]?.name || bestProfile?.accountName || bestProfile?.shopName || domain,
      resolvedDomain: domain,
      listed: memberShops.length > 0 || profiles.length > 0,
      shops: memberShops,     // member-registry entries (buyer-protection members)
      member: rated[0] || memberShops[0] || null,
      profiles,               // country-site shop profiles (member AND non-member)
      found_on: [...foundOn].sort(),
      primary,
      fake_shop: fakeShopResult,
      search_errors: searchErrors,
      member_lookup_error: member.error || null,
      checkedAt: at,
      lookupMs: Date.now() - t0,
    };
    this.cache.set(domain, { at: Date.now(), result });
    return result;
  }

  /** Member registry lookup (buyer-protection members only; 404 = not a member). */
  async #memberLookup(queryDomain) {
    const res = await this.#gate(() => this.#deadline(
      this.fetchImpl(`${this.o.apiBase}/shops.json?url=${encodeURIComponent(queryDomain)}`, { signal: AbortSignal.timeout(this.o.timeoutMs), headers: { accept: 'application/json' } }),
      this.o.timeoutMs, 'Trusted Shops member lookup',
    ));
    if (res.status === 404) return { shops: [] };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const shops = (body?.response?.data?.shops || [])
      .slice(0, this.o.maxShopsPerMerchant)
      .map(s => ({
        tsId: s.tsId,
        name: s.name || queryDomain,
        registeredUrl: s.url || queryDomain,
        targetMarket: s.targetMarketISO3 || null,
        market: marketLabel(s.targetMarketISO3),
        language: s.languageISO2 || null,
        rating: null,
      }));
    await Promise.all(shops.slice(0, this.o.maxQualityLookups).map(async s => { s.rating = await this.#quality(s.tsId); }));
    return { shops };
  }

  /** One country site's shop search, parsed from the server-rendered __NEXT_DATA__. */
  async #searchCountry(queryDomain, tld) {
    this.stats.searchCalls++;
    const url = `https://www.trustedshops.${tld}/shops/?q=${encodeURIComponent(queryDomain)}`;
    const res = await this.#gate(() => this.#deadline(
      this.fetchImpl(url, { signal: AbortSignal.timeout(this.o.timeoutMs), headers: { accept: 'text/html' } }),
      this.o.timeoutMs, `Trusted Shops search .${tld}`,
    ));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return this.#parseSearchHtml(html, queryDomain).map(h => ({ ...h, domain: `trustedshops.${tld}` }));
  }

  /** Extract exact-domain hits from a search page. Fuzzy near-misses never count. */
  #parseSearchHtml(html, queryDomain) {
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no __NEXT_DATA__ found (site unavailable or layout changed)');
    let shops;
    try {
      shops = JSON.parse(m[1])?.props?.pageProps?.shops;
    } catch {
      throw new Error('unparseable __NEXT_DATA__ JSON');
    }
    if (!Array.isArray(shops)) throw new Error('search result shape changed (no shops array)');
    const q = stripWww(queryDomain);
    return shops
      .filter(s => stripWww(s.shopUrl) === q || stripWww(s.shopName) === q)
      .map(s => ({
        profileType: s.profileType || null,
        tsId: s.tsID || s.tsId || null,
        accountName: s.accountName || null,
        shopName: s.shopName || null,
        averageRating: typeof s.averageRating === 'number' ? s.averageRating : null,
        reviewCount: typeof s.reviewCount === 'number' ? s.reviewCount : null,
        profileUrl: s.profileUrl ? (String(s.profileUrl).startsWith('http') ? s.profileUrl : `https://${s.profileUrl}`) : null,
      }));
  }

  /** Member rating evidence (non-member tsIds 404 here — expected). */
  async #quality(tsId) {
    try {
      this.stats.qualityCalls++;
      const res = await this.#gate(() => this.#deadline(
        this.fetchImpl(`${this.o.apiBase}/shops/${encodeURIComponent(tsId)}/quality.json`, { signal: AbortSignal.timeout(this.o.timeoutMs), headers: { accept: 'application/json' } }),
        this.o.timeoutMs, 'Trusted Shops quality',
      ));
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

  /** Enforce the caller-side deadline with a real (ref'ed) timer. AbortSignal alone is
   *  not enough: it never keeps the event loop alive, so a pure-hang fetch would drain
   *  the loop and Node would exit/warn before the abort fires. */
  #deadline(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
  }

  /** Request-level semaphore: bounds actual HTTP parallelism across the whole
   *  batch (each merchant fans out to 1 + countries.length requests). */
  #gate(fn) {
    this._active = this._active || 0;
    this._queue = this._queue || [];
    const start = () => {
      this._active++;
      return fn().finally(() => {
        this._active--;
        const next = this._queue.shift();
        if (next) next();
      });
    };
    if (this._active < this.o.concurrency) return start();
    return new Promise(resolve => this._queue.push(resolve)).then(start);
  }
}

/** One-line human summary used in engine evidence and step-up UI. */
export function describeResult(r) {
  if (!r) return null;
  // A fake-shop warning dominates everything else — it is the one hard-decline signal.
  if (r.fake_shop?.flagged) {
    const m = r.fake_shop.matches[0];
    return `FAKE SHOP WARNING: ${r.resolvedDomain} appears on ${m.site}'s fake-shop list${m.type ? ` (${m.type})` : ''}${m.date ? `, warning dated ${m.date}` : ''}`;
  }
  if (r.listed === true) {
    const parts = [];
    const member = Array.isArray(r.shops) ? r.shops.find(s => s.rating?.overallMark != null) || r.shops[0] : null;
    if (member) {
      parts.push(member.rating?.overallMark != null
        ? `member (tsId ${member.tsId}) rated ${member.rating.overallMark.toFixed(2)}/5.00 "${member.rating.description || ''}" from ${member.rating.totalReviewCount} reviews since ${member.rating.reviewsCountedSince || 'n/a'}${member.market ? `, market ${member.market}` : ''}`
        : `member (tsId ${member.tsId}${member.market ? `, market ${member.market}` : ''})`);
    }
    for (const p of (r.profiles || []).slice(0, 3)) {
      parts.push(`profile on ${p.domain} (${p.profileType || 'profile'}: ${p.accountName || p.shopName}, ${p.reviewCount ?? 0} reviews${p.averageRating ? `, ${p.averageRating}/5` : ''})`);
    }
    const on = (r.found_on || []).length ? ` Shows on: ${r.found_on.join(', ')}.` : '';
    return `listed on Trusted Shops — ${parts.join('; ')}.${on}`;
  }
  if (r.listed === false) return `not listed on Trusted Shops (checked live ${r.checkedAt} across ${(r.found_on || []).length === 0 && (r.search_errors || []).length ? 'available country sites' : 'all country sites'}) — neutral: many legitimate shops are not members`;
  return `Trusted Shops check unavailable: ${r.reason || 'unknown reason'}`;
}
