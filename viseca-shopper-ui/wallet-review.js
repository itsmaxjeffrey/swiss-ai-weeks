// Real signing-path review. Local authenticated service; no customer credentials forwarded.
const http = require('node:http');
const crypto = require('node:crypto');
function buildReview(policy, controls, messages = []) {
  const text = (value, limit = 2000) => String(value || '').slice(0, limit);
  const domains = value => Array.isArray(value) ? value.slice(0, 50).map(v => text(v, 200)) : [];
  const amount = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const price = p => ({ amount: amount(p?.amount), currency: text(p?.currency, 3) });
  return {
    source: 'shopper_policy_sign',
    customer_messages: messages.slice(-4).map(m => text(m)),
    proposed_request: text(policy.request),
    permissions: {
      items: (Array.isArray(policy.items) ? policy.items : []).slice(0, 30).map(i => ({ product: text(i.product, 300), quantity: amount(i.quantity), max_unit_price: price(i.max_unit_price) })),
      budget: { max_total: amount(policy.budget?.max_total), currency: text(policy.budget?.currency, 3) },
      timing: { order_by: text(policy.timing?.order_by, 60), deliver_by: text(policy.timing?.deliver_by, 60), search_until: text(policy.timing?.search_until, 60) },
      merchant: { allowed_domains: domains(policy.merchant?.allowed_domains), blocked_domains: domains(policy.merchant?.blocked_domains), require_impressum: policy.merchant?.require_impressum === true },
      stop_rules: (Array.isArray(policy.stop_rules) ? policy.stop_rules : []).slice(0, 20).map(v => text(v, 300)),
    },
    account_controls: { spend_cap_chf: amount(controls.cap), whitelist: domains(controls.whitelist) },
  };
}
function reviewPolicy(payload, { token, port = 8790, timeoutMs = 2000 } = {}) {
  if (!token) return Promise.resolve({ status: 'not_connected', review_required: false });
  return new Promise(resolve => {
    let done = false;
    const finish = result => { if (!done) { done = true; resolve(result); } };
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/internal/shopper/policy-review', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 64000) { req.destroy(); finish({status:'invalid_response',review_required:false}); } });
      res.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (res.statusCode !== 200 || typeof value.status !== 'string' || typeof value.review_required !== 'boolean') throw Error();
          finish(value);
        } catch { finish({ status:'unavailable',review_required:false }); }
      });
    });
    req.setTimeout(timeoutMs,()=>{req.destroy();finish({status:'timeout',review_required:false});});
    req.on('error',()=>finish({status:'unavailable',review_required:false}));
    req.end(JSON.stringify(payload));
  });
}
function digest(payload) { return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
module.exports = { buildReview, reviewPolicy, digest };
