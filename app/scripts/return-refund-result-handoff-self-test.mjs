import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  advanceReturnRefundWaitBudget,
  createReturnRefundWaitTimeoutError,
  returnRefundClaimCommandUnsettled,
} from '../apps/worker/src/return-refund-wait-state.mjs';

const sourceIndex = process.argv.indexOf('--source');
const sourcePath = sourceIndex < 0
  ? new URL('../apps/worker/src/postgres-playwright-runner.mjs', import.meta.url)
  : process.argv[sourceIndex + 1];
assert(sourcePath, '--source requires a saved runner file');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('async function waitForReturnRefundOutput({');
const end = source.indexOf('\nasync function ensureResidentWorkflowForReturnRefund()', start);
assert(start > 0 && end > start);
const requestId = 'exact-refund-request';
const completed = { requestId, mode: 'claim', status: 'completed', result: { outcome: 'auto-refunded' } };

function harness({ output = null, commandStatus = 'active', commandId = requestId,
  onSleep = () => {}, onCheckpoint = () => {}, onProgress = () => {},
  onHeartbeat = () => {} } = {}) {
  const state = { now: 0, sleeps: 0, reads: 0, output, commandStatus, commandId, heartbeats: [] };
  const context = {
    Date: { now: () => state.now },
    setTimeout: (resolve, ms) => {
      state.now += ms;
      state.sleeps += 1;
      onSleep(state);
      assert(state.sleeps < 20, 'fixture must not wait indefinitely');
      resolve();
    },
    fsp: { readFile: async () => {
      state.reads += 1;
      if (!state.output) throw new Error('result not published');
      return JSON.stringify(state.output);
    } },
    readProgress: async () => {
      onProgress(state);
      return { residentCommand: { requestId: state.commandId, status: state.commandStatus } };
    },
    activeChildRunning: () => true,
    activeClaim: { id: 'exact-work-order' },
    checkpointActiveClaim: async () => { onCheckpoint(state); },
    heartbeat: async (stage) => {
      state.heartbeats.push(stage);
      onHeartbeat(state, stage);
    },
    heartbeatIntervalMs: 100,
    returnRefundAutoApproveEnabled: true,
    returnRefundOutputFile: 'isolated-fixture-no-browser',
    returnRefundResultTimeoutMs: 500,
    returnRefundHardTimeoutMs: 500,
    residentCommandDeferrals: new Map(),
    advanceReturnRefundWaitBudget,
    returnRefundClaimCommandUnsettled,
    createReturnRefundWaitTimeoutError,
    console,
  };
  const wait = vm.runInNewContext(`${source.slice(start, end)}\nwaitForReturnRefundOutput;`, context);
  return { state, run: (options = {}) => wait({ requestId, mode: 'claim', ...options }) };
}

// The file is published during the poll sleep, immediately before the child
// reports idle and the deadline expires. The already-completed claim must win.
const handoff = harness({ onSleep: (s) => { s.output = completed; s.commandStatus = 'idle'; } });
assert.equal((await handoff.run()).result.outcome, 'auto-refunded');
assert.equal(handoff.state.sleeps, 1);
assert(handoff.state.reads >= 2);

const verification = harness({ onSleep: (s) => {
  s.output = { ...completed, status: 'verification-timeout', error: 'verification is still required' };
  s.commandStatus = 'idle';
} });
await assert.rejects(verification.run(), (e) => e.code === 'HUMAN_VERIFICATION_TIMEOUT');

for (const foreign of [{ ...completed, requestId: 'old-request' }, { ...completed, mode: 'scan' }]) {
  const wrongOutput = harness({ output: foreign, commandStatus: 'idle' });
  await assert.rejects(wrongOutput.run(), (e) => e.code === 'RETURN_REFUND_HARD_TIMEOUT');
}
const wrongCommand = harness({ output: completed, commandStatus: 'idle', commandId: 'different-command' });
await assert.rejects(wrongCommand.run(), (e) => e.code === 'RETURN_REFUND_HARD_TIMEOUT');

const active = harness({ output: completed, onSleep: (s) => {
  if (s.sleeps === 2) s.commandStatus = 'idle';
} });
assert.equal((await active.run()).result.outcome, 'auto-refunded');
assert.equal(active.state.sleeps, 2, 'a published result cannot release an active command');
assert(active.state.heartbeats.includes('return-refund-command-awaiting-settlement'));

const missing = harness({ commandStatus: 'idle' });
await assert.rejects(missing.run(), (e) => e.code === 'RETURN_REFUND_HARD_TIMEOUT');

// A slow checkpoint can move wall time beyond the deadline after the last
// regular output read. Recheck the exact settled result before reporting it.
const finalRead = harness({ onCheckpoint: (s) => {
  s.now += 600;
  s.output = completed;
  s.commandStatus = 'idle';
} });
assert.equal((await finalRead.run({ timeoutMs: 1_000, hardTimeoutMs: 1_000 })).result.outcome, 'auto-refunded');

// Wall time can cross the cap during checkpoint I/O while the exact command
// is still active. Keep its claim until the original command publishes its
// result and becomes idle, rather than releasing it as a page error.
const lateCheckpoint = harness({
  onCheckpoint: (s) => { s.now += 600; },
  onSleep: (s) => {
    if (s.sleeps === 2) { s.output = completed; s.commandStatus = 'idle'; }
  },
});
assert.equal((await lateCheckpoint.run({ timeoutMs: 1_000, hardTimeoutMs: 1_000 })).result.outcome, 'auto-refunded');
assert.equal(lateCheckpoint.state.sleeps, 2);
assert(lateCheckpoint.state.heartbeats.includes('return-refund-command-awaiting-settlement'));

// A regular heartbeat can cross the cap too, and the settlement heartbeat
// itself can take longer than the polling allowance. Start that allowance
// after I/O so the next poll still observes the same command's actual result.
const lateHeartbeat = harness({
  onHeartbeat: (s, stage) => { s.now += stage === 'return-refund-command-awaiting-settlement' ? 31_000 : 600; },
  onSleep: (s) => {
    if (s.sleeps === 2) { s.output = completed; s.commandStatus = 'idle'; }
  },
});
assert.equal((await lateHeartbeat.run({ timeoutMs: 1_000, hardTimeoutMs: 1_000 })).result.outcome, 'auto-refunded');
assert.equal(lateHeartbeat.state.sleeps, 2);
assert(lateHeartbeat.state.heartbeats.includes('return-refund-command-awaiting-settlement'));

console.log('RETURN_REFUND_RESULT_HANDOFF_SELF_TEST_OK: 10 race and fencing cases');
