import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||'workflow.mjs','utf8');
const start=source.indexOf('const runRestoredVerificationRecoveryOnly =');
const end=source.indexOf('const completeFailedVerificationRecoveryCommand =',start);
assert(start>0&&end>start,'Recovery implementation not found');
const implementation=source.slice(start,end);
const listUrl='https://mms.pinduoduo.com/aftersales/work_order/list';
const detailUrl='https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=100';
const loginUrl='https://mms.pinduoduo.com/login';
const stop=new Error('stop at first verification wait');
async function firstWait({url=detailUrl,anchorUrl=listUrl,existing=true}={}){
 const calls={created:0,navigated:[],waited:null,closedLogin:false,protected:[]};
 const makePage=(initialUrl)=>{let current=initialUrl;return{url:()=>current,isClosed:()=>false,goto:async next=>{calls.navigated.push(next);current=next;}};};
 const anchor=makePage(anchorUrl),original=makePage(url),pages=existing?[anchor,original]:[anchor];
 const context={
  activeVerificationRecoveryCommand:{url,stage:'verification-recovery',verificationId:'v1'},
  validatedPddVerificationRecoveryUrl:value=>value.startsWith('https://mms.pinduoduo.com/')?value:null,
  isSystemLoginUrl:(_system,value)=>value.startsWith(loginUrl),
  isAuthenticatedSystemUrl:(_system,value)=>value.startsWith('https://mms.pinduoduo.com/')&&!value.startsWith(loginUrl),
  listUrl,pddPage:anchor,context:{pages:()=>pages},pddRenderWaitMs:30000,
  writeRestoredVerificationRecovery:()=>{},
  closeStaleSystemLoginPages:async()=>{calls.closedLogin=true;},
  createBackgroundPage:async()=>{calls.created++;return makePage('about:blank');},
  registerDerivedPage:page=>page,closeDeviceAccessIfPrompted:async()=>{},persistSystemTabs:()=>{},
  protectVerificationRecoveryPage:(page,id)=>calls.protected.push({page,id}),
  releaseVerificationRecoveryPages:()=>{},
  navigateSystemPage:async(page,next)=>{
   assert.equal(context.activeVerificationRecoveryPage,page,
    'New recovery tab must be protected before navigation begins');
   assert(calls.protected.some(item=>item.page===page&&item.id==='v1'),
    'New recovery tab must retain its verification identity before navigation');
   return page.goto(next);
  },
  waitForRestoredVerificationClear:async page=>{calls.waited=page;throw stop;},
 };
 const run=vm.runInNewContext(`${implementation}\nrunRestoredVerificationRecoveryOnly;`,context);
 await assert.rejects(run,error=>error===stop);
 return{calls,anchor,original};
}

const business=await firstWait();
assert.equal(business.calls.waited,business.original,'LIVE_CHALLENGE_PAGE_SKIPPED_FOR_CLEAR_ANCHOR');
assert.equal(business.calls.created,0,'Never duplicate a live challenge tab');
assert.deepEqual(business.calls.navigated,[],'Do not reload either page during verification recovery');
assert.equal(business.calls.closedLogin,false,'Business recovery is not stale login cleanup');

const staleLogin=await firstWait({url:loginUrl});
assert.equal(staleLogin.calls.waited,staleLogin.anchor,'An already authenticated anchor supersedes stale login recovery');
assert.equal(staleLogin.calls.closedLogin,false,'A business URL alone must not close the live login tab during recovery');
assert.equal(staleLogin.calls.created,0);
assert.deepEqual(staleLogin.calls.navigated,[]);

const actualLogin=await firstWait({url:loginUrl,anchorUrl:loginUrl});
assert.equal(actualLogin.calls.waited,actualLogin.anchor,'Keep the existing exact login page');
assert.equal(actualLogin.calls.created,0);
assert.deepEqual(actualLogin.calls.navigated,[]);

const missingBusiness=await firstWait({existing:false});
assert.equal(missingBusiness.calls.created,1,'Recreate only the missing business recovery page');
assert.deepEqual(missingBusiness.calls.navigated,[detailUrl]);
assert.notEqual(missingBusiness.calls.waited,missingBusiness.anchor);
assert(missingBusiness.calls.protected.some(item=>item.page===missingBusiness.calls.waited),
 'Recreated challenge tab must be protected before its first wait');

const anchorBusiness=await firstWait({anchorUrl:detailUrl});
assert.equal(anchorBusiness.calls.waited,anchorBusiness.anchor,'Reuse an exact challenge already hosted by the anchor');
assert.equal(anchorBusiness.calls.created,0);
assert.deepEqual(anchorBusiness.calls.navigated,[]);

const cleanupStart=source.indexOf('const closeStaleSystemLoginPages =');
const cleanupEnd=source.indexOf('const resolveSystemLoginPage =',cleanupStart);
assert(cleanupStart>0&&cleanupEnd>cleanupStart,'Stale-login cleanup implementation not found');
const observerAnchor={isClosed:()=>false,url:()=>listUrl};
let loginClosed=false;
const redirectedLogin={isClosed:()=>loginClosed,url:()=>loginUrl};
const cleanupContext={
 activeVerificationRecoveryCommand:{verificationId:'v1'},
 pddManualLoginWaits:0,pddPostLoginStabilityWaits:0,
 waitForPddPostLoginBarrier:async()=>{},
 pagesForVerificationScan:()=>[observerAnchor,redirectedLogin],
 derivedPages:new Set([redirectedLogin]),
 closeDerivedPage:async()=>{loginClosed=true;},
};
const cleanup=vm.runInNewContext(`${source.slice(cleanupStart,cleanupEnd)}\ncloseStaleSystemLoginPages;`,cleanupContext);
await cleanup(observerAnchor,'pdd',url=>url.startsWith(loginUrl),'pdd-resident-authenticated-anchor-cleanup');
assert.equal(loginClosed,false,'Observer must preserve a login redirect owned by verification recovery');
await cleanup(observerAnchor,'pdd',url=>url.startsWith(loginUrl),'pdd-login-recovery');
assert.equal(loginClosed,false,'Login recovery must preserve the operator tab during verification recovery');
await cleanup(observerAnchor,'pdd',url=>url.startsWith(loginUrl),'pdd-verification-restart-authenticated-anchor');
assert.equal(loginClosed,false,'Restart recovery must preserve the exact login tab');
cleanupContext.activeVerificationRecoveryCommand=null;
await cleanup(observerAnchor,'pdd',url=>url.startsWith(loginUrl),'pdd-resident-authenticated-anchor-cleanup');
assert.equal(loginClosed,true,'Ordinary stale-login cleanup remains available after recovery ends');

const closeStart=source.indexOf('const closeDerivedPage =');
const closeEnd=source.indexOf('\nfor (const page of initialPages)',closeStart);
assert(closeStart>0&&closeEnd>closeStart,'Derived-page close implementation not found');
const recoveryTab={closeCalls:0,isClosed:()=>false,close(){this.closeCalls++;return Promise.resolve();}};
const pageSet=new Set([recoveryTab]);
const pageMeta=new Map([[recoveryTab,{purpose:'pdd-verification-restart-recovery'}]]);
const closeContext={
 derivedPages:pageSet,derivedPageMeta:pageMeta,
 deliberateDerivedPageCloses:new WeakMap(),
 verificationRecoveryProtectedPages:new Map(),
 activeVerificationRecoveryCommand:{verificationId:'v1'},
 activeVerificationRecoveryPage:recoveryTab,
};
const {closeDerivedPage:close,protectVerificationRecoveryPage:protect,
 releaseVerificationRecoveryPages:release}=vm.runInNewContext(
 `${source.slice(closeStart,closeEnd)}\n({closeDerivedPage,protectVerificationRecoveryPage,releaseVerificationRecoveryPages});`,
 closeContext);
protect(recoveryTab,'v1');
await close(recoveryTab);
assert.equal(recoveryTab.closeCalls,0,'Concurrent cleanup must preserve the exact challenge tab');
assert.equal(pageSet.has(recoveryTab),true,'Protected challenge tab must remain registered');
closeContext.activeVerificationRecoveryCommand=null;
closeContext.activeVerificationRecoveryPage=null;
await close(recoveryTab);
assert.equal(recoveryTab.closeCalls,0,
 'A failed recovery must keep its challenge tab protected after resident assignment reset');
await close(recoveryTab,{allowVerificationRecoveryClose:true});
assert.equal(recoveryTab.closeCalls,1,'Verified-clear path may close its completed challenge tab');
assert.equal(pageSet.has(recoveryTab),false,'Completed challenge tab must leave the derived-page set');
const releasedTab={closeCalls:0,isClosed:()=>false,close(){this.closeCalls++;return Promise.resolve();}};
pageSet.add(releasedTab);
protect(releasedTab,'v1');
release('v1');
await close(releasedTab);
assert.equal(releasedTab.closeCalls,1,'Confirmed-clear release must restore normal cleanup');

const failureStart=source.indexOf('const completeFailedVerificationRecoveryCommand =');
const failureEnd=source.indexOf('const runReturnRefundClaimOnly =',failureStart);
assert(failureStart>0&&failureEnd>failureStart,'Failed recovery implementation not found');
const loginTab={isClosed:()=>false,url:()=>loginUrl};
const retained=new Map();
const failureContext={
 activeVerificationRecoveryCommand:{verificationId:'v2',stage:'verification-recovery'},
 activeVerificationRecoveryPage:recoveryTab,
 context:{pages:()=>[loginTab]},
 residentCommandFailureStatus:()=> 'verification-required',
 protectVerificationRecoveryPage:(page,id)=>retained.set(page,id),
 isSystemLoginUrl:(_system,url)=>url.startsWith(loginUrl),
 readProgress:()=>({currentUrl:loginUrl}),
 writeRestoredVerificationRecovery:()=>{},
 persistBrowserAuth:async()=>{},
 resetResidentAssignment:()=>{},
};
const failedRecovery=vm.runInNewContext(
 `${source.slice(failureStart,failureEnd)}\ncompleteFailedVerificationRecoveryCommand;`,
 failureContext,
);
await failedRecovery(new Error('verification still present'));
assert.equal(retained.get(recoveryTab),'v2','Failed recovery must retain the exact challenge tab');
assert.equal(retained.get(loginTab),'v2','Failed recovery must retain the live PDD login tab');

console.log('VERIFICATION_RECOVERY_PAGE_SELF_TEST_OK');
