const retryableResidentOutcomes = new Set(['rate-limited', 'retryable-error']);

const parseTime = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Decide whether a finished resident-browser command can release its claim.
 * The worker must never infer this from a stale checkpoint or from a command
 * that still has an unresolved external effect.
 */
export function classifyResidentCommandRetryRelease({
  progress = {},
  claim = {},
  claimHydratedAtMs = 0,
  now = Date.now(),
  defaultRetryMs = 120_000,
  minRetryMs = 30_000,
  maxRetryMs = 15 * 60_000,
} = {}) {
  const command = progress?.residentCommand;
  const outcome = String(command?.outcome || '').trim().toLowerCase();
  if (command?.status !== 'idle' || !retryableResidentOutcomes.has(outcome)) return null;

  const assignmentId = String(command.assignmentId || '').trim();
  const leaseToken = String(claim.leaseToken || '').trim();
  if (assignmentId && leaseToken && assignmentId !== leaseToken) return null;

  const orderNumber = String(progress.orderNumber || '').trim();
  const claimedOrderNumber = String(claim.external_order_number || '').trim();
  if (orderNumber && claimedOrderNumber && orderNumber !== claimedOrderNumber) return null;

  const updatedAtMs = parseTime(progress.updatedAt);
  if (Number.isFinite(claimHydratedAtMs)
    && (!Number.isFinite(updatedAtMs) || updatedAtMs <= claimHydratedAtMs)) return null;

  const explicitRetryAt = parseTime(progress.retryAfterAt || command.retryAfterAt);
  const configuredDelay = Number(
    outcome === 'rate-limited' ? progress.rateLimitWaitMs : progress.retryAfterMs,
  );
  const fallbackDelay = Number.isFinite(configuredDelay) && configuredDelay > 0
    ? configuredDelay
    : Number(defaultRetryMs);
  const retryDelayMs = Math.max(minRetryMs, Math.min(maxRetryMs, fallbackDelay));
  const retryAtMs = Number.isFinite(explicitRetryAt) && explicitRetryAt > now
    ? explicitRetryAt
    : now + retryDelayMs;
  const currentStep = String(progress.step || '').trim() || 'resident-command-finished';
  const step = outcome === 'rate-limited'
    ? 'rate-limited-retry-ready'
    : 'resident-retryable-error-retry-ready';

  return {
    outcome,
    currentStep: step,
    previousStep: currentStep,
    nextAttemptAt: new Date(retryAtMs),
    retryDelayMs: Math.max(0, retryAtMs - now),
    payload: {
      ...progress,
      step,
      error: null,
      manualReview: null,
      residentCommandRecovery: {
        status: 'retry-ready',
        outcome,
        previousStep: currentStep,
        detectedAt: new Date(now).toISOString(),
        retryAt: new Date(retryAtMs).toISOString(),
        browserKeptResident: true,
        externalActionsReplayed: false,
      },
      updatedAt: new Date(now).toISOString(),
    },
  };
}

export const isRetryableResidentCommandOutcome = (outcome) => (
  retryableResidentOutcomes.has(String(outcome || '').trim().toLowerCase())
);

// A background PDD auth observation can overwrite the visible pause step
// after a resident business command has already finished. Only the exact
// command for this fenced claim may release it; the caller checks external
// effects before applying the pause.
export function classifyResidentTerminalPauseAfterSessionRecovery({
  progress = {}, claim = {}, claimHydratedAtMs = 0, commandRequestId = null,
  now = Date.now(),
} = {}) {
  if (progress.step !== 'pdd-session-recovered' || progress.verificationLocation) return null;
  const command = progress.residentCommand || {};
  const outcome = String(command.outcome || '').trim();
  if (command.action !== 'run-order' || command.status !== 'idle'
    || !['flow-paused', 'manual-review-blocked'].includes(outcome)) return null;
  if (!commandRequestId || command.requestId !== commandRequestId) return null;
  if (!claim.leaseToken || command.assignmentId !== claim.leaseToken) return null;
  if (!claim.external_order_number || progress.orderNumber !== claim.external_order_number) return null;
  const acceptedAt = parseTime(command.acceptedAt);
  const completedAt = parseTime(command.completedAt);
  const progressUpdatedAt = parseTime(progress.updatedAt);
  if (!Number.isFinite(claimHydratedAtMs) || !Number.isFinite(acceptedAt)
    || !Number.isFinite(completedAt) || !Number.isFinite(progressUpdatedAt)
    || acceptedAt < claimHydratedAtMs || completedAt < acceptedAt
    || progressUpdatedAt < completedAt) return null;
  const terminalRecordedAt = parseTime(command.terminalRecordedAt);
  const terminalReasonRecovered = command.terminalOutcome === outcome
    && Number.isFinite(terminalRecordedAt)
    && terminalRecordedAt >= acceptedAt && terminalRecordedAt <= completedAt
    && Boolean(String(command.terminalReason || '').trim());
  const reason = terminalReasonRecovered
    ? String(command.terminalReason).trim()
    : '浏览器业务命令已暂停，后台登录状态刷新覆盖了具体原因；禁止重复提交，等待人工核对';
  return {
    outcome,
    reason,
    payload: {
      ...progress,
      step: outcome,
      manualReview: {
        stage: 'resident-command-terminal-recovery', reason,
        originalStage: terminalReasonRecovered ? command.terminalStage || null : null,
      },
      residentTerminalRecovery: {
        commandRequestId,
        assignmentId: claim.leaseToken,
        outcome,
        recoveredAt: new Date(now).toISOString(),
        terminalReasonRecovered,
        externalActionsReplayed: false,
      },
      updatedAt: new Date(now).toISOString(),
    },
  };
}

// Reconciliation is read-only, but its browser process stays resident after a
// command ends. Match the command receipt rather than waiting for process exit
// or relying on a step that background authentication observations can replace.
export function residentReconciliationTerminalOutcome({
  progress = {}, commandRequestId = null, startedAtMs, reused = true,
} = {}) {
  if (!Number.isFinite(startedAtMs)) return null;
  if (commandRequestId) {
    const command = progress.residentCommand || {};
    const acceptedAt = parseTime(command.acceptedAt);
    const completedAt = parseTime(command.completedAt);
    if (command.requestId !== commandRequestId || command.action !== 'run-order'
      || command.status !== 'idle' || !Number.isFinite(acceptedAt)
      || !Number.isFinite(completedAt) || acceptedAt < startedAtMs
      || completedAt < acceptedAt) return null;
    return String(command.outcome || 'finished-without-observation');
  }
  // The initial child can run an order without an IPC command. Only a new
  // business checkpoint can establish termination in that startup path.
  if (reused) return null;
  const businessAt = parseTime(progress.businessUpdatedAt);
  if (!Number.isFinite(businessAt) || businessAt <= startedAtMs) return null;
  return ({
    'human-verification-required': 'verification-required',
    'manual-login-required': 'login-required',
    'flow-paused': 'flow-paused',
    'manual-review-blocked': 'manual-review-blocked',
  })[progress.step] || null;
}
