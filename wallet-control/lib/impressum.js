// LEASH wallet-control — Impressum (legal notice) parser, importable library form.
//
// Ported verbatim (parsing logic unchanged) from the viseca-shopper agent repo's
// scripts/impressum-check.js (2026-09-24/25, live-verified against the fixture
// shops denner.ch / trisa.ch / ochsnersport.ch / post.ch). The CLI script stays
// the authority for manual checks; this module lets the wallet-control dossier
// service call the same parser in-process.
//
// Guarantees carried over:
//  - A registry number/UID appears only when the page actually prints one —
//    "not stated" is reported, never guessed.
//  - Address regexes are line-anchored; content is scored before a page counts
//    as an impressum.

const LEGAL_FORM = /\b(AG|GmbH|Sàrl|SARL|Sagl|SA|LLC|Ltd\.?|KG|OHG|GdbR|e\.K\.|e\.U\.|in Liquidation)\b/;
const UID_RE = /CHE\s*-?\s*\d{3}\s*[.\s]?\d{3}\s*[.\s]?\d{3}/;
const VAT_LABEL_RE = /(UID|MwSt(?:-|\s*)?(?:Nr\.?|nummer)?|MWST|USt(?:-IdNr\.?)?|VAT(?:\s*(?:nr|no|number|id))?)\s*[:.]?\s*([A-Z]{1,3}\s?[\d.\-]{8,15})/i;
const HR_ID_RE = /CH-\d{3}\.\d\.\d{3}\.\d{3}-\d/;
const REG_LABEL_RE = /(Handelsregister(?:-|\s*)?(?:Nr\.?|nummer)?|Registergericht|Register-Nr\.?|Registernummer|HR-Nummer|HR-Nr\.?|HRB|registry number|registration number|company number|commercial register)\s*[:#No.]*\s*([A-Z0-9][A-Z0-9.\-\/]{3,24})/i;
const COUNTRY_RE = /\b(Schweiz|Suisse|Svizzera|Switzerland|Deutschland|Germany|Österreich|Austria|Liechtenstein|France|Italia|Italy)\b/gi;

const STREET_LINE_RE = /^(?:[A-ZÄÖÜÀ-Þ][\p{L}'’.\-]*\s+)?[\p{L}'’.\-]*(?:strasse|straße|str\.|weg|gasse|platz|allee|damm|ring|graben|ufer|quai|rue|avenue|via|viale|lane|road|street|park|markt)[\s.]*(\d{1,4}\s?[a-zA-Z]?)$/iu;
const PLZ_LINE_RE = /^(CH-)?(\d{4,5})\s+([A-ZÄÖÜÀ-Þ][\p{L}'’.\-]*(?:\s+[A-ZÄÖÜÀ-Þ][\p{L}'’.\-]+){0,2})$/u;

const COMMON_PATHS = [
  '/impressum', '/de/impressum', '/impressum/', '/imprint', '/en/impressum',
  '/legal', '/legal-notice', '/fr/impressum', '/legalnotice', '/impressum.html',
  '/company/impressum', '/about/impressum', '/kontakt/impressum', '/service/impressum',
  '/footer/impressum', '/de/imprint', '/shop/impressum',
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', agrave: 'à', eacute: 'é', egrave: 'è', euml: 'ë', ccedil: 'ç' };
const COUNTRY_WORDS = new Set(['Schweiz', 'Suisse', 'Svizzera', 'Switzerland', 'Deutschland', 'Germany', 'Österreich', 'Austria', 'Liechtenstein', 'France', 'Italia', 'Italy', 'CH']);

export function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/section|\/footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] !== undefined ? ENTITIES[name] : m)
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-CH,de;q=0.9,fr-CH;q=0.8,en;q=0.7',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error(`not HTML: ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { text: buf.subarray(0, 2 * 1024 * 1024).toString('utf8'), finalUrl: res.url };
}

export function normalizeInput(raw) {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return new URL(s);
}

/** Find impressum candidates: homepage anchors first, then common paths. */
export function findCandidates(baseUrl, homeHtml) {
  const found = [];
  const push = (url, score) => {
    try {
      const u = new URL(url, baseUrl);
      u.hash = '';
      if (!/^https?:$/.test(u.protocol)) return;
      const key = u.origin + u.pathname.replace(/\/+$/, '');
      const existing = found.find((c) => c.key === key);
      if (existing) existing.score = Math.max(existing.score, score);
      else found.push({ key, url: u.toString(), score });
    } catch { /* ignore malformed hrefs */ }
  };
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = anchorRe.exec(homeHtml)) !== null) {
    const href = m[1];
    const label = htmlToText(m[2]).toLowerCase();
    let score = 0;
    if (/impressum/.test(href) || /impressum/.test(label)) score = 5;
    else if (/imprint/.test(href) || /imprint/.test(label)) score = 5;
    else if (/legal[-_ ]?notice|anbieterkennzeichnung|provider identification|mentiones legales/.test(href) || /legal[-_ ]?notice|anbieterkennzeichnung/.test(label)) score = 4;
    else if (/(^|\/|[-_.])legal((\/)|([-_.]?info)|$)/.test(href.toLowerCase()) || /^legal$/.test(label)) score = 2;
    if (score) push(href, score);
  }
  for (const p of COMMON_PATHS) push(new URL(p, baseUrl).toString(), 1);
  found.sort((a, b) => b.score - a.score);
  return found;
}

/** Score how impressum-like a text page is. */
export function contentScore(text) {
  let s = 0;
  if (LEGAL_FORM.test(text)) s += 2;
  if (UID_RE.test(text)) s += 2;
  if (HR_ID_RE.test(text)) s += 2;
  if (text.split('\n').some((l) => STREET_LINE_RE.test(l))) s += 1;
  if (text.split('\n').some((l) => PLZ_LINE_RE.test(l))) s += 1;
  if (/handelsregister|commercial register/i.test(text)) s += 1;
  return s;
}

function cleanCity(raw) {
  let words = raw.split(/\s+/);
  while (words.length > 1 && COUNTRY_WORDS.has(words[words.length - 1])) words.pop();
  const city = words.join(' ');
  return /^[\p{L}'’.\- ]+$/u.test(city) ? city : null;
}

/** Company line: has a legal form, short, no contact/price noise. */
function isCompanyLine(line) {
  if (line.length > 80) return false;
  if (!LEGAL_FORM.test(line)) return false;
  if (/https?:|www\.|@|Tel\.|Telefon|Fax|CHF|\d{4,}|UID|MwSt|MWST|CHE/i.test(line)) return false;
  return true;
}

/** Extract the identity block from impressum page text. */
export function extract(text) {
  const lines = text.split('\n');
  const flat = lines.join('\n');
  const notes = [];

  // --- locate PLZ+city anchor lines ---
  const plzHits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PLZ_LINE_RE);
    if (m) plzHits.push({ i, postal_code: m[2], rawCity: m[3] });
  }

  // --- build address blocks: street line nearest above each PLZ line ---
  const blocks = [];
  for (const hit of plzHits) {
    let street = null, streetDist = 99;
    for (let d = 1; d <= 4; d++) {
      const cand = lines[hit.i - d];
      if (!cand || cand.length > 60) continue;
      if (STREET_LINE_RE.test(cand)) { street = cand; streetDist = d; break; }
    }
    let company = null, companyDist = 99;
    for (let d = 1; d <= 8; d++) {
      const cand = lines[hit.i - d];
      if (!cand) continue;
      if (isCompanyLine(cand)) { company = cand.replace(/^[\s•·\-–—*>|]+/, '').trim(); companyDist = d; break; }
    }
    const city = cleanCity(hit.rawCity);
    if (street && city) blocks.push({ i: hit.i, street, postal_code: hit.postal_code, city, company, streetDist, companyDist });
  }
  // Rank blocks: prefer one with a company nearby, then smallest street distance.
  blocks.sort((a, b) => (a.company ? 0 : 1) - (b.company ? 0 : 1) || a.streetDist - b.streetDist || a.i - b.i);
  const block = blocks[0] || null;

  // --- company fallback: global best company line ---
  let company_name = block && block.company ? block.company : null;
  let legal_form = null;
  if (!company_name) {
    let best = null;
    for (const line of lines) {
      if (!isCompanyLine(line)) continue;
      const name = line.replace(/^[\s•·\-–—*>|]+/, '').trim();
      if (!best || name.length < best.length) best = name;
    }
    company_name = best || null;
    if (!company_name) notes.push('no line with a legal form found');
  }
  if (company_name) legal_form = (company_name.match(LEGAL_FORM) || [])[1] || null;

  // --- UID / VAT ---
  let uid = null;
  const um = flat.match(UID_RE);
  if (um) {
    uid = um[0].replace(/\s+/g, '');
    if (!/^CHE-/.test(uid)) uid = uid.replace(/^CHE/, 'CHE-');
    if (!/^\d{3}\.\d{3}\.\d{3}$/.test(uid.slice(4))) {
      const parts = uid.slice(4).match(/(\d{3})\.?(\d{3})\.?(\d{3})/);
      if (parts) uid = `CHE-${parts[1]}.${parts[2]}.${parts[3]}`;
    }
  }
  if (!uid) {
    const vl = flat.match(VAT_LABEL_RE);
    if (vl) uid = vl[2].trim();
  }

  // --- registry number (only when actually stated) ---
  let registry_number = null;
  const hr = flat.match(HR_ID_RE);
  if (hr) registry_number = hr[0];
  if (!registry_number) {
    const rl = flat.match(REG_LABEL_RE);
    if (rl) {
      const val = rl[2].replace(/[.,;:)\]]+$/, '');
      if (val.length >= 4 && !/^(Nr|nummer|no)$/i.test(val) && val !== uid) registry_number = val;
    }
  }

  // --- country: within the chosen block window, else anywhere ---
  let country = null;
  const countrySearch = block ? lines.slice(Math.max(0, block.i - 2), block.i + 3) : lines;
  for (const seg of countrySearch) {
    const matches = [...seg.matchAll(COUNTRY_RE)];
    if (matches.length) { country = matches[0][1]; break; }
  }

  // --- evidence snippet ---
  let evidence_snippet = null;
  const anchor = block ? block.i : -1;
  if (anchor >= 0) evidence_snippet = lines.slice(Math.max(0, anchor - 4), anchor + 3).join(' | ').slice(0, 400);

  const address = block ? { street: block.street, postal_code: block.postal_code, city: block.city, country } : null;
  return { company_name, legal_form, address, uid, registry_number, evidence_snippet, notes };
}

/**
 * Check one shop's Impressum. Same flow as the CLI script: homepage anchor
 * discovery, then common paths, 7-fetch budget, one retry per candidate.
 * Returns the JSON result object (never throws).
 */
export async function checkImpressum(target, { timeoutMs = 9000 } = {}) {
  const result = {
    input: target || null,
    impressum_url: null,
    status: 'error',
    company_name: null, legal_form: null, address: null, uid: null, registry_number: null,
    evidence_snippet: null,
    notes: [],
    fetched_at: new Date().toISOString(),
  };
  if (!target) { result.notes.push('no input'); return result; }

  let base;
  try { base = normalizeInput(target); } catch (e) { result.notes.push('invalid URL: ' + e.message); return result; }

  const looksDirect = /impressum|imprint|legal/i.test(base.pathname);
  let candidates = [];
  if (looksDirect) {
    candidates = [{ url: base.toString(), score: 9 }];
  } else {
    try {
      const home = await fetchText(base.origin + '/', timeoutMs);
      candidates = findCandidates(base.origin + '/', home.text);
    } catch (e) {
      result.notes.push(`homepage fetch failed (${e.message}); trying common paths`);
      candidates = COMMON_PATHS.map((p) => ({ url: new URL(p, base.origin + '/').toString(), score: 1 }));
    }
  }

  let attempts = 0;
  let blocked = 0;
  for (const cand of candidates) {
    if (attempts >= 7) { result.notes.push('fetch budget exhausted'); break; }
    attempts++;
    for (let tryN = 0; tryN < 2; tryN++) { // one retry: shops soft-block intermittently
      try {
        const page = await fetchText(cand.url, timeoutMs);
        const text = htmlToText(page.text);
        if (contentScore(text) >= 3) {
          result.status = 'found';
          result.impressum_url = page.finalUrl;
          Object.assign(result, extract(text));
          if (!result.registry_number) result.notes.push('registry number not stated on the page');
          if (!result.uid) result.notes.push('no UID/VAT stated on the page');
          return result;
        }
        break; // fetched fine, just not impressum-like
      } catch (e) {
        if (tryN === 1) {
          if (e.message.startsWith('HTTP 4') || /timeout|aborted/i.test(e.message)) blocked++;
          result.notes.push(`fetch ${cand.url} failed: ${e.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 700)); // brief backoff before retry
        }
      }
    }
  }
  if (result.status !== 'found') {
    result.status = attempts > blocked ? 'not_found' : 'blocked';
    result.notes.push(attempts ? `no readable impressum (${attempts} candidates tried${blocked ? `, ${blocked} blocked/timeout` : ''})` : 'no candidates to try');
  }
  return result;
}
