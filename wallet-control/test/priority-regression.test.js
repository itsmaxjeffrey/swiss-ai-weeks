import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Worker } from '../lib/worker.js';
import { HistoryProfiles } from '../lib/history.js';
import { evaluate } from '../lib/engine.js';
import { compilePolicy } from '../lib/policy-compiler.js';

const known = new HistoryProfiles([{ customer_id: 'C', merchant_id: 'M', merchant_name: 'Shop', customer_device_id: 'DEV', timestamp: '2026-08-01T10:00:00Z', status: 'approved' }]);
function event() { return { authorization: { authorization_id: 'A', timestamp: '2026-08-10T10:00:00Z', billing_amount_chf: 10, amount: 10, items_subtotal: 10, delivery_fee: 0, currency: 'CHF', customer_device_id: 'DEV', recent_attempt_count_10m: 0, merchant: { merchant_id: 'M', merchant_name: 'Shop', merchant_category: 'groceries', merchant_country: 'CH' }, items: [{ item_id: 'I', item_name: 'Apples', item_category: 'groceries', quantity: 1, unit_price: 10, currency: 'CHF', item_details: 'Fresh apples' }] }, mandate: { customer_id: 'C', status: 'active', instruction: 'test', hard_rules: [], uncertainty_policy: 'ask' }, context: { approved_spend_in_period_chf: 0 }, deadline_at: new Date(Date.now()+8000).toISOString() }; }
function engine(e, profiles = known, extras = {}) { const store = new Store(); return evaluate(e, store.runState(store.createRun({run_id:'R'})), profiles, null, extras); }
async function runWorker({ e = event(), failFirst = false, repeat = false, trustedShops = null, jev = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-regression-'));
  const file = path.join(dir, 'state.json');
  const store = new Store(file); const run = store.createRun({ run_id: 'R', totalEvents: 1 });
  let polls = 0, submissions = 0; let worker;
  const client = { async nextRequest() { if (++polls <= (repeat ? 2 : 1)) return { envelope: { data: e } }; worker.stopRun('R'); return null; },
    async submitDecision() { if (++submissions === 1 && failFirst) throw Error('test network interruption'); return {}; }, async resolve() { return {}; } };
  worker = new Worker({ client, store, profiles: known, trust: null, trustedShops, jev, log: {error() {}} });
  await worker.startRun('R');
  for (let n=0;n<500 && worker.activeRuns.size;n++) await new Promise(r=>setTimeout(r,10));
  assert.equal(worker.activeRuns.size, 0, 'worker must finish');
  const result = {store,run,worker,submissions,file,dir}; return result;
}
for (const retry of [false,true]) test(`approval persists spend, normalized state and dedupe (retry=${retry})`, async t => {
  const r = await runWorker({failFirst:retry, repeat:true}); t.after(()=>fs.rmSync(r.dir,{recursive:true,force:true}));
  assert.equal(r.store.getDecision('R','A').finalDecision,'approved');
  assert.equal(r.run.spend.length,1);
  const restored = new Store(r.file); const run = restored.getRun('R');
  assert.equal(run.spend.length,1);
  assert.equal(restored.runState(run).approvedSpendInWindow(7,Date.parse(event().authorization.timestamp)),10);
  assert.equal(r.worker.feed.filter(e=>e.kind==='decision').length,1);
});
test('successful retry opens persistent human inbox and resolution counts once', async t=>{
  const e=event();e.mandate.hard_rules=[{field:'policy.requires_review',operator:'=',value:'true'}];
  const r=await runWorker({e,failFirst:true,repeat:true}); t.after(()=>fs.rmSync(r.dir,{recursive:true,force:true}));
  assert.equal(r.run.stepUps.size,1);assert.equal(r.run.spend.length,0);
  const restored=new Store(r.file);assert.equal(restored.getRun('R').stepUps.size,1);
  await r.worker.resolveStepUp('R','A','approve','Customer reviewed');
  assert.equal(r.run.spend.length,1); assert.equal(r.run.stepUps.size,0);
  r.store.recordStepUpResolution('R','A','approved','repeated');
  assert.equal(r.run.spend.length,1);assert.equal(new Store(r.file).getRun('R').spend.length,1);
});
test('one-item policy declines two units on one line',()=>{
  const e=event();e.mandate={...e.mandate,...compilePolicy('Buy one ordinary grocery item for CHF 20 or less from a shop I use regularly. Ask me when uncertain.')};
  e.authorization.items[0].quantity=2;e.authorization.items[0].unit_price=5;
  const out=engine(e);assert.equal(out.decision,'decline');assert.ok(out.reason_codes.includes('QUANTITY_EXCEEDED'));
});
test('invalid quantities are uncertainty rather than permission',()=>{
  const e=event();e.mandate.hard_rules=[{field:'basket.total_quantity',operator:'<=',value:1}];delete e.authorization.items[0].quantity;
  assert.ok(engine(e).reason_codes.includes('QUANTITY_UNKNOWN'));
});
test('EUR 200 cap declines CHF 195 (EUR 205.26)',()=>{
  const e=event();e.mandate={...e.mandate,...compilePolicy('Buy groceries for EUR 200 or less.')};
  e.authorization.amount=195;e.authorization.billing_amount_chf=195;e.authorization.items_subtotal=195;e.authorization.items[0].unit_price=195;
  assert.ok(engine(e).reason_codes.includes('LIMIT_EXCEEDED'));
});
test('unresolved requirement cannot be auto-approved by approve-uncertainty setting',()=>{
  const e=event();e.mandate.hard_rules=[{field:'policy.requires_review',operator:'=',value:'true'}];e.mandate.uncertainty_policy='approve';
  assert.equal(engine(e).decision,'step_up');
});
test('unknown customer is not falsely labelled device novelty or unusual hour',()=>{
  const e=event();e.authorization.timestamp='2026-08-10T02:00:00Z';
  const out=engine(e,new HistoryProfiles([]));
  assert.ok(!out.reason_codes.includes('DEVICE_NOVELTY'));assert.ok(!out.reason_codes.includes('UNUSUAL_HOUR'));
});
test('unknown history cannot satisfy familiar-merchant restriction',()=>{
  const e=event();e.mandate.hard_rules=[{field:'merchant.familiar_to_customer',operator:'=',value:'true'}];
  const out=engine(e,new HistoryProfiles([]));assert.equal(out.decision,'step_up');assert.ok(out.reason_codes.includes('MERCHANT_HISTORY_UNAVAILABLE'));assert.ok(!out.reason_codes.includes('MERCHANT_UNFAMILIAR'));
});
test('known customer on genuinely unseen device still steps up',()=>{
  const e=event();e.authorization.customer_device_id='UNSEEN';assert.ok(engine(e).reason_codes.includes('DEVICE_NOVELTY'));
});
test('unknown device baseline with integrity mandate still asks',()=>{
  const e=event();e.mandate.hard_rules=[{field:'session.integrity_monitoring',operator:'=',value:'true'}];
  assert.ok(engine(e,new HistoryProfiles([])).reason_codes.includes('DEVICE_HISTORY_UNAVAILABLE'));
});
test('nightly cap uses explicit nightly prices, never order total',()=>{
  const e=event();e.mandate.hard_rules=[{field:'booking.nightly_amount_chf',operator:'<=',value:200}];e.authorization.items[0].item_details='Hotel CHF 150 per night';
  assert.equal(engine(e).decision,'approve');
  e.authorization.items[0].item_details='Hotel CHF 250 per night';assert.equal(engine(e).decision,'decline');
  e.authorization.items[0].item_details='Hotel three nights, total CHF 450';assert.ok(engine(e).reason_codes.includes('NIGHTLY_PRICE_UNKNOWN'));
});
test('failing optional merchant checker cannot crash or block decision',async t=>{
  const e=event();e.authorization.merchant.merchant_url='https://shop.example';
  const r=await runWorker({e,trustedShops:{async checkOne(){throw Error('optional unavailable')}}});t.after(()=>fs.rmSync(r.dir,{recursive:true,force:true}));
  assert.ok(r.store.getDecision('R','A')?.submitted);
});
test('near-deadline requests skip optional enrichment and still submit',async t=>{
  const e=event();e.deadline_at=new Date(Date.now()+800).toISOString();e.authorization.merchant.merchant_url='https://shop.example';let called=false;
  const r=await runWorker({e,trustedShops:{async checkOne(){called=true;return null}}});t.after(()=>fs.rmSync(r.dir,{recursive:true,force:true}));
  assert.equal(called,false);assert.ok(r.store.getDecision('R','A')?.submitted);
});

test('restart restores simulator pending requests and accepts the real customer answer', async t=>{
  const {LocalApi}=await import('../sim/local-api.js');const {offlinePackPath}=await import('../lib/pack-path.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leash-inbox-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');const store=new Store(file);const client=new LocalApi(offlinePackPath(),store);
  const draft=client.createMandate({instruction:'Review every purchase.',hard_rules:[{field:'policy.requires_review',operator:'=',value:'true'}],uncertainty_policy:'ask'});
  const mandate=client.confirmMandate(draft.draft_id,{confirmed:true});const started=client.startRun({scenario_id:'SCEN0000',mandate_id:mandate.mandate_id});
  const worker=new Worker({client,store,profiles:new HistoryProfiles([]),trust:null});await worker.startRun(started.run_id);
  for(let n=0;n<100&&worker.activeRuns.size;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(store.getRun(started.run_id).status,'awaiting_customers');
  const restored=new Store(file);const restoredClient=new LocalApi(offlinePackPath(),restored);
  const restoredWorker=new Worker({client:restoredClient,store:restored,profiles:new HistoryProfiles([]),trust:null});
  const auth=[...restored.getRun(started.run_id).stepUps.keys()][0];assert.ok(auth);
  await restoredWorker.resolveStepUp(started.run_id,auth,'approve','Customer confirms after restart');
  assert.equal(restored.getRun(started.run_id).spend.length,1);assert.equal(restored.getRun(started.run_id).status,'completed');
});


test('currency conversion follows decimal half-even rounding at both tie directions', async()=>{
  const {toChf}=await import('../lib/util.js');
  assert.equal(toChf(20.50, 'EUR'),19.48);
  assert.equal(toChf(20.30, 'EUR'),19.28);
  assert.equal(toChf(-20.30, 'EUR'),-19.28);
  assert.equal(compilePolicy('Buy groceries for EUR 20.30 or less.').hard_rules.find(r=>r.field==='authorization.billing_amount_chf').value,19.28);
});
