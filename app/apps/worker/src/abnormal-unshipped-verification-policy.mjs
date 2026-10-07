// Rechecking a still-unshipped abnormal-network case requires a PDD detail
// visit. Repeated real challenges on that same case justify a bounded pause;
// the business decision and all submission guards remain unchanged.
export const abnormalUnshippedVerificationRetryAt = ({
  scenarioCode,
  waitKind,
  shipmentWaitStatus,
  recentResolvedVerifications,
  existingRetryAt,
  nowMs = Date.now(),
}) => {
  if (scenarioCode !== 'abnormal-network-warning'
    || waitKind !== 'logistics'
    || !['awaiting-pdd-shipment', 'pdd-shipment-rechecked'].includes(shipmentWaitStatus)
    || Number(recentResolvedVerifications) < 2) return null;
  const existingMs = Date.parse(existingRetryAt || '');
  if (!Number.isFinite(existingMs) || !Number.isFinite(nowMs)) return null;
  const delayedMs = Math.max(existingMs, nowMs + 30 * 60_000);
  return delayedMs > existingMs ? new Date(delayedMs) : null;
};
