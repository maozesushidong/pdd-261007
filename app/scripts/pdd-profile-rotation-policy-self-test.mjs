import assert from 'node:assert/strict';

import { canTrustCorrectedPddProfile } from '../apps/worker/src/pdd-profile-rotation-policy.mjs';

const base = {
  shopId: 'shop-corrected',
  bindingStatus: 'revoked',
  expectedShopName: 'PANAPOPO医疗健康旗舰店',
  confirmedMallId: '523765477',
  confirmedFingerprint: 'old-profile',
  observedShopName: 'PANAPOPO医疗健康旗舰店',
  observedMallId: '523765477',
  observedFingerprint: 'new-profile',
  observedAt: '2026-09-27T14:38:10.360Z',
  loginRequestedAt: '2026-09-04T03:17:48.076Z',
  marker: {
    shopId: 'shop-corrected',
    profileFingerprint: 'new-profile',
    identityBinding: {
      shopId: 'shop-corrected',
      status: 'confirmed',
      expectedShopName: 'PANAPOPO医疗健康旗舰店',
      mallId: '523765477',
      loginRequestedAt: '2026-09-04T03:17:48.076Z',
    },
    lastUnmaskedIdentityObservation: {
      actualShopName: 'PANAPOPO医疗健康旗舰店',
      mallId: '523765477',
      profileFingerprint: 'new-profile',
      loginRequestedAt: '2026-09-04T03:17:48.076Z',
      detectedAt: '2026-09-27T14:39:10.360Z',
    },
  },
};
const check = (change) => canTrustCorrectedPddProfile({
  ...base,
  ...change,
  marker: change.marker || base.marker,
});
assert.equal(check({}), true, 'the exact previously confirmed merchant can use its current profile');
assert.equal(check({ bindingStatus: 'confirmed' }), false);
assert.equal(check({ observedMallId: '207852746' }), false, 'a different merchant ID is never trusted');
assert.equal(check({ observedShopName: 'PANAPOPO医疗保健旗舰店' }), false);
assert.equal(check({ observedFingerprint: 'old-profile' }), false);
assert.equal(check({ marker: { ...base.marker, shopId: 'another-shop' } }), false);
assert.equal(check({ marker: { ...base.marker, profileFingerprint: 'another-profile' } }), false);
assert.equal(check({ marker: { ...base.marker, identityBinding: {
  ...base.marker.identityBinding, status: 'revoked',
} } }), false);
assert.equal(check({ marker: { ...base.marker, identityBinding: {
  ...base.marker.identityBinding, loginRequestedAt: 'another-login',
} } }), false);
assert.equal(check({ marker: { ...base.marker, lastUnmaskedIdentityObservation: {
  ...base.marker.lastUnmaskedIdentityObservation,
  detectedAt: '2026-09-27T14:30:00.000Z',
} } }), false, 'a stale marker observation cannot authorize a profile change');
console.log('PDD corrected-profile policy self-test passed');
