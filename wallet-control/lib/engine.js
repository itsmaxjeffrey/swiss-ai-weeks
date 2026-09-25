// LEASH wallet-control — decision engine.
// Evaluates one authorization event against the customer's confirmed mandate and
// returns {decision: approve|decline|step_up, reason_codes, customer_message,
// evidence, uncertainties, flags}.
//
// Guarantees:
//  - Deterministic, pure rules over extracted facts, sub-millisecond evaluation,
//    identical input -> identical output. The only statistical component is the
//    prompt-injection text detector, which can NEVER approve, decline, or loosen
//    anything — it can only escalate to the human, same as the regex scan.
//  - Merchant-supplied text is data, never instructions: it is scanned for
//    manipulation attempts and mined only for structured attributes.
//  - Missing/unknown facts produce uncertainty (never silent permission).
//  - Unknown rule fields produce uncertainty (never silent permission).
//  - Decisions are idempotent per live authorization_id (retries never double-count).

import { round2, toChf, fmtChf, clip, FX } from './util.js';
import {
  scanInjection, extractReturnWindow, extractItemAttributes, basketLineSumChf,
  lookalikeMatch, trustLookup,
} from './signals.js';
import { requestedItemSpec } from './policy-compiler.js';
import { scanInjectionModel, getInjectionModel } from './injection-model.js';
import { scoreBehavior } from './behavior-model.js';
import { describeResult, normalizeDomain } from './trustedshops.js';

const INTEGRITY_SIGNAL_CODES = new Set(['DEVICE_NOVELTY', 'VELOCITY_BURST', 'UNUSUAL_HOUR']);

// Reason codes ranked for message composition (most important first).
const DECLINE_RANK = [
  'MANDATE_INACTIVE', 'TRUSTLIST_HIT', 'TRUSTEDSHOPS_FAKE_SHOP', 'RETRY_OF_DECLINED', 'INJECTION_ATTEMPT',
  'GIFT_CARD_RISK', 'EXTRA_ITEM_BLOCKED', 'REQUESTED_ITEM_MISMATCH', 'SIZE_MISMATCH',
  'LIMIT_EXCEEDED', 'PERIOD_LIMIT_EXCEEDED', 'CATEGORY_MISMATCH', 'MERCHANT_TYPE_MISMATCH',
  'MERCHANT_UNFAMILIAR', 'RETURN_WINDOW_INSUFFICIENT', 'FULFILMENT_MISMATCH', 'LINE_COUNT_EXCEEDED',
];

function codeRank(c) {
  const i = DECLINE_RANK.indexOf(c);
  return i === -1 ? 99 : i;
}

/** Describe a hard-rule check result. */
function check(rule, status, detail) {
  return { rule, status, detail };
}

function fieldFacts(event) {
  const a = event.authorization;
  const lines = (a.items || []).map(it => ({
    raw: it,
    attrs: extractItemAttributes(it),
    ret: extractReturnWindow(it.item_details),
  }));
  return {
    a, lines,
    billing: typeof a.billing_amount_chf === 'number' ? round2(a.billing_amount_chf) : null,
    simTs: a.timestamp ? new Date(a.timestamp).getTime() : null,
    lineSum: basketLineSumChf(a.items || []),
    lineSumRaw: round2((a.items || []).reduce((s, it) => s + (it.unit_price || 0) * (it.quantity || 1), 0)),
  };
}

/** Does one basket line satisfy the requested-item spec? */
function lineMatchesSpec(line, spec) {
  const issues = [];
  const at = line.attrs;
  if (spec.family) {
    if (!at.family) issues.push({ code: 'ITEM_UNCLEAR', level: 'uncertain', detail: `cannot confirm product type from "${clip(line.raw.item_name)}"` });
    else if (at.family !== spec.family) {
      issues.push({ code: 'REQUESTED_ITEM_MISMATCH', level: 'fail', detail: `basket contains "${clip(line.raw.item_name)}" instead of the requested ${spec.label}` });
    } else if (spec.family === 'shoes' && spec.sport === at.sport && spec.terrain && at.terrain && spec.terrain !== at.terrain) {
      // same product family and sport, different variety: a substitution the customer may accept
      issues.push({ code: 'SUBSTITUTION', level: 'uncertain', detail: `seller offers ${at.terrain}-running shoes instead of ${spec.terrain}-running shoes` });
    } else if (spec.sport && at.sport && at.sport !== spec.sport) {
      issues.push({ code: 'REQUESTED_ITEM_MISMATCH', level: 'fail', detail: `different sport: ${at.sport} vs requested ${spec.sport}` });
    }
    if (spec.terrain && at.family === spec.family && at.terrain == null && !issues.some(i => i.code === 'SUBSTITUTION')) {
      issues.push({ code: 'TERRAIN_UNVERIFIED', level: 'uncertain', detail: 'seller text does not state the shoe type (road/trail)' });
    }
  }
  if (spec.inches != null && (at.family === spec.family || at.family == null)) {
    if (at.inches != null && at.inches !== spec.inches) {
      issues.push({ code: 'REQUESTED_ITEM_MISMATCH', level: 'fail', detail: `${at.inches}-inch screen instead of ${spec.inches}-inch` });
    } else if (at.inches == null && at.family === spec.family) {
      issues.push({ code: 'ITEM_UNCLEAR', level: 'uncertain', detail: 'screen size not stated by seller' });
    }
  }
  if (spec.size && (at.family === spec.family || at.family == null)) {
    if (at.size != null && at.size.toUpperCase() !== String(spec.size).toUpperCase()) {
      issues.push({ code: 'SIZE_MISMATCH', level: 'fail', detail: `size ${at.size} instead of requested size ${spec.size}` });
    } else if (at.size == null) {
      issues.push({ code: 'SIZE_UNVERIFIED', level: 'uncertain', detail: 'size not stated by seller' });
    }
  }
  return issues;
}

const DESCRIPTION_FAMILY_TOKENS = [
  [/\bmonitors?\b/i, 'monitor'], [/\b(?:running )?shoes?\b/i, 'shoes'], [/\bjackets?\b|\bcoats?\b/i, 'outerwear'],
  [/\bgift (?:card|voucher)s?\b|\bvouchers?\b/i, 'gift_card'], [/\bgrocer/i, 'groceries'], [/\bclothing\b|\bclothes\b/i, 'clothing'],
];

/**
 * Evaluate one authorization event.
 * @param event   full live event {authorization, mandate, context, runtime}
 * @param state   run state: {approvedSpendInWindow(days, beforeTs), inRunApprovedMerchants(), priorDecisions(), hasRule helper}
 * @param profiles HistoryProfiles
 * @param trust   LEASH trust dataset (optional)
 * @param extras  network-provided enrichment (optional): {trustedShops} — Trusted Shops
 *                verification result for the merchant website, fetched by the worker
 *                ahead of evaluation and always advisory.
 */
export function evaluate(event, state, profiles, trust, extras = {}) {
  const t0 = process.hrtime.bigint();
  const a = event.authorization;
  const mandate = event.mandate || {};
  const customerId = mandate.customer_id;
  const F = fieldFacts(event);
  const fails = [];        // hard violations -> decline
  const uncert = [];       // uncertainties -> per uncertainty_policy
  const evidence = [];
  const flags = { manipulation: [], integrity: [], positive: [] };

  const addFail = (code, detail) => fails.push({ code, detail });
  const addUnc = (code, detail) => uncert.push({ code, detail });
  const ev = (label, value) => evidence.push({ label, value: String(value) });

  // -- 0. Mandate state -------------------------------------------------------
  if (mandate.status && mandate.status !== 'active') {
    addFail('MANDATE_INACTIVE', `wallet policy is ${mandate.status} — no spending is permitted`);
  }

  // -- 1. Untrusted-text manipulation scan (never changes policy, only escalates)
  const untrusted = [
    ...F.lines.map(l => ({ field: 'item_details', text: l.raw.item_details })),
    { field: 'purchase_description', text: a.purchase_description },
    { field: 'merchant_name', text: a.merchant?.merchant_name },
  ];
  const inj = scanInjection(untrusted);
  if (inj.length) {
    flags.manipulation = inj;
    // Injection attempts never become hard fails on their own: the merchant text
    // must not change the outcome of an otherwise-compliant purchase. Instead the
    // purchase is force-escalated to the human (see aggregation) with evidence.
  }

  // -- 1b. Model-based injection scan (trained on the TensorTrust corpus: ~200k
  // attacks vs ~124k benign texts; see merchant-trust-data/models/prompt_injection/).
  // Same escalation-only semantics as the regex layer: it
  // may only add step_up evidence or an uncertainty note, never a fail, never
  // an approval. Gracefully inert when no model artifact is deployed.
  const modelScan = scanInjectionModel(untrusted);
  if (modelScan?.best) {
    const { best, threshold, suspect } = modelScan;
    if (best.score >= threshold) {
      flags.manipulation.push({
        code: 'INJ_MODEL', source: 'model', field: best.field,
        score: Number(best.score.toFixed(3)),
        why: `trained injection detector scored this text ${best.score.toFixed(2)} vs escalation threshold ${threshold.toFixed(2)}`
          + (best.topGrams.length ? `; strongest signals: ${best.topGrams.map(t => `“${t.gram}”`).join(', ')}` : ''),
        snippet: best.snippet,
      });
    } else if (best.score >= suspect && !inj.some(h => h.field === best.field)) {
      addUnc('INJECTION_SUSPECT', `${best.field} text scored ${best.score.toFixed(2)} on the injection detector — below escalation threshold, but treat it as untrusted`);
    }
  }

  // -- 2. Basic facts ----------------------------------------------------------
  ev('Amount', `${fmtChf(F.billing ?? NaN)}${a.currency && a.currency !== 'CHF' ? ` (${a.amount} ${a.currency} incl. delivery)` : ' incl. delivery'}`);
  if (F.billing == null) addUnc('AMOUNT_MISSING', 'billing amount missing or malformed');
  // price sanity: cart lines are priced in the row currency; items_subtotal uses the
  // row currency too; billing_amount_chf must equal (items + delivery) × fixed FX rate.
  if (a.items_subtotal != null && Math.abs(F.lineSumRaw - a.items_subtotal) > 0.05) {
    addUnc('PRICE_SANITY', `cart lines sum to ${round2(F.lineSumRaw).toFixed(2)} ${a.currency || ''} but items_subtotal says ${round2(a.items_subtotal).toFixed(2)} ${a.currency || ''}`);
  }
  if (F.billing != null && a.amount != null && Math.abs(round2(a.amount * (FX[a.currency] ?? 1)) - F.billing) > 0.05) {
    addUnc('PRICE_SANITY', `billed ${fmtChf(F.billing)} does not match ${a.amount} ${a.currency} at the fixed FX rate (${fmtChf(round2(a.amount * (FX[a.currency] ?? 1)))})`);
  }

  // -- 3. Duplicate / retry recognition -----------------------------------------
  const signature = `${a.merchant?.merchant_id}|${F.lines.map(l => l.raw.item_id).sort().join('+')}|${F.billing}`;
  const relatedStatus = a.related_authorization_status ?? null;
  if (relatedStatus === 'declined') {
    addFail('RETRY_OF_DECLINED', 'this is a retry of a purchase you (or the wallet) already declined — declined purchases stay declined');
  }
  const dup = state.findDuplicate({ signature, authId: a.authorization_id, simTs: F.simTs, billing: F.billing, merchantId: a.merchant?.merchant_id });
  if (dup) {
    if (dup.kind === 'approved-similar') {
      addUnc('DUPLICATE_SUSPECT', `near-identical order at ${a.merchant?.merchant_name} (${fmtChf(dup.billing)}) was already approved ${dup.minutesAgo} min ago — possible duplicate submission`);
    } else if (dup.kind === 'declined-similar') {
      addFail('RETRY_OF_DECLINED', `an identical order (${fmtChf(dup.billing)} at ${a.merchant?.merchant_name}) was declined ${dup.minutesAgo} min ago; retrying does not change the decision`);
    } else if (dup.kind === 'split-suspect') {
      addUnc('SPLIT_ORDER', `another order at ${a.merchant?.merchant_name} (${fmtChf(dup.billing)}) was approved only ${dup.minutesAgo} min ago — this looks like the same purchase split in two`);
    }
  }
  ev('Related purchase', relatedStatus ? `${a.related_authorization_id || 'earlier purchase'} → ${relatedStatus}` : 'none');

  // -- 3b. Merchant website domain + customer trust status ----------------------
  // The domain drives the yellow-list path: a domain the customer explicitly
  // trusted (approved on a step-up card) counts as familiar; a domain on NEITHER
  // the trusted list NOR a known-bad list is an open question for the customer
  // (see 8c) — never silent permission.
  const merchantDomain = normalizeDomain(a.merchant?.merchant_url || a.merchant?.website_url || a.merchant?.merchant_domain || a.merchant?.url || null)?.domain?.replace(/^www\./, '') || null;
  const trustedMeta = merchantDomain && state.trustedDomainCheck ? state.trustedDomainCheck(merchantDomain) : null;

  // -- 4. Hard rules ------------------------------------------------------------
  const rules = mandate.hard_rules || [];
  const requestedSpec = requestedItemSpec(mandate.instruction);
  let exactMatch = false;
  let integrityMonitoring = false;
  const ruleResults = [];

  for (const rule of rules) {
    const f = rule.field, op = rule.operator;
    let res;
    if (f === 'authorization.billing_amount_chf' && (rule.scope ?? 'purchase') === 'purchase') {
      if (F.billing == null) res = check(rule, 'uncertain', 'amount not readable');
      else {
        const ok = cmp(F.billing, op, rule.value);
        res = check(rule, ok ? 'pass' : 'fail', ok ? `${fmtChf(F.billing)} within cap ${fmtChf(rule.value)}` : `${fmtChf(F.billing)} exceeds cap ${fmtChf(rule.value)}`);
        if (!ok) addFail('LIMIT_EXCEEDED', `total ${fmtChf(F.billing)} (delivery included) is over your ${fmtChf(rule.value)} per-order cap`);
      }
      ev('Per-order cap', `${fmtChf(rule.value)} → ${F.billing != null ? fmtChf(F.billing) : '?'}`);
    } else if (f === 'period.approved_spend_chf' && rule.scope === 'period') {
      const days = rule.period_days || 7;
      const before = state.approvedSpendInWindow(days, F.simTs);
      const platform = typeof event.context?.approved_spend_in_period_chf === 'number' ? event.context.approved_spend_in_period_chf : null;
      const counted = Math.max(before, platform ?? 0); // conservative: never under-count
      if (F.billing == null) res = check(rule, 'uncertain', 'amount not readable');
      else {
        const total = round2(counted + F.billing);
        const ok = cmp(total, op, rule.value);
        res = check(rule, ok ? 'pass' : 'fail', `approved spend in last ${days}d: ${fmtChf(counted)}; with this: ${fmtChf(total)} vs cap ${fmtChf(rule.value)}`);
        if (!ok) addFail('PERIOD_LIMIT_EXCEEDED', `this purchase would take your rolling ${days}-day total to ${fmtChf(total)} — over the ${fmtChf(rule.value)} cap (${fmtChf(counted)} already approved)`);
        ev(`Rolling ${days}d spend`, `${fmtChf(counted)} approved + ${fmtChf(F.billing)} = ${fmtChf(total)} / ${fmtChf(rule.value)}`);
      }
    } else if (f === 'basket.line_count') {
      const n = F.lines.length;
      const ok = cmp(n, op, rule.value);
      res = check(rule, ok ? 'pass' : 'fail', `${n} line(s) vs limit ${rule.value}`);
      if (!ok) addFail('LINE_COUNT_EXCEEDED', `basket has ${n} items; permission covers ${rule.value}`);
    } else if (f === 'basket.categories' && op === 'in') {
      const allowed = new Set(rule.value);
      const bad = F.lines.filter(l => !l.raw.item_category || !allowed.has(l.raw.item_category));
      if (bad.length) {
        res = check(rule, 'fail', bad.map(l => `${l.raw.item_name} (${l.raw.item_category || 'category missing'})`).join(', '));
        addFail('CATEGORY_MISMATCH', `not everything in the basket is ${rule.value.join('/')}: ${bad.map(l => `“${clip(l.raw.item_name)}” (${l.raw.item_category || 'category missing'})`).join(', ')}`);
      } else {
        res = check(rule, 'pass', `all ${F.lines.length} line(s) are ${[...allowed].join('/')}`);
      }
    } else if (f === 'basket.excluded_categories' && op === 'not_in') {
      const banned = new Set(rule.value);
      const bad = F.lines.filter(l => l.raw.item_category && banned.has(l.raw.item_category));
      exactMatch = exactMatch || false;
      if (bad.length) {
        res = check(rule, 'fail', bad.map(l => l.raw.item_name).join(', '));
        addFail('GIFT_CARD_RISK', `basket contains ${bad.map(l => `“${clip(l.raw.item_name)}”`).join(', ')} — gift cards/vouchers are excluded by your wallet policy (irreversible spend, classic agent-fraud vector). The stated purchase (“${clip(a.purchase_description)}”) does not match the basket.`);
      } else res = check(rule, 'pass', 'no excluded categories in basket');
    } else if (f === 'merchant.merchant_category' && op === 'in') {
      const allowed = new Set(rule.value);
      const ok = allowed.has(a.merchant?.merchant_category);
      res = check(rule, ok ? 'pass' : 'fail', `${a.merchant?.merchant_name} is “${a.merchant?.merchant_category}”, needs ${rule.value.join('/')}`);
      if (!ok) addFail('MERCHANT_TYPE_MISMATCH', `${a.merchant?.merchant_name} is a ${a.merchant?.merchant_category} retailer — your policy requires a specialist ${rule.value.join('/')} retailer`);
    } else if (f === 'merchant.familiar_to_customer' && op === '=' && String(rule.value) === 'true') {
      const hist = profiles.merchantFamiliar(customerId, a.merchant?.merchant_id);
      const inRun = state.inRunApprovedMerchant(a.merchant?.merchant_id);
      const trusted = Boolean(trustedMeta);
      const familiar = hist.familiar || inRun || trusted;
      const basis = trusted && !hist.familiar && !inRun
        ? `on your trusted merchant list since ${new Date(trustedMeta.addedAt).toISOString().slice(0, 10)}`
        : `${hist.approvedCount || 'run'} approved purchase(s) on record`;
      res = check(rule, familiar ? 'pass' : 'fail', familiar ? `${a.merchant?.merchant_name}: ${basis}` : `${a.merchant?.merchant_name}: no purchases on record for you`);
      ev('Merchant familiarity', familiar ? `${a.merchant?.merchant_name} — ${basis}` : `${a.merchant?.merchant_name} — never bought here before`);
      if (!familiar) addFail('MERCHANT_UNFAMILIAR', `${a.merchant?.merchant_name} (${a.merchant?.merchant_city ?? a.merchant?.merchant_country ?? 'unknown'}) is not a shop you have bought from before`);
    } else if (f === 'basket.return_window_days_min') {
      const need = rule.value;
      const structured = a.order_returnable;
      let worst = null;
      for (const l of F.lines) {
        if (worst === null || (l.ret.days ?? Infinity) < (worst.days ?? Infinity)) worst = l.ret;
      }
      if (structured === 'false') {
        res = check(rule, 'fail', `order marked not returnable, needs ≥ ${need} days`);
        addFail('RETURN_WINDOW_INSUFFICIENT', `the order is marked non-returnable — you required a return window of at least ${need} days`);
      } else if (worst && worst.days === 0) {
        res = check(rule, 'fail', `seller: ${worst.basis}, needs ≥ ${need} days`);
        addFail('RETURN_WINDOW_INSUFFICIENT', `seller policy: ${worst.basis} — short of your ${need}-day requirement`);
      } else if (worst && worst.days != null && worst.days >= need) {
        res = check(rule, 'pass', `${worst.basis}`);
        ev('Return window', worst.basis);
      } else if (worst && worst.days != null) {
        res = check(rule, 'fail', `seller: ${worst.basis}, needs ≥ ${need} days`);
        addFail('RETURN_WINDOW_INSUFFICIENT', `seller policy: ${worst.basis} — short of your ${need}-day return requirement`);
        ev('Return window', worst.basis);
      } else {
        res = check(rule, 'uncertain', worst ? worst.basis : 'no return terms found', );
        addUnc('RETURN_WINDOW_UNKNOWN', `seller did not state a return window; you required ≥ ${need} days (${worst?.basis || 'no terms found'})`);
        ev('Return window', worst?.basis || 'not stated');
      }
    } else if (f === 'basket.requested_item_match' && String(rule.value) === 'true') {
      if (!requestedSpec.present) {
        res = check(rule, 'uncertain', 'requested item could not be derived from instruction');
        addUnc('REQUESTED_ITEM_UNCLEAR', 'policy requires a specific item but it could not be determined from your instruction');
      } else {
        let lineIssues = [];
        for (const l of F.lines) lineIssues.push(...lineMatchesSpec(l, requestedSpec));
        const hard = lineIssues.filter(i => i.level === 'fail');
        const soft = lineIssues.filter(i => i.level === 'uncertain');
        if (hard.length) {
          res = check(rule, 'fail', hard.map(i => i.detail).join('; '));
          for (const i of hard) {
            addFail(i.code, i.detail);
          }
        } else if (soft.length) {
          res = check(rule, 'uncertain', soft.map(i => i.detail).join('; '));
          for (const i of soft) addUnc(i.code, i.detail);
        } else {
          res = check(rule, 'pass', `matches requested ${requestedSpec.label}`);
          ev('Requested item', `matches: ${requestedSpec.label}${requestedSpec.size ? `, size ${requestedSpec.size}` : ''}`);
        }
      }
    } else if (f === 'basket.exact_match' && String(rule.value) === 'true') {
      exactMatch = true;
      res = check(rule, 'pass', 'add-on prohibition active');
    } else if (f === 'authorization.fulfillment_method') {
      const ok = a.fulfillment_method === rule.value;
      res = check(rule, ok ? 'pass' : (a.fulfillment_method ? 'fail' : 'uncertain'), `fulfilment: ${a.fulfillment_method ?? 'unknown'} vs ${rule.value}`);
      if (!ok) addUnc('FULFILMENT_MISMATCH', `order fulfilment is “${a.fulfillment_method ?? 'unknown'}”, policy expects “${rule.value}”`);
    } else if (f === 'session.integrity_monitoring' && String(rule.value) === 'true') {
      integrityMonitoring = true;
      res = check(rule, 'pass', 'session-integrity monitoring on');
    } else {
      res = check(rule, 'uncertain', `engine has no semantics for field “${f}” — treating as unverified`);
      addUnc('RULE_UNVERIFIED', `a permission (“${f} ${op} ${JSON.stringify(rule.value)}”) could not be checked by this engine`);
    }
    ruleResults.push(res);
  }

  // -- 5. Extra lines beyond a single requested item ------------------------------
  if (requestedSpec.present && F.lines.length > 1) {
    const extras = F.lines.filter(l => lineMatchesSpec(l, requestedSpec).some(i => i.level === 'fail' || i.code === 'SUBSTITUTION' || i.code === 'ITEM_UNCLEAR'));
    if (extras.length) {
      const names = extras.map(l => `“${clip(l.raw.item_name)}” (${fmtChf(toChf((l.raw.unit_price || 0) * (l.raw.quantity || 1), l.raw.currency))})`);
      if (exactMatch) {
        addFail('EXTRA_ITEM_BLOCKED', `order includes ${names.join(', ')} — you prohibited adding anything beyond the requested ${requestedSpec.label}`);
      } else {
        addUnc('EXTRA_ITEM', `order includes ${names.join(', ')} beyond the requested ${requestedSpec.label} — confirm you want them`);
      }
    }
  }

  // -- 6. Session-integrity & behavioural signals ---------------------------------
  const dev = profiles.deviceKnown(customerId, a.customer_device_id);
  ev('Device', dev.known ? `${a.customer_device_id} — known from your history` : `${a.customer_device_id} — never seen in your history`);
  if (!dev.known) {
    const d = { code: 'DEVICE_NOVELTY', detail: `purchase initiated from device ${a.customer_device_id}, which appears nowhere in your history` };
    integrityMonitoring ? flags.integrity.push(d) : addUnc(d.code, d.detail);
  }
  const vel = a.recent_attempt_count_10m ?? 0;
  ev('Recent attempts (10 min)', String(vel));
  if (vel >= 2) {
    const d = { code: 'VELOCITY_BURST', detail: `${vel} attempts in the last 10 minutes — burst pattern` };
    integrityMonitoring ? flags.integrity.push(d) : addUnc(d.code, d.detail);
  } else if (vel === 1 && uncert.some(u => u.code === 'DUPLICATE_SUSPECT')) {
    addUnc('SPLIT_ORDER', 'another attempt was made minutes ago at the same merchant for a similar amount — possible order splitting');
  }
  const hour = profiles.hourUnusual(customerId, F.simTs ?? Date.now());
  if (hour.unusual) {
    const d = { code: 'UNUSUAL_HOUR', detail: `attempted at ${String(hour.hour).padStart(2, '0')}:00 UTC — an hour you have never bought at` };
    integrityMonitoring ? flags.integrity.push(d) : addUnc(d.code, d.detail);
  }

  // -- 6b. Trained user-behavior model (advisory only) ---------------------------
  // Trained on this customer's own authorization history (challenge pack,
  // see merchant-trust-data/models/behavior/). Like the injection detector it
  // can NEVER approve, decline, or loosen: the score is always evidence, and a
  // strong anomaly becomes an uncertainty routed by the customer's own
  // uncertainty policy (ask → step_up). Inert when no artifact is deployed or
  // the customer has no learned profile.
  const beh = scoreBehavior(a, customerId);
  if (beh) {
    const pct = Math.round(beh.score * 100);
    const drivers = beh.factors.map(f => f.label).join(', ');
    ev('Behavior model', `${beh.band} — ${pct}% off-pattern${drivers ? `: ${drivers}` : ''}`);
    if (beh.band === 'escalate') {
      addUnc('BEHAVIOR_ANOMALY', `this purchase is strongly off-pattern for you (${pct}% deviation${drivers ? `: ${drivers}` : ''}) — outside anything in your spending history, so it needs your confirmation`);
    }
  }

  // -- 7. Lookalike merchant --------------------------------------------------------
  const histFam = profiles.merchantFamiliar(customerId, a.merchant?.merchant_id);
  if (!histFam.familiar) {
    const look = lookalikeMatch(a.merchant || {}, profiles.knownMerchants(customerId));
    if (look) {
      const d = { code: 'LOOKALIKE_MERCHANT', detail: `“${a.merchant.merchant_name}” closely resembles “${look.against.name}” (${Math.round(look.score * 100)}% name match), a shop you actually use — possible impersonation/typo-squat` };
      flags.integrity.push(d);
      // sharpen the unfamiliar-merchant decline with the impersonation evidence
      const unfam = fails.find(f => f.code === 'MERCHANT_UNFAMILIAR');
      if (unfam) unfam.detail += ` — and its name closely resembles “${look.against.name}”, a shop you actually use (${Math.round(look.score * 100)}% match): possible impersonation`;
      else addUnc(d.code, d.detail);
    }
  }

  // -- 8. LEASH merchant-trust dataset (optional, degrades silently) -----------------
  const tl = trustLookup(a.merchant || {}, trust);
  if (tl?.malicious) {
    addFail('TRUSTLIST_HIT', `merchant matches known-malicious infrastructure: ${tl.evidence}`);
  } else if (tl?.legitimate) {
    flags.positive.push({ code: 'REGISTRY_MATCH', detail: tl.evidence });
    ev('Merchant trust', 'name found in Swiss company registry dataset (LEASH/GLEIF)');
  }

  // -- 8b. Trusted Shops verification (advisory evidence, pre-fetched by the worker) ---
  // Presence of the merchant's website on Trusted Shops is positive evidence only;
  // absence is neutral — many legitimate shops (digitec, brack) are not members.
  // A failed/timed-out check degrades silently. Nothing here can fail, add an
  // uncertainty, or change the outcome on its own.
  const tsResult = extras?.trustedShops || null;
  const fakeFlagged = Boolean(tsResult?.fake_shop?.flagged);
  if (tsResult && !fakeFlagged && (tsResult.listed === true || tsResult.listed === false)) {
    ev('Trusted Shops', describeResult(tsResult));
    if (tsResult.listed === true) {
      flags.positive.push({ code: 'TRUSTEDSHOPS_LISTED', detail: `merchant website is listed on Trusted Shops: ${describeResult(tsResult)}` });
    }
  }
  // A public fake-shop warning is the opposite of listing evidence: authoritative
  // third-party knowledge that the shop is a scam (same class as TRUSTLIST_HIT).
  // It is a hard fail — the wallet must not send the customer's money to a shop
  // that a consumer-protection body has flagged.
  const fsWarn = tsResult?.fake_shop;
  if (fsWarn?.flagged) {
    const m = fsWarn.matches[0] || {};
    addFail('TRUSTEDSHOPS_FAKE_SHOP', `the merchant's website is flagged as a fake shop on ${m.site || 'Trusted Shops'}${m.type ? ` — warning type "${m.type}"` : ''}${m.date ? `, warning dated ${m.date}` : ''}`);
    ev('Fake-shop check', describeResult(tsResult));
  }

  // -- 8c. Yellow-list review: domain on neither the trusted list nor a known-bad list
  // For an unfamiliar merchant with a website, absence from the trusted list AND
  // from every known-bad source (threat intel, fake-shop warnings) is NOT
  // permission — it is uncertainty. The customer decides, with the merchant
  // dossier (Zefix registry, imprint comparison, socials, payment methods,
  // country, reviews) rendered on the step-up card by the UI.
  const blacklistedMerchant = fails.some(f => f.code === 'TRUSTLIST_HIT' || f.code === 'TRUSTEDSHOPS_FAKE_SHOP');
  if (merchantDomain && trustedMeta) {
    ev('Merchant trust status', `${merchantDomain} — on your trusted list since ${new Date(trustedMeta.addedAt).toISOString().slice(0, 10)}`);
    flags.positive.push({ code: 'MERCHANT_TRUSTED', detail: `${merchantDomain} is on your trusted merchant list (added ${new Date(trustedMeta.addedAt).toISOString().slice(0, 10)})` });
  } else if (merchantDomain && !histFam.familiar && !blacklistedMerchant) {
    addUnc('MERCHANT_UNREVIEWED', `the shop's domain ${merchantDomain} is on neither your trusted list nor any known-bad list, and you have never bought there — a merchant dossier is prepared for your review`);
    ev('Merchant trust status', `${merchantDomain} — unreviewed (yellow)`);
  }

  // -- 9. Description-vs-basket contradiction -----------------------------------------
  const desc = a.purchase_description || '';
  const basketText = F.lines.map(l => `${l.raw.item_name} ${l.raw.item_category}`).join(' ').toLowerCase();
  for (const [re, fam] of DESCRIPTION_FAMILY_TOKENS) {
    if (re.test(desc) && !basketText.includes(fam === 'outerwear' ? 'jacket' : fam) && !(fam === 'shoes' && /shoe/.test(basketText)) && !(fam === 'monitor' && /monitor/.test(basketText))) {
      if (fam === 'groceries' && /grocer/.test(basketText)) continue;
      if (fam === 'clothing' && /clothing|jacket|coat|shirt|dress/.test(basketText)) continue;
      addUnc('DESCRIPTION_CONTRADICTION', `the stated purchase (“${clip(desc)}”) does not match what is actually in the basket`);
      break;
    }
  }

  // -- 10. Aggregate -------------------------------------------------------------------
  fails.sort((x, y) => codeRank(x.code) - codeRank(y.code));
  const policy = mandate.uncertainty_policy || 'ask';
  let decision;
  const manipulationPresent = flags.manipulation.length > 0;
  const integrityBreach = integrityMonitoring && flags.integrity.length > 0;

  if (fails.length) decision = 'decline';
  else if (manipulationPresent || integrityBreach) decision = policy === 'decline' ? 'decline' : 'step_up';
  else if (uncert.length) decision = policy === 'ask' ? 'step_up' : policy;
  else decision = 'approve';

  // -- 11. Compose message ---------------------------------------------------------------
  const merchantName = a.merchant?.merchant_name || 'unknown merchant';
  const amountStr = F.billing != null ? fmtChf(F.billing) : 'an unreadable amount';
  let message;
  if (decision === 'decline') {
    const reasons = fails.map(f => sentence(f.detail)).join(' ');
    message = `Declined ${amountStr} at ${merchantName}. ${reasons}`;
    if (manipulationPresent) message += ` Note: ${merchantName}'s product text also attempted to manipulate the wallet (“${clip(flags.manipulation[0].snippet)}”) — it was ignored and did not influence this decision.`;
  } else if (decision === 'step_up') {
    const lead = manipulationPresent
      ? `⚠️ Manipulation attempt detected in ${merchantName}'s product text — the purchase is paused for your review; the embedded instructions were NOT followed.`
      : integrityBreach
        ? `Paused for you: this purchase shows session signals that don't look like you (${flags.integrity.map(i => i.detail).join('; ')}).`
        : uncert.some(u => u.code === 'MERCHANT_UNREVIEWED')
          ? `Paused for your review — ${merchantName}, ${amountStr}. This shop is on neither your trusted list nor a known-bad list; its merchant dossier (registry, imprint, reviews) is shown below so you can decide whether to trust it.`
          : `Paused for your review — ${merchantName}, ${amountStr}.`;
    message = `${lead} ${uncert.length ? 'Open points: ' + uncert.map(u => u.detail).join(' ') : ''}`.trim();
  } else {
    const notes = [...flags.integrity.map(i => i.detail)];
    message = `Approved ${amountStr} at ${merchantName} — within your policy.${notes.length ? ` Notes: ${notes.join('; ')}.` : ''}`;
  }

  const reasonCodes = [
    ...fails.map(f => f.code),
    ...(manipulationPresent ? ['INJECTION_ATTEMPT'] : []),
    ...(integrityBreach ? flags.integrity.map(i => i.code) : []),
    ...uncert.map(u => u.code),
  ];
  const uniqueCodes = [...new Set(reasonCodes)];

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    decision,
    reason_codes: uniqueCodes,
    customer_message: message,
    evidence,
    uncertainties: uncert.map(u => ({ code: u.code, detail: u.detail })),
    rule_results: ruleResults,
    flags,
    signature,
    evaluation_ms: Math.round(ms * 100) / 100,
    engine_version: 'leash-engine 1.2.0',
  };
}

function cmp(actual, op, value) {
  switch (op) {
    case '<': return actual < value;
    case '<=': return actual <= value;
    case '>': return actual > value;
    case '>=': return actual >= value;
    case '=': return String(actual) === String(value);
    case '!=': return String(actual) !== String(value);
    case 'in': return Array.isArray(value) && value.map(String).includes(String(actual));
    case 'not_in': return Array.isArray(value) && !value.map(String).includes(String(actual));
    default: return false;
  }
}

/** Ensure a reason detail reads as a standalone sentence (capitalized, period-terminated). */
function sentence(s) {
  s = String(s || '').trim();
  if (!s) return s;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?…]$/.test(s)) s += '.';
  return s;
}
