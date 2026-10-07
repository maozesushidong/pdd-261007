import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflow = (await fs.readFile(path.join(root, 'workflow.mjs'), 'utf8'))
  .replace(/\r\n/gu, '\n');
const runner = await fs.readFile(
  path.join(root, 'apps/worker/src/postgres-playwright-runner.mjs'), 'utf8',
).then((source) => source.replace(/\r\n/gu, '\n'));
const extract = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `missing source region: ${start}`);
  return source.slice(from, to);
};

const persistedPaths = [];
const emptyState = () => ({ cookies: [], origins: [] });
const browserStorage = {
  pdd: emptyState(), oms: emptyState(),
  tms: { cookies: [{ name: 'unrelated-cookie' }], origins: [
    { origin: 'http://tms.test', localStorage: [] },
  ] },
};
const persistenceContext = {
  AUTH_STORAGE_HOSTS: { pdd: 'pdd', oms: 'oms', tms: 'tms' },
  scopeBrowserStorageState: (state, host) => state[host],
  readProgress: () => ({}),
  normalizePddShopNameCandidate: () => '',
  canonicalPddShopIdentityName: () => '',
  expectedShopName: '', expectedMallId: '',
  hasPddStorageData: () => false,
  pddStatePath: 'pdd.json', pddLastKnownGoodStatePath: 'pdd-good.json',
  omsStatePath: 'oms.json', tmsStatePath: 'tms.json',
  tmsBaseUrl: 'http://tms.test',
  writeJsonAtomic: (file) => persistedPaths.push(file),
};
vm.runInNewContext(
  `${extract(workflow, 'const persistBrowserAuth = async', '\n\nconst pauseForManualReview = async')}
globalThis.persistBrowserAuthForTest = persistBrowserAuth;`,
  persistenceContext,
  { filename: 'workflow-tms-snapshot-persistence.mjs' },
);
await persistenceContext.persistBrowserAuthForTest({
  storageState: async () => browserStorage,
});
assert.deepEqual(persistedPaths, [],
  'a TMS login page without a token must not overwrite a usable saved session');
browserStorage.tms.origins[0].localStorage.push({ name: 'tms_auth_token', value: 'live-token' });
await persistenceContext.persistBrowserAuthForTest({
  storageState: async () => browserStorage,
});
assert.deepEqual(persistedPaths, ['tms.json'],
  'an authenticated TMS browser should still persist its session');

const savedState = { origins: [{ origin: 'http://tms.test', localStorage: [
  { name: 'tms_auth_token', value: 'same-shop-test-token' },
] }] };
let accountFromApi = 'configured-account';
let apiAllowed = true;
let restoredToken = null;
let navigatedTo = null;
let registrationReady = true;
const tmsPage = {
  url: () => navigatedTo || 'http://tms.test/login',
  evaluate: async (_callback, token) => { restoredToken = token; },
};
const snapshotContext = {
  Date,
  Error,
  URL,
  AbortSignal,
  process: { env: { TMS_ACCOUNT: 'configured-account' } },
  tmsStatePath: 'same-shop-tms-auth.json',
  tmsBaseUrl: 'http://tms.test',
  tmsLogisticsUrl: 'http://tms.test/logistics',
  tmsNavigationTimeoutMs: 30_000,
  readSavedStorageState: () => savedState,
  fetch: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer same-shop-test-token');
    return { ok: apiAllowed, json: async () => ({ success: true,
      data: { username: accountFromApi } }) };
  },
  logRunStep: () => {},
  navigateSystemPage: async (_page, url) => { navigatedTo = url; },
  waitForTmsCustomerRegistration: async () => registrationReady,
};
vm.runInNewContext(
  `${extract(workflow, 'const validatedSavedTmsToken = async', '\n\nconst ensureTmsLoginOnce = async')}
globalThis.validatedSavedTmsTokenForTest = validatedSavedTmsToken;
globalThis.restoreValidatedTmsSessionForTest = restoreValidatedTmsSession;`,
  snapshotContext,
  { filename: 'workflow-tms-snapshot-recovery.mjs' },
);
assert.equal(await snapshotContext.restoreValidatedTmsSessionForTest(tmsPage), true);
assert.equal(restoredToken, 'same-shop-test-token');
assert.equal(navigatedTo, 'http://tms.test/logistics');
restoredToken = null;
navigatedTo = null;
assert.equal(await snapshotContext.restoreValidatedTmsSessionForTest({
  url: () => 'https://mms.pinduoduo.com/login',
  evaluate: async () => { throw new Error('wrong origin was modified'); },
}), false, 'the TMS token must never be injected into a different origin');
accountFromApi = 'different-account';
assert.equal(await snapshotContext.restoreValidatedTmsSessionForTest(tmsPage), false,
  'a valid token belonging to another account must never enter this shop browser');
assert.equal(restoredToken, null);
assert.equal(navigatedTo, null);
accountFromApi = 'configured-account';
apiAllowed = false;
assert.equal(await snapshotContext.validatedSavedTmsTokenForTest(), null,
  'an expired saved token must fall back to normal login');
apiAllowed = true;
registrationReady = false;
await assert.rejects(snapshotContext.restoreValidatedTmsSessionForTest(tmsPage),
  /业务页恢复后仍未渲染/u);
registrationReady = true;

let attempts = 0;
let manualWaits = 0;
let challengeVisible = false;
let failLogin = true;
const progress = [];
const loginAttempts = { tms: 0 };
const page = { url: () => 'http://tms.aipro123.top/login' };
const workflowContext = {
  Date,
  Error,
  systemLoginAttempts: loginAttempts,
  systemLoginMaxAttempts: 3,
  ensureTmsLoginOnce: async () => {
    attempts += 1;
    if (failLogin) throw new Error('login page did not leave /login');
    return 'authenticated';
  },
  hasHumanVerification: async () => challengeVisible,
  waitForManualSystemLogin: async () => {
    manualWaits += 1;
    failLogin = false;
    return page;
  },
  writeProgress: (update) => progress.push(update),
};
vm.runInNewContext(
  `${extract(workflow, 'const ensureTmsLogin = async', '\n\nconst tmsLoginPageRendered = async')}
globalThis.ensureTmsLoginForTest = ensureTmsLogin;`,
  workflowContext,
  { filename: 'workflow-tms-login-recovery.mjs' },
);
await assert.rejects(
  workflowContext.ensureTmsLoginForTest(page, {}),
  (error) => error.code === 'TMS_LOGIN_RETRY_DEFERRED',
);
assert.equal(attempts, 1, 'a failed form must not enter an in-claim login loop');
assert.equal(loginAttempts.tms, 1);
assert.equal(progress.at(-1).step, 'tms-login-retry-deferred');
assert.equal(progress.at(-1).systemLogin.status, 'retry-ready');
assert.equal(progress.at(-1).verificationStage, null);

failLogin = false;
assert.equal(await workflowContext.ensureTmsLoginForTest(page, {}), 'authenticated');
assert.equal(loginAttempts.tms, 0, 'successful login clears the attempt counter');

failLogin = true;
challengeVisible = true;
assert.equal(await workflowContext.ensureTmsLoginForTest(page, {}), 'authenticated');
assert.equal(manualWaits, 1, 'a real challenge still waits for operator resolution');
assert.equal(progress.at(-1).systemLogin.status, 'waiting-human');
assert.equal(loginAttempts.tms, 0);

const runnerContext = {
  detectBrowserProxyNavigationFailure: () => null,
  isRetryableCreatedTmsFilterFailure: () => false,
};
vm.runInNewContext(
  `${extract(runner, 'const retryableTransientWorkflowFailure =', '\n\nasync function reconcileCompletedDatabaseOrder')}
globalThis.retryableTransientWorkflowFailureForTest = retryableTransientWorkflowFailure;`,
  runnerContext,
  { filename: 'runner-tms-login-recovery.mjs' },
);
const deferredReason = 'TMS automatic login recovery deferred for this shop profile: login timeout';
assert.equal(runnerContext.retryableTransientWorkflowFailureForTest({
  systemLogin: { system: 'tms', status: 'retry-ready' },
  error: deferredReason,
}), deferredReason);
assert.equal(runnerContext.retryableTransientWorkflowFailureForTest({
  systemLogin: { system: 'tms', status: 'waiting-human' },
  error: deferredReason,
}), null, 'a CAPTCHA is not a generic transient login retry');

console.log('TMS login recovery self-test passed');
