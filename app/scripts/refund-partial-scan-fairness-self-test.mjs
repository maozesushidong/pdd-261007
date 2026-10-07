import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as policy from '../apps/worker/src/return-refund-scan-policy.mjs';

const file = process.env.RUNNER_SOURCE_FILE || 'apps/worker/src/postgres-playwright-runner.mjs';
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('  let claim = null;', source.indexOf('const processDueExternalStateReconciliation'));
const end = source.indexOf('  if (claim && !returnRefundOnly && !directRefundExecutionSession)', start);
assert(start > 0 && end > start, 'Runner selection block not found');
const selection = source.slice(start, end);
const now = 20_000_000;

async function choose({ cursor = { page: 4, itemOffset: 9 }, elapsed = 26 * 60_000,
  due = true, idle = true, active = false, startup = false, bounded = false,
  persistent = false, configured = true, refundOnly = false, direct = false,
  scanFails = false } = {}) {
  const calls = [];
  const sandbox = vm.createContext({
    Date: { now: () => now },
    mixedBusinessSlotSession: !refundOnly, boundedSlotSession: bounded,
    persistentSlotSession: persistent, returnRefundOnly: refundOnly,
    directRefundExecutionSession: direct, startupLeaseRecoveryPending: startup,
    activeClaim: active ? { id: 'active' } : null,
    ordinaryOpportunitySinceRefundTurn: false, drainOrdinaryQueueBeforeRefund: true,
    lastKnownRefundOpportunityAt: now, returnRefundCycleCursor: cursor,
    lastReturnRefundScanAt: now - elapsed, returnRefundDirectClaimsSinceScan: 1,
    returnRefundDirectClaimsBeforeScan: 10, returnRefundScanForceIntervalMs: 7_200_000,
    assignmentKind: 'ordinary', shopId: 'test-shop', workerId: 'test-worker', leaseSeconds: 180,
    dynamicPddShopBinding: true, currentPddIdentityBindingToken: 'test-identity',
    returnRefundConfiguredForShop: () => configured, returnRefundScanDueNow: () => due,
    shouldPrioritizeReturnRefundScan: () => false,
    shouldResumePartialReturnRefundScan: (options) => policy.shouldResumePartialReturnRefundScan
      ? policy.shouldResumePartialReturnRefundScan({ ...options, now }) : false,
    pool: { query: async (sql, values) => {
      calls.push('idle-check');
      assert.match(sql, /lease_token IS NULL/);
      assert.match(sql, /current_work_order_id IS NULL/);
      assert.equal(values[0], 'test-shop');
      return { rows: [{ idle }] };
    } },
    runReturnRefundScan: async () => {
      calls.push('scan');
      if (scanFails) throw new Error('verification gate remains active');
    },
    deferReturnRefundScanAfterFailure: async () => { calls.push('defer'); },
    claimEligibleOrdinary: async () => {
      calls.push('ordinary');
      return { id: 'ordinary', scenario_code: 'abnormal-network-warning' };
    },
    repository: { claimNext: async () => {
      calls.push('refund');
      return { id: 'refund', scenario_code: 'return-refund' };
    } },
  });
  const result = await vm.runInContext(`(async () => { ${selection}\nreturn claim; })()`, sandbox);
  return { result, calls, refundCounter: sandbox.returnRefundDirectClaimsSinceScan };
}

const overdue = await choose();
assert.deepEqual(overdue.calls, ['idle-check', 'scan'],
  'UNFINISHED_REFUND_SCAN_STARVED_BY_CONTINUOUS_ORDINARY_BACKLOG');
assert.equal(overdue.result, true, 'Yield after the bounded batch before claiming another order');
assert.equal(overdue.refundCounter, 0);
for (const options of [
  { cursor: null }, { cursor: { page: 1, itemOffset: 0 } }, { due: false },
  { elapsed: 10 * 60_000 - 1 }, { startup: true }, { bounded: true },
  { persistent: true }, { configured: false }, { active: true },
]) {
  const result = await choose(options);
  assert.deepEqual(result.calls, ['ordinary'], JSON.stringify(options));
}
const occupied = await choose({ idle: false });
assert.deepEqual(occupied.calls, ['idle-check', 'ordinary'], 'Never start a scan with an occupied DB runtime');
assert.deepEqual((await choose({ refundOnly: true })).calls, ['refund']);
assert.deepEqual((await choose({ direct: true })).calls, ['refund']);
const failed = await choose({ scanFails: true });
assert.deepEqual(failed.calls, ['idle-check', 'scan', 'defer']);
assert.equal(failed.result, false, 'A failed scan must return to verification/retry gates before new claims');
assert.equal(failed.refundCounter, 1, 'A failed batch must not erase the current queue fairness counter');
assert.deepEqual((await choose({ elapsed: 10 * 60_000 })).calls, ['idle-check', 'scan']);
assert.deepEqual((await choose({ cursor: { page: 1, itemOffset: 3 } })).calls, ['idle-check', 'scan']);

const resume = policy.shouldResumePartialReturnRefundScan;
assert.equal(typeof resume, 'function');
const options = { configured: true, scanDue: true, cursor: { page: 2, itemOffset: 0 },
  lastBatchAt: now - 10 * 60_000, now };
assert.equal(resume(options), true);
for (const cursor of [null, {}, { page: 1, itemOffset: 0 }, { page: -2, itemOffset: 1 },
  { page: 1.5, itemOffset: 1 }, { page: 2, itemOffset: -1 }]) {
  assert.equal(resume({ ...options, cursor }), false, `Invalid/full-cycle cursor: ${JSON.stringify(cursor)}`);
}
assert.equal(resume({ ...options, scanDue: false }), false);
assert.equal(resume({ ...options, configured: false }), false);
assert.equal(resume({ ...options, lastBatchAt: now - 10 * 60_000 + 1 }), false);
assert.equal(resume({ ...options, lastBatchAt: now + 1 }), false);

// Placement matters: keep authentication, manual pauses, verification pressure,
// operator commands and external-state reconciliation ahead of this new opportunity.
const floorAt = source.indexOf('    && shouldResumePartialReturnRefundScan({', start);
assert(floorAt > source.indexOf('if (!activeClaim && !(await hasRecoverableStartupLease())'));
assert(floorAt > source.indexOf('await repository.isShopOperatorPaused(shopId)', source.indexOf('async function processOne()')));
assert(floorAt > source.indexOf('const idleCommand = await repository.claimPendingCommand', source.indexOf('async function processOne()')));
console.log('PARTIAL_REFUND_SCAN_FAIRNESS_SELF_TEST_OK (Runner selection, idle lease guard, cooldown, error yield and policy cases)');
