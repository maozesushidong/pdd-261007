import assert from 'node:assert/strict';
import {
  buildDiscoverySelectionKey,
  discoverNextEligibleSelection,
  findKnownOrdinaryDiscoveryExclusion,
} from '../packages/adapters/src/pdd/discovery-selection.mjs';

const excludedOrderNumbers = new Set([
  '260803-220452656741448',
  '260803-220452656741449',
]);

const scan = async (candidates) => {
  const inspected = [];
  const skipped = [];
  const result = await discoverNextEligibleSelection({
    excludedOrderNumbers,
    findSelection: async (skippedSelectionKeys) => candidates.find((candidate) => (
      !skippedSelectionKeys.has(candidate.discoveryKey)
      && !skippedSelectionKeys.has(candidate.rowFingerprint)
    )) || null,
    inspectSelection: async (selection) => {
      inspected.push(selection.rowFingerprint);
      return { orderNumber: selection.detailOrderNumber, detailUrl: selection.detailUrl };
    },
    onExcluded: async (entry) => skipped.push(entry),
  });
  return { result, inspected, skipped };
};

const nextCandidate = await scan([
  {
    discoveryKey: 'in-transit-refund:0',
    rowFingerprint: 'owner-deleted-row',
    rowOrderNumber: null,
    detailOrderNumber: '260803-220452656741448',
    detailUrl: 'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=deleted',
  },
  {
    discoveryKey: 'in-transit-refund:1',
    rowFingerprint: 'next-pending-row',
    rowOrderNumber: null,
    detailOrderNumber: '260803-220452656741450',
    detailUrl: 'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=next',
  },
]);
assert.equal(nextCandidate.result.orderNumber, '260803-220452656741450');
assert.equal(nextCandidate.result.selection.rowFingerprint, 'next-pending-row');
assert.deepEqual(nextCandidate.inspected, ['owner-deleted-row', 'next-pending-row']);
assert.equal(nextCandidate.skipped.length, 1);
assert.equal(nextCandidate.skipped[0].reason, 'excluded-order');
assert.equal(nextCandidate.skipped[0].discoveryKey, 'in-transit-refund:0');
assert.deepEqual(nextCandidate.skipped[0].skippedKeys, [
  'in-transit-refund:0',
  'owner-deleted-row',
]);

const allExcluded = await scan([
  {
    discoveryKey: 'in-transit-refund:0',
    rowFingerprint: 'first-excluded-row',
    rowOrderNumber: null,
    detailOrderNumber: '260803-220452656741448',
  },
  {
    discoveryKey: 'in-transit-refund:1',
    rowFingerprint: 'second-excluded-row',
    rowOrderNumber: null,
    detailOrderNumber: '260803-220452656741449',
  },
]);
assert.equal(allExcluded.result, null);
assert.deepEqual(allExcluded.inspected, ['first-excluded-row', 'second-excluded-row']);
assert.equal(allExcluded.skipped.length, 2);

const stableKey = buildDiscoverySelectionKey({
  pageNumber: 1,
  scenarioCode: 'in-transit-refund',
  rowOrderNumber: '260815-297439106663182',
  workOrderCreatedAt: '2026-08-17T05:00:00.000Z',
  scenarioCandidateNumber: 0,
});
assert.equal(stableKey, buildDiscoverySelectionKey({
  pageNumber: 1,
  scenarioCode: 'in-transit-refund',
  rowOrderNumber: '260815-297439106663182',
  workOrderCreatedAt: '2026-08-17T05:00:00.000Z',
  scenarioCandidateNumber: 9,
}));
assert.notEqual(stableKey, buildDiscoverySelectionKey({
  pageNumber: 2,
  scenarioCode: 'in-transit-refund',
  rowOrderNumber: '260815-297439106663182',
  workOrderCreatedAt: '2026-08-17T05:00:00.000Z',
}));

let dynamicFingerprintRead = 0;
const dynamicSkipped = [];
const dynamicFingerprintResult = await discoverNextEligibleSelection({
  excludedOrderNumbers,
  findSelection: async (skippedSelectionKeys) => {
    const changingExcludedCandidate = {
      discoveryKey: stableKey,
      rowFingerprint: `dynamic-countdown-${dynamicFingerprintRead += 1}`,
      rowOrderNumber: null,
      detailOrderNumber: '260803-220452656741448',
    };
    if (!skippedSelectionKeys.has(changingExcludedCandidate.discoveryKey)) {
      return changingExcludedCandidate;
    }
    return {
      discoveryKey: buildDiscoverySelectionKey({
        pageNumber: 1,
        scenarioCode: 'in-transit-refund',
        rowOrderNumber: '260803-220452656741450',
        workOrderCreatedAt: '2026-08-17T05:01:00.000Z',
      }),
      rowFingerprint: 'next-stable-row',
      rowOrderNumber: null,
      detailOrderNumber: '260803-220452656741450',
    };
  },
  inspectSelection: async (selection) => ({ orderNumber: selection.detailOrderNumber }),
  onExcluded: async (entry) => dynamicSkipped.push(entry),
});
assert.equal(dynamicFingerprintResult.orderNumber, '260803-220452656741450');
assert.equal(dynamicFingerprintRead, 2);
assert.equal(dynamicSkipped.length, 1);
assert.equal(dynamicSkipped[0].discoveryKey, stableKey);

const knownCandidate = {
  orderNumber: '260817-600729198183650',
  scenarioCode: 'in-transit-refund',
  platformCaseKey: 'pdd-work-order:500012982340709',
  firstDiscoveredAt: '2026-08-19T17:45:04.316Z',
};
assert.equal(findKnownOrdinaryDiscoveryExclusion({
  rowOrderNumber: knownCandidate.orderNumber,
  scenarioCode: knownCandidate.scenarioCode,
  workOrderCreatedAt: '2026-08-19T16:30:00.000Z',
}, [knownCandidate]), knownCandidate);
assert.equal(findKnownOrdinaryDiscoveryExclusion({
  rowOrderNumber: knownCandidate.orderNumber,
  scenarioCode: knownCandidate.scenarioCode,
  workOrderCreatedAt: '2026-08-19T17:46:00.000Z',
}, [knownCandidate]), null,
'a later PDD work-order instance for the same order and scenario must still be opened');
assert.equal(findKnownOrdinaryDiscoveryExclusion({
  rowOrderNumber: knownCandidate.orderNumber,
  scenarioCode: knownCandidate.scenarioCode,
  workOrderCreatedAt: null,
}, [knownCandidate]), null,
'list candidates without a readable creation time must retain detail-level verification');

console.log('PDD discovery exclusion scan self-test passed');
