import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'workflow.mjs'), 'utf8').replace(/\r\n/gu, '\n');
const start = source.indexOf('let returnRefundScanPage = null;');
const end = source.indexOf('\n\nconst residentCommandFailureStatus =', start);
assert(start >= 0 && end > start, 'resident refund-scan source must be present');
const scanSource = source.slice(start, end);

const scenario = async ({ proofPage = 9, failure = 'verification' } = {}) => {
  class HumanVerificationRequiredError extends Error {}
  const cursor = { page: 9, itemOffset: 2 };
  const proof = { page: proofPage, rowCount: 10, nextCursor: cursor,
    capturedAt: new Date().toISOString(), urlSha256: 'url', rowsSha256: 'rows' };
  const listPage = { currentUrl: 'about:blank', url() { return this.currentUrl; },
    isClosed() { return false; } };
  const observed = { created: 0, navigated: 0, proofReads: 0, retained: 0,
    calls: [], outputs: 0 };
  const sandbox = {
    Date, Number, Math, process: { env: {} },
    HumanVerificationRequiredError,
    activeReturnRefundCommand: { scanCursor: cursor, maxItems: 3,
      maxDurationMs: 120_000, requestId: 'test-scan' },
    pddPage: { url: () => 'https://mms.pinduoduo.com/' },
    omsPage: {}, tmsPage: {},
    context: {}, listUrl: 'https://mms.pinduoduo.com/', shopId: 'test-shop',
    pddRenderWaitMs: 1000, RETURN_REFUND_WORKBENCH_URL:
      'https://mms.pinduoduo.com/aftersales/aftersale_list',
    focusSystemPage: async () => {}, ensurePddLogin: async () => {},
    registerDerivedPage: (page) => page,
    createBackgroundPage: async () => { observed.created += 1; return listPage; },
    navigateSystemPage: async (page, url) => {
      observed.navigated += 1;
      page.currentUrl = url;
    },
    readReturnRefundScanResumeProof: async () => {
      observed.proofReads += 1;
      return proof;
    },
    collectReturnRefundCandidates: async (_page, _context, options) => {
      observed.calls.push(options);
      if (observed.calls.length === 1) {
        throw failure === 'verification'
          ? new HumanVerificationRequiredError('slider') : new Error('other failure');
      }
      return { items: [], scan: { nextCursor: { page: 9, itemOffset: 3 },
        resumeProof: options.resumeProof } };
    },
    returnRefundVisibleStep: async () => {}, checkForHumanVerification: async () => {},
    logRunStep: (stage) => {
      if (stage === 'return-refund-resume-proof-retained-after-verification') observed.retained += 1;
    },
    closeDerivedPage: async () => {}, evaluateReturnRefundRules: () => ({}),
    writeReturnRefundOutput: () => { observed.outputs += 1; },
  };
  vm.runInNewContext(`${scanSource}\nglobalThis.testScan = runReturnRefundScanOnly;`, sandbox,
    { filename: 'workflow-refund-verification-resume.mjs' });
  await assert.rejects(sandbox.testScan(), /slider|other failure/u);
  await sandbox.testScan();
  return { observed, proof };
};

const resumed = await scenario();
assert.equal(resumed.observed.proofReads, 1);
assert.equal(resumed.observed.retained, 1);
assert.equal(resumed.observed.calls[1].resumeProof, resumed.proof,
  'a verified deep list page must be offered to the next scan after a slider');
assert.equal(resumed.observed.created, 1);
assert.equal(resumed.observed.navigated, 1,
  'the same Worker must reuse its existing list tab after verification');
assert.equal(resumed.observed.outputs, 1,
  'the interrupted scan must not emit a completed output');

for (const unsafe of [
  { proofPage: 8, failure: 'verification' },
  { proofPage: 9, failure: 'other' },
]) {
  const result = await scenario(unsafe);
  assert.equal(result.observed.calls[1].resumeProof, null,
    'a wrong page or unrelated failure must not retain a resume proof');
}

console.log('Return-refund verification resume self-test passed');
