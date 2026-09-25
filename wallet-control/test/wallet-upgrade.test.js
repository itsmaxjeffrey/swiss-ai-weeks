import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { calendarKey,controlChecks,validateControls } from '../lib/wallet-controls.js';
import { WalletProof,DeviceAccess } from '../lib/wallet-proof.js';
import { Store } from '../lib/store.js';
import { trialPurchase,replayPurchases } from '../lib/wallet-lab.js';
import { HistoryProfiles } from '../lib/history.js';
import { buildTrustIndex } from '../lib/signals.js';
import { Worker } from '../lib/worker.js';

const event=()=>({authorization:{authorization_id:'a',timestamp:'2026-03-31T22:30:00Z',billing_amount_chf:30,amount:30,currency:'CHF',items_subtotal:30,delivery_fee:0,merchant:{merchant_id:'shop',merchant_name:'Shop',merchant_country:'CH'},items:[{item_id:'i',item_name:'Book',item_category:'books',quantity:1,unit_price:30,currency:'CHF'}]},mandate:{mandate_id:'m',status:'active',customer_id:'c',hard_rules:[],uncertainty_policy:'ask'},context:{}});
const trust=buildTrustIndex({malicious_domains:{},malicious_ips:{},legit_companies:[]});
test('Zurich month, Monday week and DST boundaries use local calendar',()=>{
 assert.equal(calendarKey('2026-03-31T22:30:00Z','month'),'2026-04');
 assert.equal(calendarKey('2026-03-29T22:30:00Z','week'),'2026-03-30');
 assert.equal(calendarKey('2026-03-29T00:30:00Z','day'),'2026-03-29');
 assert.equal(calendarKey('2026-03-29T01:30:00Z','day'),'2026-03-29');
});
test('calendar caps count other runs and later accepted purchases',()=>{
 const e=event(),spends=[{authorization_id:'b',amount:80,simTs:Date.parse('2026-04-01T12:00:00Z'),mandate_id:'other',run_id:'other'}];
 assert.ok(controlChecks(e,{month_cap:100},spends).issues.some(i=>i.code==='CONTROL_LIMIT'));
 assert.equal(controlChecks(e,{month_cap:110},spends).issues.length,0);
});
test('late approval must fit rolling windows ending after it',()=>{
 const e=event();e.mandate.hard_rules=[{field:'period.approved_spend_chf',scope:'period',period_days:7,operator:'<=',value:100}];
 assert.ok(controlChecks(e,{},[{authorization_id:'b',amount:80,simTs:Date.parse('2026-04-03T00:00:00Z'),mandate_id:'m'}]).issues.some(i=>i.code==='PERIOD_LIMIT_EXCEEDED'));
});
test('omitted evidence produces uncertainty and malformed basket fails closed',()=>{
 const e=event();const r=controlChecks(e,{returnable:true,delivery_days:3,sizes:['M']});
 assert.equal(r.issues.length,3);assert.ok(r.issues.every(i=>i.uncertain));
 e.authorization.items[0].quantity=0;
 assert.ok(controlChecks(e,{}).issues.some(i=>i.code==='INVALID_BASKET'));
 assert.throws(()=>validateControls({daily_orders:1.2}));
});
test('control versions reject races and corrupted durable state never opens empty',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wallet-check-'));
 try {const p=path.join(dir,'state.json'),s=new Store(p);s.updateControls({day_cap:100},0);assert.throws(()=>s.updateControls({day_cap:200},0));assert.equal(new Store(p).controls.day_cap,100);fs.writeFileSync(p,'{broken');assert.throws(()=>new Store(p));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('policy proofs reject changed payload and wrong signing authority',()=>{
 const a=fs.mkdtempSync(path.join(os.tmpdir(),'wallet-proof-')),b=fs.mkdtempSync(path.join(os.tmpdir(),'wallet-proof-'));
 try {const p=new WalletProof(a),q=new WalletProof(b),receipt=p.sign('policy',{cap:100});assert.equal(p.verify(receipt),true);assert.equal(q.verify(receipt),false);receipt.document.payload.cap=101;assert.equal(p.verify(receipt),false);}finally{fs.rmSync(a,{recursive:true,force:true});fs.rmSync(b,{recursive:true,force:true});}
});
test('device request signatures bind body and cannot be replayed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wallet-device-'));
 try {const access=new DeviceAccess(dir),pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),device=access.request({public_key:pair.publicKey.export({format:'jwk'}),name:'Test browser'});access.setStatus(device.id,'active');
 const raw='{"paused":true}',ts=String(Date.now()),nonce=crypto.randomUUID(),req={method:'POST',url:'/api/controls',headers:{'x-wallet-device':device.id,'x-wallet-time':ts,'x-wallet-nonce':nonce}};
 const message=[req.method,req.url,ts,nonce,crypto.createHash('sha256').update(raw).digest('hex')].join('\n');req.headers['x-wallet-signature']=crypto.sign('sha256',Buffer.from(message),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 assert.throws(()=>access.verify(req,'{}'));assert.equal(access.verify(req,raw),device.id);assert.throws(()=>access.verify(req,raw));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('purchase preview and policy replay leave supplied inputs unchanged',()=>{
 const e=event(),m=e.mandate,controls={purchase_cap:50},records=[{event:e,decision:'decline'}],before=JSON.stringify({m,controls,records});
 const preview=trialPurchase({price:30,quantity:1,item:'Book'},m,controls,trust);assert.equal(preview.payment_performed,false);
 const replay=replayPurchases(records,m,controls,new HistoryProfiles([]),trust);assert.equal(replay.payment_performed,false);assert.equal(replay.count,1);assert.equal(JSON.stringify({m,controls,records}),before);
});
test('expired approvals never reach payment platform',async()=>{
 const e=event(),s=new Store();s.putMandate(e.mandate);s.createRun({run_id:'r',mandate_id:'m',mandateSnapshot:e.mandate,totalEvents:1});
 s.acceptDecision('r','a',{decision:'step_up',amount:30,simTs:Date.parse(e.authorization.timestamp)},e,{},Date.now()-1);
 let called=false;const w=new Worker({store:s,client:{resolve:async()=>{called=true;}},profiles:new HistoryProfiles([]),trust});
 await assert.rejects(w.resolveStepUp('r','a','approve'),/expired/);assert.equal(called,false);assert.equal(s.ledger().length,0);
});
test('simultaneous conflicting resolutions produce one platform call',async()=>{
 const e=event(),s=new Store();s.putMandate(e.mandate);s.createRun({run_id:'r',mandate_id:'m',mandateSnapshot:e.mandate,totalEvents:1});
 s.acceptDecision('r','a',{decision:'step_up',amount:30,simTs:Date.parse(e.authorization.timestamp)},e,{},Date.now()+60000);
 let calls=0;const w=new Worker({store:s,client:{resolve:async()=>{calls++;}},profiles:new HistoryProfiles([]),trust});
 const results=await Promise.allSettled([w.resolveStepUp('r','a','decline'),w.resolveStepUp('r','a','approve')]);
 assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(s.ledger().length,0);
});
