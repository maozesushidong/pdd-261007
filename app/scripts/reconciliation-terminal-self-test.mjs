import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { residentReconciliationTerminalOutcome } from '../apps/worker/src/resident-command-recovery-policy.mjs';

const source = readFileSync(new URL('../apps/worker/src/postgres-playwright-runner.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const extract = (name) => {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  assert(start >= 0 && end > start);
  return source.slice(start, end);
};
const hydratedAt = '2026-09-23T10:45:48.000Z';
const workOrder = { id: 'order-id', shop_id: 'shop-id', external_order_number: 'order-number', current_ordinary_instance_id: 'instance-id' };
const claimMatchStart = source.indexOf('const progressBelongsToClaim =');
const claimMatchEnd = source.indexOf('\n};', claimMatchStart) + 3;
assert(claimMatchStart >= 0 && claimMatchEnd > claimMatchStart);
const realProgressBelongsToClaim = new Function(
  'residentBrowser', 'canonicalScenarioCode', 'ordinaryIdentityForClaim', 'ordinaryIdentityValidationError',
  `${source.slice(claimMatchStart, claimMatchEnd)}; return progressBelongsToClaim;`,
)(true, value => value, claim => ({
  ordinaryInstanceId: claim.current_ordinary_instance_id,
  platformWorkOrderId: claim.platform_work_order_id || null,
  platformCaseKey: claim.platform_case_key || null,
}), () => null);
const progress = {
  orderNumber: workOrder.external_order_number,
  ordinaryInstanceId: workOrder.current_ordinary_instance_id,
  step: 'pdd-session-recovered',
  updatedAt: '2026-09-23T11:09:44.113Z',
  businessUpdatedAt: '2026-09-23T10:47:52.357Z',
  residentCommand: {
    requestId: 'current-command', action: 'run-order', status: 'idle',
    acceptedAt: '2026-09-23T10:45:48.788Z',
    completedAt: '2026-09-23T10:47:58.147Z', outcome: 'verification-required',
  },
};
const confirmed = { ...progress, externalStateReconciliation: { state: 'confirmed', confirmationMethod: 'fixture-read-only' } };
const runFixture = async (snapshots, { run = {}, error = null } = {}) => {
  let reads = 0, timerCleared = false, completeCalls = 0;
  const checkpoints = [];
  const bindings = {
    repository: {
      getWorkOrderForReconciliation: async () => workOrder,
      checkpointExternalStateReconciliation: async value => { checkpoints.push(value); },
      completeExternalStateReconciliation: async () => { completeCalls++; return workOrder; },
    },
    shopId: 'shop-id', heartbeatIntervalMs: 1000, residentBrowser: true,
    ordinaryIdentityForClaim: claim => ({ ordinaryInstanceId: claim.current_ordinary_instance_id }),
    ordinaryFirstDiscoveredAtForClaim: () => null,
    hydrateClaimProgress: async () => {}, heartbeat: async () => {},
    readProgress: async () => {
      reads++;
      if (reads > 12) throw Error('reconciliation kept waiting after command completion');
      return reads === 1 ? { ...progress, updatedAt: hydratedAt } : snapshots[Math.min(reads - 2, snapshots.length - 1)];
    },
    startOrReusePlaywright: async () => ({ reused: true, commandRequestId: 'current-command', exitPromise: new Promise(() => {}), ...run }),
    progressBelongsToClaim: realProgressBelongsToClaim,
    stopActiveChildGracefully: async () => { throw Error('resident browser must stay open'); },
    residentReconciliationTerminalOutcome,
    setInterval: () => 'heartbeat-timer',
    clearInterval: value => { assert.equal(value, 'heartbeat-timer'); timerCleared = true; },
    setTimeout: callback => { queueMicrotask(callback); },
  };
  const fn = new Function(...Object.keys(bindings), `${extract('runExternalStateReconciliation')}; return runExternalStateReconciliation;`)(...Object.values(bindings));
  if (error) await assert.rejects(fn({ work_order_id: workOrder.id }), error);
  else assert.equal((await fn({ work_order_id: workOrder.id })).state, 'confirmed');
  assert.equal(timerCleared, true, 'heartbeat must stop when this command finishes');
  assert.equal(completeCalls, error ? 0 : 1, 'missing evidence must never complete an order');
  assert(!checkpoints.some(value => value.payload.updatedAt === hydratedAt), 'await the hydration timestamp before checkpointing');
  return { reads, checkpoints };
};

await runFixture([progress], { error: value => value.code === 'HUMAN_VERIFICATION_REQUIRED' && /HumanVerificationRequired/.test(value.message) });
for (const outcome of ['flow-paused', 'manual-review-blocked', 'rate-limited', 'retryable-error', 'login-required', 'verification-timeout', 'idle']) {
  await runFixture([{ ...progress, residentCommand: { ...progress.residentCommand, outcome } }], { error: /external-state-reconciliation-failed/ });
}
for (const changed of [
  { requestId: 'old-command' }, { action: 'discover' }, { status: 'active' },
  { acceptedAt: '2026-09-23T10:00:00Z' }, { completedAt: null },
  { completedAt: '2026-09-23T10:00:00Z' },
]) {
  const result = await runFixture([{ ...progress, residentCommand: { ...progress.residentCommand, ...changed } }, confirmed]);
  assert.equal(result.reads, 3, 'stale or active commands must not terminate this reconciliation');
}
await runFixture([{ ...progress, ordinaryInstanceId: 'different-case' }, confirmed]);
await runFixture([confirmed]);
// A newly launched read-only reconciliation has a pending marker but no claim
// lease. Missing and null tokens must agree, without accepting another claim.
const initialReconciliation = { ...confirmed,
  residentCommand: {action:'run-order',status:'pending',queuedAt:hydratedAt} };
assert.equal(realProgressBelongsToClaim(initialReconciliation, workOrder), true);
await runFixture([initialReconciliation], {run:{reused:false,commandRequestId:null}});
assert.equal(realProgressBelongsToClaim(initialReconciliation, {...workOrder,leaseToken:'active-lease'}), false);
assert.equal(realProgressBelongsToClaim({...initialReconciliation,
  residentCommand:{...initialReconciliation.residentCommand,assignmentId:'another-lease'}},workOrder), false);
assert.equal(realProgressBelongsToClaim({...initialReconciliation,ordinaryInstanceId:'another-instance'},workOrder), false);
assert.equal(realProgressBelongsToClaim({...initialReconciliation,orderNumber:'another-order'},workOrder), false);
await runFixture([progress], { run: { commandRequestId: null, commandErrorCode: 'RESIDENT_COMMAND_BUSY_TIMEOUT' }, error: /command-not-started/ });
await runFixture([{ ...progress, step: 'human-verification-required', residentCommand: null }], {
  run: { reused: false, commandRequestId: null }, error: value => value.code === 'HUMAN_VERIFICATION_REQUIRED',
});
assert.equal(residentReconciliationTerminalOutcome({ progress, reused: true, startedAtMs: Date.parse(hydratedAt) }), null);
assert.equal(residentReconciliationTerminalOutcome({ progress: { ...progress, step: 'human-verification-required', businessUpdatedAt: hydratedAt }, reused: false, startedAtMs: Date.parse(hydratedAt) }), null);

// Exercise the actual IPC wrapper: an accepted or apply-delayed command carries
// its own request id; a busy timeout must not be associated with the old id.
for (const errorCode of [null, 'RESIDENT_COMMAND_APPLY_TIMEOUT', 'RESIDENT_COMMAND_BUSY_TIMEOUT']) {
  const child = {}, exitPromise = new Promise(() => {});
  const bindings = {
    residentBrowser: true, activeChild: child, activeChildExitPromise: exitPromise,
    activeChildRunning: () => true,
    sendWorkflowCommand: async payload => {
      assert.equal(payload.reconcileOnly, true);
      if (errorCode) throw Object.assign(new Error('fixture'), { code: errorCode, requestId: 'receipt-id' });
      return { requestId: 'receipt-id' };
    },
    isResidentCommandDelayError: () => true, shopId: 'shop-id', heartbeat: async () => {},
    console: { error: () => {} },
    stopActiveChildGracefully: () => { throw Error('must keep resident process'); },
  };
  const fn = new Function(...Object.keys(bindings), `${extract('startOrReusePlaywright')}; return startOrReusePlaywright;`)(...Object.values(bindings));
  const result = await fn('order-number', { reconcileOnly: true });
  assert.equal(result.commandRequestId, errorCode === 'RESIDENT_COMMAND_BUSY_TIMEOUT' ? null : 'receipt-id');
  assert.equal(result.exitPromise, exitPromise);
}

// The real caller must defer a finished CAPTCHA command even when the newest
// background checkpoint says that the PDD session has recovered.
{
  const start = source.indexOf('  const processExternalStateReconciliation = async () => {');
  const end = source.indexOf('\n  const externalStateReconciliationAllowed', start);
  assert(start >= 0 && end > start);
  const calls = [];
  const bindings = {
    shopId: 'shop-id', externalStateRetryMs: 120000, externalStateRetryWindowMs: 600000,
    externalStateMaxAttempts: 6,
    repository: {
      recoverStaleExternalStateReconciliations: async () => [],
      claimNextExternalStateReconciliation: async () => workOrder,
      deferExternalStateReconciliationForVerification: async args => calls.push(args),
      failExternalStateReconciliation: async () => { throw Error('verification must not consume a failed attempt'); },
    },
    runExternalStateReconciliation: async () => { throw Object.assign(new Error('fixture terminal receipt'), { code: 'HUMAN_VERIFICATION_REQUIRED' }); },
    readProgress: async () => progress, heartbeat: async () => {},
  };
  const fn = new Function(...Object.keys(bindings), `let processedClaimsSinceExternalStateReconciliationCheck = 2; ${source.slice(start, end)}; return processExternalStateReconciliation;`)(...Object.values(bindings));
  assert.equal(await fn(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workOrderId, workOrder.id);
  assert.equal(calls[0].ordinaryInstanceId, workOrder.current_ordinary_instance_id);
}
console.log('Reconciliation terminal-command regression passed: verification, identity, receipt, stale progress, busy and resident preservation');
