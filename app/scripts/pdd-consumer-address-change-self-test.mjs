import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
 archiveReadiness, renderedOrdinaryCompletionObservation,
} from '../workflow-runtime.mjs';
import {
  ADDRESS_CHANGE_MESSAGES as messages, ADDRESS_CHANGE_MESSAGE_VARIANTS as variants,
  parseConsumerAddressChangeState as parse,
  evaluateConsumerAddressChange as evaluate, runConsumerAddressChange as run,
} from '../packages/adapters/src/pdd/consumer-address-change.mjs';
const orderNumber = '260921-123456789012345';
const creation = '消费者申请修改地址\n处理时间：2026-09-21 01:00:00';
const rejection = `拒绝消费者改地址申请\n您已拒绝消费者改地址申请\n处理方案：不同意修改地址\n不同意改地址原因：包裹已打包完成\n发送话术：${messages.reject}\n处理时间：2026-09-21 01:01:00`;
const negotiation = `客服已给出处理方案\n具体方案：协商退款重拍\n发送话术：${messages.negotiate}\n处理时间：2026-09-21 01:02:00`;
const snapshot = (stage, overrides={}) => {
 const form = stage === 'reject' ? '请尽快审核消费者的改地址申请\n消费者已发起的改地址申请，请尽快进行审核操作\n处理方案 同意修改地址申请 不同意修改地址\n不同意修改地址原因 包裹已打包完成 包裹已交付快递 海淘商品已清关 其他原因\n发送话术 提交'
  : stage === 'negotiate' ? '请和消费者协商解决改地址问题\n您已拒绝消费者改地址申请，请和消费者协商解决方案\n具体方案 协商退款重拍 联系快递修改地址 拦截快递退款\n发送话术 提交' : '';
 const history = [stage === 'completed' ? negotiation : '', stage !== 'reject' ? rejection : '', creation].filter(Boolean).join('\n');
 return { text: `订单未发货\n【${stage === 'completed' ? '已完结' : '待处理'}】消费者申请修改地址 平台受理\n${form}\n服务进度\n${history}\n订单信息 查看详情\n订单编号：${orderNumber}\n待发货\n售后信息\n暂无售后信息\n收货信息\n物流轨迹\n发货物流 退货物流\n暂无发货物流`,
 submitCount: stage === 'completed' ? 0 : 1,
 messages: stage === 'completed' ? [] : [messages[stage]], ...overrides };
};
let count = 0;
function check(name, fn) { fn();count++;console.log('PASS',name); }
check('stage 1 and positive shipping proof',()=>{
 const state=parse(snapshot('reject'),orderNumber);assert.equal(state.stage,'reject');assert(state.unshipped && state.noAftersale);
 assert.equal(evaluate({consumerAddressChangeState:state}).pdd.reasonOption,'包裹已打包完成');
});
check('stage 2 resumes using the actual first-stage history',()=>{
 const state=parse(snapshot('negotiate'),orderNumber);assert(state.rejectionProof);assert.equal(state.stage,'negotiate');
 const decision = evaluate({consumerAddressChangeState:state});
 assert.equal(decision.pdd.option,'协商退款重拍');
 assert(decision.pdd.generatedMessageAcceptedVariants.includes(variants.negotiate[1]));
});
check('completion requires both records and no form',()=>{
 assert(parse(snapshot('completed'),orderNumber).complete);
 const platformVariant = snapshot('completed', {
  text: snapshot('completed').text.replace(messages.negotiate, variants.negotiate[1]),
 });
 assert(parse(platformVariant,orderNumber).complete, 'known PDD stage-2 platform variant must prove completion');
 assert.equal(variants.negotiate[1], '亲亲，您可以退款后使用新重新地址下单哦');
 for (const mutation of [s=>s.replace(rejection,''),s=>s.replace(negotiation,''),s=>s.replace('包裹已打包完成','其他原因'),s=>s.replace(messages.negotiate,'另一条话术')]) {
  const s=snapshot('completed');s.text=mutation(s.text);assert(!parse(s,orderNumber).complete);
 }
 assert(!parse(snapshot('completed',{submitCount:1}),orderNumber).complete);
});
check('unsupported or missing shipping/aftersale proof never submits',()=>{
 for (const [from,to] of [['待发货','待收货'],['暂无发货物流','物流公司 中通 运单号 123456789012'],['暂无发货物流',''],['暂无售后信息','退款处理中']]) {
  const s=snapshot('reject');s.text=s.text.replace(from,to);
  assert.equal(evaluate({consumerAddressChangeState:parse(s,orderNumber)}).outcome,'manual-review');
 }
});
check('wrong order/type/stale form never submits',()=>{
 for (const s of [snapshot('reject',{text:snapshot('reject').text.replace('消费者申请修改地址','消费者申请退款')}),snapshot('reject',{text:snapshot('reject').text.replace('服务进度',`服务进度 ${rejection}`)}),snapshot('negotiate',{text:snapshot('negotiate').text.replace(rejection,'')})]) {
  assert.equal(evaluate({consumerAddressChangeState:parse(s,orderNumber)}).outcome,'manual-review');
 }
 assert.equal(evaluate({consumerAddressChangeState:parse(snapshot('reject'),'260921-999999999999999')}).outcome,'manual-review');
});
const harness = ({start='reject', wrongMessage=false, stuck=false, mutateBeforeClick=false, receipts=new Map()}={}) => {
 let stage=start, clock=0, current=snapshot(stage), clicks=[], applies=[], events=[];
 const runtime={ orderNumber,timeoutMs:500, now:()=>clock,wait:async ms=>{clock+=ms},
  assertIdentity:async()=>{}, read:async()=>current,record:e=>events.push(e),
  guard:async(key,action)=>{if(receipts.has(key)) return {alreadySucceeded:true,...receipts.get(key)};
   const value=await action();receipts.set(key,value);return value},
  apply:async d=>{applies.push(d.pdd.stageCode);if(wrongMessage)current.messages=['错误话术']},
  submit:async({decision,beforeClick,settleUntil})=>{
   if(mutateBeforeClick)current.text=current.text.replace('待发货','待收货');
   await beforeClick();clicks.push(decision.pdd.stageCode);
   if(!stuck){stage=stage==='reject'?'negotiate':'completed';current=snapshot(stage)}
   return {transitionConfirmed:await settleUntil(),submitReceipt:{success:!stuck}};
  }};
 return {runtime,clicks,applies,events,receipts};
};
let h=harness();let result=await run(h.runtime);assert(result.isCompleted);assert.deepEqual(h.clicks,['reject','negotiate']);count++;
// Exercise the workflow boundary as well as the scenario runner. A valid
// two-stage completion must survive the generic archive consistency check.
const workflowSource = readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const completionStart = workflowSource.indexOf('const ordinaryCompletionFromState =');
const completionEnd = workflowSource.indexOf('\n};', completionStart) + 3;
assert(completionStart >= 0 && completionEnd > completionStart);
for (const initialStage of ['reject', 'completed']) {
 const sample = harness({start:initialStage});
 const state = await run(sample.runtime);
 let progress = {orderNumber, pddResolutionSubmission:{}};
 const context = vm.createContext({shopId:'test-shop',
  IN_TRANSIT_ADDRESS_CHANGE_CODE:'consumer-address-change-in-transit',
  verifiedProactiveSummaryMatchesCompletion:()=>false,
  verifiedInterceptSummaryMatchesCompletion:()=>false,
  ordinaryTerminalOutcomeConflicts:()=>false,
  renderedOrdinaryCompletionObservation,
  readProgress:()=>progress, writeProgress:patch=>{progress={...progress,...patch}},
  finalizeOrdinaryEvidence:()=>{},
 });
 vm.runInContext(`${workflowSource.slice(completionStart,completionEnd)}; globalThis.complete=ordinaryCompletionFromState;`,context);
 const completion=context.complete(orderNumber,'consumer-address-change',state.decision,state);
 assert.equal(archiveReadiness(progress,completion).ready,true,
  `verified address-change completion must archive from ${initialStage}`);
 assert.equal(completion.completionEvidence,'协商退款重拍');
 assert.equal(Object.hasOwn(completion,'platformCompletionObservation'),false,
  'scenario completion without a rendered PDD resolution detail must not claim detail-page proof');
 assert.equal(completion.completionServiceEvidence,'不同意修改地址：包裹已打包完成；协商退款重拍');
 assert.equal(archiveReadiness(progress,{...completion,outcome:'同意修改地址申请'}).reason,
  'completion-outcome-mismatch','a genuinely different outcome must still be blocked');
 const legacyCompletion={...completion,
  completionEvidence:'不同意修改地址：包裹已打包完成；协商退款重拍',
  submitClicked:false,submitReceipt:null,recoveredFromCompletedPage:false};
 const legacyProgress={...progress,shopId:'test-shop',scenarioCode:'consumer-address-change',
  platformCaseKey:'pdd-work-order:fixture',pddResolutionSubmission:legacyCompletion,
  consumerAddressChange:{orderNumber,platformCaseKey:'pdd-work-order:fixture',lastVerifiedState:state}};
 assert.equal(archiveReadiness(legacyProgress,legacyCompletion).ready,true,
  'existing completed checkpoints must also recover without replaying either submit');
 for(const field of ['complete','noForm','orderMatches','rejectionProof','negotiationProof','creationProof']){
  const incomplete={...legacyProgress,consumerAddressChange:{...legacyProgress.consumerAddressChange,
   lastVerifiedState:{...state,[field]:false}}};
  assert.equal(archiveReadiness(incomplete,legacyCompletion).ready,false,
   `legacy recovery must retain ${field} proof`);
 }
 assert.equal(archiveReadiness({...legacyProgress,platformCaseKey:'pdd-work-order:other'},legacyCompletion).ready,false,
  'legacy completion from another platform case must remain blocked');
 assert.equal(archiveReadiness(legacyProgress,{...legacyCompletion,outcome:'同意修改地址申请'}).ready,false);
 count++;
}
h=harness({start:'negotiate'});await run(h.runtime);assert.deepEqual(h.clicks,['negotiate']);count++;
h=harness({start:'completed'});await run(h.runtime);assert.deepEqual(h.clicks,[]);count++;
h=harness({wrongMessage:true});await assert.rejects(run(h.runtime),e=>e.reasonCode==='address-change-message-mismatch' && e.externalEffectStatus==='failed');assert.equal(h.clicks.length,0);count++;
h=harness({mutateBeforeClick:true});await assert.rejects(run(h.runtime),e=>e.reasonCode==='address-change-unsupported-shipping-state');assert.equal(h.clicks.length,0);count++;
h=harness({stuck:true});await assert.rejects(run(h.runtime),e=>e.reasonCode==='address-change-submit-unconfirmed' && e.externalEffectStatus==='unknown');assert.equal(h.clicks.length,1);count++;
h=harness({receipts:new Map([['ordinary-consumer-address-change-reject-v1',{stage:'reject'}]])});await assert.rejects(run(h.runtime),e=>e.reasonCode==='address-change-receipt-page-mismatch');assert.equal(h.clicks.length,0);count++;
console.log(JSON.stringify({passed:count}));
export {snapshot,orderNumber,rejection,negotiation};

