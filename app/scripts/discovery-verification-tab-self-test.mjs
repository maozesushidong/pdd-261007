import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const between = (start, end) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `missing workflow section: ${start}`);
  return source.slice(first, last);
};

const declarations = [
  between('class HumanVerificationRequiredError extends Error', '\nclass PddLoginRequiredError extends Error'),
  between('class PddLoginRequiredError extends Error', '\nconst recordPddLoginRequired ='),
  between('class RateLimitPauseError extends Error', '\nclass ManualReviewRequiredError extends Error'),
  between('const residentCommandFailureStatus =', '\nconst resetPddAfterResidentDiscoveryFailure ='),
  between('const completeFailedResidentCommand =', '\nconst restoredVerificationStablePasses ='),
].join('\n');

let resets = 0;
let output = null;
let completed = null;
const sandbox = {
  shopId: 'test-shop',
  browserHeadless: false,
  claimedHumanVerificationTimeoutMs: 120_000,
  activeReturnRefundCommand: null,
  context: {},
  readProgress: () => ({ residentCommand: { requestId: 'test-request' } }),
  writePddDiscoveryOutput: (value) => { output = value; },
  writeReturnRefundOutput: () => assert.fail('discovery must not write refund output'),
  resetPddAfterResidentDiscoveryFailure: async () => { resets += 1; },
  currentSystemPage: () => ({ url: () => 'https://mms.pinduoduo.com/aftersales/work_order/list' }),
  writeProgress: () => {},
  saveWorkflowDiagnostics: async () => {},
  persistBrowserAuth: async () => {},
  resetResidentAssignment: (value) => { completed = value; },
};
vm.runInNewContext(`${declarations}\nglobalThis.api = { completeFailedResidentCommand, HumanVerificationRequiredError, HumanVerificationTimeoutError, PddLoginRequiredError, RateLimitPauseError };`, sandbox);

for (const [error, expectedStatus] of [
  [new sandbox.api.HumanVerificationRequiredError('discovery', 'https://mms.pinduoduo.com/verify'), 'verification-required'],
  [new sandbox.api.HumanVerificationTimeoutError('discovery', 'https://mms.pinduoduo.com/verify'), 'verification-timeout'],
  [new sandbox.api.PddLoginRequiredError('discovery', 'https://mms.pinduoduo.com/login'), 'login-required'],
  [new sandbox.api.RateLimitPauseError('discovery'), 'rate-limited'],
]) {
  resets = 0;
  await sandbox.api.completeFailedResidentCommand('discover', error);
  assert.equal(output?.status, expectedStatus);
  assert.equal(completed?.outcome, expectedStatus);
  assert.equal(resets, 0, `${expectedStatus} must preserve the visible PDD page`);
}

resets = 0;
await sandbox.api.completeFailedResidentCommand('discover', new Error('temporary discovery page failure'));
assert.equal(output?.status, 'retryable-error');
assert.equal(resets, 1, 'a page failure should still reset the discovery page');
console.log('Discovery verification tab preservation regression passed');
