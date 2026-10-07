// A fresh runner heartbeat does not make its cached browser observation fresh.
// This describes audit evidence only and never resumes a queue or changes auth.
export const authObservationEvidence = (shop, system, {
  now = Date.now(), maxAgeMs = 60_000,
} = {}) => {
  const checkedAt = Date.parse(shop.authHealth?.[system]?.checkedAt || '');
  const authAgeMs = Number.isFinite(checkedAt) ? now - checkedAt : null;
  const runtimeAgeSeconds = shop.runtimeObservationAgeSeconds;
  const runtimeAgeMs = runtimeAgeSeconds != null && Number.isFinite(Number(runtimeAgeSeconds))
    ? Number(runtimeAgeSeconds) * 1000 : null;
  const recent = age => age != null && age >= 0 && age <= maxAgeMs;
  return {
    evidenceState: recent(authAgeMs) || recent(runtimeAgeMs) ? 'current' : 'stale',
    authCheckedAt: shop.authHealth?.[system]?.checkedAt || null,
    runtimeObservationAgeSeconds: runtimeAgeSeconds ?? null,
  };
};
