import assert from 'node:assert/strict';
import {
  AUTH_STORAGE_HOSTS,
  hasBrowserStorageData,
  hasPddStorageData,
  hasUsablePddSessionCookie,
  pddStorageMatchesMallId,
  isWeakAuthHealthEvidence,
  mergeAuthHealthMaps,
  mergeBrowserStorageStates,
  mergeSystemAuthHealth,
  restoreBrowserAuthFromSnapshots,
  scopeBrowserStorageState,
} from '../packages/adapters/src/browser-auth-state.mjs';
import {
  isAuthenticatedPddUrl,
  isAuthenticatedSystemUrl,
  isBrowserNetworkErrorUrl,
  isPddLoginUrl,
  selectLivePddPage,
  selectLiveSystemPage,
} from '../packages/adapters/src/browser-runtime-state.mjs';

const nowMs = Date.parse('2026-08-19T14:00:00.000Z');

const pddIdentityState = (mallIds) => ({
  cookies: [],
  origins: mallIds.map((mallId, index) => ({
    origin: index ? 'https://seller.pinduoduo.com' : 'https://mms.pinduoduo.com',
    localStorage: [{ name: 'new_userinfo', value: JSON.stringify({ mall_id: mallId }) }],
  })),
});
assert.equal(pddStorageMatchesMallId(pddIdentityState(['714086874']), '714086874'), true);
assert.equal(pddStorageMatchesMallId(pddIdentityState(['434904737']), '714086874'), false,
  'a saved login from another shop must not be eligible for restoration');
assert.equal(pddStorageMatchesMallId(pddIdentityState(['714086874', '434904737']), '714086874'), false,
  'conflicting PDD origins must not validate a saved login');
assert.equal(pddStorageMatchesMallId({ cookies: [], origins: [] }, '714086874'), false,
  'a snapshot without a merchant ID must not validate a known shop');
assert.equal(pddStorageMatchesMallId({
  cookies: [], origins: [{ origin: 'https://mms.pinduoduo.com', localStorage: [
    { name: 'new_userinfo', value: JSON.stringify({ mall_id: '714086874' }) },
    { name: 'new_userinfo', value: '{malformed' },
  ] }],
}, '714086874'), false, 'an unreadable conflicting identity must fail closed');

const confirmedOms = {
  status: 'authenticated',
  url: 'https://www.jeoms.com/xianma/trade/sales',
  checkedAt: '2026-08-19T13:50:00.000Z',
  confidence: 'confirmed',
  evidence: 'rendered-business-session',
};
const idleOmsLogin = {
  status: 'expired',
  url: 'https://www.jeoms.com/xianma/login',
  checkedAt: '2026-08-19T14:00:00.000Z',
  stage: 'oms-idle-session-observer',
};
assert.equal(isWeakAuthHealthEvidence(idleOmsLogin), true);
assert.deepEqual(mergeSystemAuthHealth(undefined, idleOmsLogin), {
  ...idleOmsLogin,
  status: 'unknown',
  confidence: 'weak',
  evidence: 'login-url-only',
});
const monotonicOms = mergeSystemAuthHealth(confirmedOms, idleOmsLogin);
assert.equal(monotonicOms.status, 'authenticated',
  'a URL-only idle observation must not overwrite a confirmed business session');
assert.equal(monotonicOms.lastObservation.status, 'unknown');
assert.equal(monotonicOms.observedUrl, idleOmsLogin.url);
assert.equal(mergeSystemAuthHealth(confirmedOms, {
  status: 'expired',
  url: idleOmsLogin.url,
  checkedAt: '2026-08-19T14:01:00.000Z',
  confidence: 'confirmed',
  evidence: 'controlled-login-check',
}).status, 'expired', 'a controlled login check must be allowed to confirm expiration');
assert.equal(mergeSystemAuthHealth({
  status: 'verification-required',
  url: 'https://mms.pinduoduo.com/login/',
  checkedAt: '2026-08-19T14:00:00.000Z',
  confidence: 'confirmed',
  evidence: 'challenge-rendered-in-derived-tab',
}, {
  status: 'expired',
  url: 'https://mms.pinduoduo.com/login/',
  checkedAt: '2026-08-19T14:01:00.000Z',
  confidence: 'confirmed',
  evidence: 'session-cookie-unusable',
}).status, 'expired', 'a later confirmed missing PDD action cookie supersedes a cleared challenge');
const unreachableOms = mergeSystemAuthHealth(confirmedOms, {
  status: 'unreachable',
  url: 'chrome-error://chromewebdata/',
  checkedAt: '2026-08-19T14:02:00.000Z',
  confidence: 'confirmed',
  source: 'controlled-workflow-connectivity-check',
  evidence: 'browser-network-error-page',
});
assert.equal(unreachableOms.status, 'unreachable',
  'a confirmed browser network error must replace stale authenticated state');
assert.equal(mergeSystemAuthHealth(unreachableOms, {
  status: 'unknown',
  url: 'about:blank',
  checkedAt: '2026-08-19T14:03:00.000Z',
  confidence: 'weak',
  source: 'resident-idle-url-observer',
  evidence: 'about:blank',
}).status, 'unreachable', 'a weak URL observation must not hide a confirmed connectivity failure');
assert.equal(mergeSystemAuthHealth(unreachableOms, {
  status: 'authenticated',
  url: confirmedOms.url,
  checkedAt: '2026-08-19T14:04:00.000Z',
  confidence: 'confirmed',
  evidence: 'rendered-business-session',
}).status, 'authenticated', 'a newly rendered business page must confirm connectivity recovery');
assert.equal(mergeAuthHealthMaps(
  { oms: confirmedOms },
  { oms: idleOmsLogin, pdd: { status: 'authenticated', checkedAt: '2026-08-19T14:00:00.000Z' } },
).oms.status, 'authenticated', 'API aggregation must retain stronger per-system evidence');
const mixed = {
  cookies: [
    { name: 'windows_app_shop_token_23', value: 'pdd-token', domain: '.pinduoduo.com', path: '/', expires: 4_102_444_800 },
    { name: 'PASS_ID', value: 'pass-id', domain: 'mms.pinduoduo.com', path: '/', expires: 4_102_444_800 },
    { name: 'oms-token', value: 'oms', domain: 'www.jeoms.com', path: '/', expires: 4_102_444_800 },
    { name: 'tms-token', value: 'tms', domain: 'tms.aipro123.top', path: '/', expires: -1 },
  ],
  origins: [
    { origin: 'https://mms.pinduoduo.com', localStorage: [{ name: 'pddUser', value: 'pdd' }] },
    { origin: 'https://www.jeoms.com', localStorage: [{ name: 'omsUser', value: 'oms' }] },
    { origin: 'http://tms.aipro123.top', localStorage: [{ name: 'tmsUser', value: 'tms' }] },
  ],
};

const pdd = scopeBrowserStorageState(mixed, AUTH_STORAGE_HOSTS.pdd);
const oms = scopeBrowserStorageState(mixed, AUTH_STORAGE_HOSTS.oms);
const tms = scopeBrowserStorageState(mixed, AUTH_STORAGE_HOSTS.tms);
assert.deepEqual(pdd.cookies.map((cookie) => cookie.name), ['windows_app_shop_token_23', 'PASS_ID']);
assert.deepEqual(oms.cookies.map((cookie) => cookie.name), ['oms-token']);
assert.deepEqual(tms.cookies.map((cookie) => cookie.name), ['tms-token']);
assert.deepEqual(pdd.origins.map((origin) => origin.origin), ['https://mms.pinduoduo.com']);
assert.deepEqual(oms.origins.map((origin) => origin.origin), ['https://www.jeoms.com']);
assert.deepEqual(tms.origins.map((origin) => origin.origin), ['http://tms.aipro123.top']);

assert.equal(hasUsablePddSessionCookie(pdd, nowMs), true);
assert.equal(hasPddStorageData(pdd), true);
assert.equal(hasUsablePddSessionCookie({
  cookies: [{ name: 'PASS_ID', domain: 'mms.pinduoduo.com', path: '/', expires: nowMs / 1000 + 3600 }],
  origins: [],
}, nowMs), false, 'PASS_ID alone must not be treated as a confirmed shop session');
assert.equal(hasUsablePddSessionCookie({
  cookies: [{ name: 'windows_app_shop_token_23', domain: '.pinduoduo.com', path: '/', expires: nowMs / 1000 - 1 }],
  origins: [],
}, nowMs), false, 'an expired shop token must not bootstrap a browser');
assert.equal(hasUsablePddSessionCookie({
  cookies: [{ name: 'windows_app_shop_token_23', domain: '.pinduoduo.com', path: '/', expires: nowMs / 1000 + 4 * 60 }],
  origins: [],
}, nowMs), false, 'a session with less than five minutes remaining must not start a new PDD action');
assert.equal(hasUsablePddSessionCookie({
  cookies: [{ name: 'windows_app_shop_token_23', domain: '.pinduoduo.com', path: '/', expires: nowMs / 1000 + 6 * 60 }],
  origins: [],
}, nowMs), true, 'a session with enough time for submission remains usable');

const merged = mergeBrowserStorageStates([pdd, oms, tms]);
assert.deepEqual(new Set(merged.cookies.map((cookie) => cookie.name)), new Set([
  'windows_app_shop_token_23', 'PASS_ID', 'oms-token', 'tms-token',
]));
assert.equal(merged.origins.length, 3);
assert.equal(mergeBrowserStorageStates([]), undefined);
assert.equal(hasBrowserStorageData(oms), true);

let appliedState = null;
let applyAttempts = 0;
const currentState = {
  cookies: [
    { name: 'PASS_ID', value: 'current-pass', domain: 'mms.pinduoduo.com', path: '/', expires: 4_102_444_800 },
    { name: 'oms-token', value: 'current-oms', domain: 'www.jeoms.com', path: '/', expires: 4_102_444_800 },
    { name: 'unrelated', value: 'keep-me', domain: 'example.com', path: '/', expires: 4_102_444_800 },
  ],
  origins: [],
};
const fakeContext = {
  storageState: async () => currentState,
  setStorageState: async (state) => {
    applyAttempts += 1;
    if (applyAttempts < 3) {
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
    appliedState = state;
  },
};
const restored = await restoreBrowserAuthFromSnapshots(fakeContext, merged);
assert.deepEqual(restored.restoredSystems, ['pdd', 'tms']);
assert.equal(applyAttempts, 3, 'auth restoration must retry transient startup navigation races');
assert(appliedState, 'missing auth systems must be restored after persistent browser launch');
assert.equal(appliedState.cookies.find((cookie) => cookie.name === 'windows_app_shop_token_23')?.value, 'pdd-token');
assert.equal(appliedState.cookies.find((cookie) => cookie.name === 'oms-token')?.value, 'current-oms',
  'an existing current-system session must win over an older saved snapshot');
assert.equal(appliedState.cookies.find((cookie) => cookie.name === 'unrelated')?.value, 'keep-me',
  'restoring auth must preserve unrelated current browser storage');

let replacedOmsState = null;
const replacedOms = await restoreBrowserAuthFromSnapshots({
  storageState: async () => currentState,
  setStorageState: async (state) => { replacedOmsState = state; },
}, merged, { replaceSystems: ['oms'] });
assert.deepEqual(replacedOms.restoredSystems, ['pdd', 'oms', 'tms']);
assert.equal(replacedOmsState.cookies.find((cookie) => cookie.name === 'oms-token')?.value, 'oms',
  'an explicitly shared OMS snapshot must replace an expired per-profile token');
assert.equal(replacedOmsState.cookies.find((cookie) => cookie.name === 'unrelated')?.value, 'keep-me',
  'replacing shared OMS auth must preserve unrelated browser storage');

const savedWithIndexedDb = {
  ...merged,
  origins: merged.origins.map((origin, index) => index === 0
    ? { ...origin, indexedDB: [{ name: 'session-db', version: 1, stores: [] }] }
    : origin),
};
const fallbackApplications = [];
const fallbackRestored = await restoreBrowserAuthFromSnapshots({
  storageState: async () => currentState,
  setStorageState: async (state) => {
    fallbackApplications.push(state);
    if (fallbackApplications.length === 1) {
      throw new Error('Error setting storage state: Unable to restore IndexedDB: Internal error.');
    }
  },
}, savedWithIndexedDb);
assert.equal(fallbackRestored.degraded, true);
assert.equal(fallbackRestored.recovery, 'indexeddb-omitted');
assert.deepEqual(fallbackRestored.restoredSystems, ['pdd', 'tms']);
assert.equal(fallbackApplications.length, 2);
assert.equal(fallbackApplications[1].origins.some((origin) => 'indexedDB' in origin), false);

let stateReadAttempts = 0;
const readFallbackApplications = [];
const readFallbackRestored = await restoreBrowserAuthFromSnapshots({
  storageState: async (options) => {
    stateReadAttempts += 1;
    if (options?.indexedDB) {
      throw new Error('InvalidStateError: Failed to get ServiceWorkerRegistration objects: The document is in an invalid state.');
    }
    return currentState;
  },
  setStorageState: async (state) => { readFallbackApplications.push(state); },
}, savedWithIndexedDb);
assert.equal(stateReadAttempts, 2,
  'an IndexedDB state read failure must retry with cookies and localStorage only');
assert.equal(readFallbackRestored.degraded, true);
assert.equal(readFallbackRestored.recovery, 'indexeddb-omitted');
assert.deepEqual(readFallbackRestored.restoredSystems, ['pdd', 'tms']);
assert.equal(readFallbackApplications.length, 1);
assert.equal(readFallbackApplications[0].origins.some((origin) => 'indexedDB' in origin), false);

let failedReadAttempts = 0;
const retainedUnreadableProfile = await restoreBrowserAuthFromSnapshots({
  storageState: async () => {
    failedReadAttempts += 1;
    throw new Error('InvalidStateError: Failed to get ServiceWorkerRegistration objects: The document is in an invalid state.');
  },
  setStorageState: async () => { throw new Error('setStorageState must not run'); },
}, savedWithIndexedDb);
assert.equal(failedReadAttempts, 2);
assert.equal(retainedUnreadableProfile.degraded, true);
assert.equal(retainedUnreadableProfile.recovery, 'persistent-profile-retained');
assert.deepEqual(retainedUnreadableProfile.restoredSystems, []);
assert.deepEqual(retainedUnreadableProfile.attemptedSystems, ['pdd', 'oms', 'tms']);

let failedFallbackAttempts = 0;
const retainedProfile = await restoreBrowserAuthFromSnapshots({
  storageState: async () => currentState,
  setStorageState: async () => {
    failedFallbackAttempts += 1;
    throw new Error('InvalidStateError: Failed to get ServiceWorkerRegistration objects: The document is in an invalid state.');
  },
}, savedWithIndexedDb);
assert.equal(failedFallbackAttempts, 2);
assert.equal(retainedProfile.degraded, true);
assert.equal(retainedProfile.recovery, 'persistent-profile-retained');
assert.deepEqual(retainedProfile.restoredSystems, []);
assert.deepEqual(retainedProfile.attemptedSystems, ['pdd', 'tms']);

appliedState = null;
const alreadyAuthenticated = await restoreBrowserAuthFromSnapshots({
  storageState: async () => mixed,
  setStorageState: async (state) => { appliedState = state; },
}, merged);
assert.deepEqual(alreadyAuthenticated.restoredSystems, []);
assert.equal(appliedState, null, 'a current valid profile must not be overwritten by a saved snapshot');

await assert.rejects(() => restoreBrowserAuthFromSnapshots({
  storageState: async () => currentState,
  setStorageState: async () => {
    throw new Error('Target page, context or browser has been closed');
  },
}, merged), /Target page, context or browser has been closed/,
'a closed browser context must fail immediately instead of being hidden as a navigation retry');

await assert.rejects(() => restoreBrowserAuthFromSnapshots({
  storageState: async () => {
    throw new Error('Target page, context or browser has been closed');
  },
}, merged), /Target page, context or browser has been closed/,
'a closed browser context during state capture must fail immediately');

const fakePage = (url, closed = false) => ({
  url: () => url,
  isClosed: () => closed,
});
const loginPage = fakePage('https://mms.pinduoduo.com/login/?redirectUrl=%2Faftersales%2Fwork_order%2Flist');
const businessPage = fakePage('https://mms.pinduoduo.com/aftersales/work_order/list');
const detailPage = fakePage('https://mms.pinduoduo.com/aftersales-ssr/detail?id=123');
assert.equal(isPddLoginUrl(loginPage.url()), true);
assert.equal(isBrowserNetworkErrorUrl('chrome-error://chromewebdata/'), true);
assert.equal(isBrowserNetworkErrorUrl('edge-error://edgewebdata/'), true);
assert.equal(isBrowserNetworkErrorUrl('about:neterror?e=proxyConnectFailure'), true);
assert.equal(isBrowserNetworkErrorUrl(businessPage.url()), false);
assert.equal(isAuthenticatedPddUrl(loginPage.url()), false);
assert.equal(isAuthenticatedPddUrl(businessPage.url()), true);
assert.equal(isAuthenticatedSystemUrl('oms', 'https://www.jeoms.com/xianma/dashboard'), true);
assert.equal(isAuthenticatedSystemUrl('oms', 'https://www.jeoms.com/xianma/login'), false);
assert.equal(isAuthenticatedSystemUrl('tms', 'http://tms.aipro123.top/logistics'), true);
assert.equal(isAuthenticatedSystemUrl('tms', 'http://tms.aipro123.top/login'), false);
assert.equal(selectLivePddPage([loginPage, detailPage, businessPage], loginPage), businessPage,
  'an authenticated work-order list must replace a stale login anchor');
assert.equal(selectLivePddPage([loginPage, fakePage(businessPage.url(), true)], loginPage), loginPage,
  'closed business pages must not replace the current anchor');
const omsLoginPage = fakePage('https://www.jeoms.com/xianma/login');
const omsBusinessPage = fakePage('https://www.jeoms.com/xianma/trade/sales');
assert.equal(selectLiveSystemPage('oms', [omsLoginPage, omsBusinessPage], omsLoginPage), omsBusinessPage);
const tmsLoginPage = fakePage('http://tms.aipro123.top/login');
const tmsBusinessPage = fakePage('http://tms.aipro123.top/logistics');
assert.equal(selectLiveSystemPage('tms', [tmsLoginPage, tmsBusinessPage], tmsLoginPage), tmsBusinessPage);

console.log('browser auth storage-state self-test passed');
