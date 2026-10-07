import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { isAuthenticatedSystemUrl, isSystemLoginUrl } from '../packages/adapters/src/browser-runtime-state.mjs';
import { closeTimedOutVerificationModal } from '../packages/adapters/src/verification-detector/expired-modal.mjs';

const source = fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
};
const policy = section('const pddLoginVerificationOrigins =', 'const closeDeviceAccessIfPrompted =');
const closeCode = section('const verificationCloseInFlight =', '// The image-selection modal is intentionally handled');
const qrCode = section('const pddQrRefreshState =', 'const ensurePddLogin =');
const promptCode = section('const closeHumanVerificationPrompt =', 'const verificationCloseInFlight =');
const deviceCode = section('const closeDeviceAccessIfPrompted =', '// Close only a verified CAPTCHA');
const releaseCode = section('const releaseImageClickVerificationAfterClose =', '// A manual-login loop');
const expireCode = section('const expireResidentVerificationIfOverdue =', 'class HumanVerificationRequiredError');
const loginUrl = 'https://mms.pinduoduo.com/login/?redirectUrl=%2Faftersales%2Fwork_order%2Flist';
const businessUrl = 'https://mms.pinduoduo.com/aftersales/work_order/list';
const fixture = `<section role="dialog" style="position:absolute;left:200px;top:150px;width:320px;height:220px">
<button class="modal-close" aria-label="关闭" style="position:absolute;right:-15px;top:-15px;width:30px;height:30px" onclick="window.closeClicks++;this.parentElement.remove()">×</button>
<div class="captcha-panel" style="margin:24px;width:272px;height:160px;background:#eee"><p>验证时间过长，请重试</p></div></section>
<script>window.closeClicks=0;window.documentId=Math.random()</script>`;
const browser = await chromium.launch({ headless: true, ...(process.env.PDD_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.PDD_BROWSER_EXECUTABLE_PATH } : {}) });
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.route('https://mms.pinduoduo.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
  const scope = { isSystemLoginUrl, closeTimedOutVerificationModal,
    imageClickVerificationAutoCloseEnabled: false, businessVerificationAutoCloseEnabled: false };
  const api = vm.runInNewContext(`${policy}\n${closeCode}\n${promptCode}\n${qrCode}\n${deviceCode}\n${releaseCode}\n${expireCode}\n({
    close:closeHumanVerificationSurface, prompt:closeHumanVerificationPrompt, qr:refreshExpiredPddQr,
    device:closeDeviceAccessIfPrompted, release:releaseImageClickVerificationAfterClose,
    expire:expireResidentVerificationIfOverdue, protected:isManualPddLoginSurface,
    origins:pddLoginVerificationOrigins
  });`, scope);
  await page.goto(loginUrl);
  const initialDocument = await page.evaluate(() => window.documentId);
  assert.equal((await api.close(page)).reason, 'pdd-login-manual-only');
  assert.equal((await api.prompt(page)).reason, 'pdd-login-manual-only');
  assert.equal(await api.device(page), false);
  assert.equal(await api.qr(page), false);
  assert.equal((await api.release({ page, system: 'pdd', allowBusinessVerification: true })).released, false);
  assert.equal(await api.expire({ located: { page }, progress: { verificationLocation: { detectedAt: '2000-01-01' } } }), false);
  assert.equal(await page.locator('[role="dialog"]').count(), 1);
  assert.equal(await page.evaluate(() => window.closeClicks), 0);
  assert.equal(await page.evaluate(() => window.documentId), initialDocument);
  assert.equal(page.url(), loginUrl);
  checks += 6;

  // A business-page challenge also remains open for the operator.
  await page.goto(businessUrl);
  assert.equal(api.protected(page), false);
  const closed = await api.close(page);
  assert.equal(closed.closed, false, JSON.stringify(closed));
  assert.equal(closed.reason, 'verification-auto-close-disabled');
  assert.equal(await page.evaluate(() => window.closeClicks), 0);
  assert.equal(page.url(), businessUrl);
  checks++;

  const origin = { url: () => loginUrl, isClosed: () => false };
  const popup = { url: () => 'https://mms.pinduoduo.com/security-check', isClosed: () => false };
  api.origins.set(popup, { page: origin, url: popup.url() });
  assert.equal(api.protected(popup), true);
  origin.url = () => businessUrl;
  assert.equal(api.protected(popup), false, 'Login protection must end when its origin is authenticated');
  assert.equal(api.protected({ url: () => 'https://www.jeoms.com/xianma/login', isClosed: () => false }), false);
  checks++;

  // Exercise the real post-login wait on one unchanged document for ten seconds.
  const barrierCode = section('const isPddBusinessPageForBarrier =', 'const readLogisticsWaitQueue =');
  const stabilityCode = section('const waitForPddPostLoginStability =', 'const waitForPddManualLoginExit =');
  const observerSection = section('const observeResidentRuntimeState =', 'const runtimeObservationTimer =');
  const observerCode = observerSection.slice(0, observerSection.indexOf('\n};') + 3);
  const stabilityScope = vm.createContext({ pddPostLoginStabilityMs: 10_000, isSystemLoginUrl,
    isAuthenticatedSystemUrl, shopId: 'test', console: { log() {} },
    context: { cookies: async () => [] }, hasUsablePddSessionCookie: () => true,
    updateAuthHealth() {},
    pddPostLoginRecoveryPacing: { start() {} },
    pddPostLoginRecoveryIntervalMs: 120, pddPostLoginRecoveryDurationMs: 3000,
    writeProgress: value => progress.push(value), readProgress: () => progress.at(-1) || {},
    PddLoginRequiredError: Error, setTimeout });
  const progress = [];
  const stability = vm.runInContext(`let pddManualLoginWaits=0; let pddPostLoginStabilityWaits=0;
    let pddPostLoginBarrier=null; let pddPostLoginBarrierPromise=null;
    ${barrierCode}\n${stabilityCode}\n${observerCode}\n({wait:waitForPddPostLoginStability,observe:observeResidentRuntimeState,
      mark:markPddLoginTransition, active:()=>pddPostLoginStabilityWaits});`, stabilityScope);
  const stabilityPage = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await stabilityPage.route('https://mms.pinduoduo.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
  await stabilityPage.goto(businessUrl);
  const beforeWaitUrl = stabilityPage.url();
  const beforeWaitDocument = await stabilityPage.evaluate(() => window.documentId);
  const start = Date.now();
  let resumed = false;
  let automatedActions = 0;
  const barrierPage = {
    url: () => stabilityPage.url(),
    isClosed: () => false,
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
  assert.equal(stability.mark(barrierPage, loginUrl, businessUrl, 'pdd-manual-login-transition'), true);
  const pending = stability.wait(barrierPage, 'pdd-manual-login').then(value => { resumed=true; return value; });
  const concurrent = stability.wait(barrierPage, 'resident-observer').then(() => { automatedActions += 1; return barrierPage; });
  assert(stability.active() >= 1);
  await stability.observe(); // No observer dependencies supplied: any page work would fail.
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(resumed, false);
  assert.equal(automatedActions, 0, 'Concurrent automation resumed during the ten-second barrier');
  assert.equal(await pending, barrierPage);
  assert.equal(await concurrent, barrierPage);
  assert(Date.now() - start >= 9950, 'Automation resumed before ten seconds');
  assert.equal(stability.active(), 0);
  assert.equal(stabilityPage.url(), beforeWaitUrl);
  assert.equal(await stabilityPage.evaluate(() => window.documentId), beforeWaitDocument);
  assert.equal(progress[0].pddPostLoginStability.status, 'waiting');
  assert.equal(progress.at(-1).pddPostLoginStability.status, 'completed');
  checks++;

  // Exercise manual CAPTCHA waiting without sleeping two minutes or solving anything.
  let currentUrl = loginUrl;
  let checkpoint = {};
  const fakePage = { url: () => currentUrl, isClosed: () => false, waitForTimeout: async () => {} };
  let waitCalls = 0;
  const manualCode = section('const waitForPddManualLoginExit =', 'const waitForLoginExit =');
  const manualScope = vm.createContext({ shopId: 'test', humanVerificationMaxTimeoutMs: 120000,
    humanVerificationPollMs: 250, humanVerificationClearStableMs: 3000, humanVerificationFocusKeepAliveMs: 500,
    resolveSystemLoginPage: async p => p, locateSystemLoginAcrossPages: async p => ({ page:p, url:p.url() }),
    verificationFocusCoordinator: { acquire:async()=>({acquired:true,owner:{}}), release(){}, hasWaiters:()=>false },
    activateVerificationPage: async()=>({activated:true}), console:{warn(){}},
    writeProgress: p => { checkpoint={...checkpoint,...p}; }, readProgress:()=>checkpoint,
    detectHumanVerification:async()=>({reason:'expired-verification-modal'}),
    verificationTimeoutSuppressesSurface:()=>false, verificationSurfaceFingerprint:()=> 'test',
    verificationPageRole:()=> 'pdd-anchor', verificationSurfaceHasExpired:async()=>({expired:true}),
    waitForStableVerificationClear:async options=>{
      waitCalls++; assert.equal(options.deadline,null,'Login timeout must not dismiss CAPTCHA');
      assert.equal(await options.hasVerification(fakePage),true);
      currentUrl=businessUrl; return {status:'cleared'};
    },
    waitForPddPostLoginStability:async p=>p,
  });
  const manual = vm.runInContext(`let pddManualLoginWaits=0; ${manualCode}\nwaitForPddManualLoginExit;`,manualScope);
  assert.equal(await manual(fakePage, url=>isSystemLoginUrl('pdd',url), 'pdd-manual-login'),fakePage);
  assert.equal(waitCalls,1);
  assert.equal(vm.runInContext('pddManualLoginWaits',manualScope),0);
  checks++;
  console.log(JSON.stringify({ passed:true, checks, loginModalPreserved:true, businessModalPreserved:true, samePageWaitMs:Date.now()-start }));
} finally { await browser.close(); }

