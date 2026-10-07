import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchesDispatchedRefundManualHold } from './dispatched-refund-hold-reload-policy.mjs';

const options = {
  enabled:true, shopId:'shop-medical', expectedShopName:'医疗器械官方旗舰店',
  expectedWorkOrderId:'07108740-e65d-4893-ab0c-a328a832bbbf',
  expectedEffectId:'40bd05e7-edab-4b18-9942-5f7eb5e4d72e',
  expectedOrderNumber:'260925-140677005640355', expectedAftersaleNumber:'23045165508322',
  now:Date.parse('2026-10-02T04:30:00Z'),
  binding:{binding_token:'99999999-9999-4999-8999-999999999999',mall_id:'613879688',actual_shop_name:'医疗器械官方旗舰店'},
};
const fixture = {
  id:options.expectedEffectId,work_order_id:options.expectedWorkOrderId,
  effect_shop_id:options.shopId,work_shop_id:options.shopId,refund_shop_id:options.shopId,
  refund_work_order_id:options.expectedWorkOrderId,external_order_number:options.expectedOrderNumber,
  refund_order:options.expectedOrderNumber,aftersale_number:options.expectedAftersaleNumber,
  effect_type:'pdd-return-refund',effect_status:'unknown',idempotency_key:`pdd-return-refund:${options.expectedAftersaleNumber}`,
  scenario_code:'return-refund',work_status:'paused',work_runtime_status:'manual-review',completion_state:'pending',
  current_step:'return-refund-dispatched-unknown-manual-review',recovery_state:'ready',recovery_reason:null,
  ordinary_instance_id:null,current_ordinary_instance_id:null,action_state:'manual-review',
  next_attempt_at:'2099-01-01T00:00:00Z',next_check_at:'2099-01-01T00:00:00Z',
  refund_binding_token:options.binding.binding_token,refund_mall_id:options.binding.mall_id,
  refund_shop_name:options.expectedShopName,effect_count:1,active_commands:0,owns_current_lease:false,
  detail_url:`https://mms.pinduoduo.com/aftersales-ssr/detail?id=${options.expectedAftersaleNumber}&orderSn=${options.expectedOrderNumber}`,
  effect_receipt:{orderNumber:options.expectedOrderNumber,aftersaleNumber:options.expectedAftersaleNumber,
    submission:{confirmationDispatchStarted:true,confirmationClicked:true}},
};
const evaluate = (row=fixture, overrides={}) => matchesDispatchedRefundManualHold({...options,row,...overrides});
assert(evaluate());
assert(evaluate({...fixture,next_attempt_at:new Date(fixture.next_attempt_at),next_check_at:new Date(fixture.next_check_at)}));
assert(evaluate({...fixture,effect_receipt:{...fixture.effect_receipt,submission:{confirmationDispatchStarted:true}}}));
assert(evaluate({...fixture,effect_receipt:{...fixture.effect_receipt,submission:{confirmationClicked:true}}}));
let rejected=0;
for (const patch of [
  {id:'different-effect'}, {work_order_id:'different-work'}, {effect_shop_id:'other'}, {work_shop_id:'other'},
  {refund_shop_id:'other'}, {refund_work_order_id:'other'}, {external_order_number:'other'}, {refund_order:'other'},
  {aftersale_number:'other'}, {effect_type:'pdd-submit'}, {effect_status:'failed'}, {effect_status:'reserved'},
  {idempotency_key:'other'}, {scenario_code:'ordinary'}, {work_status:'retry-ready'}, {work_status:'completed'},
  {work_runtime_status:'paused'}, {work_runtime_status:'processing'}, {completion_state:'confirmed'},
  {current_step:'return-refund-manual-review'}, {recovery_state:'held'}, {recovery_reason:'unknown-external-effect'},
  {ordinary_instance_id:options.expectedWorkOrderId}, {current_ordinary_instance_id:options.expectedWorkOrderId},
  {action_state:'ready'}, {next_attempt_at:null}, {next_check_at:null}, {next_attempt_at:'invalid'},
  {next_attempt_at:'2026-10-01T00:00:00Z'}, {next_check_at:'2026-10-01T00:00:00Z'},
  {next_attempt_at:'2026-10-03T00:00:00Z'}, {next_check_at:'2026-10-03T00:00:00Z'},
  {refund_binding_token:'old-token'}, {refund_mall_id:'wrong-mall'}, {refund_shop_name:'wrong-shop'},
  {effect_count:2}, {effect_count:0}, {active_commands:1}, {owns_current_lease:true}, {owns_current_lease:null},
  {detail_url:'https://evil.example/aftersales-ssr/detail'}, {detail_url:fixture.detail_url.replace('id=23045165508322','id=111111')},
  {detail_url:fixture.detail_url.replace('orderSn=260925-140677005640355','orderSn=260925-140677005640356')},
  {effect_receipt:null}, {effect_receipt:{...fixture.effect_receipt,orderNumber:'other'}},
  {effect_receipt:{...fixture.effect_receipt,aftersaleNumber:'other'}},
  {effect_receipt:{...fixture.effect_receipt,submission:{}}},
  {effect_receipt:{...fixture.effect_receipt,submission:{confirmationClicked:'true'}}},
]) { assert.equal(evaluate({...fixture,...patch}),false,JSON.stringify(patch));rejected++; }
for (const patch of [
  {enabled:false}, {expectedWorkOrderId:'invalid'}, {expectedEffectId:'invalid'}, {expectedOrderNumber:'invalid'},
  {expectedAftersaleNumber:'invalid'}, {binding:null}, {binding:{...options.binding,actual_shop_name:'other'}},
  {binding:{...options.binding,binding_token:'old-token'}}, {binding:{...options.binding,mall_id:'other'}},
  {now:Date.parse('2099-01-01T00:00:00Z')}, {now:NaN},
]) { assert.equal(evaluate(fixture,patch),false);rejected++; }
// Ordinary deferred unknown effects retain their separate six-hour policy.
const ordinary = {...fixture,effect_type:'pdd-submit',scenario_code:'ordinary',work_status:'retry-ready',
  work_runtime_status:'retry-ready',current_step:'logistics-waiting-released',next_attempt_at:'2026-09-30T08:30:27.707Z'};
assert.equal(evaluate(ordinary),false);
const source=fs.readFileSync(new URL('./safe-single-shop-reload.mjs',import.meta.url),'utf8');
assert(source.includes('Date.parse(row.next_attempt_at) <= Date.now() + 6 * 60 * 60_000'));
assert(source.includes('FOR UPDATE OF effect, work_order, refund NOWAIT'));
assert(source.includes('Dispatched refund manual hold changed before code reload'));
console.log(JSON.stringify({passed:true,positiveCases:4,negativeCases:rejected+1,ordinarySixHourGuardPreserved:true}));
