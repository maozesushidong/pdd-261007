import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const sourceIndex = process.argv.indexOf('--source');
const moduleUrl = sourceIndex < 0
  ? new URL('../packages/adapters/src/verification-detector/tab-selection.mjs', import.meta.url)
  : pathToFileURL(process.argv[sourceIndex + 1]);
const { selectVerificationTab } = await import(moduleUrl.href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const extensionId = 'a'.repeat(32);
let checks = 0;
const fixture = (evaluate, workerCount = 1) => {
  const workers = Array.from({ length: workerCount }, (_, index) => ({
    url: () => `chrome-extension://${extensionId}/worker-${index}.js`,
    evaluate: (fn, arg) => evaluate(fn, arg, index),
  }));
  const context = {
    serviceWorkers: () => workers,
    newCDPSession: async () => ({
      send: async method => {
        assert.equal(method, 'Target.getTargetInfo', 'only read-only target identification is allowed');
        return { targetInfo: { targetId: 'exact-target' } };
      },
      detach: async () => {},
    }),
  };
  return {
    page: { isClosed: () => false, context: () => context },
    extensionIds: [extensionId], switchDelayMs: 0, settleMs: 0,
    minSwitchIntervalMs: 0, extensionTimeoutMs: 25,
  };
};
const bounded = async operation => {
  let watchdog;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('Extension RPC blocked the caller past its deadline')), 500);
      }),
    ]);
  } finally { clearTimeout(watchdog); }
};

// Exercise the actual exported helper with a nonresponding extension. No live
// browser, PDD page, CAPTCHA solver, database or existing Worker is involved.
{
  let hung = true;
  const input = fixture(() => hung ? new Promise(() => {}) : Promise.resolve({
    selected: true, activated: false, reason: 'verification-tab-already-selected',
  }));
  const result = await bounded(selectVerificationTab(input));
  assert.equal(result.reason, 'tab-selection-extension-timeout');
  assert.equal(result.activated, false);
  hung = false;
  assert.equal((await bounded(selectVerificationTab(input))).selected, true,
    'a hung read-only inspection must not retain the serialized selection queue');
  checks++;
}
{
  const targets = deferred();
  const pendingCallbacks = [];
  let updates = 0;
  const scope = vm.createContext({
    Date,
    chrome: {
      debugger: { getTargets: () => targets.promise },
      tabs: {
        get: async id => ({ id, windowId: 7, active: false }),
        update: async () => { updates++; },
      },
    },
  });
  const input = fixture(async (fn, arg) => {
    scope.rpcArgs = arg;
    const operation = vm.runInContext(`(${fn.toString()})(rpcArgs)`, scope);
    pendingCallbacks.push(operation);
    return operation;
  });
  assert.equal((await bounded(selectVerificationTab(input))).reason, 'tab-selection-extension-timeout');
  targets.resolve([{ id: 'exact-target', type: 'page', tabId: 41 }]);
  await Promise.all(pendingCallbacks);
  assert.equal(updates, 0, 'a delayed inspection must never select a tab after its deadline');
  checks++;
}
{
  const activation = deferred();
  let calls = 0;
  const input = fixture((fn, arg) => {
    calls++;
    if (arg.activate) return activation.promise;
    return Promise.resolve({ selected: false, activated: false, reason: 'tab-selection-pending' });
  }, 2);
  input.minSwitchIntervalMs = 80;
  const result = await bounded(selectVerificationTab(input));
  assert.equal(result.reason, 'tab-selection-extension-timeout');
  assert.equal(result.activationUnconfirmed, true);
  const atTimeout = calls;
  assert.equal((await bounded(selectVerificationTab(input))).reason, 'tab-selection-awaiting-extension-result');
  assert.equal(calls, atTimeout, 'an unconfirmed activation must not retry or fall back to another worker');
  activation.resolve({ selected: true, activated: true });
  await delay(5);
  const resumedAt = Date.now();
  const settled = await bounded(selectVerificationTab(input));
  assert.equal(settled.selected, true, 'selection may resume once the original extension result settles');
  assert(Date.now() - resumedAt >= 65, 'an uncertain delayed activation must retain minimum switching cadence');
  checks++;
}
{
  const targets = deferred();
  const pendingCallbacks = [];
  let targetReads = 0, updates = 0;
  const scope = vm.createContext({
    Date,
    chrome: {
      debugger: { getTargets: () => ++targetReads === 1
        ? Promise.resolve([{ id: 'exact-target', type: 'page', tabId: 41 }]) : targets.promise },
      tabs: {
        get: async id => ({ id, windowId: 7, active: false }),
        update: async () => { updates++; },
      },
    },
  });
  const input = fixture(async (fn, arg) => {
    scope.rpcArgs = arg;
    const operation = vm.runInContext(`(${fn.toString()})(rpcArgs)`, scope);
    pendingCallbacks.push(operation);
    return operation;
  });
  const result = await bounded(selectVerificationTab(input));
  assert.equal(result.activationUnconfirmed, true);
  targets.resolve([{ id: 'exact-target', type: 'page', tabId: 41 }]);
  await Promise.all(pendingCallbacks);
  assert.equal(updates, 0, 'a timed-out activation that has not dispatched must not jump to a stale tab later');
  checks++;
}
{
  const input = fixture(() => Promise.resolve({ selected: true, activated: false }));
  for (const extensionTimeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(selectVerificationTab({ ...input, extensionTimeoutMs }), /timeout.*positive/i);
  }
  checks++;
}

// Execute the real PDD login function in an isolated scope, stopping at the
// first optional focus operation. Actual login URLs must be published before
// that operation; an authenticated business URL must not be marked logged out.
const workflowFile = process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs', import.meta.url);
const source = fs.readFileSync(workflowFile, 'utf8');
const first = source.indexOf('const ensurePddLogin = async');
const last = source.indexOf('\nconst capturePddShopIdentity = async', first);
assert(first > 0 && last > first);
const loginFunction = source.slice(first, last);
const business = 'https://mms.pinduoduo.com/aftersales/work_order/list';
for (const login of [true, false]) {
  const stopped = new Error('fixture-focus-stop');
  let logoutRecords = 0;
  const page = { url: () => login ? 'https://mms.pinduoduo.com/login/' : business };
  const scope = vm.createContext({
    pddPage: page, listUrl: business, process: { env: {} }, pddLoginMode: 'manual', browserHeadless: false,
    adoptLivePddAnchor: async () => page,
    isAuthenticatedSystemUrl: (_, url) => url === business,
    waitForPddPostLoginBarrier: async () => {}, locateSystemLoginAcrossPages: async () => null,
    closeStaleSystemLoginPages: async () => {}, closeDeviceAccessIfPrompted: async () => {},
    recordPddLoginRequired: actualPage => {
      assert(actualPage.url().includes('/login')); logoutRecords++; return new Error('login-required');
    },
    focusManualLoginPage: async () => { assert.equal(logoutRecords, 1); throw stopped; },
    saveWorkflowDiagnostics: async () => {}, capturePddShopIdentity: async () => true,
    activeAssignmentId: null, activeReturnRefundCommand: null,
    updateAuthHealth: () => {}, persistBrowserAuth: async () => {}, persistSystemTabs: () => {},
    console: { log() {}, error() {} },
  });
  const ensure = vm.runInContext(`${loginFunction}\nensurePddLogin`, scope);
  if (login) await assert.rejects(ensure(page, {}), error => error === stopped);
  else {
    assert.equal(await ensure(page, {}), page);
    assert.equal(logoutRecords, 0);
  }
  checks++;
}
console.log(JSON.stringify({ checks, passed: true, isolated: true, liveWorkerAttached: false }));
