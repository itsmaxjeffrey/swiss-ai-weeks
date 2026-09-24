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
  const shoes = t.match(/\b(road|trail)[- ]?running\s+shoes?\b/i) || t.match(/\brunning\s+shoes?\b/i);
  if (shoes) {
    spec.present = true;
    spec.family = 'shoes'; spec.sport = 'running';
    if (/\broad[- ]?running\b/i.test(t)) spec.terrain = 'road';
    if (/\btrail[- ]?running\b/i.test(t)) spec.terrain = 'trail';
    spec.label = `${spec.terrain ? spec.terrain + '-' : ''}running shoes`;
    const sz = t.match(/\bsize\s+([0-9]{1,2}(?:\.\d)?)\b/i);
    if (sz) { spec.size = sz[1]; spec.label += ` in size ${sz[1]}`; }
  }
  const jacket = t.match(/\b(?:waterproof\s+)?(?:jacket|rain ?coat|coat)\b/i);
  if (jacket && !spec.present) { spec.present = true; spec.family = 'outerwear'; spec.label = jacket[0].toLowerCase(); }
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
  const lower = t.toLowerCase();
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
  let perOrder = null;
  let m = t.match(/\b(?:up to|no more than|at or below|at most|maximum of|max\.?|not more than|pay no more than)\s*(?:CHF|EUR|GBP|USD)?\s*([0-9][0-9.,]*)/i)
       || t.match(/\b(?:CHF|EUR|GBP|USD)\s*([0-9][0-9.,]*)\s*(?:or less|at most|or below|maximum)/i)
       || t.match(/\bfor\s+(?:CHF|EUR|GBP|USD)?\s*([0-9][0-9.,]*)\s*or less/i);
  if (m && !/across|in total|per period/i.test(m[0])) perOrder = parseFloat(m[1].replace(/,/g, ''));
  if (perOrder != null && Number.isFinite(perOrder)) {
    addRule(
      { field: 'authorization.billing_amount_chf', operator: '<=', value: perOrder, currency: 'CHF', scope: 'purchase' },
      `Total per purchase (including delivery fees) must be ≤ ${money(perOrder)}.`,
      'Per-order limit'
    );
    if (/including delivery/i.test(t)) guidance.push('The cap is checked on the final billed total, which already includes delivery — delivery is never added twice.');
  }

  // ---- Rolling period cap ----------------------------------------------------
  // "keep the total across any seven days at or below CHF 300",
  // "keep spend under CHF 300 in any 7 days"
  {
    const DAY = String.raw`\b(?:across|in|over|within|per)\s+(?:any\s+)?([a-z]+|\d+)\s*(?:calendar\s+)?days?\b`;
    const CAP = String.raw`\b(?:at or below|at most|no more than|not more than|up to|under|max(?:imum)?)\s*(?:CHF|EUR|GBP|USD)?\s*([0-9][0-9.,]*)`;
    let period = null;
    const mA = t.match(new RegExp(DAY + String.raw`[^.;]*?` + CAP, 'i'));
    if (mA) {
      // reject matches where the day-phrase is a return-window clause ("returned within 14 days")
      const before = t.slice(Math.max(0, mA.index - 40), mA.index + 14);
      if (!/return/i.test(before)) period = { days: wordsToNumber(mA[1]), cap: parseFloat(mA[2].replace(/,/g, '')) };
    }
    if (!period) {
      const mB = t.match(new RegExp(CAP + String.raw`[^.;]*?` + DAY, 'i'));
      if (mB && !/return/i.test(mB[0])) period = { cap: parseFloat(mB[1].replace(/,/g, '')), days: wordsToNumber(mB[2]) };
    }
    if (period && Number.isFinite(period.days) && Number.isFinite(period.cap) && period.days >= 1) {
      addRule(
        { field: 'period.approved_spend_chf', operator: '<=', value: period.cap, currency: 'CHF', scope: 'period', period_days: period.days },
        `Approved spend in any rolling ${period.days}-day window must stay ≤ ${money(period.cap)} (only final approvals count; pending questions don't).`,
        'Rolling limit'
      );
    }
  }

  // ---- Quantity / single item -------------------------------------------------
  let singleItem = false;
  const singleMatch = t.match(/\b(?:buy|order|purchase|get)\s+(?:one|a single|\b1\b)\s+/i) || t.match(/\b(?:buy|order)\s+the\b/i);
  if (singleMatch) {
    singleItem = true;
    addRule(
      { field: 'basket.line_count', operator: '<=', value: 1 },
      'Exactly one item may be purchased (no multi-line baskets).',
      'Single item'
    );
  }

  // ---- Category / purpose ------------------------------------------------------
  // Purpose statements: "Order our household groceries", "buy clothing for me"
  const cats = new Set();
  for (const [word, cat] of Object.entries(CATEGORY_WORDS)) {
    const re = new RegExp(`\\b${word}s?\\b`, 'i');
    if (re.test(t)) { cats.add(cat); break; }
  }
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
    || /\busual (?:shop|store|seller)\b/i.test(t)) {
    addRule(
      { field: 'merchant.familiar_to_customer', operator: '=', value: 'true' },
      'Only merchants you have actually bought from before (at least one approved purchase in your history).',
      'Familiar merchant'
    );
  }

  const specialist = t.match(/\bspecialist\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:retailer|seller|store|shop)\b/i)
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
  const ret = t.match(/\breturned?\s+within\s+([0-9]+)\s+days?\s+or more\b/i)
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
  if (/\bdo not add anything\b|\bnothing I did not ask for\b|\bno add-?ons\b|\bno extras?\b/i.test(t)) {
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
  if (/\bpause anything\b|\bsomeone other than me\b|\bdriving the session\b|\bdoesn.t look like me\b|\bnot like me\b/i.test(t)) {
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
  const sentences = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const covered = [
    /CHF|EUR|GBP|USD|\bper order\b|\bdays?\b/i, /grocer|clothing|clothes|monitor|shoes|jacket|coat/i,
    /shop|store|seller|retailer|merchant/i, /return/i, /ask|decline|approve|uncertain|doubt/i,
    /add|extra/i, /deliver/i, /pause|session|someone/i, /\bone\b|\bsingle\b/i,
  ];
  for (const s of sentences) {
    if (!covered.some(re => re.test(s))) {
      openQuestions.push(`We could not translate: “${s}” — tell us what you meant, or confirm without it.`);
    }
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
