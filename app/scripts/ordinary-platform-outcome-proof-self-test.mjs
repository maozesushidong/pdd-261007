import assert from 'node:assert/strict';
import { capturedInterceptRecallPlatformOutcome as capture } from './ordinary-platform-outcome-proof.mjs';

const orderNumber = '260926-403135567461639';
const platformCaseId = '500013444391018';
const option = '已进行召回';
const input = {
  scenarioCode: 'intercept-recall', orderNumber, platformCaseId,
  effectStatus: 'succeeded', effectReservedAt: '2026-09-29T00:17:15Z',
  receipt: {
    completedAt: '2026-09-29T00:17:32Z',
    result: {
      selectedPddOption: option, selectedPddOutcome: option,
      submitClicked: true, transitionConfirmed: true,
      submitReceipt: {
        success: true, httpStatus: 200,
        requestUrl: 'https://mms.pinduoduo.com/latitude/mallTicket/submitForm',
      },
      selectionProof: {
        stage: 'ordinary-intercept-recall-unsigned-shipment-recalled',
        orderNumber, selections: [{ actualLabel: option }],
        missingLabels: [], wrongFrameLabels: [],
      },
      responseCandidates: [
        {
          url: 'https://mms.pinduoduo.com/latitude/mallTicket/submitForm',
          ok: true, httpStatus: 200, responseText: '{"success":true}',
          requestBody: JSON.stringify({
            bizId: platformCaseId, bizContext: { orderSn: orderNumber },
            formDataList: [{ keyLabel: '收货状态', valueLabel: option }],
          }),
        },
        {
          url: 'https://mms.pinduoduo.com/strickland/sop/mms/detail',
          ok: true, httpStatus: 200,
          requestBody: JSON.stringify({ instanceId: platformCaseId }),
          responseText: JSON.stringify({
            success: true,
            result: {
              orderSn: orderNumber, problemTitle: '消费者申请退款后提示拦截',
              status: 3,
              todoDetail: {
                finished: true,
                flowList: [{
                  title: '已联系快递主动召回',
                  createdAt: Date.parse('2026-09-29T00:17:31Z'),
                  itemList: [{ key: '收货状态', value: option }],
                }],
              },
            },
          }),
        },
      ],
    },
  },
};
const modified = (change) => {
  const copy = structuredClone(input);
  change(copy);
  return capture(copy);
};
assert.equal(capture(input), option);
assert.equal(modified((x) => { x.platformCaseId = '500013444391019'; }), null);
assert.equal(modified((x) => { x.orderNumber = '260926-403135567461638'; }), null);
assert.equal(modified((x) => { x.receipt.result.submitClicked = false; }), null);
assert.equal(modified((x) => { x.receipt.result.transitionConfirmed = false; }), null);
assert.equal(modified((x) => { x.receipt.result.responseCandidates.reverse(); }), null);
assert.equal(modified((x) => {
  const candidate = x.receipt.result.responseCandidates[1];
  const body = JSON.parse(candidate.responseText);
  body.result.todoDetail.flowList[0].itemList[0].value = '消费者已收到货';
  candidate.responseText = JSON.stringify(body);
}), null);
assert.equal(modified((x) => {
  const candidate = x.receipt.result.responseCandidates[1];
  const body = JSON.parse(candidate.responseText);
  body.result.status = 2;
  candidate.responseText = JSON.stringify(body);
}), null);
assert.equal(modified((x) => {
  const candidate = x.receipt.result.responseCandidates[1];
  const body = JSON.parse(candidate.responseText);
  body.result.todoDetail.flowList[0].createdAt = Date.parse('2026-09-28T00:00:00Z');
  candidate.responseText = JSON.stringify(body);
}), null);
console.log('拦截召回工单同单提交后平台结果提取自测通过');
