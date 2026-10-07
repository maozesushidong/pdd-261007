import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the production recovery loop without starting the business worker
// or connecting to a shop. Browser observations and checkpoint races are
// supplied by the harness; suppression and recovery logic run unchanged.
const source = fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE
  || new URL('../workflow.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const offset = source.indexOf(start);
  const stop = source.indexOf(end, offset + start.length);
  assert(offset >= 0 && stop > offset, `Missing production section: ${start}`);
  return source.slice(offset, stop);
};
const production = [
  section('class HumanVerificationRequiredError extends Error', 'class PddLoginRequiredError'),
  section('const verificationSurfaceFingerprint =', '// A wait deadline is a scheduler boundary'),
  section('const waitForRestoredVerificationClear =', 'const runRestoredVerificationRecoveryOnly ='),
].join('\n');
const detection = { selector: 'slider', frameUrl: 'https://mms.pinduoduo.com/challenge' };
const command = { stage: 'restore-verification', verificationId: 'verification-a',
  detectedAt: new Date(Date.now() - 130_000).toISOString() };

const harness = ({ suppressed = false, onCheck, onDelay } = {}) => {
  const state = { detection, closed: false, checks: 0, delays: 0, writes: [], progress: {} };
  const page = {
    isClosed: () => state.closed,
    url: () => 'https://mms.pinduoduo.com/aftersales-ssr/detail?id=test',
    waitForTimeout: async () => { state.delays += 1; await onDelay?.(state); },
  };
  const release = () => {
    state.progress = { verificationTimeout: {
      status: 'closed', system: 'pdd', timeoutMs: 120_000,
      timedOutAt: new Date().toISOString(),
      suppressUntil: new Date(Date.now() + 600_000).toISOString(),
      fingerprint: JSON.stringify(['pdd', page.url(), 'pdd-anchor', detection.frameUrl, detection.selector]),
      closeResult: { closed: false, reason: 'non-image-click-verification-preserved' },
    } };
  };
  if (suppressed) release();
  const scope = {
    browserHeadless: false, claimedHumanVerificationTimeoutMs: 120_000,
    humanVerificationMaxTimeoutMs: 120_000, humanVerificationPostTimeoutSuppressionMs: 600_000,
    restoredVerificationStablePasses: 3, restoredVerificationStableDelayMs: 1,
    shopId: 'test-shop', verificationPageRole: () => 'pdd-anchor',
    isManualPddLoginSurface: () => false,
    detectHumanVerification: async () => state.detection,
    readProgress: () => state.progress,
    writeRestoredVerificationRecovery: (_command, values) => {
      state.writes.push(values);
      state.progress = { ...state.progress, ...values };
    },
    checkForHumanVerification: async () => {
      state.checks += 1;
      // This is the pre-fix regression: the raw detector keeps seeing the
      // slider while the normal detector skips its cooldown fingerprint.
      if (state.checks > 4) throw new Error('Recovery spun on a suppressed challenge');
      if (onCheck) return onCheck(state, release);
      if (suppressed) { state.progress.verificationLocation = null; return false; }
      state.detection = null;
      return true;
    },
  };
  const recover = vm.runInNewContext(`${production}\nwaitForRestoredVerificationClear;`, scope);
  return { state, recover: () => recover(page, command) };
};

const retained = harness({ suppressed: true });
await assert.rejects(retained.recover, (error) => error.code === 'HUMAN_VERIFICATION_TIMEOUT'
  && error.verificationCloseResult.closed === false && error.verificationTimeoutMs === 120_000);
assert.equal(retained.state.checks, 0, 'Do not enter another verification wait during cooldown');
assert.equal(retained.state.writes.length, 0, 'Do not resurrect a released verification gate');
assert.equal(retained.state.detection, detection, 'Preserve the visible slider');

const raced = harness({ onCheck: (_state, release) => { release(); return false; } });
await assert.rejects(raced.recover, (error) => error.code === 'HUMAN_VERIFICATION_TIMEOUT');
assert.equal(raced.state.checks, 1, 'A concurrent observer release must stop the next iteration');
assert.equal(raced.state.writes.length, 1);

const cleared = harness();
await cleared.recover();
assert.equal(cleared.state.checks, 1);
assert.equal(cleared.state.delays, 2, 'Wait for stable clear before reporting recovery');

const redraw = harness({ onDelay: (state) => {
  if (state.delays === 1) state.detection = detection;
} });
await redraw.recover();
assert.equal(redraw.state.checks, 2, 'A challenge redrawn during confirmation is still blocking');

const different = harness({ suppressed: true, onCheck: (state) => { state.detection = null; } });
different.state.progress.verificationTimeout.fingerprint = 'another-surface';
await different.recover();
assert.equal(different.state.checks, 1, 'A different challenge receives normal handling');

const closed = harness();
closed.state.closed = true;
await assert.rejects(closed.recover, /页面在确认解除前已关闭/u);
console.log('verification restore wait self-test passed');
