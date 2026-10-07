import assert from 'node:assert/strict';

import { classifyResidentTerminalPauseAfterSessionRecovery } from '../apps/worker/src/resident-command-recovery-policy.mjs';

const claim = { external_order_number: '260923-115762828951026', leaseToken: 'active-lease' };
const progress = {
  step: 'pdd-session-recovered',
  orderNumber: claim.external_order_number,
  updatedAt: '2026-09-24T16:39:49Z',
  residentCommand: {
    action: 'run-order', status: 'idle', outcome: 'manual-review-blocked',
    requestId: 'current-command', assignmentId: claim.leaseToken,
    acceptedAt: '2026-09-24T14:50:30Z',
    completedAt: '2026-09-24T14:51:19Z',
  },
};
const input = {
  progress, claim, commandRequestId: 'current-command',
  claimHydratedAtMs: Date.parse('2026-09-24T14:50:00Z'),
  now: Date.parse('2026-09-24T16:40:00Z'),
};
const recovered = classifyResidentTerminalPauseAfterSessionRecovery(input);
assert.equal(recovered?.outcome, 'manual-review-blocked');
assert.equal(recovered.payload.step, 'manual-review-blocked');
assert.equal(recovered.payload.residentTerminalRecovery.externalActionsReplayed, false);
assert.match(recovered.reason, /禁止重复提交/);
const withOriginalReason = {
  ...progress,
  residentCommand: {
    ...progress.residentCommand,
    terminalOutcome: 'manual-review-blocked',
    terminalReason: 'PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE: 备注入口禁用',
    terminalStage: 'pdd-resolution-submit',
    terminalRecordedAt: '2026-09-24T14:51:18Z',
  },
};
const recoveredOriginal = classifyResidentTerminalPauseAfterSessionRecovery({
  ...input, progress: withOriginalReason,
});
assert.equal(recoveredOriginal.reason,
  'PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE: 备注入口禁用');
assert.equal(recoveredOriginal.payload.manualReview.originalStage, 'pdd-resolution-submit');
assert.equal(recoveredOriginal.payload.residentTerminalRecovery.terminalReasonRecovered, true);
for (const terminalRecordedAt of ['2026-09-24T14:50:29Z', '2026-09-24T14:51:20Z']) {
  const stale = classifyResidentTerminalPauseAfterSessionRecovery({ ...input,
    progress: { ...withOriginalReason, residentCommand: {
      ...withOriginalReason.residentCommand, terminalRecordedAt,
    } },
  });
  assert.match(stale.reason, /禁止重复提交/,
    'a reason outside this exact command must not be reused');
}
for (const change of [
  { progress: { ...progress, step: 'processing' } },
  { progress: { ...progress, orderNumber: 'another-order' } },
  { progress: { ...progress, verificationLocation: { status: 'waiting-human' } } },
  { progress: { ...progress, residentCommand: { ...progress.residentCommand, status: 'active' } } },
  { progress: { ...progress, residentCommand: { ...progress.residentCommand, requestId: 'old-command' } } },
  { progress: { ...progress, residentCommand: { ...progress.residentCommand, assignmentId: 'old-lease' } } },
  { progress: { ...progress, residentCommand: { ...progress.residentCommand, acceptedAt: '2026-09-24T14:49:00Z' } } },
  { progress: { ...progress, residentCommand: { ...progress.residentCommand, outcome: 'completed' } } },
  { commandRequestId: null },
]) {
  assert.equal(classifyResidentTerminalPauseAfterSessionRecovery({ ...input, ...change }), null);
}
const flowPaused = classifyResidentTerminalPauseAfterSessionRecovery({
  ...input,
  progress: { ...progress, residentCommand: { ...progress.residentCommand, outcome: 'flow-paused' } },
});
assert.equal(flowPaused?.payload.step, 'flow-paused');
console.log('resident terminal pause recovery regression passed');
