import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {returnRefundScanEffectiveStartCursor, returnRefundPartialScanCooldownMs,
  returnRefundVerificationCooldownUntil} from '../apps/worker/src/return-refund-scan-policy.mjs';

const adapterIndex=process.argv.indexOf('--adapter');
const adapterUrl=adapterIndex<0?new URL('../packages/adapters/src/pdd/return-refund.mjs',import.meta.url)
  :pathToFileURL(process.argv[adapterIndex+1]);
const {collectReturnRefundCandidates}=await import(adapterUrl.href);
const RETURN_REFUND_LIST_ACTION_SCOPE='refund-list-without-platform-messages-v1';
const orders=Array.from({length:4},(_,i)=>`261006-${String(i+1).repeat(15)}`);
const ids=Array.from({length:4},(_,i)=>`23${String(i+1).repeat(12)}`);
const html='<button>售后工作台</button><button>待商家处理</button><button>退货退款</button>'
  +'<button aria-current="page">1</button>'
  +orders.map((order,i)=>`<article>订单号 ${order} 售后编号 ${ids[i]} 待商家处理
  <button onclick="window.detailClicks=(window.detailClicks||0)+1">查看详情</button></article>`).join('');
const deferredRefunds=orders.map((orderNumber,i)=>({orderNumber,aftersaleNumber:ids[i],
  nextCheckAt:new Date(Date.now()+86400000).toISOString()}));
const runner=fs.readFileSync(new URL('../apps/worker/src/postgres-playwright-runner.mjs',import.meta.url),'utf8');
const start=runner.indexOf('async function runReturnRefundScan() {');
const end=runner.indexOf('async function runReturnRefundValidation()',start);
assert(start>=0&&end>start);
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
let cases=0;
try {
  for(const itemOffset of [0,3]) {
    const context=await browser.newContext();
    await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
    const page=await context.newPage();
    await page.goto('https://mms.pinduoduo.com/aftersales/aftersale_list');
    const options={maxItems:3,maxDurationMs:8000,delayMs:0,renderWaitMs:100,deferredRefunds};
    const requested={page:26,itemOffset,actionScope:RETURN_REFUND_LIST_ACTION_SCOPE};
    const wrapped=await collectReturnRefundCandidates(page,context,{...options,scanCursor:requested});
    assert.equal(wrapped.scan.cursorWrapped,true);
    assert.deepEqual(wrapped.scan.nextCursor,{page:1,itemOffset:0},
      'DURABLE_WRAP_MUST_COMPLETE_AT_CYCLE_BOUNDARY');
    assert.equal(wrapped.scan.examined,0,'Do not start the next cycle inside the previous cycle');
    assert.equal(wrapped.scan.resumeProof,null);
    assert.equal(wrapped.items.length,0);
    const fresh=await collectReturnRefundCandidates(page,context,{...options,maxItems:1,
      scanCursor:{page:1,itemOffset:0,actionScope:RETURN_REFUND_LIST_ACTION_SCOPE}});
    assert.equal(fresh.scan.examined,1,'The following cycle must still inspect the first row');
    assert.deepEqual(fresh.scan.nextCursor,{page:1,itemOffset:1});
    assert.equal(await page.evaluate(()=>window.detailClicks||0),0);
    const outputs=[wrapped,fresh];
    let persisted=0;
    const state={Date,Math,Set,Number,Error,
      returnRefundScanEffectiveStartCursor,returnRefundPartialScanCooldownMs,returnRefundVerificationCooldownUntil,
      returnRefundConfiguredForShop:()=>true,returnRefundCycleCursor:requested,
      returnRefundCycleTotals:{scannedItems:0,persistedItems:0,examinedItems:0},
      returnRefundCycleVisitedCursors:new Set(['1:3','2:0']),
      fsp:{rm:async()=>{}},returnRefundOutputFile:'unused',ensureResidentWorkflowForReturnRefund:async()=>{},
      mixedBusinessSlotSession:false,slotSession:false,returnRefundScanMaxDurationMs:120000,
      returnRefundScanMaxItems:3,returnRefundOnly:false,returnRefundScanOnce:false,
      returnRefundCombinedBatchItems:3,returnRefundAutoApproveEnabled:true,
      returnRefundPartialBatchCooldownMs:300000,returnRefundPostVerificationCooldownMs:300000,
      shopId:'fixture-shop',shop:{expectedShopName:'Correct shop',configuredPddIdentityNames:['Correct shop']},
      repository:{listFutureReturnRefundRechecks:async()=>[],listConfirmedReturnRefundCompletions:async()=>[],
        enqueueReturnRefunds:async({items})=>{assert.equal(items.length,0);persisted++;return [];},
        setReturnRefundScanCursor:async({cursor})=>cursor},
      sendWorkflowCommand:async()=>({requestId:'scan'}),
      waitForReturnRefundOutput:async()=>{assert(outputs.length);return outputs.shift();},
      readProgress:async()=>({pddShopIdentity:{actualShopName:'Correct shop',profileFingerprint:'profile'}}),
      normalizeDetectedPddShopName:name=>name,readBrowserProfileMarker:async()=>({profileFingerprint:'profile'}),
      isMaskedDetectedPddShopName:()=>false,synchronizeDetectedPddShopIdentity:async()=>true,
      pddIdentityMatches:()=>true,currentPddIdentityMetadata:{mallId:'123'},dynamicPddShopBinding:false,
      heartbeat:async()=>{},
    };
    vm.runInNewContext(runner.slice(start,end)+'\nglobalThis.scan=runReturnRefundScan;',state);
    const completed=await state.scan();
    assert.equal(completed.fullScanCompleted,true);
    assert.equal(state.returnRefundCycleCursor,null);
    assert.equal(state.returnRefundCycleVisitedCursors.size,0,'Use the existing completed-cycle reset');
    const before=Date.now();
    const next=await state.scan();
    assert.equal(next.fullScanCompleted,false);
    assert.equal(state.returnRefundCycleCursor.page,1);
    assert.equal(state.returnRefundCycleCursor.itemOffset,1);
    assert.equal(state.returnRefundCycleVisitedCursors.has('1:0'),true);
    assert(state.returnRefundScanRetryNotBefore>=before+300000,'Keep five-minute partial pacing');
    assert.equal(persisted,2);
    await context.close();cases++;
  }
  console.log(JSON.stringify({passed:true,isolated:true,cases,actualCollector:true,actualRunner:true,
    wrapCompletesPreviousCycle:true,nextCycleStartsAtFirstRow:true,duplicateGuardUnchanged:true,
    fiveMinuteCooldownUnchanged:true,liveWorkerAttached:false}));
} finally {await browser.close();}
