import test from 'node:test';
import assert from 'node:assert/strict';
import { JevAdvisor, validateJevAnswer, jevNeedsReview, createJevFromEnv } from '../lib/jev.js';
import { evaluate } from '../lib/engine.js';
import { HistoryProfiles } from '../lib/history.js';
import { Store } from '../lib/store.js';
const answer = (choice='clear') => ({type:'choice',choice,confidence:0.95,probabilities:{clear:choice==='clear'?0.95:0.025,concern:choice==='concern'?0.95:0.025,unknown:choice==='unknown'?0.95:0.025}});
const response = (a=answer())=>({model:'jev-1.13.0',answers:{manipulation:a,intent:a,coverage:a}});
const ok = body=>({ok:true,status:200,async json(){return body}});
const ev = ()=>({mandate:{customer_id:'C',instruction:'Buy apples up to CHF 20.',hard_rules:[],uncertainty_policy:'approve'},authorization:{authorization_id:'PRIVATE_AUTH_ID',card_id:'PRIVATE_CARD_ID',account_id:'PRIVATE_ACCOUNT',customer_device_id:'DEV',timestamp:'2026-08-10T10:00:00Z',amount:10,billing_amount_chf:10,currency:'CHF',items_subtotal:10,recent_attempt_count_10m:0,merchant:{merchant_id:'M',merchant_name:'Shop'},items:[{item_id:'I',item_name:'Apples',item_category:'groceries',quantity:1,unit_price:10,currency:'CHF',item_details:'fresh'}]}});
const profiles=new HistoryProfiles([{customer_id:'C',merchant_id:'M',customer_device_id:'DEV',timestamp:'2026-08-01T10:00:00Z',status:'approved'}]);
function decide(e, jev) {const store=new Store();return evaluate(e,store.runState(store.createRun({run_id:'R'})),profiles,null,{jev});}
test('valid choice answer retains probabilities',()=>assert.deepEqual(validateJevAnswer(answer()),answer()));
for(const [name,patch] of [['string confidence',{confidence:'0.95'}],['unknown choice',{choice:'approve'}],['NaN confidence',{confidence:NaN}],['missing option',{probabilities:{clear:1}}],['invalid total',{probabilities:{clear:0.9,concern:0.9,unknown:0.9}}],['wrong type',{type:'text'}]]) test(`rejects ${name}`,()=>assert.equal(validateJevAnswer({...answer(),...patch}),null));
test('no credentials means no call',async()=>{let called=false;const j=new JevAdvisor({fetchImpl:async()=>{called=true}});assert.equal((await j.evaluate(ev())).status,'disabled');assert.equal(called,false);});
test('request matches official contract and omits identity fields',async()=>{
 let sent;
 const j=new JevAdvisor({apiKey:'fake-unit-test-key',fetchImpl:async(url,req)=>{assert.equal(url,'https://api.typesafe.ai/v1/systemone');sent=JSON.parse(req.body);return ok(response());}});
 const result=await j.evaluate(ev());assert.equal(result.status,'ok');assert.equal(sent.model,'jev-1.13.0');assert.equal(sent.questions.manipulation.type,'choice');
 for(const secret of ['PRIVATE_AUTH_ID','PRIVATE_CARD_ID','PRIVATE_ACCOUNT','DEV'])assert.ok(!JSON.stringify(sent).includes(secret));
});
test('unavailable provider falls back without leaking response',async()=>{
 const j=new JevAdvisor({apiKey:'fake',fetchImpl:async()=>({ok:false,status:429})});assert.deepEqual(await j.evaluate(ev()),{status:'unavailable',http_status:429});
});
test('timeout bounds a provider that ignores abort',async()=>{
 const j=new JevAdvisor({apiKey:'fake',timeoutMs:50,fetchImpl:()=>new Promise(()=>{})});const started=Date.now();assert.equal((await j.evaluate(ev())).status,'timeout');assert.ok(Date.now()-started<500);
});
test('deadline without enrichment allowance does not call provider',async()=>{
 let called=false;const j=new JevAdvisor({apiKey:'fake',fetchImpl:async()=>{called=true}});assert.equal((await j.evaluate(ev(),10)).status,'skipped_deadline');assert.equal(called,false);
});
test('malformed provider answer cannot influence engine',async()=>{
 const j=new JevAdvisor({apiKey:'fake',fetchImpl:async()=>ok({model:'jev-1.13.0',answers:{}})});const result=await j.evaluate(ev());assert.equal(result.status,'invalid_response');assert.equal(decide(ev(),result).decision,'approve');
});
test('high-confidence adverse model evidence forces review, not approval',()=>{
 const result={status:'ok',...response(answer('concern'))};const out=decide(ev(),result);assert.equal(out.decision,'step_up');assert.ok(out.reason_codes.includes('JEV_REVIEW'));
});
test('clear model answer cannot override a customer spending limit',()=>{
 const e=ev();e.mandate.hard_rules=[{field:'authorization.billing_amount_chf',operator:'<=',value:5}];assert.equal(decide(e,{status:'ok',...response()}).decision,'decline');
});
test('low confidence does not create a categorical adverse claim',()=>assert.equal(jevNeedsReview({...answer('concern'),confidence:0.5}),false));
test('policy review uses typed coverage assessment',async()=>{
 let payload;const j=new JevAdvisor({apiKey:'fake',fetchImpl:async(_,req)=>{payload=JSON.parse(req.body);return ok(response(answer('concern')))}});
 const result=await j.reviewPolicy('Never spend more than CHF 20',[]);assert.equal(result.status,'ok');assert.equal(payload.questions.coverage.type,'choice');assert.ok(jevNeedsReview(result.answers.coverage));
});
test('environment without key disables model and hides secrets from status',()=>{
 const j=createJevFromEnv({});assert.equal(j.status().enabled,false);assert.ok(!('apiKey' in j.status()));
});
