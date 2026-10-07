import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `missing source: ${start}`);
  return source.slice(a, b);
};
const declarations = [
  between('class HumanVerificationRequiredError extends Error', '\nclass PddLoginRequiredError extends Error'),
  between('class PddLoginRequiredError extends Error', '\nconst recordPddLoginRequired ='),
  between('class RateLimitPauseError extends Error', '\nclass ManualReviewRequiredError extends Error'),
  between('const prepareGoodDeedFeedback = async', '\nconst submitGoodDeedFeedback ='),
  between('const residentCommandFailureStatus =', '\nconst resetPddAfterResidentDiscoveryFailure ='),
].join('\n');
const locator = {
  filter() { return this; }, last() { return this; },
  getByRole() { return this; }, getByText() { return this; }, locator() { return this; },
  async inputValue() { return ''; },
};
const page = { ...locator, async waitForTimeout() {} };
let opening = 0;
let visibleChecks = 0;
let failure;
let dialogVisible = false;
let transientFailures = 0;
const sandbox = {
  browserHeadless: false,
  claimedHumanVerificationTimeoutMs: 120000,
  focusSystemPage: async () => {},
  waitForFirstVisible: async () => {
    visibleChecks++;
    if (visibleChecks === 1) return null;
    return dialogVisible || visibleChecks % 2 === 0 ? locator : null;
  },
  firstVisible: async () => locator,
  updateOrdinaryExecution() {},
  pacedAction: async () => {
    opening++;
    if (failure) throw failure;
    if (transientFailures-- > 0) throw new Error('detached feedback link');
    dialogVisible = true;
  },
};
vm.runInNewContext(`${declarations}\nglobalThis.api = { prepareGoodDeedFeedback, residentCommandFailureStatus, HumanVerificationRequiredError, HumanVerificationTimeoutError, PddLoginRequiredError, RateLimitPauseError };`, sandbox);
const api = sandbox.api;
for (const [type, outcome] of [
  ['RateLimitPauseError', 'rate-limited'],
  ['HumanVerificationRequiredError', 'verification-required'],
  ['HumanVerificationTimeoutError', 'verification-timeout'],
  ['PddLoginRequiredError', 'login-required'],
]) {
  opening = 0;
  visibleChecks = 0;
  failure = new api[type]('open-good-deed-feedback', 'https://example.invalid/detail');
  await assert.rejects(api.prepareGoodDeedFeedback(page, 'test-order', 'product-shortage'), error => {
    assert.equal(error, failure, `${type} must reach the queue handler unchanged`);
    assert.equal(api.residentCommandFailureStatus(error), outcome);
    return true;
  });
  assert.equal(opening, 1, `${type} must stop further feedback attempts`);
}
failure = null;
opening = 0;
visibleChecks = 0;
transientFailures = 1;
assert.equal((await api.prepareGoodDeedFeedback(page, 'test-order', 'product-shortage')).dialog, locator);
assert.equal(opening, 2, 'a transient detached entry should retain bounded retry');
console.log('PDD feedback suspension regression passed (rate limit, CAPTCHA, timeout, login, transient retry)');
