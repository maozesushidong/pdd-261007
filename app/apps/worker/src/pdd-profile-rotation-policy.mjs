// A previously wrong login may revoke a shop's old browser-profile binding.
// Trust a new profile only when the live merchant ID is the one previously
// confirmed for this shop and the local marker independently agrees.
export const canTrustCorrectedPddProfile = ({
  shopId,
  bindingStatus,
  expectedShopName,
  confirmedMallId,
  confirmedFingerprint,
  observedShopName,
  observedMallId,
  observedFingerprint,
  observedAt,
  loginRequestedAt,
  marker,
}) => {
  const text = (value) => String(value || '').trim();
  const observedAtMs = Date.parse(text(observedAt));
  const markerObservation = marker?.lastUnmaskedIdentityObservation || {};
  const markerObservedAtMs = Date.parse(text(markerObservation.detectedAt));
  return bindingStatus === 'revoked'
    && Boolean(text(shopId) && text(expectedShopName)
      && text(confirmedMallId) && text(loginRequestedAt))
    && text(observedShopName) === text(expectedShopName)
    && text(observedMallId) === text(confirmedMallId)
    && Boolean(text(confirmedFingerprint) && text(observedFingerprint))
    && text(confirmedFingerprint) !== text(observedFingerprint)
    && text(marker?.shopId) === text(shopId)
    && text(marker?.profileFingerprint) === text(observedFingerprint)
    && text(marker?.identityBinding?.shopId) === text(shopId)
    && marker?.identityBinding?.status === 'confirmed'
    && text(marker?.identityBinding?.expectedShopName) === text(expectedShopName)
    && text(marker?.identityBinding?.mallId) === text(confirmedMallId)
    && text(marker?.identityBinding?.loginRequestedAt) === text(loginRequestedAt)
    && text(markerObservation.actualShopName) === text(expectedShopName)
    && text(markerObservation.mallId) === text(confirmedMallId)
    && text(markerObservation.profileFingerprint) === text(observedFingerprint)
    && text(markerObservation.loginRequestedAt) === text(loginRequestedAt)
    && Number.isFinite(observedAtMs)
    && Number.isFinite(markerObservedAtMs)
    && markerObservedAtMs >= observedAtMs - 2 * 60_000;
};
