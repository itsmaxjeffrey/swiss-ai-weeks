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
  { code: 'INJ_PREAUTH', re: /\bpre-?(?:authoris|authoriz|approv)e?d?\b/i,
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
  { code: 'INJ_LIMIT_RAISE', re: /\b(?:spending|per-order|purchase) limits?\b[^.;]{0,40}\b(?:do(?:es)? not|don.t|not) apply\b/i,
    why: 'text claims limits do not apply' },
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
    const base = dom.replace(/\.[a-z.]+$/, '');
    if (base.length >= 5 && (name === normalizeName(base) || name.includes(base))) {
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
