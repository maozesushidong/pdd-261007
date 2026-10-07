const finiteTimestamp = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const positiveDuration = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

export const isReturnRefundScanVerificationFailure = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const status = String(error?.result?.status || '').toLowerCase();
  return code.includes('VERIFICATION_REQUIRED')
    || code.includes('VERIFICATION_TIMEOUT')
    || status === 'verification-required'
    || status === 'verification-timeout';
};

export const isReturnRefundScanLoginFailure = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const status = String(error?.result?.status || '').toLowerCase();
  return code.includes('LOGIN_REQUIRED') || status === 'login-required';
};

export const returnRefundSessionRunwayCooldownUntil = (result, now = Date.now()) => {
  if (result?.outcome !== 'page-error' || result?.retryKind !== 'pdd-session-runway') return 0;
  const retryAt = Date.parse(String(result.nextCheckAt || ''));
  const checkedAt = finiteTimestamp(typeof now === 'function' ? now() : now, Date.now());
  return Number.isFinite(retryAt) && retryAt > checkedAt ? retryAt : 0;
};

export const nextReturnRefundScanRetry = ({
  error,
  now = Date.now(),
  verificationRetryMs = 10_000,
  verificationTimeoutRetryMs = 30 * 60_000,
  failureRetryMs = 120_000,
} = {}) => {
  const checkedAt = finiteTimestamp(typeof now === 'function' ? now() : now, Date.now());
  const verificationRequired = isReturnRefundScanVerificationFailure(error);
  const verificationTimedOut = String(error?.code || '').toUpperCase().includes('VERIFICATION_TIMEOUT')
    || String(error?.result?.status || '').toLowerCase() === 'verification-timeout';
  const loginRequired = isReturnRefundScanLoginFailure(error);
  const baseRetryDelayMs = verificationTimedOut
    // A timed-out slider must not reopen the same deep refund list every five
    // minutes while the operator is away. Direct claims use a separate queue.
    ? positiveDuration(verificationTimeoutRetryMs, 30 * 60_000)
    : verificationRequired || loginRequired
    ? positiveDuration(verificationRetryMs, 10_000)
    : positiveDuration(failureRetryMs, 120_000);
  const rateLimited = String(error?.result?.status || '').toLowerCase() === 'rate-limited'
    || String(error?.code || '').toUpperCase() === 'RETURN_REFUND_RATE_LIMITED';
  const limitRetryAt = rateLimited ? Date.parse(error?.result?.retryAfterAt || '') : NaN;
  const retryDelayMs = Number.isFinite(limitRetryAt) && limitRetryAt > checkedAt
    ? Math.max(baseRetryDelayMs, limitRetryAt - checkedAt)
    : baseRetryDelayMs;
  return {
    verificationRequired,
    loginRequired,
    retryDelayMs,
    retryNotBefore: checkedAt + retryDelayMs,
  };
};

export const isReturnRefundScanDue = ({
  cursor = null,
  now = Date.now(),
  lastSuccessfulScanAt = 0,
  retryNotBefore = 0,
  intervalMs = 30 * 60_000,
} = {}) => {
  const checkedAt = finiteTimestamp(typeof now === 'function' ? now() : now, Date.now());
  if (checkedAt < finiteTimestamp(retryNotBefore, 0)) return false;
  if (cursor) return true;
  return checkedAt - finiteTimestamp(lastSuccessfulScanAt, 0)
    >= positiveDuration(intervalMs, 30 * 60_000);
};

export const returnRefundScanBatchDurationMs = ({
  baseDurationMs = 120_000,
  maxDurationMs = 4 * 60 * 60_000,
  cursor = null,
} = {}) => {
  const base = positiveDuration(baseDurationMs, 120_000);
  const page = Math.max(1, Math.floor(Number(cursor?.page) || 1));
  // Restoring a deep UI cursor starts from page one on each bounded batch.
  // Keep the same click pace and item cap; allow enough time to inspect more
  // than one row after those sequential page transitions.
  const seekAllowanceMs = Math.min(120_000, Math.max(0, page - 5) * 12_000);
  return Math.min(positiveDuration(maxDurationMs, base), base + seekAllowanceMs);
};

// The first scan after changing the list action scope rechecks the requested
// page from row zero. Its actual start, rather than the legacy offset, must
// be used for progress and cycle detection. All subsequent batches retain
// the normal duplicate-cursor guard.
export const returnRefundScanEffectiveStartCursor = (requested, scan) => {
  const sameCursor = (a, b) => a?.page === b?.page && a?.itemOffset === b?.itemOffset;
  const proof = scan?.resumeProof;
  return Number.isSafeInteger(requested?.page) && requested.page > 0
    && Number.isSafeInteger(requested?.itemOffset) && requested.itemOffset > 0
    && scan?.resumeCheck?.cursorScopeReset === true
    && scan.resumeCheck.resumed === false
    && sameCursor(requested, scan.requestedCursor)
    && sameCursor(scan.startCursor, { page: requested.page, itemOffset: 0 })
    && Number.isSafeInteger(scan.examined) && scan.examined > 0
    && (scan.actionScope === 'refund-list-without-platform-messages-v1'
      || (proof?.actionScope === 'refund-list-without-platform-messages-v1'
        && proof.page === requested.page
        && sameCursor(proof.nextCursor, scan.nextCursor)))
    ? scan.startCursor : requested;
};

export const returnRefundPartialScanCooldownMs = ({
  baseMs = 5 * 60_000,
  postVerificationMs = 5 * 60_000,
  verificationHandledCount = 0,
} = {}) => {
  const base = positiveDuration(baseMs, 5 * 60_000);
  return Number(verificationHandledCount) > 0
    ? Math.max(base, positiveDuration(postVerificationMs, 5 * 60_000))
    : base;
};

export const returnRefundVerificationCooldownUntil = ({
  scannedAt = 0,
  verificationHandledCount = 0,
  postVerificationMs = 5 * 60_000,
} = {}) => Number(verificationHandledCount) > 0
  ? finiteTimestamp(scannedAt, 0)
    + positiveDuration(postVerificationMs, 5 * 60_000)
  : 0;

export const shouldPrioritizeReturnRefundScan = ({
  configured = false,
  scanDue = false,
  boundedSession = false,
  assignmentKind = '',
  directClaimsSinceScan = 0,
  directClaimsBeforeScan = 4,
  lastSuccessfulScanAt = 0,
  forceIntervalMs = 2 * 60 * 60_000,
  now = Date.now(),
} = {}) => {
  if (!configured || !scanDue) return false;
  if (boundedSession && assignmentKind === 'refund-scan') return true;
  if (finiteTimestamp(directClaimsSinceScan, 0)
    >= positiveDuration(directClaimsBeforeScan, 4)) return true;
  const checkedAt = finiteTimestamp(typeof now === 'function' ? now() : now, Date.now());
  return checkedAt - finiteTimestamp(lastSuccessfulScanAt, 0)
    >= positiveDuration(forceIntervalMs, 2 * 60 * 60_000);
};

export const shouldResumePartialReturnRefundScan = ({
  configured = false,
  scanDue = false,
  cursor = null,
  lastBatchAt = 0,
  now = Date.now(),
} = {}) => {
  if (!configured || !scanDue
    || !Number.isSafeInteger(cursor?.page) || cursor.page < 1
    || !Number.isSafeInteger(cursor?.itemOffset) || cursor.itemOffset < 0
    || (cursor.page === 1 && cursor.itemOffset === 0)) return false;
  // A partial batch is not a completed discovery cycle. Give its durable
  // cursor a bounded turn even while ordinary and known-refund queues stay
  // nonempty. Existing retry/captcha gates still determine scanDue.
  const checkedAt = finiteTimestamp(typeof now === 'function' ? now() : now, Date.now());
  return checkedAt - finiteTimestamp(lastBatchAt, checkedAt) >= 10 * 60_000;
};

export const returnRefundScanStartupDelay = ({
  shopKey = '',
  maxDelayMs = 10 * 60_000,
  slotIndex = null,
  slotCount = null,
} = {}) => {
  const key = String(shopKey || '').trim();
  const maximum = Math.max(0, Math.floor(Number(maxDelayMs) || 0));
  if (maximum === 0) return 0;
  const normalizedSlotIndex = Number(slotIndex);
  const normalizedSlotCount = Number(slotCount);
  if (Number.isInteger(normalizedSlotIndex)
    && normalizedSlotIndex >= 0
    && Number.isInteger(normalizedSlotCount)
    && normalizedSlotCount > 0) {
    const slot = normalizedSlotIndex % normalizedSlotCount;
    return Math.floor(maximum * (slot + 0.5) / normalizedSlotCount);
  }
  if (!key) return 0;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  return hash % (maximum + 1);
};
