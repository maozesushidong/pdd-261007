import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPddPostLoginRecoveryPacing } from '../packages/adapters/src/pdd/post-login-recovery-pacing.mjs';

let time = 1000;
const waits = [];
const pacing = createPddPostLoginRecoveryPacing({
  intervalMs: 3500,
  durationMs: 180_000,
  now: () => time,
  sleep: async ms => { waits.push(ms); time += ms; },
});
const page = { url: () => 'https://mms.pinduoduo.com/aftersales/work_order/list', isClosed: () => false };
const loginPage = { url: () => 'https://mms.pinduoduo.com/login/', isClosed: () => false };
const omsPage = { url: () => 'https://www.jeoms.com/', isClosed: () => false };

assert.equal(await pacing.beforeOperation(page, 'locator.click'), false, 'No login means no recovery pacing');
assert.deepEqual(pacing.start(), { armedAt: 1000, intervalMs: 3500, durationMs: 180000 });
assert.equal(await pacing.beforeOperation(loginPage, 'locator.click'), false, 'Manual login must remain responsive');
assert.equal(await pacing.beforeOperation(omsPage, 'page.goto'), false, 'OMS is outside PDD recovery pacing');
assert.equal(await pacing.beforeOperation(page, 'locator.evaluate'), false, 'Read probes must remain responsive');
assert.deepEqual(await Promise.all([
  pacing.beforeOperation(page, 'page.goto'),
  pacing.beforeOperation(page, 'locator.click'),
  pacing.beforeOperation(page, 'page.press'),
]), [true, true, true]);
assert.deepEqual(waits, [3500, 3500, 3500], 'Navigation and interactions must start separately');
assert.equal(time, 11500);
time = 182000;
assert.equal(await pacing.beforeOperation(page, 'locator.fill'), false, 'Normal speed resumes after recovery window');
assert.deepEqual(pacing.start(), { armedAt: 182000, intervalMs: 3500, durationMs: 180000 });
assert.equal(await pacing.beforeOperation(page, 'locator.fill'), true, 'Every new login starts a fresh recovery window');
assert.equal(time, 185500);
time = 500000;
assert.deepEqual(pacing.start(), { armedAt: 500000, intervalMs: 3500, durationMs: 180000 });
time = 900000;
assert.equal(await pacing.beforeOperation(loginPage, 'locator.click'), false);
assert.equal(await pacing.beforeOperation(page, 'locator.evaluate'), false);
assert.equal(await pacing.beforeOperation(page, 'page.goto'), true,
  'A shop paused after login must still pace its first business navigation');
assert.equal(time, 903500);
time = 1080001;
assert.equal(await pacing.beforeOperation(page, 'locator.click'), false,
  'Normal pacing resumes three minutes after the first business interaction');

const workflowSource = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const residentStart = workflowSource.indexOf('const initializeResidentSystemsForDiscovery = async () => {');
const residentEnd = workflowSource.indexOf('let pageCrashRecoveryAttempts = 0;', residentStart);
assert(residentStart >= 0 && residentEnd > residentStart, 'Resident startup function must exist');
const residentCalls = [];
let loginShouldFail = false;
const residentScope = {
  readProgress: () => ({}),
  restoredSystemTargets: () => ({ pdd: 'https://mms.pinduoduo.com/' }),
  navigateSystemPage: async () => { residentCalls.push('navigate'); },
  persistSystemTabs: () => {},
  returnRefundPddOnlyMode: true,
  focusSystemPage: async () => {},
  ensurePddLogin: async () => {
    residentCalls.push('login-check');
    if (loginShouldFail) throw new Error('session expired');
  },
  updateAuthHealth: () => { residentCalls.push('authenticated'); },
  pddPostLoginRecoveryPacing: { start: () => { residentCalls.push('paced'); } },
  pddPage: {},
  context: {},
  residentOmsWarmupPromise: null,
  residentTmsWarmupPromise: null,
};
const initializeResidentSystemsForDiscovery = vm.runInNewContext(
  `${workflowSource.slice(residentStart, residentEnd)}\ninitializeResidentSystemsForDiscovery`,
  residentScope,
);
await initializeResidentSystemsForDiscovery();
assert.deepEqual(residentCalls, ['paced', 'navigate', 'login-check', 'authenticated', 'paced'],
  'An existing PDD session must be paced after startup authentication');
residentCalls.length = 0;
loginShouldFail = true;
await assert.rejects(initializeResidentSystemsForDiscovery(), /session expired/u);
assert.deepEqual(residentCalls, ['paced', 'navigate', 'login-check'],
  'An expired session must not claim authentication or run later business actions');

console.log(JSON.stringify({ passed: true, recoveryIntervalMs: 3500, recoveryDurationMs: 180000, waits }));
