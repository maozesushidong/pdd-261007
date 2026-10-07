const verificationSteps = new Set([
  'human-verification-required',
  'manual-login-required',
]);

const verificationStatuses = new Set([
  'detected',
  'waiting-human',
  'verification-required',
]);

export const classifyReturnRefundWaitState = (progress = {}) => {
  const verificationWaiting = verificationSteps.has(progress.step)
    || verificationStatuses.has(progress.verificationLocation?.status)
    || ['expired', 'verification-required'].includes(progress.authHealth?.pdd?.status);
  const rateLimitWaiting = progress.step === 'rate-limited-waiting';
  return {
    verificationWaiting,
    rateLimitWaiting,
    pausesActiveTimeout: verificationWaiting || rateLimitWaiting,
  };
};

// A claim must not be released while its already-delivered resident command
// can still start or is still executing. The browser may have accepted the
// message before a CAPTCHA blocked the command loop.
export const returnRefundClaimCommandUnsettled = ({
  mode = 'claim',
  requestId = '',
  progress = {},
  deferred = null,
} = {}) => {
  if (mode !== 'claim' || !requestId) return false;
  if (deferred?.requestId === requestId && deferred.accepted === false) return true;
  const command = progress.residentCommand || {};
  return command.requestId === requestId && command.status === 'active';
};

export const createReturnRefundWaitTimeoutError = ({
  progress = {},
  mode = 'claim',
  timeoutMs = 0,
  hardLimit = false,
} = {}) => {
  const operation = mode === 'scan' ? '扫描' : '处理';
  const waitState = classifyReturnRefundWaitState(progress);
  if (waitState.verificationWaiting) {
    const error = new Error(`等待退货退款${operation}期间仍需完成拼多多登录或验证`);
    error.code = 'PDD_HUMAN_VERIFICATION_REQUIRED';
    error.kind = 'verification-required';
    error.retryable = true;
    return error;
  }
  const suffix = hardLimit ? `${timeoutMs}ms硬性上限` : '超时';
  const error = new Error(`等待退货退款${operation}结果${suffix}`);
  error.code = hardLimit ? 'RETURN_REFUND_HARD_TIMEOUT' : 'RETURN_REFUND_TIMEOUT';
  error.kind = 'page-error';
  error.retryable = true;
  return error;
};

export const returnRefundProgressMarker = (progress = {}, requestId = null) => {
  const expectedRequestId = String(requestId || '').trim();
  const residentCommand = progress.residentCommand || {};
  if (expectedRequestId && (
    String(residentCommand.requestId || '').trim() !== expectedRequestId
    || residentCommand.status !== 'active'
  )) return null;
  // Runtime observations update `updatedAt` even when the browser has not
  // advanced the business flow. Prefer the dedicated business clock so a
  // heartbeat cannot keep a stalled refund command alive until the hard cap.
  const businessUpdatedAt = String(progress.businessUpdatedAt || progress.updatedAt || '').trim();
  if (!businessUpdatedAt || !Number.isFinite(Date.parse(businessUpdatedAt))) return null;
  return [
    String(residentCommand.requestId || expectedRequestId),
    String(progress.step || ''),
    businessUpdatedAt,
  ].join(':');
};

export const advanceReturnRefundWaitBudget = ({
  remainingMs,
  elapsedMs,
  timeoutMs,
  previousProgressMarker = null,
  progress = {},
  requestId = null,
} = {}) => {
  const waitState = classifyReturnRefundWaitState(progress);
  const observedProgressMarker = returnRefundProgressMarker(progress, requestId);
  const progressAdvanced = Boolean(
    observedProgressMarker && observedProgressMarker !== previousProgressMarker,
  );
  const refreshedRemainingMs = progressAdvanced ? timeoutMs : remainingMs;
  return {
    ...waitState,
    progressAdvanced,
    progressMarker: observedProgressMarker || previousProgressMarker,
    remainingMs: waitState.pausesActiveTimeout
      ? refreshedRemainingMs
      : refreshedRemainingMs - Math.max(0, Number(elapsedMs) || 0),
  };
};
