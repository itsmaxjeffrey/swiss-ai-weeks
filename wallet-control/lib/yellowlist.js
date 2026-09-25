// LEASH wallet-control — yellow-list merchant dossier service.
//
// For a merchant domain that is on NEITHER the customer's trusted list
// ("whitelist") NOR a known-bad list ("blacklist": threat intel, fake-shop
// warnings), this service assembles the evidence a human needs to decide
// whether to trust the merchant:
//
//   1. Swiss commercial register (Zefix) — is there a registered company,
//      and is it based in Switzerland? Token-free via the official Lindas
//      SPARQL mirror of the Zefix core-data extract (graph
//      lindas.admin.ch/foj/zefix, verified live 2026-09-25). When the free
//      Zefix REST API token is configured (LEASH_ZEFIX_TOKEN="email:token"),
//      the registration date — and from it the company age — is added.
//   2. Website imprint (Impressum) — company name + full address, parsed with
//      the same verified parser as the shopper's impressum-check script.
//   3. Zefix ↔ imprint comparison — name similarity, city/postal/street
//      agreement → strong | partial | mismatch | unknown verdict.
//   4. LinkedIn page — parsed from homepage links.
//   5. Instagram page — parsed from homepage links.
//   6. Company age — Zefix API registration date when the token exists;
//      reported honestly as unknown otherwise (the open extract carries no
//      dates and the public zefix.ch site is a JS app — no scraping guesses).
//   7. Payment methods — scanned from the shop's own homepage text.
//   8. Country — merchant country (imprint / Zefix / TLD) vs the customer's
//      country (default CH, LEASH_CUSTOMER_COUNTRY overrides).
//   9. Reviews — Trusted Shops shop rating via the existing checker, plus
//      schema.org aggregateRating parsed from the exact product page when a
//      product URL is supplied.
//
// Guarantees (mirror the engine's design principles):
//  - Evidence only. The dossier NEVER approves or declines anything; it feeds
//    the customer's decision card (and the agent's own pre-check).
//  - Degrades silently per check: a failed source becomes an "unknown" line,
//    never a fabricated negative or positive.
//  - No domain invention: name-only inputs get an honest error.
//  - Fast by construction: bounded concurrency, per-request deadlines the
//    module enforces itself, 6 h TTL cache, in-flight de-duplication.

import { normalizeDomain } from './trustedshops.js';
import { jaroWinkler, normalizeName } from './util.js';
import { checkImpressum, fetchText, htmlToText } from './impressum.js';

const ZEFIX_GRAPH = 'https://lindas.admin.ch/foj/zefix';
const ZEFIX_SPARQL = 'https://lindas.admin.ch/query';

const COUNTRY_WORDS = {
  'Schweiz': 'CH', 'Suisse': 'CH', 'Svizzera': 'CH', 'Switzerland': 'CH',
  'Deutschland': 'DE', 'Germany': 'DE', 'Österreich': 'AT', 'Austria': 'AT',
  'Liechtenstein': 'LI', 'France': 'FR', 'Italia': 'IT', 'Italy': 'IT',
};
const TLD_COUNTRY = { ch: 'CH', de: 'DE', at: 'AT', li: 'LI', fr: 'FR', it: 'IT' };

const PAYMENT_PATTERNS = [
  ['Visa', /\bvisa\b/i],
  ['Mastercard', /master\s?card/i],
  ['American Express', /american\s+express|\bamex\b/i],
  ['TWINT', /\btwint\b/i],
  ['PostFinance', /post\s?finance/i],
  ['PayPal', /paypal/i],
  ['Apple Pay', /apple\s?pay/i],
  ['Google Pay', /google\s?pay/i],
  ['Klarna', /klarna/i],
  ['Invoice (Rechnung)', /kauf\s+auf\s+rechnung|zahlung\s+(?:per|auf)\s+rechnung|per\s+rechnung\b|pay(?:ment)?\s+(?:by|via|on)\s+invoice/i],
  ['Bank transfer / prepayment', /bank\s?transfer|überweisung|ueberweisung|vorauszahlung|prepayment/i],
  ['Crypto', /\bbitcoin\b|\bethereum\b|\bcrypto(?:currency)?\s?payment/i],
];

const DEFAULTS = {
  perFetchMs: 9000,          // per HTTP request deadline
  ttlMs: 6 * 60 * 60 * 1000, // dossier cache: 6 h
  maxParallel: 3,            // concurrent dossier builds
  sparqlTimeoutMs: 12000,
  productTimeoutMs: 8000,
};

export class MerchantDossier {
  constructor({ trustedShops = null, customerCountry = null, ...overrides } = {}) {
    this.o = { ...DEFAULTS, ...overrides };
    this.trustedShops = trustedShops; // TrustedShopsChecker instance (shared)
    this.customerCountry = (customerCountry || process.env.LEASH_CUSTOMER_COUNTRY || 'CH').toUpperCase();
    this.cache = new Map();   // domain -> {at, dossier}
    this.inflight = new Map(); // domain -> Promise
    this.homeCache = new Map(); // domain -> {at, html, error} homepage (2 h)
    this.homeTtlMs = 2 * 60 * 60 * 1000;
    this.sem = new Semaphore(this.o.maxParallel);
    this.stats = { cached: 0, built: 0 };
  }

  /** Check one input (url, bare domain, or {domain, product_url}). Never throws. */
  async checkOne(input) {
    const raw = typeof input === 'string' ? input : (input?.domain || input?.url || input?.merchant || null);
    const productUrl = (typeof input === 'object' && input ? (input.product_url || input.productUrl || null) : null);
    const dom = normalizeDomain(raw);
    if (!dom) {
      return { domain: typeof raw === 'string' ? raw : null, checked_at: new Date().toISOString(), error: 'no domain supplied — a merchant name alone cannot be verified (no domains are invented)' };
    }
    const domain = dom.domain.replace(/^www\./, '');
    const cached = this.cache.get(domain);
    if (cached && Date.now() - cached.at < this.o.ttlMs) {
      this.stats.cached++;
      return { ...cached.dossier, cache: 'hit' };
    }
    const pending = this.inflight.get(domain);
    if (pending) return pending;
    const p = this.sem.run(() => this.#build(domain, productUrl))
      .then((d) => { this.cache.set(domain, { at: Date.now(), dossier: d }); this.stats.built++; return d; })
      .catch((e) => ({ domain, checked_at: new Date().toISOString(), cache: 'miss', error: `dossier build failed: ${e.message}` }))
      .finally(() => this.inflight.delete(domain));
    this.inflight.set(domain, p);
    return p;
  }

  /** Check a batch concurrently. */
  async check(inputs) {
    const t0 = Date.now();
    const list = Array.isArray(inputs) ? inputs : [inputs];
    const results = await Promise.all(list.map((x) => this.checkOne(x)));
    return { results, tookMs: Date.now() - t0 };
  }

  // ---- internals -----------------------------------------------------------

  async #build(domain, productUrl) {
    const dossier = {
      domain,
      product_url: productUrl || null,
      checked_at: new Date().toISOString(),
      cache: 'miss',
      imprint: null,
      registry: null,
      social: { linkedin: null, instagram: null },
      payments: { methods: [], source: null },
      country: { merchant_country: null, customer_country: this.customerCountry, same_country: null, basis: null },
      reviews: { shop: null, product: null },
      summary: { positives: [], negatives: [], unknowns: [] },
    };

    // 1) homepage (socials, payments, brand hint) and impressum in parallel
    const [home, impressum] = await Promise.all([
      this.#homepage(domain),
      checkImpressum(`https://${domain}`, { timeoutMs: this.o.perFetchMs }).catch((e) => ({
        status: 'error', notes: [`impressum check failed: ${e.message}`], input: domain,
        company_name: null, legal_form: null, address: null, uid: null, registry_number: null,
        impressum_url: null, evidence_snippet: null,
      })),
    ]);
    dossier.imprint = { status: impressum.status, url: impressum.impressum_url, company_name: impressum.company_name, legal_form: impressum.legal_form, address: impressum.address, uid: impressum.uid, registry_number: impressum.registry_number, evidence_snippet: impressum.evidence_snippet, notes: impressum.notes };

    if (home.html) {
      dossier.social = extractSocials(home.html);
      dossier.payments = { methods: extractPayments(home.html), source: 'homepage-scan' };
    }

    // 2) Zefix registry lookup by imprint company name (or UID), then compare
    const brandHint = home.html ? brandHintFromHtml(home.html) : null;
    const lookupName = impressum.company_name || brandHint;
    const zefix = lookupName || impressum.uid
      ? await this.#zefix({ name: lookupName, uid: impressum.uid })
      : { status: 'skipped', notes: ['no company name or UID to look up'] };
    dossier.registry = zefix;

    if (zefix.status === 'found' && zefix.in_switzerland) {
      dossier.country.merchant_country = dossier.country.merchant_country || 'CH';
      dossier.country.basis = 'entry in the Swiss commercial register (Zefix)';
    }
    if (!dossier.country.merchant_country && impressum.address?.country) {
      dossier.country.merchant_country = COUNTRY_WORDS[impressum.address.country] || null;
      if (dossier.country.merchant_country) dossier.country.basis = `imprint states ${impressum.address.country}`;
    }
    if (!dossier.country.merchant_country) {
      const tld = domain.split('.').pop();
      if (TLD_COUNTRY[tld]) {
        dossier.country.merchant_country = TLD_COUNTRY[tld];
        dossier.country.basis = `.{$tld} domain (weak signal)`.replace('{$tld}', tld);
      }
    }
    dossier.country.same_country = dossier.country.merchant_country
      ? dossier.country.merchant_country === dossier.country.customer_country
      : null;

    if (zefix.status === 'found') {
      dossier.registry.compare = compareImprintToRegistry(impressum, zefix);
    }

    // 3) company age — only from the Zefix REST API (token); never guessed
    if (zefix.status === 'found') {
      const age = await this.#registryAge(zefix);
      dossier.registry.registration_date = age.registration_date;
      dossier.registry.age_years = age.age_years;
      if (age.note) dossier.registry.notes = [...(dossier.registry.notes || []), age.note];
    }

    // 4) reviews: shop level (Trusted Shops, shared checker/cache) + product level
    if (this.trustedShops) {
      try {
        const ts = await this.trustedShops.checkOne(domain);
        dossier.reviews.shop = tsShopRating(ts);
      } catch { dossier.reviews.shop = null; }
    }
    if (productUrl) {
      dossier.reviews.product = await this.#productReviews(productUrl).catch(() => null);
    }

    dossier.summary = summarize(dossier);
    return dossier;
  }

  /** Homepage HTML with its own small TTL cache (socials/payments/hint only). */
  async #homepage(domain) {
    const cached = this.homeCache.get(domain);
    if (cached && Date.now() - cached.at < this.homeTtlMs) return cached;
    let out = { at: Date.now(), html: null, error: null };
    try {
      const page = await fetchText(`https://${domain}/`, this.o.perFetchMs);
      out.html = page.text;
    } catch (e) {
      out.error = e.message;
    }
    this.homeCache.set(domain, out);
    return out;
  }

  /** Zefix lookup via the token-free Lindas SPARQL mirror. */
  async #zefix({ name, uid }) {
    const base = {
      source: 'zefix-lindas-sparql',
      status: 'not_found', company_name: null, uid: null, chid: null, purpose: null,
      legal_form_iri: null, address: null, in_switzerland: null, notes: [],
    };
    let rows = [];
    try {
      if (uid) {
        const digits = String(uid).replace(/\D/g, '');
        if (digits.length === 12) {
          rows = await this.#sparql(zefixQuery({ uidContains: digits }));
          if (!rows.length && name) rows = await this.#sparql(zefixQuery({ exact: name }));
        } else if (name) rows = await this.#sparql(zefixQuery({ exact: name }));
      } else if (name) {
        rows = await this.#sparql(zefixQuery({ exact: name }));
        if (!rows.length) rows = await this.#sparql(zefixQuery({ contains: name }));
      }
    } catch (e) {
      return { ...base, status: 'error', notes: [`Zefix (Lindas SPARQL) query failed: ${e.message}`] };
    }
    if (!rows.length) {
      base.notes.push(name ? `no register entry matches "${name}"` : 'no register entry for this UID');
      return base;
    }
    const r = pickBestRow(rows, name);
    const ids = String(r.ids || '').split('|').filter(Boolean);
    let uidVal = null, chid = null;
    for (const id of ids) {
      if (id.includes('/UID/')) uidVal = formatUid(id.split('/UID/')[1]);
      if (id.includes('/CHID/')) chid = id.split('/CHID/')[1];
    }
    return {
      ...base,
      status: 'found',
      company_name: r.legalName,
      uid: uidVal,
      chid,
      purpose: r.purpose || null,
      legal_form_iri: r.additionalType || null,
      address: (r.street || r.postal || r.city) ? { street: r.street || null, postal_code: r.postal || null, city: r.city || null, region: r.region || null } : null,
      in_switzerland: true, // Zefix is the Swiss commercial register by definition
      registry_ref: r.company && String(r.company).includes('/zefix/company/') ? String(r.company) : null,
      notes: rows.length > 1 ? [`${rows.length} register entries matched; best name match shown`] : [],
    };
  }

  async #sparql(query) {
    const res = await fetch(ZEFIX_SPARQL, {
      method: 'POST',
      headers: { 'Accept': 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query }).toString(),
      signal: AbortSignal.timeout(this.o.sparqlTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.results?.bindings || []).map((b) => ({
      company: b.c?.value ?? null,
      legalName: b.legalName?.value ?? null,
      ids: b.ids?.value ?? '',
      purpose: b.purpose?.value ?? null,
      additionalType: b.atype?.value ?? null,
      street: b.street?.value ?? null,
      postal: b.postal?.value ?? null,
      city: b.city?.value ?? null,
      region: b.region?.value ?? null,
    }));
  }

  /** Registration date/age via the Zefix REST API — needs the free credentials.
   *  Accepted env shapes: LEASH_ZEFIX_TOKEN="***" or
   *  LEASH_ZEFIX_USERNAME + LEASH_ZEFIX_PASSWORD (secret store). */
  async #registryAge(zefix) {
    const auth = zefixAuthHeader(process.env);
    if (!auth) {
      return {
        registration_date: null, age_years: null,
        note: 'company age needs Zefix API credentials (LEASH_ZEFIX_USERNAME + LEASH_ZEFIX_PASSWORD, or combined LEASH_ZEFIX_TOKEN) — the open register extract carries no registration dates',
      };
    }
    try {
      const headers = { 'Authorization': auth, 'Accept': 'application/json', 'Content-Type': 'application/json' };
      let detail = null;
      if (zefix.uid) {
        const res = await fetch(`https://www.zefix.ch/ZefixPublicREST/api/v1/company/${encodeURIComponent(zefix.uid)}`, { headers, signal: AbortSignal.timeout(10000) });
        if (res.ok) detail = await res.json();
      }
      if (!detail && zefix.company_name) {
        const res = await fetch('https://www.zefix.ch/ZefixPublicREST/api/v1/company/search', {
          method: 'POST', headers,
          body: JSON.stringify({ name: [zefix.company_name], maxEntries: 5 }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const found = await res.json();
          const list = Array.isArray(found) ? found : (found?.companies || []);
          detail = list.find((c) => !zefix.uid || normUid(c.uid) === normUid(zefix.uid)) || list[0] || null;
        }
      }
      const dateVal = detail && (detail.registryDate || detail.registry_date || detail.registrationDate || detail.foundingDate);
      if (!dateVal) return { registration_date: null, age_years: null, note: 'Zefix API reachable but no registration date returned' };
      const ts = Date.parse(dateVal);
      if (!Number.isFinite(ts)) return { registration_date: null, age_years: null, note: 'Zefix API returned an unparsable registration date' };
      return { registration_date: dateVal.slice(0, 10), age_years: Math.floor((Date.now() - ts) / (365.25 * 86400_000)), note: null };
    } catch (e) {
      return { registration_date: null, age_years: null, note: `Zefix API failed: ${e.message}` };
    }
  }

  /** Product-level reviews: schema.org aggregateRating JSON-LD on the product page. */
  async #productReviews(url) {
    try {
      const page = await fetchText(url, this.o.productTimeoutMs);
      const blocks = [...page.text.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      for (const b of blocks) {
        let data;
        try { data = JSON.parse(b[1].trim()); } catch { continue; }
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const candidates = [node, ...(node?.['@graph'] || [])];
          for (const n of candidates) {
            const type = String(n?.['@type'] || '');
            const agg = n?.aggregateRating;
            if (/product|offer|book|movie|event/i.test(type) && agg) {
              const rating = Number(agg.ratingValue);
              const count = Number(agg.reviewCount ?? agg.ratingCount);
              if (Number.isFinite(rating)) {
                return {
                  url, rating, count: Number.isFinite(count) ? count : null,
                  best: Number(agg.bestRating) || 5, source: 'product page (schema.org)',
                };
              }
            }
          }
        }
      }
      return { url, rating: null, count: null, source: 'product page (no aggregateRating found)' };
    } catch (e) {
      return { url, rating: null, count: null, source: `product page fetch failed: ${e.message}` };
    }
  }
}

// ---- pure helpers (exported for tests) --------------------------------------

/** Flatten the Trusted Shops checker's member-shaped result into the dossier's
 *  shop-rating view. primary.rating is {overallMark, totalReviewCount, …}|null. */
export function tsShopRating(tsResult) {
  const primary = tsResult?.primary || null;
  const r = primary?.rating || null;
  return {
    listed: tsResult?.listed ?? null,
    rating: r?.overallMark ?? null,
    review_count: r?.totalReviewCount ?? null,
    source: 'Trusted Shops',
    profile_url: primary?.profileUrl || null,
  };
}

/** LinkedIn / Instagram links found in homepage HTML. */
export function extractSocials(html) {
  const out = { linkedin: null, instagram: null };
  const li = html.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[A-Za-z0-9_\-.\u00C0-\u017F%]+/i);
  if (li) out.linkedin = normalizeSocialUrl(li[0]);
  const ig = html.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?!p\/|explore\/|accounts\/|reel\/|tv\/)[A-Za-z0-9_.]+/i);
  if (ig) out.instagram = normalizeSocialUrl(ig[0]);
  return out;
}

function normalizeSocialUrl(s) {
  let u = s.replace(/["'>,;)\]]+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

/** Payment methods scanned from shop HTML/text. */
export function extractPayments(html) {
  const text = htmlToText(html).slice(0, 400_000);
  const found = [];
  for (const [label, re] of PAYMENT_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  return found;
}

/** Brand hint from homepage metadata (used for Zefix when the imprint fails). */
export function brandHintFromHtml(html) {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (og) return cleanBrand(og[1]);
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t) {
    const part = cleanBrand(t[1].split(/[|–—·-]/)[0]);
    if (part) return part;
  }
  return null;
}

function cleanBrand(s) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length >= 3 && v.length <= 60 ? v : null;
}

function sparqlString(s) {
  return JSON.stringify(String(s).replace(/["\\]/g, ' '));
}

/** Build the Zefix SPARQL query (exact legalName, contains, or UID). */
export function zefixQuery({ exact, contains, uidContains } = {}) {
  let filter;
  if (uidContains) filter = `FILTER(CONTAINS(STR(?id), ${JSON.stringify(uidContains)}))`;
  else if (exact) filter = `FILTER(?legalName = ${sparqlString(exact)})`;
  else if (contains) filter = `FILTER(CONTAINS(LCASE(?legalName), ${sparqlString(contains.toLowerCase())}))`;
  else throw new Error('zefixQuery needs exact, contains, or uidContains');
  return `PREFIX schema: <http://schema.org/>
SELECT ?c ?legalName (GROUP_CONCAT(DISTINCT ?id; separator="|") AS ?ids) ?purpose ?atype ?street ?postal ?city ?region WHERE {
  GRAPH <${ZEFIX_GRAPH}> {
    ?c schema:legalName ?legalName .
    ${uidContains ? '?c schema:identifier ?id .' : ''}
    OPTIONAL { ?c schema:identifier ?id }
    OPTIONAL { ?c schema:description ?purpose }
    OPTIONAL { ?c schema:additionalType ?atype }
    OPTIONAL { ?c schema:address ?a .
      OPTIONAL { ?a schema:streetAddress ?street }
      OPTIONAL { ?a schema:postalCode ?postal }
      OPTIONAL { ?a schema:addressLocality ?city }
      OPTIONAL { ?a schema:addressRegion ?region }
    }
    ${filter}
  }
} GROUP BY ?c ?legalName ?purpose ?atype ?street ?postal ?city ?region LIMIT ${uidContains ? 5 : 8}`;
}

function pickBestRow(rows, wantName) {
  if (!wantName || rows.length === 1) return rows[0];
  const w = normalizeName(wantName);
  let best = rows[0], bestScore = -1;
  for (const r of rows) {
    const s = jaroWinkler(normalizeName(r.legalName), w);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return best;
}

/** Basic-auth header for the Zefix REST API from the environment. Accepts, in
 *  order: LEASH_ZEFIX_B64 (base64 of "***", passed through VERBATIM so the
 *  egress proxy can substitute the secret-store sentinel in place), the
 *  combined LEASH_ZEFIX_TOKEN, or the split LEASH_ZEFIX_USERNAME +
 *  LEASH_ZEFIX_PASSWORD pair. Returns "Basic …" or null. */
export function zefixAuthHeader(env = process.env) {
  const b64 = String(env.LEASH_ZEFIX_B64 || '').trim();
  if (b64) return `Basic ${b64}`;
  const tok = env.LEASH_ZEFIX_TOKEN;
  if (tok) return 'Basic ' + Buffer.from(String(tok).trim()).toString('base64');
  const user = String(env.LEASH_ZEFIX_USERNAME || '').trim();
  const pass = String(env.LEASH_ZEFIX_PASSWORD || '').trim();
  if (user && pass) return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  return null;
}

function formatUid(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 12 || !digits.startsWith('756')) {
    // Zefix UID IRIs use the 12-digit CHE number without the CHE prefix digits —
    // the IRI suffix is already CHE-shaped (e.g. CHE105904292).
    const m = String(raw || '').match(/CHE\s*(\d{3})\.?\s*(\d{3})\.?\s*(\d{3})/);
    return m ? `CHE-${m[1]}.${m[2]}.${m[3]}` : (raw || null);
  }
  return `CHE-${digits.slice(3, 6)}.${digits.slice(6, 9)}.${digits.slice(9)}`;
}

function normUid(u) {
  return String(u || '').toUpperCase().replace(/[^0-9]/g, '');
}

/** Compare imprint identity against the Zefix record. Pure. */
export function compareImprintToRegistry(imprint, registry) {
  const nameScore = imprint.company_name && registry.company_name
    ? jaroWinkler(normalizeName(imprint.company_name), normalizeName(registry.company_name))
    : null;
  const cityMatch = Boolean(imprint.address?.city && registry.address?.city) &&
    normalizeName(imprint.address.city) === normalizeName(registry.address.city);
  const postalMatch = Boolean(imprint.address?.postal_code && registry.address?.postal_code) &&
    String(imprint.address.postal_code) === String(registry.address.postal_code);
  const streetMatch = Boolean(imprint.address?.street && registry.address?.street) &&
    normalizeName(imprint.address.street).includes(normalizeName(registry.address.street).replace(/\d+$/, '')) &&
    normalizeName(registry.address.street).includes(normalizeName(imprint.address.street).replace(/\d+$/, ''));
  const uidMatch = Boolean(imprint.uid && registry.uid) && normUid(imprint.uid) === normUid(registry.uid);

  let verdict = 'unknown';
  if (uidMatch) verdict = 'strong';
  else if (nameScore != null) {
    if (nameScore >= 0.9 && (cityMatch || postalMatch)) verdict = 'strong';
    else if (nameScore >= 0.92) verdict = 'strong';
    else if (nameScore >= 0.75 || ((cityMatch || postalMatch) && nameScore >= 0.6)) verdict = 'partial';
    else verdict = 'mismatch';
  } else if (cityMatch && postalMatch) verdict = 'partial';

  return { name_score: nameScore != null ? Math.round(nameScore * 100) / 100 : null, uid_match: uidMatch, city_match: cityMatch ? true : (cityMatch === false ? false : null), postal_match: postalMatch ? true : (postalMatch === false ? false : null), street_match: streetMatch ? true : (streetMatch === false ? false : null), verdict };
}

/** Plain-language summary bullets for the customer card. */
export function summarize(d) {
  const pos = [], neg = [], unk = [];
  const r = d.registry, i = d.imprint;
  if (r?.status === 'found') {
    const uid = r.uid ? `, UID ${r.uid}` : '';
    pos.push(`Registered in the Swiss commercial register (Zefix): ${r.company_name}${uid}${r.address?.city ? `, seat ${r.address.city}` : ''}`);
    if (r.registration_date) pos.push(`Company registered since ${r.registration_date} (${r.age_years} year${r.age_years === 1 ? '' : 's'} old)`);
    else unk.push('Company age unknown — the free Zefix API token (LEASH_ZEFIX_TOKEN) is not configured');
    if (r.compare?.verdict === 'strong') pos.push('Imprint matches the registry entry (name and address agree)');
    else if (r.compare?.verdict === 'partial') unk.push('Imprint only partially matches the registry entry — check the address details');
    else if (r.compare?.verdict === 'mismatch') neg.push('Imprint does NOT match the registry entry — the site may be impersonating a real company');
  } else if (r?.status === 'not_found') {
    neg.push('No Swiss commercial-register entry found for this shop — either foreign or unregistered');
  } else if (r?.status === 'skipped' || r?.status === 'error') {
    unk.push('Swiss register lookup unavailable (no company name to search)');
  }
  if (i?.status === 'found') {
    const a = i.address;
    pos.push(`Impressum found: ${i.company_name}${a ? `, ${a.street}, ${a.postal_code} ${a.city}` : ''}`);
  } else if (i?.status === 'blocked') {
    unk.push('Website blocks automated reads — the imprint could not be verified');
  } else if (i?.status !== 'found') {
    neg.push('No readable Impressum (legal notice) found — Swiss/EU shops are required to publish one');
  }
  if (d.social.linkedin) pos.push('LinkedIn company page found');
  else unk.push('No LinkedIn company page found');
  if (d.social.instagram) pos.push('Instagram profile found');
  else unk.push('No Instagram profile found');
  if (d.payments.methods.length) pos.push(`Payment methods offered: ${d.payments.methods.join(', ')}`);
  else unk.push('Payment methods not detectable from the homepage');
  if (d.country.same_country === true) pos.push(`Based in ${d.country.merchant_country} — same country as you`);
  else if (d.country.same_country === false) neg.push(`Based in ${d.country.merchant_country} — not your country (${d.country.customer_country})`);
  else unk.push('Merchant country could not be determined');
  const ts = d.reviews.shop;
  if (ts?.listed === true && ts.rating != null) pos.push(`Trusted Shops: rated ${ts.rating}/5 from ${ts.review_count ?? '?'} reviews`);
  else if (ts?.listed === true) pos.push('Listed on Trusted Shops (no rating published)');
  else if (ts?.listed === false) unk.push('Not listed on Trusted Shops (neutral — many good shops are not members)');
  const pr = d.reviews.product;
  if (pr?.rating != null) pos.push(`Product page shows a rating of ${pr.rating}/${pr.best} (${pr.count ?? '?'} reviews)`);
  else if (d.product_url) unk.push('No product-level reviews found on the product page');
  if (d.error) unk.push(d.error);
  return { positives: pos, negatives: neg, unknowns: unk };
}

/** Tiny promise semaphore for bounded concurrency. */
class Semaphore {
  constructor(n) { this.free = n; this.queue = []; }
  run(fn) {
    return new Promise((resolve) => {
      const start = () => fn().then((v) => { this.free++; this.#next(); return v; });
      if (this.free > 0) { this.free--; resolve(start); }
      else this.queue.push(() => { this.free--; resolve(start); });
    }).then((start) => start());
  }
  #next() { if (this.queue.length) this.queue.shift()(); }
}
