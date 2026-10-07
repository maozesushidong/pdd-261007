import assert from 'node:assert/strict';
import { matchesFreshLegacyPddBusinessObservation as matches } from './fresh-legacy-pdd-business-observation.mjs';

const now = Date.parse('2026-09-29T09:00:00Z');
const recent = new Date(now - 1_000).toISOString();
const url = 'https://mms.pinduoduo.com/aftersales/work_order/list';
const auth = { status: 'expired', confidence: 'confirmed', evidence: 'session-cookie-unusable',
  source: 'pdd-post-login-stability', checkedAt: recent, url };
const tabs = { checkedAt: new Date(now - 7 * 60 * 60_000).toISOString(),
  pdd: { url: 'https://mms.pinduoduo.com/login/' } };
const valid = { now, metadata: { authHealth: { pdd: auth }, systemTabs: tabs },
  progress: { authHealth: { pdd: auth }, systemTabs: tabs, updatedAt: recent,
    currentUrl: url, step: 'manual-login-required', residentCommand: { status: 'idle' },
    systemLogin: { system: 'pdd', stage: 'pdd-session-cookie-check', url, detectedAt: recent } } };
assert.equal(matches(valid), true, 'fresh page observations can supersede the old login tab snapshot');
const rejected = [
  (x) => { x.metadata.authHealth.pdd.checkedAt = new Date(now - 21_000).toISOString(); },
  (x) => { x.progress.authHealth.pdd.checkedAt = new Date(now + 1).toISOString(); },
  (x) => { x.metadata.authHealth.pdd.evidence = 'rendered-login-url'; },
  (x) => { x.progress.authHealth.pdd.source = 'uncontrolled-observer'; },
  (x) => { x.progress.authHealth.pdd.confidence = 'weak'; },
  (x) => { x.progress.authHealth.pdd.url = 'https://mms.pinduoduo.com/login/'; },
  (x) => { x.metadata.authHealth.pdd.url = 'https://mms.pinduoduo.com.evil.test/aftersales/list'; },
  (x) => { x.metadata.authHealth.pdd.url = 'http://mms.pinduoduo.com/aftersales/list'; },
  (x) => { x.progress.currentUrl = 'https://mms.pinduoduo.com/login/'; },
  (x) => { x.progress.updatedAt = new Date(now - 21_000).toISOString(); },
  (x) => { x.progress.step = 'return-refund-claim-starting'; },
  (x) => { x.progress.residentCommand.status = 'active'; },
  (x) => { delete x.progress.residentCommand; },
  (x) => { x.progress.verificationLocation = { status: 'waiting-human' }; },
  (x) => { x.progress.systemLogin.system = 'oms'; },
  (x) => { x.progress.systemLogin.stage = 'rendered-login'; },
  (x) => { x.progress.systemLogin.url = 'https://mms.pinduoduo.com/login/'; },
  (x) => { x.progress.systemLogin.detectedAt = new Date(now - 21_000).toISOString(); },
  (x) => { x.metadata.systemTabs.checkedAt = new Date(now).toISOString(); },
  (x) => { x.progress.systemTabs.checkedAt = new Date(now).toISOString(); },
];
for (let i = 0; i < rejected.length; i += 1) {
  // JSON cloning intentionally separates the metadata/progress evidence.
  const input = JSON.parse(JSON.stringify(valid));
  rejected[i](input);
  assert.equal(matches(input), false, `unsafe observation ${i + 1} must be rejected`);
}
console.log(`fresh legacy PDD business observation self-test passed (${rejected.length + 1} cases)`);
