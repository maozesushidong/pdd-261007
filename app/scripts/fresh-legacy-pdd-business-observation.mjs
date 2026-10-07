// This proves only a recent business URL observation for an idle code reload.
// It does not authenticate the shop, confirm its identity, or release any work.
export const matchesFreshLegacyPddBusinessObservation = ({ metadata, progress, now = Date.now() }) => {
  const fresh = (value) => {
    const at = Date.parse(String(value || ''));
    return Number.isFinite(at) && now >= at && now - at <= 20_000;
  };
  const auths = [metadata?.authHealth?.pdd, progress?.authHealth?.pdd];
  if (auths.some((auth) => !auth
    || auth.status !== 'expired' || auth.confidence !== 'confirmed'
    || auth.evidence !== 'session-cookie-unusable'
    || !['pdd-post-login-stability', 'resident-session-recovery'].includes(auth.source)
    || !fresh(auth.checkedAt))) return false;
  const url = auths[0].url;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://mms.pinduoduo.com'
      || !parsed.pathname.startsWith('/aftersales/')) return false;
  } catch { return false; }
  if (auths[1].url !== url || progress.currentUrl !== url
    || !fresh(progress.updatedAt)
    || progress.step !== 'manual-login-required'
    || progress.residentCommand?.status !== 'idle'
    || progress.verificationLocation
    || progress.systemLogin?.system !== 'pdd'
    || progress.systemLogin?.stage !== 'pdd-session-cookie-check'
    || progress.systemLogin?.url !== url
    || !fresh(progress.systemLogin?.detectedAt)) return false;
  // Ignore the legacy systemTabs snapshot only if the live auth observation
  // is newer. A later observation of a different page must fail closed.
  const observedAt = Math.min(...auths.map((auth) => Date.parse(auth.checkedAt)));
  return [metadata.systemTabs, progress.systemTabs].every((tabs) => {
    const at = Date.parse(String(tabs?.checkedAt || ''));
    return !Number.isFinite(at) || at < observedAt || tabs?.pdd?.url === url;
  });
};
