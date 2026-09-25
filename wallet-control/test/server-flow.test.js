import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlinePackPath, coherentReplayPack } from '../lib/pack-path.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Prevent OpenClaw's outbound proxy intercepting local test traffic.
delete process.env.NODE_USE_ENV_PROXY;
process.env.NO_PROXY='127.0.0.1,localhost';

test('offline pack contains matching scenarios and fixtures',()=>assert.ok(coherentReplayPack(offlinePackPath())));
test('customer HTTP flow: ordinary approval, human approve/reject, revocation', {timeout:15000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leash-http-test-'));
 const env={...process.env,PORT:'0',LEASH_MODE:'offline',LEASH_DEVICE_AUTH:'off',LEASH_STATE_FILE:path.join(dir,'state.json'),LEASH_PREFS_FILE:path.join(dir,'prefs.json'),LEASH_JEV_USAGE_FILE:path.join(dir,'usage.json'),SHOPPER_BRIDGE_SYNC_TOKEN:'test-sync-token',TYPESAFE_API_KEY:'',TYPESAFE_API_KEY_FILE:'',SHOPPER_BRIDGE_URL:''};
 delete env.PACK_DIR;delete env.NODE_USE_ENV_PROXY;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}fs.rmSync(dir,{recursive:true,force:true});});
 let output='';child.stderr.on('data',b=>{output+=b.toString()});
 const base=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Server did not start: '+output)),5000);
   child.stdout.on('data',b=>{output+=b.toString();const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});
   child.on('exit',()=>{clearTimeout(timer);reject(Error('Server exited before ready: '+output))});
 });
 async function api(url,method='GET',body){const res=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();return {status:res.status,data};}
 async function waitState(predicate){for(let i=0;i<100;i++){const {data}=await api('/api/state');if(predicate(data))return data;await new Promise(r=>setTimeout(r,20));}throw Error('State condition not reached');}
 const reviewPayload={source:'shopper_policy_sign',customer_messages:['Buy apples for CHF 20'],proposed_request:'Buy apples',permissions:{items:[{product:'apples',quantity:1}],budget:{max_total:20,currency:'CHF'}},account_controls:{spend_cap_chf:25,whitelist:[]}};
 assert.equal((await api('/api/internal/shopper/policy-review','POST',reviewPayload)).status,401);
 const reviewed=await fetch(base+'/api/internal/shopper/policy-review',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-sync-token'},body:JSON.stringify(reviewPayload)});
 assert.equal(reviewed.status,200);assert.equal((await reviewed.json()).status,'disabled');
 const audit=JSON.parse(fs.readFileSync(path.join(dir,'usage.json'),'utf8'));
 assert.equal(audit.attempts,1);assert.equal(audit.successful,0);assert.equal(audit.last.source,'shopper_policy_sign');assert.ok(!JSON.stringify(audit).includes('apples'));
 const initial=(await api('/api/state')).data;assert.equal(initial.jev.enabled,false);assert.equal(initial.scenarios.length,5);
 const scenario=initial.scenarios.find(s=>s.scenario_id==='SCEN0000');assert.ok(scenario);
 async function start(instruction){const draft=(await api('/api/policy/compile','POST',{instruction})).data;const created=(await api('/api/mandates','POST',draft)).data;assert.ok(created.draft_id);const confirmed=await api(`/api/mandates/${created.draft_id}/confirm`,'POST',{confirmed:true});assert.equal(confirmed.status,200);const run=await api('/api/runs','POST',{scenario_id:scenario.scenario_id});assert.equal(run.status,200);return confirmed.data.mandate_id;}
 await start(scenario.instruction);
 const ordinary=await waitState(s=>s.run?.decided===1);assert.equal(ordinary.run.approved,1);assert.equal(ordinary.pending_step_ups.length,0);
 for(const decision of ['approve','decline']){
   await start(scenario.instruction+' Deliver before Friday.');
   const pending=await waitState(s=>s.pending_step_ups.length===1);assert.equal(pending.run.approved,0);
   const resolved=await api(`/api/stepups/${pending.pending_step_ups[0].authorization_id}/resolve`,'POST',{decision,message:`Test customer chose ${decision}`});assert.equal(resolved.status,200);
   const final=(await api('/api/state')).data;assert.equal(final.pending_step_ups.length,0);assert.equal(final.run[decision==='approve'?'approved':'declined'],1);
 }
 const state=(await api('/api/state')).data;
 assert.equal((await api(`/api/mandates/${state.activeMandateId}`,'DELETE')).status,200);
 assert.equal((await api('/api/runs','POST',{scenario_id:scenario.scenario_id})).status,409);
});
