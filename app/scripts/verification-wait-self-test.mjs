import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  createVerificationFocusCoordinator,
  releaseVerificationFocusLock,
} from '../packages/adapters/src/verification-detector/focus-lock.mjs';
import {
  beginVerificationBudgetWindow,
  consumeVerificationBudgetWindow,
  waitForStableVerificationClear,
} from '../packages/adapters/src/verification-detector/wait-for-clear.mjs';

const workflowSource = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
assert.match(
  workflowSource,
  /verificationWait\.status !== 'cleared'[\s\S]{0,5200}const restorePage = resumePage \|\| verificationPage[\s\S]{0,1200}navigateSystemPage\(restorePage, originUrl/,
  'a cleared PDD verification redirect must restore or resume the exact business page before the action resumes',
);
assert.match(
  workflowSource,
  /const imageClickVerificationAutoCloseEnabled = false;[\s\S]{0,500}const businessVerificationAutoCloseEnabled = false;/,
  'all CAPTCHA auto-close paths must remain disabled until the operator explicitly enables them',
);
const closeStart = workflowSource.indexOf('const verificationCloseInFlight =');
const closeEnd = workflowSource.indexOf('const releaseImageClickVerificationAfterClose =', closeStart);
assert(closeStart > 0 && closeEnd > closeStart, 'verification close implementation not found');
let timedOutModalCloseCalls = 0;
const disabledClose = vm.runInNewContext(
  `${workflowSource.slice(closeStart, closeEnd)}\ncloseHumanVerificationSurface;`,
  {
    isManualPddLoginSurface: () => false,
    imageClickVerificationAutoCloseEnabled: false,
    businessVerificationAutoCloseEnabled: false,
    closeTimedOutVerificationModal: async () => {
      timedOutModalCloseCalls += 1;
      return { closed: true, method: 'explicit-timed-out-modal-x' };
    },
  },
);
const expiredChallengePage = {
  isClosed: () => false,
  url: () => 'https://mms.pinduoduo.com/aftersales/work_order/list',
};
const disabledCloseResult = await disabledClose(expiredChallengePage, {
  text: '验证时间过长，请重试',
});
assert.equal(disabledCloseResult.closed, false,
  'an expired CAPTCHA must stay visible when automatic close is disabled');
assert.equal(timedOutModalCloseCalls, 0,
  'the terminal-modal X must not bypass the disabled close policy');
assert.match(
  workflowSource,
  /closeResult\.reason === 'verification-auto-close-disabled'[\s\S]{0,420}HumanVerificationRequiredError/,
  'a timed-out live CAPTCHA must stay gated for manual completion',
);
assert.match(
  workflowSource,
  /const locateHumanVerificationAcrossPages = async[\s\S]{0,900}detectHumanVerification\(page\)/,
  'verification detection must scan all live tabs in the same shop context',
);
assert.match(
  workflowSource,
  /WORKFLOW_VERIFICATION_PAGE_REBIND_GRACE_MS \|\| '30000'/,
  'a transient slider redraw must keep the original verification tab for thirty seconds by default',
);
assert.match(
  workflowSource,
  /async function restoreNonVerificationPopupTab[\s\S]{0,1600}isSystemLoginUrl[\s\S]{0,700}detectHumanVerification[\s\S]{0,700}activateVerificationPage\(openerPage, \{\s*backgroundOnly: true,\s*purpose: 'business-restore',\s*\}\)/,
  'ordinary popups must restore the opener tab while login and verification pages remain untouched',
);
assert.match(
  workflowSource,
  /purpose === 'business-restore'[\s\S]{0,180}!verificationFocusCoordinator\.ownsLock\(\)[\s\S]{0,180}verificationLocation\?\.status/,
  'restoring a business tab must not interrupt a pending manual verification',
);
assert.match(
  workflowSource,
  /markUnexpectedForegroundPopup[\s\S]{0,1300}restoreNonVerificationPopupTab\(popupPage, opener\)/,
  'new popup tabs must be checked for login or verification before restoring the original tab',
);
assert.match(
  workflowSource,
  /const workflowSystemForAction = \(targetPage, stage = ''\) =>[\s\S]{0,450}if \(url\.includes\('mms\.pinduoduo\.com'\)\) return 'pdd';[\s\S]{0,180}if \(url\.includes\('www\.jeoms\.com'\)\) return 'oms';/,
  'cross-tab system detection must prefer the live page URL over the caller stage',
);
assert.match(
  workflowSource,
  /const verificationTimeoutSuppressesSurface = \([\s\S]{0,900}timeout\.fingerprint === verificationSurfaceFingerprint/,
  'a timed-out challenge must not be recreated by a stale in-flight observer',
);
assert.match(
  workflowSource,
  /verificationTimeout: \{[\s\S]{0,700}verificationId:[\s\S]{0,300}fingerprint:[\s\S]{0,500}suppressUntil:/,
  'verification timeout state must persist the exact challenge identity and cooldown',
);
assert.match(
  workflowSource,
  /const locateSystemLoginAcrossPages = async[\s\S]{0,900}pagesForVerificationScan\(preferredPage, system, stage\)/,
  'login recovery must scan all live tabs in the same shop context',
);
assert.match(
  workflowSource,
  /manualLoginWait[\s\S]{0,900}verificationFocusCoordinator\.acquire/,
  'manual login waits must serialize foreground focus across shops',
);
assert.match(
  workflowSource,
  /const existingPddLogin = targetAlreadyAuthenticated[\s\S]{0,420}locateSystemLoginAcrossPages/,
  'PDD login recovery must adopt an existing login tab before navigating',
);
assert.match(
  workflowSource,
  /const existingOmsLogin = await locateSystemLoginAcrossPages[\s\S]{0,260}/,
  'OMS login recovery must adopt an existing login tab before navigating',
);
assert.match(
  workflowSource,
  /const existingTmsLogin = await locateSystemLoginAcrossPages[\s\S]{0,260}/,
  'TMS login recovery must adopt an existing login tab before navigating',
);
assert.match(
  workflowSource,
  /const activation = await activateVerificationPage\(verificationPage, \{[\s\S]{0,500}backgroundOnly: true/,
  'a detected challenge must select the real verification tab without raising the browser window',
);
assert.match(
  workflowSource,
  /const ensureResidentVerificationFocus = async|const ensureResidentVerificationFocus = \(\{[\s\S]{0,1800}requireStable: true[\s\S]{0,180}stableDelayMs: 300/,
  'resident verification focus must require a stable challenge before it can enter the global focus queue',
);
assert.match(
  workflowSource,
  /maintainFocus: async \(\) => \{[\s\S]{0,1200}locateHumanVerificationAcrossPages\([\s\S]{0,220}requireStable: true[\s\S]{0,100}stableDelayMs: 300/,
  'focus keep-alive must not activate a tab from a transient loading shell',
);
assert.match(
  workflowSource,
  /const focusManualLoginPage = async \(targetPage\) =>[\s\S]{0,260}force: true/,
  'a required login must force the actual login tab into the foreground for the operator',
);
assert.match(
  workflowSource,
  /const pddPostLoginStabilityMs = Math\.max\([\s\S]{0,180}10_000[\s\S]{0,180}WORKFLOW_PDD_POST_LOGIN_STABILITY_MS/,
  'PDD re-login must retain a minimum ten-second stabilization window',
);
assert.match(
  workflowSource,
  /const beginPddPostLoginBarrier = [\s\S]*?step: 'pdd-post-login-stabilizing'[\s\S]*?const waitForPddPostLoginBarrier = async[\s\S]*?step: 'pdd-post-login-stabilized'[\s\S]*?pddPostLoginRecoveryPacing\.start\(\)/,
  'PDD automation must expose and complete the post-login stabilization gate',
);
assert.match(
  workflowSource,
  /const waitForPddManualLoginExit = async[\s\S]*?return await waitForPddPostLoginStability\(targetPage, stage\)[\s\S]*?const waitForLoginExit = async/,
  'manual PDD login must stabilize before returning control to business automation',
);
assert.match(
  workflowSource,
  /if \(loginSystem === 'pdd'\) \{[\s\S]{0,180}waitForPddPostLoginStability\(observedPage, stage\)/,
  'credential-based PDD login must use the same stabilization gate',
);
assert.match(
  workflowSource,
  /const waitForLoginExit = async[\s\S]{0,3000}locateSystemLoginAcrossPages\(observedPage, loginSystem, isLoginUrl, stage\)[\s\S]{0,1800}force: manualLoginWait/,
  'login waits must re-scan other tabs and keep the actual login tab selected',
);
assert.match(
  workflowSource,
  /targetPage = await waitForLoginExit\([\s\S]{0,260}['"]oms-manual-login['"]/,
  'OMS manual login must continue with the actual tab returned by cross-tab login recovery',
);
assert.match(
  workflowSource,
  /targetPage = await waitForLoginExit\(targetPage, \(url\) => url\.includes\('\/login'\), ['"]tms-login-result['"]/,
  'TMS login result must continue with the actual tab returned by cross-tab login recovery',
);
assert.match(
  workflowSource,
  /const closeStaleSystemLoginPages = async[\s\S]{0,1400}closeDerivedPage\(page\)/,
  'stale derived login tabs must remain eligible for cleanup after recovery ends',
);
assert.match(
  workflowSource,
  /const isPddLoginAnchor = targetPage === pddPage[\s\S]{0,1800}navigateSystemPage\(targetPage, loginUrl, 'pdd-login-challenge-reload'\)[\s\S]{0,800}method: 'pdd-login-challenge-reloaded'/,
  'an expired full-page PDD login challenge must reload the permanent anchor instead of closing it',
);
assert.doesNotMatch(
  workflowSource,
  /if \(!isPddLoginAnchor\) return promptResult;[\s\S]{0,220}targetPage\.close\(\)/,
  'PDD login timeout recovery must not close the permanent login anchor',
);
assert.match(
  workflowSource,
  /const closeStaleSystemLoginPages = async[\s\S]{0,1400}!derivedPages\.has\(page\)[\s\S]{0,240}!isLoginUrl\(url\)[\s\S]{0,180}closeDerivedPage\(page\)/,
  'stale-login cleanup must close only derived login tabs and preserve permanent or business-detail tabs',
);
assert.match(
  workflowSource,
  /isAuthenticatedSystemUrl\(system, urls\[system\]\)[\s\S]{0,500}closeStaleSystemLoginPages\([\s\S]{0,500}const crossTabVerifications = \[\]/,
  'an authenticated system anchor must remove stale derived login challenges before cross-tab discovery',
);
assert.match(
  workflowSource,
  /const authenticatedAnchor = !pddPage\.isClosed\(\)[\s\S]{0,260}isAuthenticatedSystemUrl\('pdd', pddPage\.url\(\)\)[\s\S]{0,300}let recoveryPage = authenticatedAnchor \|\| context\.pages\(\)\.find/,
  'restart recovery must reuse an authenticated PDD anchor instead of reopening a stale login URL',
);
assert.match(
  workflowSource,
  /const recoveryAuthenticationTargetUrl = isSystemLoginUrl\('pdd', verificationUrl\)[\s\S]{0,100}\? listUrl[\s\S]{0,100}: verificationUrl/,
  'a restored login challenge must resume to the PDD work-order list instead of reopening the stale login URL',
);
assert.match(
  workflowSource,
  /ensurePddLogin\([\s\S]{0,120}recoveryAuthenticationTargetUrl[\s\S]{0,40}\)/,
  'restart verification recovery must use the authenticated business target',
);
assert.doesNotMatch(
  workflowSource,
  /ensurePddLogin\(recoveryPage, context, verificationUrl\)/,
  'restart verification recovery must never navigate an authenticated page back to the persisted login URL',
);
assert.match(
  workflowSource,
  /step: 'verification-page-restoring'[\s\S]{0,1800}step: 'verification-page-restore-failed'/,
  'verification page restoration must expose both progress and failure states',
);
assert.match(workflowSource, /verificationWaitConsumedMs: 0/);
assert.match(workflowSource, /beginVerificationBudgetWindow\(\{[\s\S]{0,300}verificationWaitConsumedMs/);
assert.match(workflowSource, /verificationWaitConsumedMs = consumeVerificationBudgetWindow/);
assert.match(
  workflowSource,
  /WORKFLOW_CLAIM_VERIFICATION_TIMEOUT_MS \|\| String\(humanVerificationMaxTimeoutMs\)/,
  'claimed business verification must have a finite default wait',
);
assert.match(
  workflowSource,
  /effectiveVerificationTimeoutMs = activeAssignmentId[\s\S]{0,220}claimedHumanVerificationTimeoutMs[\s\S]{0,260}verificationDetectedAtMs \+ effectiveVerificationTimeoutMs/,
  'claimed ordinary and refund work must yield the shop queue after a bounded verification wait',
);
assert.match(
  workflowSource,
  /isExternallyCleared: verificationSystem === 'pdd'[\s\S]{0,2400}recheck\.verificationId === expectedVerificationId[\s\S]{0,1200}authHealth\?\.pdd\?\.status === 'authenticated'/,
  'only the exact resident-observed PDD challenge may release a not-ready verification page',
);

const firstRefundVerificationWindow = beginVerificationBudgetWindow({
  limitMs: 300_000,
  consumedMs: 0,
  now: 10_000,
});
assert.equal(firstRefundVerificationWindow.remainingMs, 300_000);
assert.equal(firstRefundVerificationWindow.deadline, 310_000);
const consumedRefundVerificationMs = consumeVerificationBudgetWindow(
  firstRefundVerificationWindow,
  { now: 130_000 },
);
assert.equal(consumedRefundVerificationMs, 120_000);
const secondRefundVerificationWindow = beginVerificationBudgetWindow({
  limitMs: 300_000,
  consumedMs: consumedRefundVerificationMs,
  now: 500_000,
});
assert.equal(secondRefundVerificationWindow.remainingMs, 180_000,
  'a later refund page stage must receive only the unused verification time');
assert.equal(consumeVerificationBudgetWindow(secondRefundVerificationWindow, { now: 800_000 }), 300_000,
  'the accumulated command budget must never exceed its configured limit');

const createPage = (states) => {
  let clock = 0;
  let index = -1;
  let consumedRefreshIndex = -1;
  const current = () => states[Math.min(Math.max(index, 0), states.length - 1)];
  return {
    page: {
      waitForTimeout: async (milliseconds) => {
        clock += milliseconds;
        index += 1;
      },
      isClosed: () => Boolean(current().closed),
      evaluate: async () => Boolean(current().ready),
    },
    hasVerification: async () => Boolean(current().verification),
    consumeRefresh: () => {
      if (!current().refresh || consumedRefreshIndex === index) return null;
      consumedRefreshIndex = index;
      return { trigger: 'pdd-manual-refresh', detectedAt: `tick-${clock}` };
    },
    now: () => clock,
  };
};

const cleared = createPage([
  { ready: true, verification: false },
  { ready: true, verification: false },
  { ready: true, verification: false },
]);
const clearedResult = await waitForStableVerificationClear({
  page: cleared.page,
  hasVerification: cleared.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: cleared.now,
});
assert.equal(clearedResult.status, 'cleared');
assert(cleared.now() <= 1000, 'verification clear should resume within one second');

const externallyClearedNotReady = createPage([
  { ready: false, verification: false },
  { ready: false, verification: false },
  { ready: false, verification: false },
]);
let externalClearChecks = 0;
let notReadyVerificationChecks = 0;
const externallyClearedResult = await waitForStableVerificationClear({
  page: externallyClearedNotReady.page,
  hasVerification: async () => {
    notReadyVerificationChecks += 1;
    return false;
  },
  pollMs: 250,
  stableMs: 500,
  now: externallyClearedNotReady.now,
  isExternallyCleared: async () => {
    externalClearChecks += 1;
    return true;
  },
});
assert.equal(externallyClearedResult.status, 'cleared');
assert.equal(externallyClearedResult.externallyConfirmed, true);
assert.equal(externallyClearedNotReady.now(), 750,
  'resident-confirmed clearance must release a not-ready detail page without waiting for task timeout');
assert.equal(notReadyVerificationChecks, 0,
  'a not-ready page must not run its DOM verification detector');
assert.equal(externalClearChecks, 3);

const liveChallengeWins = createPage([
  { ready: true, verification: true },
  { ready: true, verification: true },
  { ready: true, verification: false },
  { ready: true, verification: false },
  { ready: true, verification: false },
]);
const liveChallengeWinsResult = await waitForStableVerificationClear({
  page: liveChallengeWins.page,
  hasVerification: liveChallengeWins.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: liveChallengeWins.now,
  isExternallyCleared: async () => true,
});
assert.equal(liveChallengeWinsResult.status, 'cleared');
assert.equal(liveChallengeWins.now(), 1250,
  'external clearance must never override a verification challenge still visible on a ready page');
assert.equal(liveChallengeWinsResult.externallyConfirmed, undefined);

const refreshed = createPage([
  { ready: false, verification: false, refresh: true },
  { ready: true, verification: false },
  { ready: true, verification: true },
  { ready: true, verification: true },
  { ready: true, verification: false },
  { ready: true, verification: false },
  { ready: true, verification: false },
]);
const refreshCallbacks = [];
const refreshedResult = await waitForStableVerificationClear({
  page: refreshed.page,
  hasVerification: refreshed.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: refreshed.now,
  consumeRefresh: refreshed.consumeRefresh,
  onRefresh: async (refresh) => refreshCallbacks.push(refresh),
});
assert.equal(refreshedResult.status, 'cleared');
assert.equal(refreshed.now(), 1750, 'refresh blank state must not clear a returning verification challenge');
assert.equal(refreshCallbacks.length, 1, 'manual refresh should trigger exactly one recheck');
assert.equal(refreshedResult.refresh?.trigger, 'pdd-manual-refresh');

const closed = createPage([{ ready: false, verification: false, closed: true }]);
const closedResult = await waitForStableVerificationClear({
  page: closed.page,
  hasVerification: closed.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: closed.now,
});
assert.equal(closedResult.status, 'closed');

const focused = createPage([
  { ready: true, verification: true },
  { ready: true, verification: true },
  { ready: true, verification: false },
  { ready: true, verification: false },
  { ready: true, verification: false },
]);
let focusCalls = 0;
const focusedResult = await waitForStableVerificationClear({
  page: focused.page,
  hasVerification: focused.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: focused.now,
  maintainFocus: async () => { focusCalls += 1; },
  focusIntervalMs: 500,
});
assert.equal(focusedResult.status, 'cleared');
assert.equal(focusCalls, 2, 'the active verification tab must be reactivated while the challenge remains');

const autoRefreshed = createPage([
  { ready: true, verification: true },
  { ready: true, verification: true },
  { ready: true, verification: true },
  { ready: true, verification: false },
  { ready: true, verification: false },
  { ready: true, verification: false },
]);
const autoRefreshCalls = [];
const autoRefreshEvents = [];
const autoRefreshedResult = await waitForStableVerificationClear({
  page: autoRefreshed.page,
  hasVerification: autoRefreshed.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: autoRefreshed.now,
  autoRefreshAfterMs: 500,
  maxAutoRefreshes: 1,
  autoRefresh: async ({ attempt, triggeredAt }) => {
    const event = { trigger: 'pdd-auto-refresh', attempt, triggeredAt, status: 'reloaded' };
    autoRefreshCalls.push(event);
    return event;
  },
  onAutoRefresh: async (event) => autoRefreshEvents.push(event),
});
assert.equal(autoRefreshedResult.status, 'cleared');
assert.equal(autoRefreshCalls.length, 1, 'a persistent challenge should refresh exactly once');
assert.equal(autoRefreshEvents.length, 1, 'automatic refresh should emit exactly one recheck event');
assert.equal(autoRefreshedResult.autoRefresh?.trigger, 'pdd-auto-refresh');
assert.equal(autoRefreshedResult.autoRefresh?.attempt, 1);

const autoRefreshDisabled = createPage([
  { ready: true, verification: true },
  { ready: true, verification: true },
  { ready: true, verification: false },
  { ready: true, verification: false },
  { ready: true, verification: false },
]);
let disabledAutoRefreshCalls = 0;
const autoRefreshDisabledResult = await waitForStableVerificationClear({
  page: autoRefreshDisabled.page,
  hasVerification: autoRefreshDisabled.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: autoRefreshDisabled.now,
  autoRefreshAfterMs: 0,
  maxAutoRefreshes: 1,
  autoRefresh: async () => { disabledAutoRefreshCalls += 1; },
});
assert.equal(autoRefreshDisabledResult.status, 'cleared');
assert.equal(disabledAutoRefreshCalls, 0, 'zero automatic refresh delay must disable automatic refresh');

const yielded = createPage([
  { ready: true, verification: true },
  { ready: true, verification: true },
]);
const yieldedResult = await waitForStableVerificationClear({
  page: yielded.page,
  hasVerification: yielded.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: yielded.now,
  focusQuantumMs: 500,
  shouldYieldFocus: () => true,
});
assert.equal(yieldedResult.status, 'yielded');
assert.equal(yieldedResult.heldMs, 500,
  'an unresolved challenge must yield after a bounded focus turn when another shop is queued');

const unopposed = createPage([
  { ready: true, verification: true },
  { ready: true, verification: true },
  { ready: true, verification: false },
  { ready: true, verification: false },
  { ready: true, verification: false },
]);
const unopposedResult = await waitForStableVerificationClear({
  page: unopposed.page,
  hasVerification: unopposed.hasVerification,
  pollMs: 250,
  stableMs: 500,
  now: unopposed.now,
  focusQuantumMs: 500,
  shouldYieldFocus: () => false,
});
assert.equal(unopposedResult.status, 'cleared',
  'a sole verification page must retain focus until the challenge clears');

const focusTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-verification-focus-'));
try {
  const lockPath = path.join(focusTestDir, 'verification-focus.lock');
  const coordinators = ['shop-a', 'shop-b', 'shop-c'].map((shopId) => (
    createVerificationFocusCoordinator({
      lockPath,
      shopId,
      pollMs: 5,
      heartbeatMs: 20,
      ownerStaleMs: 1_000,
      queueStaleMs: 2_000,
    })
  ));
  const first = await coordinators[0].acquire({ stage: 'first' });
  assert.equal(first.owner.shopId, 'shop-a');
  const secondPending = coordinators[1].acquire({ stage: 'second' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(coordinators[0].hasWaiters(), true,
    'the focus owner must observe another shop waiting in the shared queue');
  const thirdPending = coordinators[2].acquire({ stage: 'third' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  coordinators[0].release();
  const firstRequeued = coordinators[0].acquire({ stage: 'first-requeued' });
  const second = await secondPending;
  assert.equal(second.owner.shopId, 'shop-b', 'verification focus must follow FIFO queue order');
  coordinators[1].release();
  const third = await thirdPending;
  assert.equal(third.owner.shopId, 'shop-c', 'a previous owner must not jump ahead of queued shops');
  coordinators[2].release();
  const requeued = await firstRequeued;
  assert.equal(requeued.owner.shopId, 'shop-a', 'a timed-out owner must re-enter at the queue tail');
  assert.equal(coordinators[0].hasWaiters(), false,
    'the final focus owner must not yield when the shared queue is empty');
  coordinators[0].release();

  const timeoutLockPath = path.join(focusTestDir, 'verification-focus-timeout.lock');
  const timeoutOwner = createVerificationFocusCoordinator({
    lockPath: timeoutLockPath,
    shopId: 'timeout-owner',
    pollMs: 5,
    heartbeatMs: 20,
    ownerStaleMs: 1_000,
    queueStaleMs: 2_000,
  });
  const timeoutWaiter = createVerificationFocusCoordinator({
    lockPath: timeoutLockPath,
    shopId: 'timeout-waiter',
    pollMs: 5,
    heartbeatMs: 20,
    ownerStaleMs: 1_000,
    queueStaleMs: 2_000,
  });
  await timeoutOwner.acquire({ stage: 'timeout-owner' });
  const timedOutFocus = await timeoutWaiter.acquire({ stage: 'timeout-waiter', timeoutMs: 25 });
  assert.equal(timedOutFocus.acquired, false,
    'a queued verification must stop waiting when its detection budget expires');
  assert.equal(timedOutFocus.status, 'timeout');
  timeoutOwner.release();

  const backgroundOwner = await coordinators[0].acquire({
    stage: 'background-owner',
    priority: 10,
  });
  assert.equal(backgroundOwner.owner.shopId, 'shop-a');
  const backgroundPending = coordinators[1].acquire({
    stage: 'background-waiter',
    priority: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const activeBusinessPending = coordinators[2].acquire({
    stage: 'active-business-waiter',
    priority: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  coordinators[0].release();
  const activeBusiness = await activeBusinessPending;
  assert.equal(activeBusiness.owner.shopId, 'shop-c',
    'an active order must run before an earlier background scan once the current owner releases');
  assert.equal(activeBusiness.owner.priority, 0);
  coordinators[2].release();
  const background = await backgroundPending;
  assert.equal(background.owner.shopId, 'shop-b',
    'the deferred background scan must retain its queue entry after active work completes');
  coordinators[1].release();

  const localOwner = await coordinators[0].acquire({ stage: 'other-shop-owner' });
  assert.equal(localOwner.owner.shopId, 'shop-a');
  const sameShopFirstPending = coordinators[1].acquire({ stage: 'same-shop-first' });
  const sameShopSecondPending = coordinators[1].acquire({ stage: 'same-shop-second' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const queuedForSameShop = fs.readdirSync(`${lockPath}.queue`)
    .map((entry) => JSON.parse(fs.readFileSync(path.join(`${lockPath}.queue`, entry), 'utf8')))
    .filter((request) => request.shopId === 'shop-b');
  assert.equal(queuedForSameShop.length, 1,
    'overlapping verification checks from one shop must create only one filesystem queue request');
  coordinators[0].release();
  const sameShopFirst = await sameShopFirstPending;
  assert.equal(sameShopFirst.owner.stage, 'same-shop-first');
  let sameShopSecondSettled = false;
  sameShopSecondPending.then(() => { sameShopSecondSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sameShopSecondSettled, false,
    'the second page from one shop must wait until the first verification page releases focus');
  coordinators[1].release();
  const sameShopSecond = await sameShopSecondPending;
  assert.equal(sameShopSecond.owner.stage, 'same-shop-second');
  coordinators[1].release();

  const agingLockPath = path.join(focusTestDir, 'verification-focus-aging.lock');
  const agingCoordinators = ['aging-owner', 'aging-background', 'aging-active'].map((shopId) => (
    createVerificationFocusCoordinator({
      lockPath: agingLockPath,
      shopId,
      pollMs: 5,
      heartbeatMs: 20,
      ownerStaleMs: 1_000,
      queueStaleMs: 2_000,
      priorityAgingMs: 20,
    })
  ));
  await agingCoordinators[0].acquire({ stage: 'aging-owner', priority: 0 });
  const agedBackgroundPending = agingCoordinators[1].acquire({
    stage: 'aged-background',
    priority: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const newActivePending = agingCoordinators[2].acquire({
    stage: 'new-active',
    priority: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  agingCoordinators[0].release();
  const agedWinner = await Promise.race([
    agedBackgroundPending.then((owner) => ({ shop: 'background', owner })),
    newActivePending.then((owner) => ({ shop: 'active', owner })),
  ]);
  assert.equal(agedWinner.shop, 'background',
    'a background verification must receive a bounded turn instead of being starved forever');
  agingCoordinators[1].release();
  await newActivePending;
  agingCoordinators[2].release();

  const simulatedOwner = { token: 'busy-token', pid: 1234 };
  const fileCalls = [];
  const quarantined = releaseVerificationFocusLock({
    lockPath,
    pid: simulatedOwner.pid,
    token: simulatedOwner.token,
    readOwner: () => simulatedOwner,
    unlinkSync: (target) => {
      fileCalls.push(['unlink', target]);
      const error = new Error('resource busy');
      error.code = 'EBUSY';
      throw error;
    },
    renameSync: (source, target) => fileCalls.push(['rename', source, target]),
    randomToken: () => 'quarantine-test',
  });
  assert.equal(quarantined, true, 'an EBUSY lock must be isolated without failing the workflow');
  assert.equal(fileCalls.filter(([operation]) => operation === 'rename').length, 1);

  const deferredToStaleTimeout = releaseVerificationFocusLock({
    lockPath,
    pid: simulatedOwner.pid,
    token: simulatedOwner.token,
    readOwner: () => simulatedOwner,
    unlinkSync: () => {
      const error = new Error('resource busy');
      error.code = 'EBUSY';
      throw error;
    },
    renameSync: () => {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    },
  });
  assert.equal(deferredToStaleTimeout, false,
    'a lock still held by Windows must be left for heartbeat expiry without throwing');
} finally {
  fs.rmSync(focusTestDir, { recursive: true, force: true });
}

console.log('human verification refresh recovery self-test passed');
