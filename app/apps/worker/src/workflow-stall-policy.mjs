const timestampMs = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const hasFutureDeadline = (values, nowMs) => values.some((value) => {
  const parsed = timestampMs(value);
  return parsed !== null && parsed > nowMs;
});

const activeVerificationStatuses = new Set([
  'detected',
  'waiting-human',
  'verification-required',
]);

const authenticationSystems = new Set(['pdd', 'oms', 'tms']);
const normalizeAuthenticationSystem = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return authenticationSystems.has(normalized) ? normalized : null;
};

export const workflowAuthenticationState = (progress = {}, { requiredSystems = null } = {}) => {
  const required = requiredSystems == null
    ? new Set(authenticationSystems)
    : new Set((requiredSystems || []).map(normalizeAuthenticationSystem).filter(Boolean));
  const isRequired = (system) => Boolean(system && required.has(system));
  const step = String(progress.step || '');
  const loginSystem = normalizeAuthenticationSystem(progress.systemLogin?.system);
  const verificationSystem = normalizeAuthenticationSystem(progress.verificationLocation?.system);
  const manualLoginRequired = step === 'manual-login-required'
    && (!loginSystem || isRequired(loginSystem));
  const humanVerificationRequired = step === 'human-verification-required'
    && (!verificationSystem || isRequired(verificationSystem));
  const explicitCandidates = manualLoginRequired
    ? [progress.systemLogin?.system, progress.verificationLocation?.system]
    : [progress.verificationLocation?.system, progress.systemLogin?.system];
  const normalizedExplicitCandidates = explicitCandidates
    .map(normalizeAuthenticationSystem)
    .filter(isRequired);
  const explicitSystem = normalizedExplicitCandidates.find((system) => {
    const healthStatus = String(progress.authHealth?.[system]?.status || '');
    if (['expired', 'verification-required'].includes(healthStatus)) return true;
    const verificationStatus = String(progress.verificationLocation?.status || '');
    if (system === verificationSystem
      && (humanVerificationRequired || activeVerificationStatuses.has(verificationStatus))
      && healthStatus !== 'authenticated') return true;
    const loginStatus = String(progress.systemLogin?.status || '');
    return system === loginSystem
      && manualLoginRequired
      && healthStatus !== 'authenticated'
      && loginStatus !== 'authenticated';
  });
  const blockedHealthSystem = Object.entries(progress.authHealth || {})
    .find(([system, health]) => isRequired(normalizeAuthenticationSystem(system))
      && ['expired', 'verification-required'].includes(String(health?.status || '')))?.[0];
  const activeSystem = normalizeAuthenticationSystem(progress.systemTabs?.activeSystem);
  const system = explicitSystem
    || normalizeAuthenticationSystem(blockedHealthSystem)
    || normalizedExplicitCandidates[0]
    || (isRequired(activeSystem) ? activeSystem : null)
    || [...required][0]
    || 'pdd';
  const health = progress.authHealth?.[system] || {};
  return {
    system,
    health,
    manualLoginRequired,
    humanVerificationRequired,
    blocked: manualLoginRequired
      || humanVerificationRequired
      || ['expired', 'verification-required'].includes(String(health.status || '')),
  };
};

export const workflowHeartbeatState = (requestedState, progress = {}) => {
  if (requestedState === 'browser-proxy-unavailable') return requestedState;
  const step = String(progress.step || '');
  if (step === 'manual-login-required') return 'manual-login-required';
  const verificationWaiting = step === 'human-verification-required'
    || activeVerificationStatuses.has(String(progress.verificationLocation?.status || ''))
    || Object.values(progress.authHealth || {}).some((health) => (
      String(health?.status || '') === 'verification-required'
    ));
  return verificationWaiting ? 'human-verification-required' : requestedState;
};

export const workflowStallExemption = (progress = {}, nowMs = Date.now()) => {
  const step = String(progress.step || '');
  const verificationStatus = String(progress.verificationLocation?.status || '');

  if (['manual-login-required', 'required-login', 'human-verification-required'].includes(step)) {
    return 'operator-authentication';
  }
  if (activeVerificationStatuses.has(verificationStatus)) {
    return 'operator-verification';
  }
  if (/^manual-review(?:-required|-waiting)?$/u.test(step)) {
    return 'manual-review';
  }
  if (/rate-limit/u.test(step) && hasFutureDeadline([
    progress.retryAfterAt,
    progress.rateLimit?.retryAfterAt,
  ], nowMs)) {
    return 'rate-limit-backoff';
  }
  if (/logistics-wait|ordinary-scenario-(?:stage-)?waiting/u.test(step)
    && hasFutureDeadline([
      progress.logisticsWait?.nextAttemptAt,
      progress.logisticsWait?.retryAfterAt,
      progress.logisticsRetry?.nextAttemptAt,
      progress.nextAttemptAt,
    ], nowMs)) {
    return 'scheduled-business-wait';
  }
  if (step === 'queue-empty-waiting'
    && hasFutureDeadline([progress.loopState?.nextPollAt], nowMs)) {
    return 'queue-poll-wait';
  }
  return null;
};
