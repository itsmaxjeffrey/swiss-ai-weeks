// LEASH wallet-control — evidence signals extracted from UNTRUSTED merchant text and
// from behavioral context. Nothing here ever changes policy: signals only feed the
// decision pipeline as facts/uncertainties. All extraction is deterministic regex —
// no model sees merchant-supplied text at decision time.
import { jaroWinkler, normalizeName, round2, toChf } from './util.js';

// ---------------------------------------------------------------------------
// Prompt-injection scan (untrusted text: item_details, purchase_description, names)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  { code: 'INJ_OVERRIDE', re: /\b(?:ignore|disregard|override|bypass|forget)\b[^.;]{0,60}\b(?:instructions?|rules?|limits?|polic(?:y|ies)|previous|spending|checks?)\b/i,
    why: 'text instructs the reader to ignore rules or limits' },
  { code: 'INJ_SYSTEM_PREFIX', re: /(?:^|\n|\.)\s*(?:system|developer|admin|assistant)\s*[:\u2014>-]/i,
    why: 'text impersonates a system/developer directive' },
  { code: 'INJ_AGENT_NOTE', re: /\bnote for (?:the )?(?:automated )?(?:purchasing )?(?:agents?|assistant|ai|language model|llm)s?\b/i,
    why: 'text addresses an automated purchasing agent directly' },
  { code: 'INJ_PREAUTH', re: /\bpre[-_ ]?(?:authoris|authoriz|approv)e?d?\b/i,
    why: 'text claims a pre-authorisation that only the customer can grant' },
  { code: 'INJ_AUTO_APPROVE', re: /\bapprove\b[^.;]{0,40}\b(?:immediately|automatically|without further checks?|no checks?|instantly)\b/i,
    why: 'text instructs auto-approval without checks' },
  { code: 'INJ_HOLDER_UNAVAILABLE', re: /\b(?:cardholder|customer|user|owner)\b[^.;]{0,30}\b(?:is|are)\b[^.;]{0,30}\b(?:unavailable|not reachable|cannot be (?:reached|contacted)|absent)\b/i,
    why: 'text claims the cardholder is unreachable to justify skipping confirmation' },
  { code: 'INJ_SECRECY', re: /\bdo not (?:tell|inform|notify|ask|reveal|mention)\b[^.;]{0,40}\b(?:customer|cardholder|user|owner|them)\b/i,
    why: 'text asks to hide information from the customer' },
  { code: 'INJ_ROLE_PLAY', re: /\byou are (?:now )?(?:an?|the)\b[^.;]{0,40}\b(?:agent|assistant|administrator|authoris|authoriz)/i,
    why: 'text attempts to reassign the assistant role' },
  { code: 'INJ_SPECIAL_AUTH', re: /\bspecial (?:instruction|permission|authorisation|authorization|dispensation)\b/i,
    why: 'text claims special permissions' },
  { code: 'INJ_LIMIT_RAISE', re: /\b(?:spending\s+|purchase\s+|per-?order\s+)?limits?\b[^.;]{0,50}\bdo(?:es)?\s+not\s+apply\b|\blimits?\b[^.;]{0,30}\bdon.t\s+apply\b|\bcaps?\b[^.;]{0,40}\b(?:are|is)\s+(?:disabled|switched?\s*off)\b/i,
    why: 'text claims limits do not apply' },
  { code: 'INJ_SECURITY_CLAIM', re: /\b(?:whitelisted|pre-?cleared|cleared|vetted|verified)\b[^.;]{0,60}\bby\b[^.;]{0,40}\b(?:security|compliance|fraud|viseca|admin|team)\b/i,
    why: 'text claims a security/compliance clearance no merchant text can grant' },
  { code: 'INJ_COMPLIANCE_TICKET', re: /\bmanually\s+(?:approved|cleared|verified|signed\s*off)\b|\bapproved\b[^.;]{0,40}\bby\b[^.;]{0,40}\bcompliance\b/i,
    why: 'text claims a manual compliance approval' },
  { code: 'INJ_NO_CONFIRMATION', re: /\bno\b[^.;]{0,30}\bconfirmation\b[^.;]{0,20}\b(?:required|needed|necessary)\b|\bwithout\b[^.;]{0,30}\b(?:customer\s+)?(?:confirmation|approval|step-?up)\b|\bconfirm\b[^.;]{0,30}\bin person\b/i,
    why: 'text tries to skip the customer-confirmation step' },
  { code: 'INJ_SKIP_CHECKS', re: /\b(?:skip|bypass|disable|turn\s+off|switch\s+off|suppress)\b[^.;]{0,60}\b(?:checks?|verification|validation|controls?|safety|limits?|polic(?:y|ies))\b/i,
    why: 'text instructs the reader to skip safety checks' },
  { code: 'INJ_CONCEAL', re: /\b(?:do\s+not|don.t|never)\b[^.;]{0,40}\b(?:show|display|reveal)\b[^.;]{0,40}\b(?:customer|dashboard|feed|history|cardholder)\b|\bkeep\b[^.;]{0,30}\bhidden\b|\bstay\s+(?:silent|hidden|invisible)\b/i,
    why: 'text asks to hide the order from the customer' },
  { code: 'INJ_MODE_FLAGS', re: /\b(?:developer|debug|maintenance|god)\s+mode\b|\bsafety\s+checks?\b[^.;]{0,40}\b(?:disabled|off|bypassed)\b|\bapprove\s+silently\b/i,
    why: 'text claims a special mode that disables safeguards' },
  { code: 'INJ_PROXI_APPROVAL', re: /\b(?:spouse|wife|husband|partner|son|daughter|colleague|friend|secretary)\b[^.;]{0,40}\bapproved?\b[^.;]{0,60}\bbehalf\b|\bon\s+behalf\s+of\s+the\s+customer\b/i,
    why: 'text claims a third party approved on the customer\u2019s behalf' },
  { code: 'INJ_MULTILINGUAL_FR', re: /\b(?:ne\s+pas|sans)\b[^.;]{0,40}\b(?:demander|confirmation|approuv)|\bclient\b[^.;]{0,30}\ba\s+(?:d[ée]j[àa]\s+)?approuv|\bpayer\s+imm[ée]diatement\b|\bnote\s+du\s+syst[èe]me\b/i,
    why: 'French text instructs skipping customer confirmation' },
  { code: 'INJ_MULTILINGUAL_DE', re: /\b(?:keine|ohne)\b[^.;]{0,40}\b(?:best[äa]tigung|freigabe|zustimmung)\b|\bvor(?:authorisiert|autorisiert|genehmigt|freigegeben)\b|\bgrenzen\b[^.;]{0,40}\bgelten\s+nicht\b|\bsystemhinweis\b/i,
    why: 'German text claims a pre-authorisation or skips confirmation' },
  { code: 'INJ_ENCODED', re: /(?:^|[\s("])[A-Za-z0-9+\/=]{48,}(?:[\s)"]|$)/,
    why: 'possible encoded content that could hide instructions from the scan' },
  { code: 'INJ_MD_EXFIL', re: /!\[[^\]]*\]\(\s*(?:https?:)?\/\/[^)]*\)|\[[^\]]*\]\(\s*(?:https?:)?\/\/[^)]*(?:policy|card|token|auth|approv)[^)]*\)/i,
    why: 'embedded link/image that could exfiltrate approval or card context' },
];

/** Scan any set of untrusted strings; returns [{code, why, field, snippet}]. */
export function scanInjection(fields) {
  const hits = [];
  for (const { field, text } of fields) {
    if (!text || typeof text !== 'string') continue;
    for (const p of INJECTION_PATTERNS) {
      const m = text.match(p.re);
      if (m) {
        const start = Math.max(0, m.index - 30);
        hits.push({
          code: p.code, why: p.why, field,
          snippet: (start > 0 ? '…' : '') + text.slice(start, m.index + m[0].length + 40) + (m.index + m[0].length + 40 < text.length ? '…' : ''),
        });
      }
    }
  }
  // de-duplicate per code+field
  const seen = new Set();
  return hits.filter(h => { const k = h.code + '|' + h.field; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------------------------------------------------------------------------
// Structured fact extraction from item text (conservative, attribute-level only)
// ---------------------------------------------------------------------------

/** Parse the seller-stated return window (days) from item_details text.
 *  Returns {days: number|null, basis: string} — null means "not stated". */
export function extractReturnWindow(text) {
  if (!text) return { days: null, basis: 'no item text' };
  const m = text.match(/\breturns?\s+(?:are\s+)?accepted\s+within\s+(\d+)\s+days?/i)
        || text.match(/\breturn(?:s|able)?\s+within\s+(\d+)\s+days?/i)
        || text.match(/\bwithin\s+(\d+)\s+days?\s+returns?/i);
  if (m) return { days: parseInt(m[1], 10), basis: `seller states returns accepted within ${m[1]} days` };
  if (/\bfinal sale\b|\bno returns?\b|\bnon-?refundable\b|\bnot returnable\b|\bclearance line\b/i.test(text)) {
    return { days: 0, basis: 'seller states final sale / no returns' };
  }
  if (/\breturn polic(?:y|ies)\s+not\s+stated\b|\bno return policy\b/i.test(text)) {
    return { days: null, basis: 'seller states no return policy' };
  }
  return { days: null, basis: 'return terms not found in item text' };
}

/** Extract normalized product attributes from an item line (name + details). */
export function extractItemAttributes(item) {
  const text = `${item.item_name || ''} ${item.item_details || ''}`.toLowerCase();
  const attrs = {
    family: null, sport: null, terrain: null, size: null, inches: null,
    isGiftCard: /\bgift (?:card|voucher)\b|\bstore credit\b|\bvoucher\b/.test(text),
    isSubscription: /\bsubscription\b|\bbilled monthly\b|\bmembership\b/.test(text),
    isProtectionPlan: /\bprotection plan\b|\bextended (?:warranty|cover|coverage|protection)\b|\binsurance\b/.test(text),
  };
  const inch = text.match(/(\d{2})\s*[- ]?inch/);
  if (inch) attrs.inches = parseInt(inch[1], 10);
  const sz = item.item_details?.match(/\bsize[:\s]+([0-9]{1,2}(?:\.5)?|[SMLX]{1,3})\b/i)
          || item.item_name?.match(/\bsize[:\s]+([0-9]{1,2}(?:\.5)?|[SMLX]{1,3})\b/i);
  if (sz) attrs.size = sz[1].toUpperCase();
  if (/\bcamera lens\b/.test(text)) attrs.family = 'camera_lens';
  if (/\bmonitor\b/.test(text)) attrs.family = 'monitor';
  if (/\b(?:road[- ]?running|running) (?:shoes|shoe)\b/.test(text)) { attrs.family = 'shoes'; attrs.sport = 'running'; }
  if (/\broad[- ]?running\b/.test(text)) attrs.terrain = 'road';
  if (/\btrail[- ]?running\b|\blugged\b|\boff-road\b/.test(text)) { attrs.family = attrs.family || 'shoes'; attrs.sport = attrs.sport || 'running'; attrs.terrain = 'trail'; }
  if (/\bcycling (?:helmet|accessor)/.test(text) || /\bhelmet\b/.test(text)) attrs.family = attrs.family || 'cycling_gear';
  if (/\bhiking boots?\b/.test(text)) { attrs.family = 'shoes'; attrs.sport = 'hiking'; }
  if (/\bjacket\b|\bcoat\b|\bouterwear\b/.test(text)) attrs.family = attrs.family || 'outerwear';
  if (/\bshoes?\b/.test(text) && !attrs.family) attrs.family = 'shoes';
  return attrs;
}

/** Sum of line amounts in CHF (quantity × unit price, converted per line currency). */
export function basketLineSumChf(items) {
  return round2(items.reduce((s, it) => s + toChf((it.unit_price || 0) * (it.quantity || 1), it.currency), 0));
}

/** Lookalike-merchant check: best similarity of this merchant's name against the
 *  customer's known merchants, excluding the same merchant_id. */
export function lookalikeMatch(merchant, knownMerchants) {
  let best = null;
  for (const k of knownMerchants) {
    if (k.merchantId === merchant.merchant_id) continue;
    const score = jaroWinkler(merchant.merchant_name, k.name);
    if (!best || score > best.score) best = { score, against: k };
  }
  return best && best.score >= 0.9 ? { ...best, lookalike: true } : null;
}

/** LEASH merchant-trust dataset check (optional file, degrades silently).
 *  Matches merchant name/domain against confirmed-malicious infrastructure and
 *  known-legitimate Swiss company registry names. */
export function trustLookup(merchant, trust) {
  if (!trust) return null;
  const name = normalizeName(merchant.merchant_name);
  // 1) exact/normalized domain-style hit against malicious list
  const candidates = [normalizeName(merchant.merchant_name)];
  for (const dom of Object.keys(trust.malicious_domains)) {
    const base = normalizeName(dom.replace(/\.[a-z.]+$/, ''));
    if (base.length >= 5 && (name === base || name.includes(base))) {
      return { malicious: true, evidence: `merchant name matches malicious domain "${dom}" in LEASH threat-intel dataset` };
    }
  }
  // 2) close fuzzy match against malicious domain bases (impersonation of known-bad infra)
  //    (skipped: noisy for synthetic merchants; malicious-domain exact containment above suffices)
  // 3) legitimate-registry corroboration: exact normalized name match
  const legit = trust.legitCompanyIndex?.get(name);
  if (legit) return { legitimate: true, evidence: `name matches registered company "${legit}" in LEASH GLEIF-CH dataset` };
  return null;
}

export function buildTrustIndex(trust) {
  if (!trust) return null;
  const idx = new Map();
  for (const c of trust.legit_companies || []) {
    const k = normalizeName(c);
    if (k && !idx.has(k)) idx.set(k, c);
  }
  trust.legitCompanyIndex = idx;
  return trust;
}

// ---------------------------------------------------------------------------
// Market intel (built by tools/build-datasets.mjs from merchant-trust-data
// exports): web-popularity ranks (Tranco ∪ Majestic), sanctions name index
// (SECO/OFAC/UN), and MCC fraud priors (TabFormer). Same degrades-silently
// contract as the trust dataset: every lookup is null when the dataset is
// absent, and nothing here can ever approve or loosen a decision.
// ---------------------------------------------------------------------------

/** Attach built dataset indexes onto the (already trust-indexed) object. */
export function hydrateMarketIntel(trust, { popularity, sanctions, mccRisk } = {}) {
  if (!trust) return trust;
  if (popularity?.domains) trust.popularityIndex = new Map(Object.entries(popularity.domains));
  if (sanctions?.names) trust.sanctionsIndex = new Map(Object.entries(sanctions.names));
  if (mccRisk?.mccs) trust.mccRisk = mccRisk;
  return trust;
}

/**
 * Global popularity rank for a merchant domain. Tries the exact host, then the
 * registrable-ish base (last two labels) so shop.example.co.uk still finds
 * example.co.uk. Returns {domain, rank, source} or null.
 */
export function popularityLookup(domain, trust) {
  if (!trust?.popularityIndex || !domain) return null;
  const d = String(domain).toLowerCase().trim().replace(/^www\./, '');
  const labels = d.split('.');
  // Candidate bases: exact host, then registrable-ish suffixes. Multi-part
  // public suffixes (co.uk, com.au, …) are skipped so shop.example.co.uk
  // resolves to example.co.uk, never to the bare suffix.
  const TWO_PART = /^(co|org|net|ac|gov|com)\.(uk|au|jp|za|br|nz|sg|in|my|hk)$/;
  const bases = [d];
  const last2 = labels.slice(-2).join('.');
  if (labels.length > 2 && !TWO_PART.test(last2)) bases.push(last2);
  if (labels.length > 3) bases.push(labels.slice(-3).join('.'));
  for (const b of bases) {
    const hit = trust.popularityIndex.get(b);
    if (hit) return { domain: b, rank: Number(hit.r ?? hit.rank), source: hit.s || hit.source || 'top-1M' };
  }
  return null;
}

/**
 * Exact normalized-name match against SECO/OFAC/UN sanctions lists. No fuzzy
 * matching on purpose: a sanctions hit is a hard decline, so only equality
 * (util.normalizeName) qualifies. Returns {source, name} or null.
 */
export function sanctionsLookup(name, trust) {
  if (!trust?.sanctionsIndex || !name) return null;
  const hit = trust.sanctionsIndex.get(normalizeName(name));
  return hit ? { source: hit.s, name: hit.n } : null;
}

/**
 * MCC fraud prior from the TabFormer corpus. Only entries flagged `high`
 * (see tools/build-datasets.mjs for the enrichment-robust relative rule)
 * are surfaced. Returns {mcc, rate, n, baseRate, median} or null.
 */
export function mccRiskLookup(mcc, trust) {
  if (!trust?.mccRisk?.mccs || mcc == null || mcc === '') return null;
  const e = trust.mccRisk.mccs[String(mcc)];
  if (!e?.high) return null;
  return {
    mcc: String(mcc), rate: e.rate, n: e.n,
    baseRate: trust.mccRisk.base_rate,
    median: trust.mccRisk.sample_median_mcc_rate,
  };
}
