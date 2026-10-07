import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {chromium} from 'playwright';
import {selectLivePddPage} from '../packages/adapters/src/browser-runtime-state.mjs';
import {collectReturnRefundCandidates,readReturnRefundScanResumeProof,RETURN_REFUND_WORKBENCH_URL} from '../packages/adapters/src/pdd/return-refund.mjs';

const sourceIndex=process.argv.indexOf('--source');
const sourceFile=sourceIndex<0?new URL('../workflow.mjs',import.meta.url):process.argv[sourceIndex+1];
assert(sourceFile,'--source requires a saved workflow path');
const source=fs.readFileSync(sourceFile,'utf8').replace(/\r\n/gu,'\n');
const extract=(start,end)=>{
 const from=source.indexOf(start),to=source.indexOf(end,from);
 assert(from>=0&&to>from);return source.slice(from,to);
};
const adopt=extract('const adoptLivePddAnchor =','\nconst adoptLiveSystemAnchor =');
const scan=extract('let returnRefundScanPage = null;','\n\nconst residentCommandFailureStatus =');
const orders=Array.from({length:4},(_,i)=>`260929-${String(i+1).repeat(15)}`);
const ids=Array.from({length:4},(_,i)=>`${String(i+1).repeat(14)}`);
const html='<button>售后工作台</button><button>待商家处理</button><button>退货退款</button>'
 +'<button aria-current="page">2</button>'
 +orders.map((order,i)=>`<article>订单号 ${order} 售后编号 ${ids[i]} 待商家处理 <button>查看详情</button></article>`).join('');
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
let cases=0;
try{
 const fixture=async(mode)=>{
  const context=await browser.newContext();const requests=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.fulfill({contentType:'text/html; charset=utf-8',body:html});});
  const anchor=await context.newPage(),list=await context.newPage();
  await anchor.goto(mode==='adopted'?'https://mms.pinduoduo.com/login/':'https://mms.pinduoduo.com/aftersales/work_order/list');
  await list.goto(RETURN_REFUND_WORKBENCH_URL);
  const proof=await readReturnRefundScanResumeProof(list,{page:2,itemOffset:0});
  const outputs=[];let created=0,first=true;
  const state={URL,Number,Math,Date,JSON,Error,crypto,console:{log(){}},process:{env:{}},
   shopId:'fixture-shop',pddPage:anchor,omsPage:null,tmsPage:null,context,listUrl:RETURN_REFUND_WORKBENCH_URL,
   RETURN_REFUND_WORKBENCH_URL,pddRenderWaitMs:100,residentCommandMode:true,
   activeReturnRefundCommand:{scanCursor:{page:2,itemOffset:0},maxItems:1,maxDurationMs:5000,
    deferredRefunds:orders.map((orderNumber,i)=>({orderNumber,aftersaleNumber:ids[i],nextCheckAt:new Date(Date.now()+86400000).toISOString()}))},
   selectLivePddPage,monitorSystemPage:(_system,page)=>page,persistSystemTabs(){},
   derivedPages:new Set([list]),derivedPageMeta:new Map([[list,{purpose:'return-refund-scan-list'}]]),
   registerDerivedPage(page,purpose){state.derivedPages.add(page);state.derivedPageMeta.set(page,{purpose});return page;},
   createBackgroundPage:async()=>{created+=1;return context.newPage();},
   navigateSystemPage:async(page,url)=>page.goto(url),focusSystemPage:async()=>{},ensurePddLogin:async()=>{},
   returnRefundVisibleStep:async()=>{},checkForHumanVerification:async()=>false,logRunStep(){},
   closeDerivedPage:async(page)=>{assert.notEqual(page,state.pddPage,'the permanent anchor must not be closed');state.derivedPages.delete(page);await page.close();},
   evaluateReturnRefundRules:()=>assert.fail('these exact future waits need no business action'),
   writeReturnRefundOutput:output=>outputs.push(output),initialList:list,initialProof:proof,
   collectReturnRefundCandidates:async(page,ctx,options)=>{
    if(first){first=false;return {items:[],scan:{nextCursor:{page:2,itemOffset:1},resumeProof:await readReturnRefundScanResumeProof(page,{page:2,itemOffset:1})}};}
    return collectReturnRefundCandidates(page,ctx,{...options,delayMs:0,renderWaitMs:100});
   },
  };
  vm.runInNewContext(`${adopt}\n${scan}\nreturnRefundScanPage=initialList;returnRefundScanResumeProof=initialProof;globalThis.adopt=adoptLivePddAnchor;globalThis.scan=runReturnRefundScanOnly;globalThis.scanState=()=>({page:returnRefundScanPage,proof:returnRefundScanResumeProof});`,state);
  if(mode==='adopted'){await state.adopt();assert.equal(state.pddPage,list,'the actual selection policy adopts the sole live PDD business page');}
  if(mode==='closed')await list.close();
  return {state,context,anchor,list,outputs,requests,created:()=>created};
 };
 for(const mode of ['adopted','separate','closed']){
  const f=await fixture(mode);await f.state.scan();
  const retained=f.state.scanState().page;
  assert(retained!==f.state.pddPage,'REFUND_SCAN_MUST_NOT_ALIAS_ADOPTED_PERMANENT_ANCHOR');
  assert.equal(retained.url(),RETURN_REFUND_WORKBENCH_URL);
  assert.equal(f.created(),mode==='separate'?0:1);
  assert.equal(f.state.pddPage.isClosed(),false,'login recovery anchor must remain available');
  await f.state.pddPage.goto('https://mms.pinduoduo.com/aftersales/work_order/list');
  const before=f.requests.length;
  f.state.activeReturnRefundCommand.scanCursor={page:2,itemOffset:1};
  await f.state.scan();
  assert.equal(f.outputs[1].scan.resumeCheck.resumed,true,'the actual collector revalidates and resumes the separate retained list');
  assert.equal(f.outputs[1].scan.listResponseDiagnostics.rowsSkippedKnownWait,1);
  assert.equal(f.requests.length,before,'ordinary anchor navigation must not cause another refund list navigation');
  assert.equal(f.created(),mode==='separate'?0:1,'the following batch must reuse its existing dedicated list');
  assert.equal(await retained.evaluate(()=>document.querySelectorAll('article').length),4);
  assert.equal(f.state.pddPage.isClosed(),false);
  await f.context.close();cases+=1;
 }
 console.log(`Refund scan anchor adoption passed (${cases} intercepted browser scenarios; actual anchor selection and resumed collector)`);
}finally{await browser.close();}
