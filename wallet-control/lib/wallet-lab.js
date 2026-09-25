import crypto from 'node:crypto';
import { evaluate } from './engine.js';
import { Store } from './store.js';
import { HistoryProfiles } from './history.js';
import { controlChecks, enforceControls, fail } from './wallet-controls.js';

export function trialPurchase(input, mandate, controls, trust) {
  if (!mandate?.hard_rules) throw fail('Translate an instruction or activate a policy first',400);
  const price=Number(input.price),quantity=Number(input.quantity),delivery=Number(input.delivery || 0);
  if(!Number.isFinite(price)||price<0||!Number.isInteger(quantity)||quantity<1||quantity>10000||!Number.isFinite(delivery)||delivery<0)throw fail('Enter a valid price, quantity and delivery charge',400);
  const total=Math.round((price*quantity+delivery)*100)/100;
  const event={authorization:{authorization_id:'trial_'+crypto.randomUUID(),timestamp:input.timestamp||new Date().toISOString(),amount:total,billing_amount_chf:total,currency:'CHF',items_subtotal:price*quantity,delivery_fee:delivery,
    merchant:{merchant_id:'trial_shop',merchant_name:String(input.merchant||'Selected shop').slice(0,120),merchant_country:String(input.country||'CH'),merchant_city:String(input.city||''),merchant_category:String(input.category||'general')},
    items:[{item_id:String(input.item_id||'trial_item'),item_name:String(input.item||'Selected item').slice(0,200),item_category:String(input.category||'general'),quantity,unit_price:price,currency:'CHF',item_details:String(input.details||'').slice(0,4000),
      ...(typeof input.returnable==='boolean'?{returnable:input.returnable}:{}),...(typeof input.cancellable==='boolean'?{cancellable:input.cancellable}:{}),
      ...(input.delivery_days!==''&&input.delivery_days!=null?{delivery_days:Number(input.delivery_days)}:{}),size:String(input.size||'')}],purchase_description:String(input.item||'Selected item')},
    mandate:{...mandate,status:'active',customer_id:'trial_customer'},context:{},runtime:{}};
  const scratch=new Store(),run=scratch.createRun({run_id:'trial',mandate_id:mandate.mandate_id,mandateSnapshot:event.mandate,totalEvents:1});
  const result=enforceControls(evaluate(event,scratch.runState(run),new HistoryProfiles([]),trust),controlChecks(event,controls,[]));
  return {kind:'purchase_preview',payment_performed:false,history_basis:'No customer history is assumed for this trial.',result,purchase:event.authorization};
}

export function replayPurchases(records, mandate, controls, profiles, trust) {
  const scratch=new Store(), run=scratch.createRun({run_id:'replay',mandate_id:mandate.mandate_id,mandateSnapshot:mandate,totalEvents:records.length});
  const results=[];
  for(const old of records.slice(0,250).sort((a,b)=>Date.parse(a.event.authorization.timestamp)-Date.parse(b.event.authorization.timestamp))) {
    const event=structuredClone(old.event);event.mandate={...mandate,status:'active',customer_id:event.mandate?.customer_id};
    // Rebuild replay state from newly evaluated outcomes, never recorded answers.
    event.context={...event.context,approved_spend_in_period_chf:0,recent_authorizations:[]};
    event.authorization.spend_in_period_before_chf=0;
    event.authorization.related_authorization_status=null;
    const result=enforceControls(evaluate(event,scratch.runState(run),profiles,trust),controlChecks(event,controls,scratch.ledger()));
    const a=event.authorization;
    scratch.acceptDecision('replay',a.authorization_id,{authorizationId:a.authorization_id,decision:result.decision,amount:a.billing_amount_chf,simTs:Date.parse(a.timestamp),merchantId:a.merchant?.merchant_id},event,result,0);
    results.push({authorization_id:a.authorization_id,merchant:a.merchant?.merchant_name,amount:a.billing_amount_chf,before:old.finalDecision||old.decision,after:result.decision,reason_codes:result.reason_codes,uncertainties:result.uncertainties});
  }
  return {kind:'policy_replay',payment_performed:false,count:results.length,approved:results.filter(r=>r.after==='approve').length,review:results.filter(r=>r.after==='step_up').length,declined:results.filter(r=>r.after==='decline').length,results};
}
