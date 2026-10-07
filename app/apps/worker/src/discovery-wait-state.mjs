export const discoveryWaitsForRateLimit = (progress, {
  requestId = null, startedAt, now = Date.now(),
} = {}) => {
  if (progress?.step !== 'rate-limited-waiting') return false;
  const retryAt = Date.parse(String(progress.retryAfterAt || ''));
  const waitMs = Number(progress.rateLimitWaitMs);
  if (!Number.isFinite(retryAt) || retryAt <= now
    || !Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 60 * 60_000
    || retryAt - now > waitMs + 1_000) return false;
  if (requestId) {
    const command = progress.residentCommand;
    return command?.requestId === requestId && command.status === 'active'
      && ['discover', 'chat-collect'].includes(command.action);
  }
  // A non-resident run has no command ID: only its newly written observation
  // can pause this run's timeout, never a previous browser's saved marker.
  const updatedAt = Date.parse(String(progress.updatedAt || ''));
  return Number.isFinite(startedAt) && Number.isFinite(updatedAt)
    && updatedAt >= startedAt && updatedAt <= now + 1_000;
};
