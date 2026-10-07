import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectHumanVerification } from '../packages/adapters/src/verification-detector/detect.mjs';
import { isVerificationResourceFailureDetection } from '../packages/adapters/src/verification-detector/resource-recovery.mjs';

const resourceCandidate = {
  selector: 'text:验证资源获取失败',
  boundingBox: { x: 840, y: 140, width: 220, height: 44 },
  confidence: 'high',
  reason: 'verification-resource-failed',
};
const frame = {
  url: () => 'https://mms.pinduoduo.com/login/',
  evaluate: async () => resourceCandidate,
};
const page = {
  isClosed: () => false,
  mainFrame: () => frame,
  frames: () => [frame],
};
const detection = await detectHumanVerification(page);
assert.equal(detection.reason, 'verification-resource-failed');
assert.equal(detection.frameUrl, 'https://mms.pinduoduo.com/login/');
assert.equal(isVerificationResourceFailureDetection(detection), true);
assert.equal(isVerificationResourceFailureDetection({ reason: 'verification-control' }), false);

const source = fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs', import.meta.url), 'utf8');
assert.match(source, /验证资源获取失败\\s\*\[,，\]\\s\*请重试/u,
  'login QR recovery must recognize the exact PDD resource failure copy');
const loginWait = source.slice(source.indexOf('const waitForPddManualLoginExit ='), source.indexOf('const waitForLoginExit ='));
assert.doesNotMatch(loginWait, /refreshExpiredPddQr|closeHumanVerificationSurface|writeVerificationTimeoutRelease/u,
  'manual login must not refresh or dismiss any verification prompt');
assert.match(loginWait, /deadline: null/u, 'login verification must wait for the operator without a close deadline');
const refresh = source.slice(source.indexOf('const refreshExpiredPddQr ='), source.indexOf('const ensurePddLogin ='));
assert.match(refresh, /if \(isManualPddLoginSurface\(targetPage\)\) return false/u,
  'the shared refresh helper must refuse login-page recovery');

console.log('pdd login QR recovery self-test passed');
