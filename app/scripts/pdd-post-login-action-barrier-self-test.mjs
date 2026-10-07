import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { installLoginActionBarrier } from '../packages/adapters/src/pdd/login-action-barrier.mjs';
import { createPddPostLoginRecoveryPacing } from '../packages/adapters/src/pdd/post-login-recovery-pacing.mjs';
import { hasUsablePddSessionCookie } from '../packages/adapters/src/browser-auth-state.mjs';
import { isSystemLoginUrl, isAuthenticatedSystemUrl } from '../packages/adapters/src/browser-runtime-state.mjs';
const source = fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
};
const helpers = section('const isPddBusinessPageForBarrier =', 'const readLogisticsWaitQueue =');
const manualCode = section('const waitForPddManualLoginExit =', 'const waitForLoginExit =');
const observerCode = section('const observeResidentRuntimeState =', 'const checkpointTimer =');
const business = 'https://mms.pinduoduo.com/aftersales/work_order/list';
const login = 'https://mms.pinduoduo.com/login/';
const fixture = `<style>body{height:2400px}</style><button id="filter">筛选</button><input id="text"><input id="radio" type="radio"><select id="select"><option value="a">a</option><option value="b">b</option></select><div id="scroll" style="margin-top:1800px">bottom</div><script>window.events=[];window.docId=Math.random();for(const type of ['click','input','change','keydown','wheel','scroll'])document.addEventListener(type,()=>window.events.push({type,at:Date.now()}),true)</script>`;
const browser = await chromium.launch({ headless:true, executablePath:process.env.PDD_BROWSER_EXECUTABLE_PATH });
let checks = 0;
try {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
  const page = await context.newPage();
  await page.goto(login);
  const rawEvaluate = page.mainFrame().evaluate.bind(page.mainFrame());
  const rawGoto = page.mainFrame().goto.bind(page.mainFrame());
  let progress = { step:'manual-login-required', authHealth:{pdd:{status:'expired'}} };
  const writes = [];
  const recoveryPacing = createPddPostLoginRecoveryPacing({ intervalMs: 120, durationMs: 3000 });
  const pacedStarts = [];
  const scope = vm.createContext({
    isSystemLoginUrl, isAuthenticatedSystemUrl, setTimeout, pddPostLoginStabilityMs:10000, pddLoginMode:'manual',
    context, hasUsablePddSessionCookie, expectedMallId:'', updateAuthHealth(){},
    pddPostLoginRecoveryPacing:recoveryPacing,
    pddPostLoginRecoveryIntervalMs:120, pddPostLoginRecoveryDurationMs:3000,
    shopId:'offline-fixture', console:{log(){}}, PddLoginRequiredError:Error,
    readProgress:()=>progress, writeProgress:patch=>{progress={...progress,...patch};writes.push(patch);return progress;},
    pddPage:page, workflowStopping:false,browserFailureExiting:false,browser:{isConnected:()=>true},
  });
  const api = vm.runInContext(`let pddPostLoginBarrier=null,pddPostLoginBarrierPromise=null,pddPostLoginBarrierPromiseBarrier=null;
    let pddManualLoginWaits=0,pddPostLoginStabilityWaits=0,runtimeObservationBusy=false;
    ${helpers}\n${observerCode}\n({attach:attachPddPostLoginBarrierListener,wait:waitForPddPostLoginBarrier,observe:observeResidentRuntimeState})`,scope);
  const guard=installLoginActionBarrier(context, async (p,operation)=>{
    await api.wait(p,operation);
    if (await recoveryPacing.beforeOperation(p,operation)) pacedStarts.push({operation,at:Date.now()});
  });
  await guard.ready;
  api.attach(page);
  let earlyClickAt=null;
  const earlyClick=page.getByRole('button',{name:'筛选'}).click({timeout:30000}).then(()=>{earlyClickAt=Date.now()});
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(earlyClickAt,null,'Queued click ran on the login surface');
  // Emulate the user's successful login via a raw navigation, not the automation APIs.
  await rawGoto(business);
  await context.addCookies([{ name:'windows_app_shop_token_23', value:'fixture',
    domain:'.pinduoduo.com', path:'/', expires:Math.floor(Date.now()/1000)+3600 }]);
  const startedAt = Date.parse(progress.pddPostLoginStability.startedAt);
  const documentId = await rawEvaluate(()=>window.docId);
  const attempts = [];
  const operations = [
    ['click',()=>page.getByRole('button',{name:'筛选'}).click()],
    ['fill',()=>page.locator('#text').fill('held')],
    ['select',()=>page.locator('#select').selectOption('b')],
    ['check',()=>page.locator('#radio').check()],
    ['scroll',()=>page.locator('#scroll').scrollIntoViewIfNeeded()],
    ['keyboard',()=>page.keyboard.press('Tab')],
    ['mouse',()=>page.mouse.move(20,20)],
    ['evaluate',()=>page.evaluate(()=>{window.changedByAutomation=true})],
    ['screenshot',()=>page.screenshot()],
    ['observer',()=>api.observe()],
  ];
  const pending = operations.map(([name,action])=>action().then(()=>attempts.push({name,at:Date.now()})));
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(attempts.length,0,'An action escaped during the barrier');
  assert.equal(page.url(),business);
  assert.equal(await rawEvaluate(()=>window.docId),documentId);
  assert.deepEqual(await rawEvaluate(()=>({events:window.events,changed:!!window.changedByAutomation})),{events:[],changed:false});
  await Promise.all([...pending,earlyClick]);
  assert(earlyClickAt-startedAt>=10000,'An action queued before login escaped the barrier');
  checks++;
  for (const action of attempts) assert(action.at-startedAt>=10000,JSON.stringify(action));
  const events=await rawEvaluate(()=>window.events);
  for(const event of events) assert(event.at-startedAt>=10000,JSON.stringify(event));
  assert.equal(progress.pddPostLoginStability.status,'completed');
  assert(pacedStarts.length >= 5, 'Post-login business interactions were not paced');
  for (let index = 1; index < pacedStarts.length; index++) {
    assert(pacedStarts[index].at - pacedStarts[index-1].at >= 100,
      `Recovery interactions were too close: ${JSON.stringify(pacedStarts.slice(index-1,index+1))}`);
  }
  checks+=operations.length;
  // Second login tests that an earlier completion cannot disable a new wait.
  await rawGoto(login);
  await rawGoto(business);
  const secondStart=Date.parse(progress.pddPostLoginStability.startedAt);
  let navigated=false;
  const navigation=page.goto(business+'?next=1').then(()=>{navigated=true;return Date.now()});
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(navigated,false);assert.equal(page.url(),business);
  const navigationAt=await navigation;
  assert(navigationAt-secondStart>=10000);
  checks++;
  const blockedWrites=[];
  let blockedUrl=business;
  let blockedProgress={step:'manual-login-required',authHealth:{pdd:{status:'expired'}}};
  let blockedPacingStarts=0;
  const blockedScope=vm.createContext({
    isSystemLoginUrl,isAuthenticatedSystemUrl,setTimeout,pddPostLoginStabilityMs:20,pddLoginMode:'manual',
    context:{cookies:async()=>[]},hasUsablePddSessionCookie,expectedMallId:'',
    updateAuthHealth:(system,status,page,details)=>{
      blockedProgress.authHealth={...blockedProgress.authHealth,[system]:{status,...details}};
    },
    pddPostLoginRecoveryPacing:{start(){blockedPacingStarts++}},
    pddPostLoginRecoveryIntervalMs:120,pddPostLoginRecoveryDurationMs:3000,
    shopId:'expired-fixture',console:{log(){}},
    PddLoginRequiredError:class extends Error {
      constructor(stage,url,reason){super(reason);this.stage=stage;this.url=url;}
    },
    readProgress:()=>blockedProgress,writeProgress:patch=>{
      blockedProgress={...blockedProgress,...patch};blockedWrites.push(patch);return blockedProgress;
    },
  });
  const blockedWait=vm.runInContext(`let pddPostLoginBarrier=null,pddPostLoginBarrierPromise=null,pddPostLoginBarrierPromiseBarrier=null;
    ${helpers}\nwaitForPddPostLoginBarrier`,blockedScope);
  const returnedToLogin=blockedWait({url:()=>blockedUrl,isClosed:()=>false},'expired-login',{force:true});
  setTimeout(()=>{blockedUrl=login},5);
  await assert.rejects(returnedToLogin,/重新返回登录页/);
  assert.equal(blockedProgress.step,'pdd-post-login-stabilizing');
  assert.notEqual(blockedProgress.authHealth.pdd.evidence,'session-cookie-unusable');
  assert.equal(blockedPacingStarts,0,'A real login page must not start post-login actions');
  assert(blockedWrites.some(write=>write.pddPostLoginStability?.status==='waiting'));
  checks++;
  await rawEvaluate(() => localStorage.setItem('new_userinfo', JSON.stringify({mall_id:'123456789'})));
  let liveProgress={step:'manual-login-required',authHealth:{pdd:{status:'expired'}}};
  const liveContext={
    cookies:async()=>[],
    request:{get:async()=>({ok:()=>true,json:async()=>({
      success:true,errorCode:1000000,result:{permissionList:[]},
    })})},
  };
  const liveScope=vm.createContext({
    isSystemLoginUrl,isAuthenticatedSystemUrl,setTimeout,pddPostLoginStabilityMs:20,
    pddLoginMode:'manual',context:liveContext,hasUsablePddSessionCookie,
    expectedMallId:'123456789',
    pddMallIdentityFromUserInfo:(value)=>({mallId:JSON.parse(value).mall_id}),
    updateAuthHealth(){},pddPostLoginRecoveryPacing:{start(){}},
    pddPostLoginRecoveryIntervalMs:120,pddPostLoginRecoveryDurationMs:3000,
    shopId:'live-api-fixture',console:{log(){}},PddLoginRequiredError:Error,
    readProgress:()=>liveProgress,writeProgress:patch=>{liveProgress={...liveProgress,...patch};return liveProgress},
  });
  const liveApi=vm.runInContext(`let pddPostLoginBarrier=null,pddPostLoginBarrierPromise=null,pddPostLoginBarrierPromiseBarrier=null;
    ${helpers}\n({probe:pddBusinessPageMatchesExpectedMall,wait:waitForPddPostLoginBarrier})`,liveScope);
  assert.equal(await liveApi.probe(page,{force:true}),true);
  await liveApi.wait(page,'live-api-without-shop-cookie',{force:true});
  assert.equal(liveProgress.pddPostLoginStability.status,'completed');
  await rawEvaluate(() => localStorage.setItem('new_userinfo', JSON.stringify({mall_id:'wrong-shop'})));
  assert.equal(await liveApi.probe(page),false,'a wrong mall must not be accepted before a write');
  checks++;
  // Login completed while waiting for another shop's focus lock.
  let focusWaited=false;
  const quickScope=vm.createContext({
    shopId:'focus-race',isPddBusinessPageForBarrier:(candidate)=>Boolean(candidate),
    context:{pages:()=>[]},pddPage:page,selectLivePddPage:()=>null,
    pddBusinessPageMatchesExpectedMall:async()=>false,
    resolveSystemLoginPage:async p=>p,
    verificationFocusCoordinator:{acquire:async()=>({acquired:false})},
    waitForPddPostLoginBarrier:async(p,stage,options)=>{assert.equal(options.force,true);focusWaited=true;return p;},
  });
  const manual=vm.runInContext(`${manualCode}\nwaitForPddManualLoginExit`,quickScope);
  assert.equal(await manual(page,()=>false,'pdd-manual-login'),page);
  assert.equal(focusWaited,true);checks++;
  console.log(JSON.stringify({passed:true,checks,firstActionAfterMs:Math.min(...attempts.map(x=>x.at))-startedAt,secondLoginNavigationAfterMs:navigationAt-secondStart,allActionsHeld:true,observerHeld:true,focusRaceHeld:true}));
} finally {await browser.close();}
