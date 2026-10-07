import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { verifiedProactiveSummaryMatchesCompletion } from '../packages/adapters/src/pdd/proactive-terminal-proof.mjs';
import { verifiedInterceptSummaryMatchesCompletion } from '../packages/adapters/src/pdd/intercept-terminal-proof.mjs';

const source = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const discardVerifiedTerminalDetailEvidence = ');
const end = source.indexOf('const finalizeEvidenceAfterPddCompletion = ', start);
assert(start >= 0 && end > start);

const orderNumber = '260920-119181228412252';
const proof = {
  status: 'verified', kind: 'exact-pdd-intercept-completed-detail-flow-after-submit',
  orderNumber, platformWorkOrderId: '500013403310662',
  scenarioCode: 'intercept-recall', finalOption: '消费者已收到货',
  completionSummary: '已同意退货退款', detailResponseSha256: 'b'.repeat(64),
};
const completion = {
  status: 'succeeded', orderNumber, scenarioCode: 'intercept-recall',
  outcome: '消费者已收到货', completionEvidence: '已同意退货退款',
  completionResultOption: null, submitClicked: true,
  submitReceipt: { success: true, httpStatus: 200 },
  transitionConfirmed: true, confirmationMethod: 'detail-completed',
  platformDetailProof: proof, completedAt: '2026-09-25T04:01:10Z',
};
const initial = () => ({
  orderNumber, scenarioCode: 'intercept-recall', platformWorkOrderId: proof.platformWorkOrderId,
  pddInterceptTerminalDetailProof: proof,
  ordinaryEvidenceUpload: { orderNumber, status: 'uploaded' },
  pddEvidenceScreenshot: { orderNumber, status: 'ready', relativePath: 'pdd.png' },
  tmsEvidenceScreenshot: { orderNumber, status: 'ready', relativePath: 'tms.png' },
  tmsEvidenceDisposition: { orderNumber, usage: 'pending', status: 'ready' },
});

const run = (initialProgress, { tmsPathValid = true, tmsDeleteFails = false } = {}) => {
  let progress = structuredClone(initialProgress);
  const deleted = [];
  const scope = {
    readProgress: () => progress,
    writeProgress: (patch) => { progress = { ...progress, ...patch }; },
    verifiedProactiveSummaryMatchesCompletion,
    verifiedInterceptSummaryMatchesCompletion,
    resolveReadyEvidenceScreenshot: () => ({ absolutePath: 'pdd.png' }),
    resolveReadyTmsEvidence: () => {
      if (!tmsPathValid) throw new Error('invalid TMS evidence path');
      return { absolutePath: 'tms.png' };
    },
    fs: { unlinkSync: (path) => {
      if (tmsDeleteFails && path === 'tms.png') throw new Error('TMS file busy');
      deleted.push(path);
    } },
    shopId: 'shop-test',
  };
  const cleanup = vm.runInNewContext(`${source.slice(start, end)}\ndiscardVerifiedTerminalDetailEvidence`, scope);
  return { cleanup, progress: () => progress, deleted };
};

const accepted = run(initial());
assert.equal(accepted.cleanup(orderNumber, completion), true);
assert.deepEqual(accepted.deleted, ['pdd.png', 'tms.png']);
assert.equal(accepted.progress().pddEvidenceScreenshot.status, 'deleted');
assert.equal(accepted.progress().tmsEvidenceScreenshot.status, 'deleted');
assert.equal(accepted.progress().tmsEvidenceDisposition.status, 'deleted');

const noProof = run({ ...initial(), pddInterceptTerminalDetailProof: null });
assert.equal(noProof.cleanup(orderNumber, completion), false);
assert.deepEqual(noProof.deleted, []);
const noUpload = run({ ...initial(), ordinaryEvidenceUpload: null });
assert.equal(noUpload.cleanup(orderNumber, completion), false);
assert.deepEqual(noUpload.deleted, []);
const badPath = run(initial(), { tmsPathValid: false });
assert.throws(() => badPath.cleanup(orderNumber, completion), /invalid TMS evidence path/u);
assert.deepEqual(badPath.deleted, [], 'all ready paths must be validated before deletion');
const interrupted = run(initial(), { tmsDeleteFails: true });
assert.throws(() => interrupted.cleanup(orderNumber, completion), /TMS file busy/u);
assert.equal(interrupted.progress().pddEvidenceScreenshot.status, 'deleted');
assert.equal(interrupted.progress().tmsEvidenceScreenshot.status, 'ready');
const resumed = run(interrupted.progress());
assert.equal(resumed.cleanup(orderNumber, completion), true);
assert.deepEqual(resumed.deleted, ['tms.png']);

console.log('拼多多终态核验后的临时证据清理自测通过');
