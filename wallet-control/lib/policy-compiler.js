import { toChf } from './util.js';
// LEASH wallet-control — policy compiler.
// Translates the customer's natural-language instruction into executable permissions:
// API-format hard_rules + uncertainty policy + plain-language explanations.
//
// Design constraints:
//  - Fully deterministic (no model in the loop) so translation is predictable,
//    auditable, and reproducible; the engine re-derives the requested-item spec
//    from the same code, keeping mandate and interpretation consistent.
//  - Conservative defaults: uncertainty -> ask; gift cards excluded by default.
//    Every default is shown to the customer BEFORE they confirm the mandate.
//  - Sentences the compiler cannot understand become open_questions shown to the
//    customer, never silently ignored.

const CATEGORY_WORDS = {
  grocery: 'groceries', groceries: 'groceries',
  clothing: 'clothing', clothes: 'clothing',
  electronics: 'electronics',
  book: 'books', books: 'books',
};

const SPECIALIST_WORDS = {
  sport: 'sporting_goods', sports: 'sporting_goods', sporting: 'sporting_goods',
  electronics: 'electronics', electronic: 'electronics',
  book: 'books', books: 'books', computer: 'electronics', computers: 'electronics',
  clothing: 'clothing', fashion: 'clothing',
};

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

const money = (n) => `CHF ${Number(n).toFixed(2)}`;

function wordsToNumber(w) {
  const s = w.toLowerCase();
  if (NUMBER_WORDS[s]) return NUMBER_WORDS[s];
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the requested-item spec the engine uses for attribute matching.
 * Deterministic: compilePolicy() and evaluate() both call this on the exact
 * instruction text, so the stored mandate and the runtime interpretation agree.
 */
export function requestedItemSpec(instruction) {
  const t = String(instruction || '');
  const spec = { present: false };
  const inch = t.match(/(\d{2})\s*[- ]?inch\s+(computer\s+)?monitor/i);
  if (inch) { spec.present = true; spec.family = 'monitor'; spec.inches = parseInt(inch[1], 10); spec.label = `${inch[1]}-inch monitor`; }
  const shoes = t.match(/\b(road|trail)[- ]?running\s+shoes?\b/i) || t.match(/\brunning\s+shoes?\b/i) || t.match(/\bhiking\s+boots?\b/i);
  if (shoes) {
    spec.present = true;
    spec.family = 'shoes'; spec.sport = /hiking/i.test(shoes[0]) ? 'hiking' : 'running';
    if (/\broad[- ]?running\b/i.test(t)) spec.terrain = 'road';
    if (/\btrail[- ]?running\b/i.test(t)) spec.terrain = 'trail';
    spec.label = spec.sport === 'hiking' ? 'hiking boots' : `${spec.terrain ? spec.terrain + '-' : ''}running shoes`;
    const sz = t.match(/\bsize\s+([0-9]{1,2}(?:\.\d)?)\b/i);
    if (sz) { spec.size = sz[1]; spec.label += ` in size ${sz[1]}`; }
  }
  const jacket = t.match(/\b(?:waterproof\s+)?(?:jacket|rain ?coat|coat)\b/i);
  if (jacket && !spec.present) { spec.present = true; spec.family = 'outerwear'; spec.label = jacket[0].toLowerCase(); }
  if (/\bcamera lens\b/i.test(t) && !spec.present) Object.assign(spec, { present: true, family: 'camera_lens', label: 'camera lens' });
  return spec;
}

/**
 * Compile a natural-language wallet instruction into an executable mandate draft.
 */
export function compilePolicy(instruction) {
  const t = String(instruction || '').trim();
  const rules = [];
  const guidance = [];
  const openQuestions = [];
  const understood = [];
  const warnings = [];
  let uncertaintyPolicy = null;

  const addRule = (rule, plain, label) => {
    rules.push(rule);
    understood.push({ label, plain, rule });
  };

  // ---- Uncertainty handling -------------------------------------------------
  if (/\bask me when (uncertain|unsure|in doubt)|ask when uncertain|ask me if (uncertain|unsure)\b/i.test(t)) {
    uncertaintyPolicy = 'ask';
    guidance.push('When evidence is missing or ambiguous, the purchase is paused and you decide.');
  } else if (/\bwhen in doubt,? decline|decline when (uncertain|unsure)|if (uncertain|unsure),? decline\b/i.test(t)) {
    uncertaintyPolicy = 'decline';
    guidance.push('When evidence is missing or ambiguous, the purchase is declined without bothering you.');
  } else if (/\bapprove when (uncertain|unsure)|if (uncertain|unsure),? approve\b/i.test(t)) {
    uncertaintyPolicy = 'approve';
    warnings.push('You chose to auto-approve uncertain purchases — manipulative merchant text still forces a pause.');
  } else {
    uncertaintyPolicy = 'ask';
    guidance.push('Default (no explicit instruction found): when uncertain we pause and ask you.');
  }

  // ---- Per-purchase amount cap ---------------------------------------------
  // "for CHF 20 or less", "up to CHF 200", "no more than CHF 400", "pay no more than CHF 200",
  // "at or below CHF 120", "up to CHF 250 per order"
  const amountPattern = /\b(CHF|EUR|GBP|USD)\s*([0-9]+(?:[.,][0-9]+)*)/gi;
  const parseAmount = raw => /^\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(raw)
    ? Number(raw.replace(/,/g, '')) : /^\d+,\d{1,2}$/.test(raw) ? Number(raw.replace(',', '.')) : null;
  const moneyMatches = [...t.matchAll(amountPattern)];
  let currencyFreeCap = null;
  for (const match of moneyMatches) {
    const amount = parseAmount(match[2]);
    if (amount == null || !Number.isFinite(amount)) { openQuestions.push(`Unclear amount: ${match[0]}`); continue; }
    const currency = match[1].toUpperCase();
    // Use integer minor units so EUR 20.50 at 0.95 rounds to CHF 19.48,
    // rather than losing a cent to binary floating-point multiplication.
    const value = toChf(amount, currency);
    const before = t.slice(Math.max(0, match.index - 100), match.index).split(/[.;]/).pop();
    const after = t.slice(match.index + match[0].length).split(/[.;]/)[0];
    const daysAfter = after.match(/^\s*(?:in|across|over|within)\s+(?:any\s+)?(\d+|[a-z]+)[ -]+days?(?:\s+window)?/i);
    const daysBefore = before.match(/(?:across|in|over|within)\s+(?:any\s+)?(\d+|[a-z]+)[ -]+days?\s+(?:at or below|at most|no more than|under|up to)\s*$/i);
    const days = wordsToNumber((daysAfter || daysBefore)?.[1] || '');
    const nightly = /^\s*per night\b/i.test(after);
    const monthly = /(?:per month|monthly|total per month)[^.;]*$/i.test(before) || /^\s*(?:per month|monthly)\b/i.test(after);
    if (days && days >= 1) {
      addRule({ field: 'period.approved_spend_chf', operator: '<=', value, currency: 'CHF', scope: 'period', period_days: days },
        `Approved spending in any rolling ${days}-day window must not exceed ${money(value)}.`, 'Rolling limit');
    } else if (nightly) {
      addRule({ field: 'booking.nightly_amount_chf', operator: '<=', value, currency: 'CHF', scope: 'purchase' },
        `Each booked night must cost at most ${money(value)}; missing nightly prices require review.`, 'Nightly limit');
    } else if (monthly) {
      openQuestions.push(`Calendar-month spending limit ${match[0]} needs an explicit monthly accounting rule; automatic approval is paused.`);
    } else if (/(?:up to|no more than|at or below|at most|maximum(?: of)?|max\.?|not more than|never spend more than|for)\s*$/i.test(before)
      || /^\s*(?:or less|at most|or below|maximum|per order)\b/i.test(after)) {
      addRule({ field: 'authorization.billing_amount_chf', operator: '<=', value, currency: 'CHF', scope: 'purchase' },
        `Total per purchase including delivery must be ≤ ${money(value)}${currency !== 'CHF' ? ` (${currency} ${amount.toFixed(2)} at the fixed challenge exchange rate)` : ''}.`, 'Per-order limit');
    } else openQuestions.push(`Please specify the spending scope for ${match[0]}; automatic approval is paused.`);
  }
  // Retain the supported currency-free "up to 200" form as an explicit CHF default.
  if (!moneyMatches.length) {
    const cap = t.match(/\b(?:up to|at most|max(?:imum)?(?: of)?)\s+(\d+(?:\.\d{1,2})?)\b/i);
    if (cap) { currencyFreeCap = cap[0]; addRule({ field: 'authorization.billing_amount_chf', operator: '<=', value: Number(cap[1]), currency: 'CHF', scope: 'purchase' }, `Per purchase: at most CHF ${cap[1]} (CHF assumed).`, 'Per-order limit'); }
  }

  // ---- Quantity / single item -------------------------------------------------
  let singleItem = false;
  const singleMatch = t.match(/\b(?:buy|order|purchase|get)\s+(?:one|a single|\b1\b)\s+/i) || t.match(/\b(?:buy|order)\s+the\b/i);
  if (singleMatch) {
    singleItem = true;
    addRule(
      { field: 'basket.line_count', operator: '<=', value: 1 },
      'Only one cart line may be purchased.',
      'Single item'
    );
  }

  if (singleItem) addRule({ field: 'basket.total_quantity', operator: '<=', value: 1 }, 'At most one unit may be purchased, including quantities on a single cart line.', 'Quantity');

  // ---- Category / purpose ------------------------------------------------------
  // Purpose statements: "Order our household groceries", "buy clothing for me"
  const cats = new Set();
  for (const [word, cat] of Object.entries(CATEGORY_WORDS)) {
    const re = new RegExp(`\\b${word}s?\\b`, 'i');
    if (cat === 'books' && /\bbook\s+(?:me\s+)?(?:a|the|one)\s+hotel\b/i.test(t)) continue;
    if (re.test(t)) cats.add(cat);
  }
  if (/\bhousehold (?:basics|items)\b/i.test(t)) cats.add('household');
  if (/\bhotel\b/i.test(t)) cats.add('hotel');
  if (cats.size) {
    const list = [...cats];
    addRule(
      { field: 'basket.categories', operator: 'in', value: list },
      `Every item in the basket must be ${list.join('/')}.`,
      'Purpose'
    );
  }

  // ---- Requested item ------------------------------------------------------------
  const spec = requestedItemSpec(t);
  if (spec.present) {
    addRule(
      { field: 'basket.requested_item_match', operator: '=', value: 'true' },
      `The basket must contain ${spec.label}${spec.size ? ` — the exact product, matching all stated attributes (type${spec.terrain ? ', terrain' : ''}${spec.size ? ', size' : ''}${spec.inches ? ', screen size' : ''}).` : '.'}`,
      'Requested item'
    );
  } else if (/\b(buy|order|purchase|get)\b/i.test(t) && !cats.size) {
    openQuestions.push('Which product or category should the agent buy? Name the item type so the basket can be checked against it.');
  }

  // ---- Merchant constraints -------------------------------------------------------
  if (/\b(?:shop|shops|store|seller|retailer|merchant)s?\s+(?:that|which)?\s*I\s+(?:use|have used|'ve used|used|buy|have bought|'ve bought|bought|purchase|have purchased|purchased)\s*(?:at|from|with)?\s*(?:it\s*)?(?:regularly|before|often|already)?\b/i.test(t)
    || /\bshop I use regularly\b/i.test(t)
    || /\busual (?:shop|store|seller|services?)\b/i.test(t)
    || /\b(?:supermarkets?|retailers?|shops?|sellers?) I (?:already use|already know)\b/i.test(t)) {
    addRule(
      { field: 'merchant.familiar_to_customer', operator: '=', value: 'true' },
      'Only merchants you have actually bought from before (at least one approved purchase in your history).',
      'Familiar merchant'
    );
  }

  const specialist = t.match(/\bproper\s+([a-z]+)\s+shop\b/i) || t.match(/\bspecialist\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:retailer|seller|store|shop)\b/i)
    || t.match(/\bspecialist\s+([a-z]+)\b/i);
  if (specialist) {
    const word = specialist[1].trim().split(/\s+/)[0].toLowerCase();
    const cat = SPECIALIST_WORDS[word];
    if (cat) {
      addRule(
        { field: 'merchant.merchant_category', operator: 'in', value: [cat] },
        `Merchant must be a specialist ${word} retailer (category ${cat}).`,
        'Specialist retailer'
      );
    } else {
      openQuestions.push(`What counts as a "specialist ${specialist[1]} retailer"? Name the shop types you accept.`);
    }
  }

  // ---- Return window -----------------------------------------------------------
  const ret = t.match(/\breturn(?:ed)?(?: them)?\s+within\s+at least\s+(\d+)\s+days?\b/i) || t.match(/\breturned?\s+within\s+([0-9]+)\s+days?\s+or more\b/i)
    || t.match(/\bcan be returned?\s+within\s+([0-9]+)\s+days?\b/i)
    || t.match(/\breturns?\s+(?:window\s+)?(?:of\s+)?(?:at least\s+)?([0-9]+)\s+days?\b/i);
  if (ret) {
    const days = parseInt(ret[1], 10);
    addRule(
      { field: 'basket.return_window_days_min', operator: '>=', value: days },
      `The seller's stated return window must be at least ${days} days. If the seller does not state one, that counts as uncertain (we ask you rather than guess).`,
      'Return window'
    );
  }

  // ---- No add-ons --------------------------------------------------------------
  if (/\bdo not add anything\b|\bnothing I did not ask for\b|\bno add-?ons\b|\bno extras?\b|\bnothing else in the basket\b/i.test(t)) {
    addRule(
      { field: 'basket.exact_match', operator: '=', value: 'true' },
      'Nothing beyond the requested item may be added to the basket — any extra line blocks the purchase.',
      'No add-ons'
    );
  }

  // ---- Delivery fulfilment -----------------------------------------------------
  if (/\bfor delivery\b|\bdelivered\b/i.test(t)) {
    addRule(
      { field: 'authorization.fulfillment_method', operator: '=', value: 'delivery' },
      'Order must be a delivery order.',
      'Fulfilment'
    );
  }

  // ---- Session integrity ---------------------------------------------------------
  if (/\bpause anything\b|\bsomeone other than me\b|\bdriving the session\b|\bdoesn.t look like me\b|\bnot like me\b|\bsession looks unusual\b/i.test(t)) {
    addRule(
      { field: 'session.integrity_monitoring', operator: '=', value: 'true' },
      'Session-integrity monitoring is ON: unfamiliar devices, purchase bursts, or unusual hours pause the purchase for you.',
      'Session integrity'
    );
  }

  // ---- Default guardrail: gift cards ------------------------------------------------
  addRule(
    { field: 'basket.excluded_categories', operator: 'not_in', value: ['gift_card'] },
    'Gift cards and vouchers are blocked by default — they are a classic fraud/cash-out vector. Remove this guardrail in the editor if you disagree.',
    'Gift-card guardrail (default)'
  );

  // ---- Open questions for anything not understood -----------------------------------
  // Only remove language for constraints actually represented by a rule.
  // Residual substantive wording stays visible and forces customer review.
  const supported = new Set(rules.map(r => r.field));
  let residual = t;
  if (currencyFreeCap) residual = residual.replace(currencyFreeCap, ' ');
  const consume = re => { residual = residual.replace(re, ' '); };
  consume(/\bask(?: me)? (?:when|if) (?:anything is )?(?:uncertain|unsure|unclear|in doubt)\b|\b(?:if unsure|when in doubt|if anything is unclear),? ask(?: me)?\b/gi);
  consume(/\b(?:approve|decline) when (?:uncertain|unsure)\b|\bif (?:uncertain|unsure),? (?:approve|decline)\b/gi);
  if (supported.has('authorization.billing_amount_chf') || supported.has('period.approved_spend_chf') || supported.has('booking.nightly_amount_chf')) {
    consume(/\b(?:CHF|EUR|GBP|USD)\s*\d+(?:[.,]\d+)*/gi);
    consume(/\b(?:never spend more than|pay no more than|no more than|at or below|at most|maximum(?: of)?|max\.?|up to|not more than|or less|per order|per purchase|per night|including (?:the )?delivery(?: fee)?|keep each order|keep the total|keep spend|under)\b/gi);
  }
  if (supported.has('period.approved_spend_chf')) consume(/\b(?:across|in|over|within)\s+(?:any\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)[ -]+days?(?:\s+window)?\b/gi);
  if (supported.has('basket.categories')) {
    for (const cat of cats) {
      const words = { groceries: /\b(?:ordinary grocery item|household groceries|grocery shopping|groceries|grocery)\b/gi, household: /\bhousehold (?:basics|items)\b/gi, clothing: /\b(?:clothing|clothes)\b/gi, electronics: /\belectronics\b/gi, books: /\bbooks?\b/gi, hotel: /\bhotel\b/gi };
      if (words[cat]) consume(words[cat]);
    }
  }
  if (supported.has('basket.requested_item_match')) {
    // Only the selected product family is enforced; leave other products and
    // unsupported attributes (such as waterproof or new condition) for review.
    const productPatterns = { shoes: spec.sport === 'hiking' ? /\bhiking boots?\b/i : /\b(?:(?:road|trail)[- ]?)?running shoes?\b/i, camera_lens: /\bcamera lens\b/i, outerwear: /\b(?:jacket|coat|rain ?coat)\b/i, monitor: /\b\d{2}[- ]?inch (?:computer )?monitor\b/i };
    if (productPatterns[spec.family]) consume(productPatterns[spec.family]);
    if (spec.size) consume(/\bsize\s+\d{1,2}(?:\.\d)?\b/i);
  }
  if (supported.has('merchant.familiar_to_customer')) consume(/\b(?:shops?|stores?|sellers?|retailers?|merchants?|supermarkets?)\s+(?:that |which )?I\s+(?:(?:have |already )?(?:used|use|bought|know))(?: from| at)?(?: before| regularly| already| often)?\b|\busual (?:shops?|stores?|sellers?|services?)\b/gi);
  if (supported.has('merchant.merchant_category')) consume(/\b(?:specialist|proper)\s+\w+\s+(?:retailer|seller|store|shop)\b/gi);
  if (supported.has('basket.return_window_days_min')) consume(/\b(?:can be |must be able to )?return(?:ed)?(?: them)?\s+within\s+(?:at least )?\d+\s+days?(?: or more)?\b|\breturns?\s+(?:window\s+)?(?:of\s+)?(?:at least\s+)?\d+\s+days?\b/gi);
  if (supported.has('basket.exact_match')) consume(/\bdo not add anything(?: I did not ask for)?\b|\bnothing I did not ask for\b|\bno add-?ons\b|\bno extras?\b|\bnothing else in the basket\b/gi);
  if (supported.has('authorization.fulfillment_method')) consume(/\bfor delivery\b|\bdelivered\b/gi);
  if (supported.has('basket.total_quantity')) consume(/\bone\b|\ba single\b|\b1\b/gi);
  // Neutral grammar only; descriptors, dates, countries, exclusions and units
  // are deliberately not discarded. They may contain additional restrictions.
  consume(/\b(?:the|a|an|I|me|my|our|for|from|to|of|and|or|only|buy|order|purchase|get|book|need|replace|may|agent|must|be|able|it|them|in|is|that|with)\b/gi);
  residual = residual.replace(/[.,;:!?—–-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) openQuestions.push('Please provide a purchase instruction before allowing automatic purchases.');
  if (residual) openQuestions.push(`These details still need customer review: “${residual}”. They have not been converted into automatic permissions.`);
  if (openQuestions.length) {
    addRule({ field: 'policy.requires_review', operator: '=', value: 'true' },
      'Some instructions remain unresolved. Every purchase requires customer review, even if uncertain purchases would normally be approved.', 'Unresolved instructions');
  }

  guidance.push(`Uncertainty policy: ${uncertaintyPolicy === 'ask' ? 'pause and ask you' : uncertaintyPolicy === 'decline' ? 'decline automatically' : 'approve automatically (with manipulation guard)'}.`);

  return {
    instruction: t,
    hard_rules: rules,
    uncertainty_policy: uncertaintyPolicy,
    guidance,
    open_questions: openQuestions,
    understood,
    warnings,
    requested_item: spec,
  };
}
