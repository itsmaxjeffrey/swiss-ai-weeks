const test=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const {buildReview,reviewPolicy,digest}=require('../wallet-review');
test('real policy and per-account values reach review without payment or address data',()=>{
 const p={request:'Buy a blue jacket',items:[{product:'blue jacket',quantity:2,max_unit_price:{amount:35,currency:'CHF'},card:'NEVER_SEND'}],budget:{max_total:70,currency:'CHF'},timing:{order_by:'tomorrow'},merchant:{allowed_domains:['shop.example']},customer:{email:'NEVER_SEND'},delivery:{address:'NEVER_SEND'},payment:{number:'NEVER_SEND'},stop_rules:['Ask if out of stock']};
 const input=buildReview(p,{cap:80,whitelist:['shop.example']},['Blue, not green','Two jackets']);
 assert.equal(input.permissions.items[0].quantity,2);assert.equal(input.permissions.budget.max_total,70);assert.equal(input.account_controls.spend_cap_chf,80);assert.deepEqual(input.customer_messages,['Blue, not green','Two jackets']);assert.ok(!JSON.stringify(input).includes('NEVER_SEND'));
 assert.notEqual(digest(input),digest(buildReview({...p,budget:{max_total:60,currency:'CHF'}},{cap:80,whitelist:[]},[])));
});
test('bridge sends authenticated real payload and preserves review refusal',async t=>{
 let received;
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer test-token');let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{received=JSON.parse(raw);res.end(JSON.stringify({status:'ok',review_required:true,source:'shopper_policy_sign'}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const payload=buildReview({request:'Order gloves',items:[{product:'gloves',quantity:5}],budget:{max_total:25,currency:'CHF'}},{cap:30,whitelist:[]},['Five gloves']);
 const out=await reviewPolicy(payload,{token:'test-token',port:server.address().port});assert.equal(out.review_required,true);assert.deepEqual(received,payload);
});
test('missing service authentication reports disconnected, never successful',async()=>assert.equal((await reviewPolicy({})).status,'not_connected'));
