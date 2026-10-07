import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';

const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const filterStart=source.indexOf('const findTmsFilterPanel = async');
const filterEnd=source.indexOf('\nconst readTmsRowIdentity = async',filterStart);
const helperStart=source.indexOf('const withUnblockedTmsReadOnlyQueryPage = async');
const reconciliationStart=helperStart>=0?helperStart:source.indexOf('const reconcileTmsCreateState = async');
const reconciliationEnd=source.indexOf('\nconst selectKnownTmsRow = async',reconciliationStart);
const policyStart=source.indexOf('const tmsCreateReconciliationSelectionPolicy =');
const policyEnd=source.indexOf('\n};',policyStart)+3;
assert(filterStart>=0&&filterEnd>filterStart&&reconciliationStart>=0&&reconciliationEnd>reconciliationStart&&policyStart>=0);
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
const orderNumber='260927-321378096762763';
const tmsLogisticsUrl='https://tms.aipro123.top/logistics';
let passed=0;
try {
  for(const fixture of [
    {name:'normal page',blocked:false,expected:'confirmed',created:0},
    {name:'unknown create with visible business form',blocked:true,expected:'confirmed',created:1},
    {name:'hidden form',blocked:false,hidden:true,expected:'confirmed',created:0},
    {name:'exact query confirms zero twice',blocked:true,empty:true,expected:'not-applied',created:1},
    {name:'identity mismatch remains unresolved',blocked:true,mismatch:true,expected:'unresolved',created:1},
    {name:'query failure retains uncertainty',blocked:true,httpError:true,error:/HTTP 502/u,created:1},
    {name:'original challenge is never bypassed',blocked:true,originalChallenge:true,error:/verification/u,created:0},
    {name:'new query challenge is retained',blocked:true,queryChallenge:true,error:/verification/u,created:1,keep:true},
    {name:'new query login page is retained',blocked:true,queryLogin:true,error:/manual login/u,created:1,keep:true},
  ]) {
    const context=await browser.newContext();
    let mainPage,created=0,queryRequests=0,writeRequests=0,buttonWrites=0;
    const protectedPages=new Set();
    const derivedPages=new Set();
    const derivedPageMeta=new Map();
    const unknownEffect=Object.freeze({status:'unknown',idempotencyKey:'same-protected-create'});
    let progress={shopId:'fixture-shop',orderNumber,scenarioCode:'intercept-recall',tmsFormDecision:{problemType:'拦截退回'}};
    const html=(isQuery)=>`<!doctype html><meta charset="utf-8"><style>
      .el-overlay {position:fixed;inset:0;z-index:30;background:#ddd}
      .filter-panel {width:500px;height:100px}
    </style><div class="filter-panel"><label>交易号<input></label>
      <button onclick="fetch('/api/logistics/tickets?tradeId='+document.querySelector('.filter-panel input').value)">应用</button>
    </div><div class="table-container"><div class="el-table__body-wrapper"><table><tbody>
      ${fixture.empty?'':`<tr><td>${orderNumber}</td><td>L123</td></tr>`}
    </tbody></table></div></div>
    ${(!isQuery&&(fixture.blocked||fixture.hidden))?`<div class="el-overlay el-modal-dialog" ${fixture.hidden?'style="display:none"':''}>
      <div role="dialog"><form class="logistics-form"><input id="unfinished" value="保留未确认表单">
        <button type="button" onclick="window.recordWrite()">保存</button>
      </form></div></div>`:''}
    ${(!isQuery&&fixture.originalChallenge)||(isQuery&&fixture.queryChallenge)?'<div id="challenge">verification fixture</div>':''}`;
    await context.route('**/*',async route=>{
      if(!route.request().url().startsWith('https://tms.aipro123.top/'))return route.abort();
      if(route.request().method()!=='GET'){writeRequests++;return route.abort();}
      if(route.request().url().includes('/api/logistics/tickets')){
        queryRequests++;
        return route.fulfill({status:fixture.httpError?502:200,contentType:'application/json',body:JSON.stringify({success:!fixture.httpError})});
      }
      const isQuery=route.request().frame().page()!==mainPage;
      return route.fulfill({contentType:'text/html;charset=utf-8',body:html(isQuery)});
    });
    mainPage=await context.newPage();
    await mainPage.exposeFunction('recordWrite',()=>{buttonWrites++;});
    await mainPage.goto(tmsLogisticsUrl);
    mainPage.setDefaultTimeout(350);
    const firstVisible=async candidates=>{
      for(const locator of candidates)if(await locator.count().catch(()=>0)&&await locator.first().isVisible().catch(()=>false))return locator.first();
      return null;
    };
    class HumanVerificationRequiredError extends Error {}
    const hasHumanVerification=async page=>await page.locator('#challenge').isVisible();
    const sandbox={console,Date,URL,Number,Math,shopId:'fixture-shop',context,tmsBaseUrl:'https://tms.aipro123.top',tmsLogisticsUrl,
      activeScenarioCode:'intercept-recall',activeWorkOrderType:'拦截召回',firstVisible,
      tmsPage:mainPage,derivedPages,derivedPageMeta,
      monitorSystemPage:(_system,page)=>page,persistSystemTabs:()=>{},
      isExtendedOrdinaryScenario:()=>false,matchingScenarioForTitle:()=>null,
      readProgress:()=>progress,writeProgress:patch=>{progress={...progress,...patch};},logRunStep:()=>{},
      tmsFormItem:panel=>panel,pacedAction:async(_page,_stage,action)=>action(),
      createBackgroundPage:async()=>{created++;const page=await context.newPage();page.setDefaultTimeout(350);return page;},
      registerDerivedPage:(page,purpose)=>{derivedPages.add(page);derivedPageMeta.set(page,{...derivedPageMeta.get(page),purpose});return page;},protectVerificationRecoveryPage:page=>protectedPages.add(page),
      closeDerivedPage:async page=>{if(derivedPageMeta.get(page)?.preserveUnconfirmedTmsForm)return;assert.notEqual(page,mainPage);if(!protectedPages.has(page))await page.close();},
      navigateSystemPage:async(page,url)=>page.goto(fixture.queryLogin&&page!==mainPage
        ?'https://tms.aipro123.top/login/':url,{waitUntil:'domcontentloaded',timeout:3000}),
      openTmsCustomerRegistration:async page=>{
        if(page.url().includes('/login/'))throw new Error('manual login fixture');
        if(await hasHumanVerification(page)){
          progress.verificationLocation={id:'fixture-verification',system:'tms',url:page.url()};
          throw new HumanVerificationRequiredError('verification fixture');
        }
      },
      checkForHumanVerification:async page=>{if(await hasHumanVerification(page))throw new HumanVerificationRequiredError('verification fixture');},
      hasHumanVerification,isSystemLoginUrl:(_system,url)=>url.includes('/login/'),
      closeUnexpectedTmsPopups:async()=>{},pauseForTransientRetry:async(_p,_s,code,reason)=>{throw Object.assign(new Error(reason),{code});},
      HumanVerificationRequiredError,PddLoginRequiredError:class extends Error {},RateLimitPauseError:class extends Error {},
      ManualReviewRequiredError:class extends Error {},LogisticsRetryRequiredError:class extends Error {},
      identifyExistingTmsTicket:async(selection,requested)=>{
        assert.equal(requested,orderNumber);
        assert.match(await selection.row.innerText(),new RegExp(orderNumber));
        return {status:fixture.mismatch?'mismatch':'matched',reason:'fixture mismatch',ticketId:'123',ticketNo:'L123',identity:{tradeId:orderNumber}};
      },
    };
    vm.runInNewContext(source.slice(policyStart,policyEnd)+'\n'+source.slice(filterStart,filterEnd)+'\n'
      +source.slice(reconciliationStart,reconciliationEnd)+'\nglobalThis.reconcileForTest=reconcileTmsCreateState;',sandbox);
    try {
      if(fixture.error)await assert.rejects(sandbox.reconcileForTest(mainPage,orderNumber),fixture.error,fixture.name);
      else {
        const observation=await sandbox.reconcileForTest(mainPage,orderNumber);
        assert.equal(observation.state,fixture.expected,fixture.name);
        assert.equal(observation.readOnly,true);
        assert.equal(observation.orderNumber,orderNumber);
      }
      assert.equal(created,fixture.created,fixture.name);
      assert.equal(mainPage.isClosed(),false);
      if(fixture.blocked||fixture.hidden)assert.equal(await mainPage.locator('#unfinished').inputValue(),'保留未确认表单');
      assert.equal(buttonWrites,0);assert.equal(writeRequests,0);
      assert.equal(unknownEffect.status,'unknown');
      const confirmedAnchor=fixture.blocked&&fixture.expected==='confirmed';
      assert.equal(context.pages().length,fixture.keep||confirmedAnchor?2:1,fixture.name);
      if(confirmedAnchor){
        assert.notEqual(sandbox.tmsPage,mainPage,'subsequent evidence uses the unobstructed confirmed query anchor');
        assert.equal(derivedPageMeta.get(mainPage)?.preserveUnconfirmedTmsForm,true);
        const followup=await sandbox.reconcileForTest(sandbox.tmsPage,orderNumber);
        assert.equal(followup.state,'confirmed');
        assert.equal(created,1,'the next read-only follow-up must not create another tab');
        const closeStart=source.indexOf('const closeDerivedPage = async');
        const closeEnd=source.indexOf('\nconst protectVerificationRecoveryPage =',closeStart);
        const closeSandbox={derivedPages,derivedPageMeta};
        vm.runInNewContext(source.slice(closeStart,closeEnd)+'\nglobalThis.close=closeDerivedPage;',closeSandbox);
        await closeSandbox.close(mainPage);
        assert.equal(mainPage.isClosed(),false,'normal cleanup preserves the original business form');
      }
      if(fixture.empty)assert.equal(queryRequests,2,'zero requires both original and refreshed exact queries');
      if(fixture.originalChallenge)assert.equal(queryRequests,0);
      passed++;
    } finally {await context.close();}
  }
  console.log(`TMS read-only modal reconciliation passed (${passed} isolated browser cases; no writes, original forms preserved)`);
}finally{await browser.close();}
