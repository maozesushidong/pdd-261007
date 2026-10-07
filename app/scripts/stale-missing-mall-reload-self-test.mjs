import assert from 'node:assert/strict';
import { matchesStaleMissingMallReload } from './stale-missing-mall-reload-policy.mjs';

const now = Date.now();
const input = {
  enabled: true, shopId: 'shop', expectedShopName: '居家店', verificationId: 'verification',
  now, verificationMarkerExists: false, activeVerificationCount: 0, activeCommands: 0,
  uncertainEffectsInert: true,
  binding: { mall_id: '380822048', profile_fingerprint: 'profile' },
  metadata: {
    state: 'human-verification-required', currentOrderNumber: null,
    systemTabs: { pdd: { url: 'https://mms.pinduoduo.com/aftersales/work_order/list' } },
    authHealth: { pdd: { status: 'verification-required' },
      oms: { status: 'authenticated' }, tms: { status: 'authenticated' } },
  },
  progress: {
    shopId: 'shop', step: 'human-verification-required', residentCommand: { status: 'idle' },
    verificationLocation: { id: 'verification', system: 'pdd' },
    pddShopIdentity: { status: 'unresolved', source: 'confirmed-mall-id-unavailable',
      mallId: null, expectedMallId: '380822048', profileFingerprint: 'profile',
      headerShopName: '居家店', actualShopName: '居家店', detectedAt: new Date(now).toISOString() },
  },
};
assert.equal(matchesStaleMissingMallReload(input), true);
const invalid = [
  ['enabled', false], ['verificationMarkerExists', true], ['activeVerificationCount', 1],
  ['activeCommands', 1], ['uncertainEffectsInert', false], ['verificationId', 'different'],
  ['metadata.currentOrderNumber', 'active-order'], ['metadata.state', 'processing'],
  ['metadata.systemTabs.pdd.url', 'https://mms.pinduoduo.com/login/'],
  ['metadata.authHealth.oms.status', 'expired'], ['metadata.authHealth.tms.status', 'expired'],
  ['progress.shopId', 'other'], ['progress.residentCommand.status', 'active'],
  ['progress.pddShopIdentity.source', 'confirmed-mall-id-conflict'],
  ['progress.pddShopIdentity.mallId', '999999999'],
  ['progress.pddShopIdentity.headerShopName', '其他店'],
  ['progress.pddShopIdentity.actualShopName', '其他店'],
  ['progress.pddShopIdentity.profileFingerprint', 'other'],
  ['progress.pddShopIdentity.expectedMallId', '999999999'],
  ['progress.pddShopIdentity.detectedAt', new Date(now - 20_001).toISOString()],
  ['progress.pddShopIdentity.detectedAt', new Date(now + 1).toISOString()],
];
for (const [path, value] of invalid) {
  const changed = structuredClone(input);
  const segments = path.split('.');
  const field = segments.pop();
  let target = changed;
  for (const segment of segments) target = target[segment];
  target[field] = value;
  assert.equal(matchesStaleMissingMallReload(changed), false, path);
}
console.log(`Stale missing-mall reload self-test passed (${invalid.length + 1} cases)`);
