import crypto from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => crypto.createHash('sha256').update(canonical(value) ?? 'null').digest('hex');
// Transport deadlines may change on redelivery; purchase and policy facts may not.
export const purchaseDigest = event => digest({ authorization: event.authorization, mandate: event.mandate });
export function fail(message, status = 409) { return Object.assign(new Error(message), { status }); }

export function validateControls(input = {}) {
  const allowed = ['paused','purchase_cap','day_cap','week_cap','month_cap','daily_orders','countries','cities','weekdays','returnable','cancellable','delivery_days','item_ids','max_quantity','sizes','one_purchase'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw fail('Unknown control', 400);
  const out = {};
  for (const [k,v] of Object.entries(input)) {
    if (['paused','returnable','cancellable','one_purchase'].includes(k)) {
      if (typeof v !== 'boolean') throw fail(`${k} must be true or false`,400);
    } else if (['countries','cities','weekdays','item_ids','sizes'].includes(k)) {
      if (!Array.isArray(v) || v.length > 50 || v.some(x => typeof x !== 'string' || x.length > 100 || !x.trim())) throw fail(`Invalid ${k}`,400);
      if (k === 'countries' && v.some(x => !/^[A-Z]{2}$/.test(x))) throw fail('Countries use two uppercase letters, such as CH',400);
      if (k === 'weekdays' && v.some(x => !['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].includes(x))) throw fail('Invalid weekday',400);
    } else if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1e8 || (['daily_orders','delivery_days','max_quantity'].includes(k) && !Number.isInteger(v)))) throw fail(`Invalid ${k}`,400);
    out[k] = v;
  }
  return out;
}

export function calendarKey(ts, unit) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(new Date(ts)).map(p=>[p.type,p.value]));
  if (unit === 'weekday') return parts.weekday;
  if (unit === 'month') return `${parts.year}-${parts.month}`;
  if (unit === 'week') {
    const d = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay()+6)%7);
    return d.toISOString().slice(0,10);
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function controlChecks(event, controls = {}, spends = [], { run, currentMandate, historical = false } = {}) {
  const a = event?.authorization || {}, issues = [], checks = [];
  const add = (code, detail, uncertain = false) => issues.push({code,detail,uncertain});
  const compare = (key, actual, max, detail) => {
    if (max == null) return;
    if (!Number.isFinite(actual)) add('CONTROL_EVIDENCE_MISSING',`${detail}: evidence is missing`,true);
    else { checks.push({control:key,actual,limit:max}); if (actual > max) add('CONTROL_LIMIT',`${detail}: ${actual} exceeds ${max}`); }
  };
  if (!a.authorization_id || !Number.isFinite(a.billing_amount_chf) || a.billing_amount_chf < 0 || !Number.isFinite(Date.parse(a.timestamp)) || !Array.isArray(a.items)) {
    add('INVALID_PURCHASE','Purchase identity, timestamp, amount or basket is invalid');
    return {issues,checks};
  }
  if (!historical && (!a.items.length || a.items.length > 100 || a.items.some(i => !Number.isInteger(i.quantity) || i.quantity < 1 || !Number.isFinite(i.unit_price) || i.unit_price < 0))) add('INVALID_BASKET','Every basket line needs a positive quantity and a readable price');
  if (controls.paused) add('WALLET_PAUSED','Your wallet is paused');
  if (currentMandate && currentMandate.status !== 'active') add('MANDATE_INACTIVE','This policy is no longer active');
  if (run && event.mandate?.mandate_id && event.mandate.mandate_id !== run.mandate_id) add('AUTHORITY_MISMATCH','Purchase belongs to a different policy');
  if (run?.customerIds?.length && !run.customerIds.includes(event.mandate?.customer_id)) add('AUTHORITY_MISMATCH','Purchase belongs to a different customer');
  const ts = Date.parse(a.timestamp), amount = a.billing_amount_chf;
  const ledger = spends.filter(s => s.authorization_id !== a.authorization_id);
  compare('purchase_cap',amount,controls.purchase_cap,'Per-purchase CHF limit');
  for (const unit of ['day','week','month']) {
    if (controls[unit+'_cap'] == null && !(unit === 'day' && controls.daily_orders != null)) continue;
    const key = calendarKey(ts,unit), bucket = ledger.filter(s => Number.isFinite(s.simTs) && calendarKey(s.simTs,unit) === key);
    compare(unit+'_cap',Math.round((bucket.reduce((sum,s)=>sum+s.amount,0)+amount)*100)/100,controls[unit+'_cap'],`${unit} CHF limit (Zurich calendar)`);
    if (unit === 'day') compare('daily_orders',bucket.length+1,controls.daily_orders,'Orders per day');
  }
  const membership = (key, actual, label) => {
    if (!controls[key]?.length) return;
    if (actual == null || actual === '') add('CONTROL_EVIDENCE_MISSING',`${label} is not supplied`,true);
    else if (!controls[key].map(x=>x.toLowerCase()).includes(String(actual).toLowerCase())) add('CONTROL_RESTRICTION',`${label} ${actual} is outside your permission`);
  };
  membership('countries',a.merchant?.country || a.merchant?.merchant_country,'Merchant country');
  membership('cities',a.merchant?.city || a.merchant?.merchant_city,'Merchant city');
  membership('weekdays',calendarKey(ts,'weekday'),'Purchase weekday');
  for (const item of a.items) {
    membership('item_ids',item.item_id,'Item');
    membership('sizes',item.size,'Size');
    for (const key of ['returnable','cancellable']) if (controls[key]) {
      const stated=item[key] ?? a['order_'+key];
      if (stated === false || stated === 'false') add('CONTROL_RESTRICTION',`${item.item_name || 'Item'} must be ${key}`);
      else if (stated !== true && stated !== 'true') add('CONTROL_EVIDENCE_MISSING',`${item.item_name || 'Item'}: ${key} terms are not supplied`,true);
    }
    compare('delivery_days',item.delivery_days,controls.delivery_days,'Delivery days');
  }
  compare('max_quantity',a.items.length ? a.items.reduce((sum,i)=>sum+i.quantity,0) : NaN,controls.max_quantity,'Units per purchase');
  if (controls.one_purchase && ledger.some(s => s.mandate_id === event.mandate?.mandate_id)) add('ERRAND_COMPLETE','This policy has already fulfilled its one-purchase permission');
  // A late approval must fit every rolling window containing its timestamp,
  // including windows ending at purchases accepted after the paused request.
  for (const r of event.mandate?.hard_rules || []) if (r.field === 'period.approved_spend_chf' && r.scope === 'period') {
    const days = Number(r.period_days || 7), endPoints = [ts,...ledger.filter(s=>s.simTs>=ts && s.simTs<ts+days*86400000).map(s=>s.simTs)];
    for (const end of endPoints) {
      const total = ledger.filter(s=>s.mandate_id===event.mandate?.mandate_id && s.simTs>end-days*86400000 && s.simTs<=end).reduce((sum,s)=>sum+s.amount,amount);
      if (r.operator === '<' ? total >= Number(r.value) : total > Number(r.value)) { add('PERIOD_LIMIT_EXCEEDED','This approval would exceed a rolling spending window containing the purchase'); break; }
    }
  }
  return {issues,checks};
}

export function enforceControls(result, report) {
  const hard = report.issues.filter(i=>!i.uncertain), uncertain = report.issues.filter(i=>i.uncertain);
  const decision = hard.length ? 'decline' : uncertain.length && result.decision === 'approve' ? 'step_up' : result.decision;
  return {...result,decision,hard_failures:[...(result.hard_failures || []),...hard],
    reason_codes:[...new Set([...result.reason_codes,...report.issues.map(i=>i.code)])],
    uncertainties:[...result.uncertainties,...uncertain], control_checks:report.checks,
    customer_message: report.issues.length ? `${decision === 'decline' ? 'Declined' : 'Review needed'}: ${report.issues.map(i=>i.detail).join('. ')}. ${result.customer_message.replace(/^(Approved|Declined|Paused for your review)[^—]*—\s*/,'')}` : result.customer_message,
    next_steps: [...new Set([...report.issues,...(result.hard_failures||[]),...(result.uncertainties||[]).map(i=>({...i,uncertain:true}))].map(i => i.uncertain ? `Supply evidence: ${i.detail}` : ['CONTROL_LIMIT','LIMIT_EXCEEDED','PERIOD_LIMIT_EXCEEDED'].includes(i.code) ? 'Reduce the purchase or wait for the applicable spending period to reset.' : i.code === 'ERRAND_COMPLETE' ? 'Create and confirm a new permission for another purchase.' : 'Change the purchase to meet the confirmed permission.'))],
  };
}
