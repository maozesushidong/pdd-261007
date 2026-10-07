import assert from 'node:assert/strict';

import {
  verifyProactiveTerminalDetailProof,
  verifiedProactiveSummaryMatchesCompletion,
} from '../packages/adapters/src/pdd/proactive-terminal-proof.mjs';
import { archiveReadiness, ordinaryTerminalOutcomeConflicts } from '../workflow-runtime.mjs';

const orderNumber = '260904-522495015212028';
const platformWorkOrderId = '500013405960020';
const stage = 'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics';
const finalOption = '无法确认快递单号';
const secondaryOption = '未查到退货物流轨迹';
const detail = {
  success: true,
  result: {
    orderSn: orderNumber,
    problemTitle: '物流异常主动服务',
    status: 3,
    todoDetail: {
      finished: true,
      flowList: [
        {
          title: finalOption,
          createdAt: Date.parse('2026-09-25T08:10:37Z'),
          itemList: [{ value: finalOption }, { value: `当前${secondaryOption}，${finalOption}` }],
        },
        {
          title: `未收到退回的商品且${secondaryOption}`,
          createdAt: Date.parse('2026-09-25T08:08:58Z'),
          itemList: [{ value: secondaryOption }],
        },
      ],
    },
  },
};
const responseCandidates = [
  {
    url: 'https://mms.pinduoduo.com/latitude/mallTicket/submitForm',
    ok: true,
    httpStatus: 200,
    requestBody: JSON.stringify({ finalOption, secondaryOption }),
    responseText: '{"success":true}',
  },
  {
    url: 'https://mms.pinduoduo.com/strickland/sop/mms/detail',
    ok: true,
    httpStatus: 200,
    requestBody: JSON.stringify({ id: platformWorkOrderId }),
    responseText: JSON.stringify(detail),
  },
];
const input = {
  scenarioCode: 'proactive-logistics-service',
  stage,
  orderNumber,
  platformWorkOrderId,
  selectedOption: finalOption,
  selectionProof: {
    status: 'verified', orderNumber, stage,
    selections: [{ actualLabel: finalOption }], missingLabels: [], wrongFrameLabels: [],
  },
  submitClicked: true,
  submitReceipt: { success: true, httpStatus: 200 },
  transitionConfirmed: true,
  effectStartedAt: '2026-09-25T08:10:20Z',
  submittedAt: '2026-09-25T08:10:48Z',
  responseCandidates,
};
const proof = verifyProactiveTerminalDetailProof(input);
assert.equal(proof?.status, 'verified');
assert.equal(proof?.platformWorkOrderId, platformWorkOrderId);
assert.equal(proof?.finalOption, finalOption);
assert.equal(proof?.resultOption, secondaryOption);

const completion = {
  status: 'succeeded', orderNumber, scenarioCode: input.scenarioCode,
  outcome: finalOption, completionEvidence: '未收到退货商品',
  completionResultOption: secondaryOption,
  submitClicked: true, submitReceipt: input.submitReceipt,
  transitionConfirmed: true, confirmationMethod: 'detail-completed',
  platformDetailProof: proof,
};
const progress = {
  orderNumber, scenarioCode: input.scenarioCode, platformWorkOrderId,
  pddResolutionSubmission: completion,
  pddProactiveTerminalDetailProof: proof,
};
const matches = (patch = {}) => verifiedProactiveSummaryMatchesCompletion({
  proof, progress, completion: { ...completion, ...patch },
  scenarioCode: input.scenarioCode,
  expectedOutcome: patch.outcome ?? completion.outcome,
  observedOutcome: patch.completionEvidence ?? completion.completionEvidence,
  observedResultOption: Object.hasOwn(patch, 'completionResultOption')
    ? patch.completionResultOption : completion.completionResultOption,
});
assert.equal(matches(), true);
assert.equal(matches({ completionResultOption: null }), true,
  '完成页只显示上层摘要时，精确平台详情仍能证明最终层级');
assert.equal(ordinaryTerminalOutcomeConflicts({
  scenarioCode: input.scenarioCode,
  expectedOutcome: finalOption,
  observedOutcome: '未收到退货商品',
}), true, '一般结果冲突仍应禁止归档');
assert.equal(archiveReadiness(progress, completion).ready, true,
  '只有精确的提交后 PDD 已完结详情记录可解释上层摘要');
assert.equal(archiveReadiness(progress, {
  ...completion, completionResultOption: null,
}).ready, true);
assert.equal(archiveReadiness({ ...progress, pddProactiveTerminalDetailProof: null }, completion).reason,
  'completion-outcome-mismatch');
assert.equal(matches({ completionEvidence: '已同意退货退款' }), false);
assert.equal(matches({ completionResultOption: '有退货物流轨迹' }), false);
assert.equal(matches({ transitionConfirmed: false }), false);
assert.equal(matches({ platformDetailProof: null }), false);

const reject = (patch, label) => assert.equal(verifyProactiveTerminalDetailProof({ ...input, ...patch }),
  null, label);
reject({ platformWorkOrderId: '500013405960021' }, '详情请求必须指向当前平台工单');
reject({ orderNumber: '260904-522495015212029' }, '详情响应必须属于当前订单');
reject({ selectionProof: { ...input.selectionProof, status: 'unknown' } },
  '最终选项缺少已验证的 UI 选择证据');
reject({ transitionConfirmed: false }, '只有 200 响应而无页面跳转不能解释冲突');
reject({ responseCandidates: [...responseCandidates].reverse() },
  '详情响应必须发生在最终 submitForm 之后');
reject({ responseCandidates: [responseCandidates[0], {
  ...responseCandidates[1], responseText: JSON.stringify({
    ...detail, result: { ...detail.result, todoDetail: { ...detail.result.todoDetail,
      finished: false } },
  }),
}] }, '平台详情必须明确已完结');
reject({ responseCandidates: [responseCandidates[0], {
  ...responseCandidates[1], responseText: JSON.stringify({
    ...detail, result: { ...detail.result, todoDetail: { ...detail.result.todoDetail,
      flowList: [{ ...detail.result.todoDetail.flowList[0], title: '其他选项' },
        detail.result.todoDetail.flowList[1]] } },
  }),
}] }, '平台最新处理记录必须与最终选项一致');
console.log('拼多多主动物流服务终态详情精确核验自测通过');
