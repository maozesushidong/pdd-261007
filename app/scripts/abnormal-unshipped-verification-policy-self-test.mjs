import assert from 'node:assert/strict';
import { abnormalUnshippedVerificationRetryAt } from '../apps/worker/src/abnormal-unshipped-verification-policy.mjs';

const nowMs = Date.parse('2026-09-28T18:00:00Z');
const base = {
  scenarioCode: 'abnormal-network-warning',
  waitKind: 'logistics',
  shipmentWaitStatus: 'awaiting-pdd-shipment',
  existingRetryAt: '2026-09-28T18:15:00Z',
  nowMs,
};
assert.equal(abnormalUnshippedVerificationRetryAt({
  ...base, recentResolvedVerifications: 2,
})?.toISOString(), '2026-09-28T18:30:00.000Z');
assert.equal(abnormalUnshippedVerificationRetryAt({
  ...base, recentResolvedVerifications: 1,
}), null);
assert.equal(abnormalUnshippedVerificationRetryAt({
  ...base, scenarioCode: 'product-shortage', recentResolvedVerifications: 3,
}), null);
assert.equal(abnormalUnshippedVerificationRetryAt({
  ...base, shipmentWaitStatus: 'shipped', recentResolvedVerifications: 3,
}), null);
assert.equal(abnormalUnshippedVerificationRetryAt({
  ...base, existingRetryAt: '2026-09-28T18:45:00Z', recentResolvedVerifications: 3,
}), null);
console.log('abnormal unshipped verification policy self-test passed');
