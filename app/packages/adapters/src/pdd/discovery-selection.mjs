const normalizedKeyPart = (value, fallback) => encodeURIComponent(
  String(value || '').trim() || fallback,
);

export const buildDiscoverySelectionKey = ({
  pageNumber = 1,
  scenarioCode = null,
  rowOrderNumber = null,
  workOrderCreatedAt = null,
  scenarioCandidateNumber = 0,
  duplicateNumber = 0,
} = {}) => {
  const page = Math.max(1, Math.floor(Number(pageNumber) || 1));
  const scenario = normalizedKeyPart(scenarioCode, 'unknown');
  const orderNumber = String(rowOrderNumber || '').trim();
  if (!orderNumber) {
    const position = Math.max(0, Math.floor(Number(scenarioCandidateNumber) || 0));
    return `page:${page}:scenario:${scenario}:position:${position}`;
  }
  const createdAt = normalizedKeyPart(workOrderCreatedAt, 'unknown');
  const occurrence = Math.max(0, Math.floor(Number(duplicateNumber) || 0));
  return `page:${page}:scenario:${scenario}:order:${encodeURIComponent(orderNumber)}:created:${createdAt}:occurrence:${occurrence}`;
};

export const discoverySelectionSkipKeys = (selection = {}) => [...new Set([
  String(selection.discoveryKey || '').trim(),
  String(selection.rowFingerprint || '').trim(),
].filter(Boolean))];

export const rememberDiscoverySelection = (skippedSelectionKeys, selection = {}) => {
  const keys = discoverySelectionSkipKeys(selection);
  for (const key of keys) skippedSelectionKeys.add(key);
  return keys;
};

export const findKnownOrdinaryDiscoveryExclusion = (selection = {}, candidates = []) => {
  const orderNumber = String(selection.rowOrderNumber || '').trim();
  const scenarioCode = String(selection.scenarioCode || '').trim();
  const createdAtMs = Date.parse(selection.workOrderCreatedAt || '');
  if (!orderNumber || !scenarioCode || !Number.isFinite(createdAtMs)) return null;
  return (Array.isArray(candidates) ? candidates : []).find((candidate) => {
    const firstDiscoveredAtMs = Date.parse(candidate?.firstDiscoveredAt || '');
    return String(candidate?.orderNumber || '').trim() === orderNumber
      && String(candidate?.scenarioCode || '').trim() === scenarioCode
      && String(candidate?.platformCaseKey || '').startsWith('pdd-work-order:')
      && Number.isFinite(firstDiscoveredAtMs)
      // A later PDD creation time can represent a second work-order instance
      // for the same order and scenario, so it must still be opened.
      && createdAtMs <= firstDiscoveredAtMs;
  }) || null;
};

export const discoverNextEligibleSelection = async ({
  findSelection,
  inspectSelection,
  excludedOrderNumbers = new Set(),
  maxCandidates = 100,
  onExcluded = null,
}) => {
  const exclusions = excludedOrderNumbers instanceof Set
    ? excludedOrderNumbers
    : new Set(excludedOrderNumbers || []);
  const skippedSelectionKeys = new Set();
  const candidateLimit = Math.max(1, Number.parseInt(maxCandidates, 10) || 100);

  for (let candidateNumber = 1; candidateNumber <= candidateLimit; candidateNumber++) {
    const selection = await findSelection(skippedSelectionKeys);
    if (!selection) return null;

    const rowFingerprint = String(selection.rowFingerprint || '').trim();
    const discoveryKey = String(selection.discoveryKey || rowFingerprint).trim();
    const listedOrderNumber = String(selection.rowOrderNumber || '').trim();
    if (listedOrderNumber && !exclusions.has(listedOrderNumber)) {
      return { selection, orderNumber: listedOrderNumber, detailUrl: null };
    }

    const inspection = listedOrderNumber
      ? { orderNumber: listedOrderNumber, detailUrl: null }
      : await inspectSelection(selection);
    const orderNumber = String(inspection?.orderNumber || '').trim();
    if (orderNumber && !exclusions.has(orderNumber)) {
      return { selection, orderNumber, detailUrl: inspection?.detailUrl || null };
    }

    const skippedKeys = rememberDiscoverySelection(skippedSelectionKeys, selection);
    if (typeof onExcluded === 'function') {
      await onExcluded({
        selection,
        orderNumber: orderNumber || null,
        discoveryKey: discoveryKey || null,
        rowFingerprint: rowFingerprint || null,
        skippedKeys,
        reason: orderNumber ? 'excluded-order' : 'order-number-unavailable',
      });
    }
    if (!skippedKeys.length) return null;
  }

  return null;
};
