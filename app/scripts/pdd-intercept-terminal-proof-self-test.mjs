import assert from 'node:assert/strict';

import {
  verifyInterceptTerminalDetailProof,
  verifiedInterceptSummaryMatchesCompletion,
} from '../packages/adapters/src/pdd/intercept-terminal-proof.mjs';
import { archiveReadiness } from '../workflow-runtime.mjs';

const orderNumber = '260920-119181228412252';
const platformWorkOrderId = '500013403310662';
const stage = 'ordinary-intercept-recall-consumer-received-shipment';
const finalOption = '消费者已收到货';
const responseCandidates = [
  {
    url: 'https://mms.pinduoduo.com/latitude/mallTicket/submitForm',
    ok: true, httpStatus: 200,
    requestBody: JSON.stringify({ id: platformWorkOrderId, selectedOption: finalOption }),
    responseText: '{"success":true}',
  },
  {
    url: 'https://mms.pinduoduo.com/strickland/sop/mms/detail',
    ok: true, httpStatus: 200,
    requestBody: JSON.stringify({ id: platformWorkOrderId }),
    responseText: JSON.stringify({
      success: true,
      result: {
        orderSn: orderNumber,
        problemTitle: '消费者申请退款后提示拦截',
        status: 3,
        todoDetail: {
          finished: true,
          flowList: [{
            title: finalOption,
            createdAt: Date.parse('2026-09-25T04:01:00Z'),
            itemList: [{ value: finalOption }],
          }],
        },
      },
    }),
  },
];
const input = {
  scenarioCode: 'intercept-recall', stage, orderNumber, platformWorkOrderId,
  selectedOption: finalOption,
  selectionProof: {
    status: 'verified', orderNumber, stage,
    selections: [{ actualLabel: finalOption }], missingLabels: [], wrongFrameLabels: [],
  },
  submitClicked: true,
  submitReceipt: { success: true, httpStatus: 200 },
  transitionConfirmed: true,
  effectStartedAt: '2026-09-25T04:00:48Z',
  submittedAt: '2026-09-25T04:01:10Z',
  responseCandidates,
};
const proof = verifyInterceptTerminalDetailProof(input);
assert.equal(proof?.status, 'verified');
assert.equal(proof?.platformWorkOrderId, platformWorkOrderId);

const completion = {
  status: 'succeeded', orderNumber, scenarioCode: input.scenarioCode,
  outcome: finalOption, completionEvidence: '已同意退货退款',
  completionResultOption: null,
  submitClicked: true, submitReceipt: input.submitReceipt,
  transitionConfirmed: true, confirmationMethod: 'detail-completed',
  platformDetailProof: proof,
};
const progress = {
  orderNumber, scenarioCode: input.scenarioCode, platformWorkOrderId,
  pddResolutionSubmission: completion,
  pddInterceptTerminalDetailProof: proof,
};
const matches = (p = progress, c = completion) => verifiedInterceptSummaryMatchesCompletion({
  proof: p.pddInterceptTerminalDetailProof,
  progress: p, completion: c,
  scenarioCode: input.scenarioCode,
  expectedOutcome: c.outcome,
  observedOutcome: c.completionEvidence,
  observedResultOption: c.completionResultOption,
});
assert.equal(matches(), true);
assert.equal(archiveReadiness(progress, completion).ready, true);
assert.equal(archiveReadiness({ ...progress, pddInterceptTerminalDetailProof: null }, completion).reason,
  'completion-outcome-mismatch');
assert.equal(matches(progress, { ...completion, completionEvidence: '已进行召回' }), false);
assert.equal(matches(progress, { ...completion, transitionConfirmed: false }), false);
assert.equal(matches(progress, { ...completion, platformDetailProof: null }), false);

const reject = (patch, label) => assert.equal(
  verifyInterceptTerminalDetailProof({ ...input, ...patch }), null, label);
reject({ platformWorkOrderId: '500013403310663' }, 'submit and detail must belong to the same case');
reject({ orderNumber: '260920-119181228412253' }, 'detail order must match');
reject({ selectionProof: { ...input.selectionProof, status: 'unknown' } },
  'selected option must be verified in the UI');
reject({ submitClicked: false }, 'a received response cannot replace own click evidence');
reject({ transitionConfirmed: false }, 'response alone is not a confirmed completion');
reject({ responseCandidates: [...responseCandidates].reverse() },
  'completed detail must be observed after submission');
const alteredDetail = (modify) => [responseCandidates[0], {
  ...responseCandidates[1],
  responseText: JSON.stringify(modify(JSON.parse(responseCandidates[1].responseText))),
}];
reject({ responseCandidates: alteredDetail((body) => ({
  ...body, result: { ...body.result, status: 2 },
})) }, 'case must be completed');
reject({ responseCandidates: alteredDetail((body) => ({
  ...body, result: { ...body.result, todoDetail: {
    ...body.result.todoDetail, flowList: [{
      ...body.result.todoDetail.flowList[0], title: '已进行召回',
    }],
  } },
})) }, 'latest result must be the selected option');

console.log('拼多多拦截工单终态详情精确核验自测通过');
