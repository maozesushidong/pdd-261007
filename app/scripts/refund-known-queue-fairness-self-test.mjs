import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file=process.env.RUNNER_SOURCE_FILE||'apps/worker/src/postgres-playwright-runner.mjs';
const source=fs.readFileSync(file,'utf8');
const start=source.indexOf('  let claim = null;',source.indexOf('const processDueExternalStateReconciliation'));
const end=source.indexOf('  if (claim && !returnRefundOnly && !directRefundExecutionSession)',start);
assert(start>0&&end>start,'Runner selection block not found');
const selection=source.slice(start,end);
async function choose({batchDue=true,elapsed=0,refundAvailable=true,startup=false,configured=true,bounded=false,persistent=false,refundOnly=false,direct=false,binding=true}={}){
 const calls=[];
 const context=vm.createContext({
  Date:{now:()=>1_000_000},lastKnownRefundOpportunityAt:1_000_000-elapsed,
  mixedBusinessSlotSession:!refundOnly,boundedSlotSession:bounded,persistentSlotSession:persistent,
  returnRefundOnly:refundOnly,directRefundExecutionSession:direct,startupLeaseRecoveryPending:startup,
  ordinaryOpportunitySinceRefundTurn:batchDue,drainOrdinaryQueueBeforeRefund:true,
  returnRefundDirectClaimsSinceScan:0,returnRefundDirectClaimsBeforeScan:4,lastReturnRefundScanAt:1_000_000,
  returnRefundScanForceIntervalMs:7_200_000,assignmentKind:'ordinary',shopId:'test-shop',workerId:'test-worker',leaseSeconds:180,
  activeClaim:null,returnRefundCycleCursor:null,
  dynamicPddShopBinding:binding,currentPddIdentityBindingToken:'test-identity',
  returnRefundConfiguredForShop:()=>configured,returnRefundScanDueNow:()=>false,
  shouldPrioritizeReturnRefundScan:()=>false,
  shouldResumePartialReturnRefundScan:()=>false,
  runReturnRefundScan:async()=>{throw new Error('Known-queue opportunity must not launch a browser scan');},
  deferReturnRefundScanAfterFailure:async error=>{throw error;},
  claimEligibleOrdinary:async()=>{calls.push('ordinary');return{id:'ordinary',scenario_code:'abnormal-network-warning'};},
  repository:{claimNext:async args=>{
   calls.push('refund');assert.deepEqual(Array.from(args.scenarioCodes),['return-refund']);
   assert.equal(args.identityBindingToken,binding?'test-identity':null);
   if(!refundOnly&&!direct)assert.equal(args.recoverOwnedLease,false);
   return refundAvailable?{id:'refund',scenario_code:'return-refund'}:null;
  }},
 });
 const result=await vm.runInContext(`(async()=>{${selection}\nreturn claim;})()`,context);
 return{result,calls,attemptAt:context.lastKnownRefundOpportunityAt};
}
const due=await choose();
assert.equal(due.result.id,'refund','KNOWN_REFUND_STARVED_BY_ORDINARY_DRAIN');
assert.deepEqual(due.calls,['refund'],'Do not overwrite a refund claim with an ordinary claim');
const slowRetries=await choose({batchDue:false,elapsed:10*60_000});
assert.equal(slowRetries.result.id,'refund');assert.deepEqual(slowRetries.calls,['refund']);
const withinBatch=await choose({batchDue:false,elapsed:9*60_000});
assert.equal(withinBatch.result.id,'ordinary');assert.deepEqual(withinBatch.calls,['ordinary']);
assert.equal((await choose({batchDue:false,elapsed:10*60_000-1})).result.id,'ordinary');
const empty=await choose({refundAvailable:false});
assert.equal(empty.result.id,'ordinary');assert.deepEqual(empty.calls,['refund','ordinary']);
for(const options of [{startup:true},{configured:false},{bounded:true}]){
 const held=await choose(options);assert.equal(held.result.id,'ordinary');assert.deepEqual(held.calls,['ordinary']);
}
assert.equal((await choose({persistent:true})).result.id,'refund');
assert.equal((await choose({refundOnly:true})).result.id,'refund');
assert.equal((await choose({direct:true})).result.id,'refund');
assert.equal((await choose({binding:false})).result.id,'refund');
assert.equal(due.attemptAt,1_000_000);
assert.equal((await choose({batchDue:false,elapsed:10*60_000,refundAvailable:false})).attemptAt,1_000_000);
// A sustained ordinary backlog cannot prevent the next known-refund turn.
for(let count=1;count<=20;count++){
 const r=await choose({batchDue:count>=20,elapsed:0});
 assert.equal(r.result.id,count===20?'refund':'ordinary');
}
console.log('KNOWN_REFUND_QUEUE_FAIRNESS_SELF_TEST_OK');
