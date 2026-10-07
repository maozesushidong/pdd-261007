import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const start=source.indexOf('const processOneWorkOrder = async');
const end=source.indexOf('\nlet workflowBusy =',start);
assert(start>=0&&end>start);
const order='260910-227079646811761';
const detailUrl='https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=500013304255392';
const scenario='in-transit-refund';
const run=async({cached=false,completed=false,absent=false,readError=null,extended=false,reconcile=false,recoveredSubmission=false}={})=>{
 const events=[];
 let progress={orderNumber:order,detailUrl,scenarioCode:extended?'product-shortage':scenario,
  workOrderType:extended?'商品少发':'在途物流问题',logisticsAnalysis:{orderNumber:order},
  pddEvidenceScreenshot:{orderNumber:order,status:cached?'ready':'missing'},
  ...(recoveredSubmission?{pddResolutionSubmission:{orderNumber:order,status:'succeeded',recoveredFromCompletedPage:true}}:{})};
 const page={url:()=>detailUrl,waitForLoadState:async()=>{},locator:()=>({innerText:async()=>`订单编号：${order}`})};
 const complete={status:'succeeded',orderNumber:order,recoveredFromCompletedPage:completed||absent};
 const sandbox={console:{log(){}},
  assertActiveResidentCommandIdentity(){},readProgress:()=>progress,
  writeProgress:patch=>{progress={...progress,...patch};},
  reconcileExternalStateOnly:reconcile,reconcileExternalEffectTypes:new Set(),activeScenarioCode:progress.scenarioCode,
  activeWorkOrderType:progress.workOrderType,requestedOrderNumber:order,forceEvidenceRecapture:false,forceOmsRecheck:false,
  pddPage:page,omsPage:{},tmsPage:{},context:{},pddRenderWaitMs:100,pddDetailSettleMs:10,
  isExtendedOrdinaryScenario:value=>value==='product-shortage',matchingScenarioForTitle:()=>({code:scenario}),
  persistSystemTabs(){},resetCurrentOrderForRerun(){},
  hasCompleteScenarioLogisticsAnalysis:()=>cached,hasCompleteLogisticsAnalysis:()=>cached,
  hasConsumablePddEvidence:()=>cached,hasConsumableTmsEvidence:()=>false,hasCompletedTmsBypass:()=>false,
  resolvePddConsumerNegotiationResume:()=>null,resolvePddInTransitOutcomeFallbackResume:()=>null,
  isPddDetailUrl:url=>url.includes('/tododetail'),pddSavedDetailNeedsFreshLookup:()=>false,
  focusSystemPage:async()=>{},closeDeviceAccessIfPrompted:async()=>{},ensurePddLogin:async()=>{},
  listUrl:'https://mms.pinduoduo.com/aftersales/work_order/list',
  openSavedPddDetailPage:async()=>page,logRunStep:(name)=>events.push(name),
  reopenPddDetailForResolution:async()=>page,
  hasConfirmedPendingListAbsence:()=>absent,
  completedPddStateFromPendingListAbsence:()=>({detailReady:true,orderMatches:true,isCompleted:true}),
  ensurePddResolutionDetailReady:async()=>{
   events.push('read-pdd-state');if(readError)throw readError;
   return{detailReady:true,orderMatches:true,isCompleted:completed,isPending:!completed};
  },
  analyzeWorkOrderShipping:async()=>{events.push('read-logistics');return{orderNumber:order};},
  hasCompleteScenarioOmsAnalysis:()=>false,
  analyzeOmsOrder:async()=>{events.push('oms');},
  runScenarioStagesAfterOms:async()=>{events.push('tms-create');},
  runPddResolutionWorkflow:async()=>{events.push('pdd-resolution');return complete;},
  archiveAndResetCompletedOrder:async()=>events.push('archive'),
  ordinaryCompletionFromState:()=>complete,
  executeExtendedOrdinaryScenario:async()=>{events.push('extended');return complete;},
  reconcilePddExternalState:async()=>{events.push('reconcile-only');return{orderNumber:order};},
 };
 vm.runInNewContext(source.slice(start,end)+'\nglobalThis.run=processOneWorkOrder;',sandbox);
 try{return{value:await sandbox.run(),events};}catch(error){return{error,events};}
};
for(const cached of [false,true]){
 const done=await run({cached,completed:true});
 assert.equal(done.error,undefined);
 assert.equal(done.events.includes('tms-create'),false,'TERMINAL_CASE_MUST_SKIP_EXTERNAL_SYSTEMS');
 assert.equal(done.events.includes('oms'),false,'already completed cases must not re-enter OMS');
 assert.equal(done.events.includes('read-logistics'),false,'already completed cases must not depend on usable logistics');
 assert.equal(done.value.completed,true);assert.equal(done.events.at(-1),'archive');
 const pending=await run({cached});assert.equal(pending.error,undefined);
 assert.equal(pending.events.filter(x=>x==='oms').length,1);
 assert.equal(pending.events.filter(x=>x==='tms-create').length,1);
 assert(pending.events.indexOf('read-pdd-state')<pending.events.indexOf('oms'));
 assert(pending.events.indexOf('oms')<pending.events.indexOf('tms-create'));
 for(const name of ['HumanVerificationRequiredError','PddLoginRequiredError','RateLimitPauseError','PDD_DETAIL_IDENTITY_MISMATCH']){
  const error=Object.assign(new Error(name),{name});
  const blocked=await run({cached,readError:error});assert.equal(blocked.error,error);
  assert.equal(blocked.events.includes('oms'),false);assert.equal(blocked.events.includes('tms-create'),false);
  assert.equal(blocked.events.includes('archive'),false);
 }
 const missing=await run({cached,absent:true});assert.equal(missing.error,undefined);
 assert.equal(missing.value.completed,true);assert.equal(missing.events.includes('tms-create'),false);
}
const extended=await run({extended:true});assert.equal(extended.error,undefined);
assert.equal(extended.events.filter(x=>x==='extended').length,1);assert.equal(extended.events.includes('tms-create'),false);
const reconciling=await run({reconcile:true});assert.equal(reconciling.error,undefined);
assert.equal(reconciling.value.reconciled,true);assert.equal(reconciling.events.includes('oms'),false);
for (const completed of [false, true]) {
 const readOnly=await run({reconcile:true,completed,recoveredSubmission:true});
 assert.equal(readOnly.error,undefined);
 assert.equal(readOnly.value.reconciled,true);
 assert.equal(readOnly.events.includes('reconcile-only'),true);
 assert.equal(readOnly.events.includes('pdd-resolution'),false);
 assert.equal(readOnly.events.includes('archive'),false);
}
console.log('PDD terminal-before-external regression passed (actual orchestrator, fresh/cached completed cases, pending order, interruptions, identity failure, absence, extended and reconciliation routing)');
