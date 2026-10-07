import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  advanceReturnRefundWaitBudget,
  returnRefundClaimCommandUnsettled,
} from '../apps/worker/src/return-refund-wait-state.mjs';

const source = fs.readFileSync(new URL('../apps/worker/src/postgres-playwright-runner.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function runReturnRefundClaim(claim) {');
const end = source.indexOf('\nconst handleRuntimeControlResponse =', start);
assert(start > 0 && end > start, 'refund claim implementation not found');
const implementation = source.slice(start, end);

const claim = {
  id: 'work-order-1',
  leaseToken: 'lease-1',
  external_order_number: 'order-1',
  work_order_type: '退货退款',
};
const refund = {
  action_state: 'waiting-logistics',
  aftersale_number: 'aftersale-1',
  detail_url: 'https://mms.pinduoduo.com/after-sales/detail',
  effect_status: null,
};
const result = { outcome: 'wait-logistics', nextCheckAt: '2026-09-28T00:00:00.000Z' };
const calls = { waited: [], finished: [], heartbeats: [] };
const delayed = Object.assign(new Error('received but not applied'), {
  code: 'RESIDENT_COMMAND_APPLY_TIMEOUT',
  requestId: 'original-refund-request',
});
const deferred = new Map([[delayed.requestId, { requestId: delayed.requestId, accepted: false }]]);
const context = {
  repository: {
    getReturnRefundForClaim: async () => refund,
    finishReturnRefundClaim: async (value) => { calls.finished.push(value); return true; },
  },
  fsp: { rm: async () => {} },
  returnRefundOutputFile: 'unused-result-file',
  ensureResidentWorkflowForReturnRefund: async () => {},
  sendWorkflowCommand: async () => { throw delayed; },
  activeChildRunning: () => true,
  residentCommandDeferrals: deferred,
  waitForReturnRefundOutput: async (value) => {
    calls.waited.push(value);
    return { result };
  },
  heartbeat: async (state, metadata) => { calls.heartbeats.push({ state, metadata }); },
  recordBrowserProxyNavigationFailure: () => null,
  deferClaimsAfterPddTabFailure: async () => {},
  pddSessionRunwayNotBefore: 0,
  returnRefundSessionRunwayCooldownUntil: () => 0,
  shopId: 'shop-1',
  returnRefundAutoApproveEnabled: true,
  completedCount: 0,
  console,
};
const run = vm.runInNewContext(`${implementation}\nrunReturnRefundClaim;`, context);
assert.equal(await run(claim), true);
assert.equal(calls.waited.length, 1);
assert.equal(calls.waited[0].requestId, delayed.requestId,
  'a delayed refund must wait for the original resident request');
assert.equal(calls.waited[0].mode, 'claim');
assert.equal(calls.finished.length, 1);
assert.equal(calls.finished[0].result.outcome, 'wait-logistics',
  'the claim must finish from the actual resident result, not a fabricated page error');
assert(calls.heartbeats.some((entry) => entry.state === 'return-refund-command-delayed'));

deferred.clear();
await assert.rejects(run(claim), (error) => error === delayed,
  'a command without an exact deferred marker must not be assumed delivered');
assert.equal(calls.finished.length, 1,
  'the undelivered command must not create a second completion');

const waitStart = source.indexOf('async function waitForReturnRefundOutput({');
const waitEnd = source.indexOf('\nasync function ensureResidentWorkflowForReturnRefund()', waitStart);
assert(waitStart > 0 && waitEnd > waitStart, 'refund result wait implementation not found');
let clockMs = 0;
let reads = 0;
const waitHeartbeats = [];
const waitRequestId = 'delayed-result-request';
const waitContext = {
  Date: { now: () => clockMs },
  setTimeout: (resolve, delayMs) => { clockMs += delayMs; resolve(); return 1; },
  fsp: { readFile: async () => {
    reads += 1;
    if (reads < 3) throw new Error('result pending');
    return JSON.stringify({ requestId: waitRequestId, mode: 'claim', status: 'completed', result });
  } },
  readProgress: async () => ({
    residentCommand: { requestId: waitRequestId, status: reads < 3 ? 'active' : 'idle' },
  }),
  activeChildRunning: () => true,
  activeClaim: { id: claim.id },
  checkpointActiveClaim: async () => true,
  heartbeat: async (state) => { waitHeartbeats.push(state); },
  heartbeatIntervalMs: 100,
  returnRefundAutoApproveEnabled: true,
  returnRefundOutputFile: 'unused-result-file',
  returnRefundResultTimeoutMs: 600,
  returnRefundHardTimeoutMs: 1_000,
  residentCommandDeferrals: new Map(),
  advanceReturnRefundWaitBudget,
  returnRefundClaimCommandUnsettled,
  createReturnRefundWaitTimeoutError: () => new Error('claim released too early'),
  console,
};
const waitForResult = vm.runInNewContext(
  `${source.slice(waitStart, waitEnd)}\nwaitForReturnRefundOutput;`, waitContext,
);
const completed = await waitForResult({
  requestId: waitRequestId, mode: 'claim', timeoutMs: 600, hardTimeoutMs: 1_000,
});
assert.equal(completed.result.outcome, 'wait-logistics');
assert(reads >= 3, 'the exact command must be allowed to settle beyond the first deadline');
assert(waitHeartbeats.includes('return-refund-command-awaiting-settlement'),
  'the extended lease wait must be visible in the shop heartbeat');
console.log('RETURN_REFUND_DEFERRED_COMMAND_SELF_TEST_OK');
