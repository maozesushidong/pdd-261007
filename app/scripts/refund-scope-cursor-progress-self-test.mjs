import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { returnRefundScanEffectiveStartCursor, returnRefundPartialScanCooldownMs,
  returnRefundVerificationCooldownUntil } from '../apps/worker/src/return-refund-scan-policy.mjs';

const source = fs.readFileSync(new URL('../apps/worker/src/postgres-playwright-runner.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function runReturnRefundScan() {');
const end = source.indexOf('async function runReturnRefundValidation()', start);
assert(start >= 0 && end > start);
const cursor = (itemOffset) => ({ page: 1, itemOffset });
const batch = (from, to, reset = false) => ({ items: [], scan: {
  requestedCursor: cursor(from), startCursor: cursor(reset ? 0 : from), nextCursor: cursor(to),
  examined: reset ? to : to - from, verificationHandledCount: 0,
  resumeCheck: { cursorScopeReset: reset, resumed: false },
  resumeProof: { actionScope: 'refund-list-without-platform-messages-v1', page: 1, nextCursor: cursor(to) },
} });
const fixture = (outputs) => {
  let persisted = 0;
  const sandbox = {
    Date, Math, Set, Number, Error,
    returnRefundScanEffectiveStartCursor, returnRefundPartialScanCooldownMs, returnRefundVerificationCooldownUntil,
    returnRefundConfiguredForShop: () => true,
    returnRefundCycleCursor: cursor(3), returnRefundCycleTotals: { scannedItems: 0, persistedItems: 0, examinedItems: 0 },
    returnRefundCycleVisitedCursors: new Set(),
    fsp: { rm: async () => {} }, returnRefundOutputFile: 'unused',
    ensureResidentWorkflowForReturnRefund: async () => {},
    mixedBusinessSlotSession: false, slotSession: false,
    returnRefundScanMaxDurationMs: 120000, returnRefundScanMaxItems: 3,
    returnRefundOnly: false, returnRefundScanOnce: false, returnRefundCombinedBatchItems: 3,
    returnRefundAutoApproveEnabled: true, returnRefundPartialBatchCooldownMs: 300000,
    returnRefundPostVerificationCooldownMs: 300000,
    shopId: 'test-shop', shop: { expectedShopName: 'Correct shop', configuredPddIdentityNames: ['Correct shop'] },
    repository: {
      listFutureReturnRefundRechecks: async () => [], listConfirmedReturnRefundCompletions: async () => [],
      enqueueReturnRefunds: async ({ items }) => { persisted += 1; assert.equal(items.length, 0); return []; },
      setReturnRefundScanCursor: async ({ cursor: value }) => value,
    },
    sendWorkflowCommand: async (command) => {
      assert.equal(command.action, 'refund-scan'); return { requestId: 'scan' };
    },
    waitForReturnRefundOutput: async () => { assert(outputs.length); return outputs.shift(); },
    readProgress: async () => ({ pddShopIdentity: { actualShopName: 'Correct shop', profileFingerprint: 'profile' } }),
    normalizeDetectedPddShopName: (name) => name,
    readBrowserProfileMarker: async () => ({ profileFingerprint: 'profile' }),
    isMaskedDetectedPddShopName: () => false,
    synchronizeDetectedPddShopIdentity: async () => true,
    pddIdentityMatches: () => true,
    currentPddIdentityMetadata: { mallId: '123' }, dynamicPddShopBinding: false,
    heartbeat: async () => {},
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.scan = runReturnRefundScan;', sandbox);
  return { sandbox, persisted: () => persisted };
};

// Rechecking rows 0..2 produces the same durable cursor (3), but is valid
// progress in the new action scope. The next batch must be able to use 3.
const normal = fixture([batch(3, 3, true), batch(3, 6), batch(6, 9)]);
const before = Date.now();
for (let i = 0; i < 3; i += 1) await normal.sandbox.scan();
assert.deepEqual(normal.sandbox.returnRefundCycleCursor, cursor(9));
assert.deepEqual([...normal.sandbox.returnRefundCycleVisitedCursors], ['1:0', '1:3', '1:6']);
assert(normal.sandbox.returnRefundScanRetryNotBefore >= before + 300000, 'normal five-minute pacing must remain');
assert.equal(normal.persisted(), 3);
const missingPageProofOutput = batch(3, 3, true);
missingPageProofOutput.scan.actionScope = 'refund-list-without-platform-messages-v1';
missingPageProofOutput.scan.resumeProof = null;
await fixture([missingPageProofOutput]).sandbox.scan();

for (const mutate of [
  (out) => { out.scan.resumeCheck.cursorScopeReset = false; },
  (out) => { out.scan.startCursor.itemOffset = 2; },
  (out) => { out.scan.resumeProof.actionScope = 'legacy'; },
  (out) => { out.scan.resumeProof.page = 2; },
  (out) => { out.scan.resumeProof.nextCursor = cursor(4); },
  (out) => { out.scan.examined = 0; },
]) {
  const output = batch(3, 3, true); mutate(output);
  const invalid = fixture([output]);
  await assert.rejects(invalid.sandbox.scan(), /did not advance/u);
  assert.equal(invalid.sandbox.returnRefundCycleVisitedCursors.size, 0);
}
const stalled = fixture([batch(3, 3)]);
await assert.rejects(stalled.sandbox.scan(), /did not advance/u);
const repeated = fixture([batch(3, 3, true), batch(3, 3, true)]);
await repeated.sandbox.scan();
await assert.rejects(repeated.sandbox.scan(), /游标重复: 1:0/u);
assert.equal(repeated.persisted(), 1, 'repeated migration must fail before persisting another batch');
console.log('Refund scope cursor progress passed (production scan loop, migration, next batches, stalls, loops, unchanged cooldown)');
