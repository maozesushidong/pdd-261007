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
  return code.includes('VERIFICATION_REQUIRED') || status === 'verification-required';
};

export const isReturnRefundScanLoginFailure = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const status = String(error?.result?.status || '').toLowerCase();
  return code.includes('LOGIN_REQUIRED') || status === 'login-required';
};

export const nextReturnRefundScanRetry = ({
  error,
  now = Date.now(),
  verificationRetryMs = 10_000,
  failureRetryMs = 120_000,
} = {}) => {
  const checkedAt = finiteTimestamp(typeof now === 'function' ? now() : now, Date.now());
  const verificationRequired = isReturnRefundScanVerificationFailure(error);
  const loginRequired = isReturnRefundScanLoginFailure(error);
  const retryDelayMs = verificationRequired || loginRequired
    ? positiveDuration(verificationRetryMs, 10_000)
    : positiveDuration(failureRetryMs, 120_000);
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
