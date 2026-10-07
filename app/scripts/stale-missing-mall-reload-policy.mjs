// This permits an idle code reload only. It does not clear a verification,
// confirm a mall identity, release an order, or modify any external effect.
export const matchesStaleMissingMallReload = ({
  enabled, shopId, expectedShopName, verificationId, progress, metadata, binding,
  verificationMarkerExists, activeVerificationCount, activeCommands,
  uncertainEffectsInert, now = Date.now(),
}) => {
  if (!enabled || !binding || !verificationId || verificationMarkerExists
    || activeVerificationCount !== 0 || activeCommands !== 0 || !uncertainEffectsInert) return false;
  const identity = progress?.pddShopIdentity;
  const observedAt = Date.parse(String(identity?.detectedAt || ''));
  const age = now - observedAt;
  let businessPage = false;
  try {
    const url = new URL(metadata?.systemTabs?.pdd?.url);
    businessPage = url.origin === 'https://mms.pinduoduo.com'
      && url.pathname.startsWith('/aftersales/');
  } catch { /* Missing/invalid URLs must not qualify. */ }
  return businessPage && Number.isFinite(age) && age >= 0 && age <= 20_000
    && metadata?.state === 'human-verification-required'
    && !metadata.currentOrderNumber
    && metadata.authHealth?.pdd?.status === 'verification-required'
    && metadata.authHealth?.oms?.status === 'authenticated'
    && metadata.authHealth?.tms?.status === 'authenticated'
    && progress?.shopId === shopId && progress.step === 'human-verification-required'
    && progress.residentCommand?.status === 'idle'
    && progress.verificationLocation?.id === verificationId
    && progress.verificationLocation?.system === 'pdd'
    && identity?.status === 'unresolved'
    && identity.source === 'confirmed-mall-id-unavailable' && !identity.mallId
    && identity.headerShopName === expectedShopName
    && identity.actualShopName === expectedShopName
    && identity.profileFingerprint === binding.profile_fingerprint
    && String(identity.expectedMallId || '') === String(binding.mall_id || '')
    && /^\d{5,30}$/u.test(String(binding.mall_id || ''));
};
