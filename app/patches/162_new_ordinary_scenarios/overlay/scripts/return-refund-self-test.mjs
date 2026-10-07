import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { clickPddActionWithoutForegroundPopup } from '../packages/adapters/src/pdd/background-popup.mjs';
import { PddRenderWaitTimeoutError } from '../packages/adapters/src/pdd/render-wait.mjs';
import {
  closeReturnRefundDetailOverlay,
  closeStaleReturnRefundDetailPages,
  classifyExistingReturnRefundEffect,
  classifyReturnRefundSubmission,
  classifyReturnRefundUnexpectedFailure,
  clickReturnRefundAcknowledgementOnce,
  clickReturnRefundConfirmationActionOnce,
  evaluateReturnRefundRules,
  detectReturnRefundTransientPageState,
  extractReturnRefundFacts,
  findApproveRefundAction,
  findMatchingReturnRefundDetailAction,
  findReturnRefundConfirmationAction,
  findNextReturnRefundPageAction,
  isReturnRefundDetailUrl,
  isReturnRefundExcludedDetailUrl,
  isRecoverableReturnRefundDetailFailure,
  normalizeReturnRefundScanCursor,
  parseBeijingDateTime,
  parseRefundAmount,
  processReturnRefund,
  resolveReturnRefundReadOnlyReview,
  RETURN_REFUND_WORKBENCH_URL,
  RETURN_REFUND_MANUAL_REVIEW_RECHECK_MS,
  RETURN_REFUND_CONFIRM_ENABLE_WAIT_MS,
  RETURN_REFUND_PAGE_ERROR_RECHECK_MS,
  RETURN_REFUND_UNKNOWN_EFFECT_MIN_AGE_MS,
  RETURN_REFUND_UNKNOWN_PROOF_GAP_MS,
  RETURN_REFUND_UNKNOWN_RECHECK_MS,
  RETURN_REFUND_VERIFICATION_RECHECK_MS,
  RETURN_REFUND_WAIT_RECHECK_MS,
  createVisiblePddStep,
  confirmsReturnRefundCompletion,
  isAutomatedReturnRefundCompletion,
  openReturnRefundWorkbench,
  readReturnRefundActivePageNumber,
  readReturnRefundDetail,
  readReturnRefundCompletionUnderVerification,
  readReturnRefundListRowIdentity,
  ReturnRefundTerminalNotFoundError,
  ReturnRefundTransientPageError,
  reopenReturnRefundDetailFromWorkbench,
  submitReturnRefund,
  waitForReturnRefundPageTransition,
  waitForReturnRefundDetailTarget,
} from '../packages/adapters/src/pdd/return-refund.mjs';

assert.deepEqual(normalizeReturnRefundScanCursor(), { page: 1, itemOffset: 0 });
assert.deepEqual(normalizeReturnRefundScanCursor({ page: 3.9, itemOffset: 7.8 }), { page: 3, itemOffset: 7 });
assert.deepEqual(normalizeReturnRefundScanCursor({ page: -2, itemOffset: -1 }), { page: 1, itemOffset: 0 });

assert.equal(parseRefundAmount('退款金额：￥499.99'), 499.99);
assert.equal(parseRefundAmount('退款金额：500元'), 500);
assert.equal(parseBeijingDateTime('2026-08-11 09:27:28'), '2026-08-11T01:27:28.000Z');
assert.equal(isReturnRefundDetailUrl('https://mms.pinduoduo.com/aftersales-ssr/detail?id=1'), true);
assert.equal(isReturnRefundDetailUrl('https://mms.pinduoduo.com/aftersales/work_order/list'), false);
assert.equal(isReturnRefundExcludedDetailUrl(
  'https://mms.pinduoduo.com/orders/appeals/NegativeExperienceDetail?orderSn=260808-283744704002710',
), true);
assert.equal(isReturnRefundExcludedDetailUrl(
  'https://mms.pinduoduo.com/aftersales-ssr/detail?id=22029849804345',
), false);
assert.equal(isReturnRefundExcludedDetailUrl(
  'https://example.com/orders/appeals/NegativeExperienceDetail',
), false);
assert.equal(RETURN_REFUND_VERIFICATION_RECHECK_MS, 10 * 60_000);
assert.equal(RETURN_REFUND_UNKNOWN_RECHECK_MS, 10 * 60_000);
assert.equal(RETURN_REFUND_WAIT_RECHECK_MS, 4 * 60 * 60_000);
assert.equal(RETURN_REFUND_UNKNOWN_EFFECT_MIN_AGE_MS, 30 * 60_000);
assert.equal(RETURN_REFUND_UNKNOWN_PROOF_GAP_MS, 5 * 60_000);
assert.equal(RETURN_REFUND_CONFIRM_ENABLE_WAIT_MS, 30_000);
assert.equal(RETURN_REFUND_MANUAL_REVIEW_RECHECK_MS, 30 * 60_000);
assert.equal(RETURN_REFUND_PAGE_ERROR_RECHECK_MS, 5 * 60_000);
assert.equal(classifyReturnRefundUnexpectedFailure(new Error('render timeout')).outcome, 'page-error');
assert.equal(classifyReturnRefundUnexpectedFailure(new Error('post-submit timeout'), {
  externalEffectStarted: true,
}).outcome, 'page-error');
const verificationFailure = new Error('slider remains visible');
verificationFailure.name = 'HumanVerificationRequiredError';
assert.equal(classifyReturnRefundUnexpectedFailure(verificationFailure).outcome, 'verification-required');
assert.equal(classifyReturnRefundUnexpectedFailure(new Error(
  '检测到人工验证，请在可视化浏览器中完成后重新运行流程（阶段: pdd-manual-login）',
)).outcome, 'verification-required');
const serializedLoginFailure = new Error('PDD login state expired');
serializedLoginFailure.code = 'PDD_LOGIN_REQUIRED';
assert.equal(classifyReturnRefundUnexpectedFailure(serializedLoginFailure).outcome,
  'verification-required');
assert.equal(detectReturnRefundTransientPageState(
  '未查询到相关订单信息 操作太过频繁，请稍后再试！ 订单不存在 售后单不存在',
).kind, 'rate-limited');
assert.equal(detectReturnRefundTransientPageState(
  '未查询到相关订单信息 订单不存在 售后单不存在',
).kind, 'not-found');
const terminalNotFoundFailure = new ReturnRefundTerminalNotFoundError(
  '订单不存在、售后单不存在',
  { signals: ['订单不存在', '售后单不存在'] },
);
const classifiedTerminalNotFound = classifyReturnRefundUnexpectedFailure(terminalNotFoundFailure);
assert.equal(classifiedTerminalNotFound.outcome, 'skipped-not-found');
assert.equal(classifiedTerminalNotFound.terminal, true);
assert.equal(classifiedTerminalNotFound.completionMethod, 'return-refund-not-found');
const rateLimitedFailure = new ReturnRefundTransientPageError(
  'rate-limited',
  '操作太过频繁',
  { retryAfterMs: 180_000 },
);
const classifiedRateLimit = classifyReturnRefundUnexpectedFailure(rateLimitedFailure, {
  now: Date.parse('2026-08-19T12:00:00.000Z'),
});
assert.equal(classifiedRateLimit.outcome, 'page-error');
assert.equal(classifiedRateLimit.retryKind, 'rate-limited');
assert.equal(classifiedRateLimit.nextCheckAt, '2026-08-19T12:03:00.000Z');
assert.match(classifiedRateLimit.reasons[0], /页面限流/u);
assert.equal(isRecoverableReturnRefundDetailFailure(rateLimitedFailure), false);
assert.equal(isRecoverableReturnRefundDetailFailure(terminalNotFoundFailure), false);
assert.equal(isRecoverableReturnRefundDetailFailure(
  new PddRenderWaitTimeoutError('return-refund-detail-load', 30_000),
), true);

const readOnlyReviewNow = Date.parse('2026-08-18T08:00:00.000Z');
const readOnlyPending = resolveReturnRefundReadOnlyReview({
  orderNumber: '260818-000000000000001',
  aftersaleNumber: 'manual-review-pending',
  aftersaleType: '退货退款',
  actionButtonVisible: true,
}, {
  outcome: 'auto-refund',
  riskLevel: null,
  reasons: [],
  rules: { amount: { passed: true } },
}, { now: readOnlyReviewNow });
assert.equal(readOnlyPending.outcome, 'manual-review',
  'a read-only review must never promote a still-pending case into an executable refund');
assert.equal(readOnlyPending.readOnlyReview, true);
assert.equal(readOnlyPending.nextCheckAt, '2026-08-18T08:30:00.000Z');

const readOnlyCompleted = resolveReturnRefundReadOnlyReview({
  orderNumber: '260818-000000000000002',
  aftersaleNumber: 'manual-review-completed',
  aftersaleType: '退货退款',
  aftersaleStatus: '商家同意退款，本单退款成功',
  actionButtonVisible: false,
  pageIndicatesCompleted: true,
  evidence: {
    fieldSources: {
      aftersaleStatus: { source: 'label-following-line' },
    },
  },
}, { outcome: 'manual-completed', rules: {} }, { now: readOnlyReviewNow });
assert.equal(readOnlyCompleted.outcome, 'manual-completed');
assert.equal(readOnlyCompleted.completionMethod, 'return-refund-read-only-page-completed');
assert.equal(readOnlyCompleted.readOnlyReview, true);
assert.equal(confirmsReturnRefundCompletion({
  ...readOnlyCompleted.facts,
  aftersaleType: null,
}), true, 'a terminal PDD page may omit the aftersale type after the refund has completed');
assert.equal(confirmsReturnRefundCompletion({
  orderNumber: '260812-461457333791975',
  aftersaleNumber: '22121232712399',
  aftersaleStatus: '商家同意退款，本单退款成功',
  actionButtonVisible: false,
  pageIndicatesCompleted: true,
  evidence: {
    fieldSources: {
      aftersaleStatus: { source: 'status-text', value: '商家同意退款，本单退款成功' },
    },
  },
}), true, 'the explicit PDD success status line is a confirmed terminal state');

const body = `
售后编号：22029849804345
售后类型：退货退款
退款金额：￥499.99
订单编号：260806377282957753317
售后状态：退货退款，待商家确认收货
退货物流
已到达湖南长沙转运中心
2026-08-11 09:27:28
退货快递单号：777435023839260
`;
const facts = extractReturnRefundFacts(body, { actionButtonVisible: true });
assert.equal(facts.orderNumber, '260806377282957753317');
assert.equal(facts.aftersaleNumber, '22029849804345');
const collapsedDetailFacts = extractReturnRefundFacts(body.replace(/\s+/gu, ' '), {
  actionButtonVisible: true,
});
assert.equal(collapsedDetailFacts.aftersaleType, '退货退款');
assert.equal(collapsedDetailFacts.refundAmount, 499.99);
assert.match(collapsedDetailFacts.aftersaleStatus, /待商家确认收货/u);
assert.equal(collapsedDetailFacts.evidence.fieldSources.aftersaleType.source,
  'inline-body-fallback');
assert.equal(facts.logisticsContainsChangsha, true);
assert.equal(evaluateReturnRefundRules(facts, { now: Date.parse('2026-08-14T01:27:27.000Z') }).outcome, 'auto-refund');
const statusWithoutMerchantKeyword = evaluateReturnRefundRules({
  ...facts,
  aftersaleStatus: '买家已发货，商家处理中',
}, { now: Date.parse('2026-08-11T02:00:00.000Z') });
assert.equal(statusWithoutMerchantKeyword.outcome, 'auto-refund',
  'an otherwise eligible refund must not require a “待商家” status keyword');
assert.equal(statusWithoutMerchantKeyword.rules.status.passed, true);
assert.equal(statusWithoutMerchantKeyword.rules.status.required, false);
assert.equal(statusWithoutMerchantKeyword.rules.status.legacyKeywordMatched, false);
assert.equal(evaluateReturnRefundRules({ ...facts, refundAmount: 500 }, { now: Date.parse('2026-08-11T02:00:00.000Z') }).outcome, 'manual-review');
assert.equal(evaluateReturnRefundRules(facts, { now: Date.parse('2026-08-14T01:27:28.000Z') }).outcome, 'auto-refund');
assert.equal(evaluateReturnRefundRules(facts, { now: Date.parse('2026-08-14T01:27:29.000Z') }).outcome, 'auto-refund');
assert.equal(evaluateReturnRefundRules({
  ...facts,
  logisticsContainsChangsha: false,
  logisticsContainsHengshuiJizhou: false,
  logisticsDirectionMatched: false,
}, { now: Date.parse('2026-08-11T02:00:00.000Z') }).outcome, 'wait-logistics');
assert.equal(evaluateReturnRefundRules({ ...facts, hasReturnLogistics: false, logisticsTimeline: [], latestLogisticsAt: null }).outcome, 'wait-logistics');
const noLogisticsOver72Hours = {
  ...facts,
  hasReturnLogistics: false,
  logisticsTimeline: [],
  earliestLogisticsAt: null,
  latestLogisticsAt: null,
  logisticsContainsChangsha: false,
  logisticsContainsHengshuiJizhou: false,
  logisticsDirectionMatched: false,
};
const noLogisticsAutoRefund = evaluateReturnRefundRules(noLogisticsOver72Hours, {
  now: Date.parse('2026-08-15T02:00:01.000Z'),
  firstDiscoveredAt: '2026-08-12T02:00:00.000Z',
});
assert.equal(noLogisticsAutoRefund.outcome, 'auto-refund',
  'a no-logistics case over 72 hours may auto-refund only after all core rules pass');
assert.equal(
  noLogisticsAutoRefund.policyReasonCode,
  'return-refund-no-logistics-over-72-hours-auto-approved',
);
for (const unsafeFacts of [
  { ...noLogisticsOver72Hours, refundAmount: 500 },
  { ...noLogisticsOver72Hours, orderNumber: null },
  { ...noLogisticsOver72Hours, aftersaleStatus: '退款成功', pageIndicatesCompleted: true },
]) {
  assert.equal(evaluateReturnRefundRules(unsafeFacts, {
    now: Date.parse('2026-08-15T02:00:01.000Z'),
    firstDiscoveredAt: '2026-08-12T02:00:00.000Z',
  }).outcome, 'manual-review',
    'a no-logistics case must remain manual when any core rule is unsafe');
}
const noActionOver72Hours = evaluateReturnRefundRules({
  ...noLogisticsOver72Hours,
  actionButtonVisible: false,
  pageIndicatesPendingMerchant: true,
}, {
  now: Date.parse('2026-08-15T02:00:01.000Z'),
  firstDiscoveredAt: '2026-08-12T02:00:00.000Z',
});
assert.equal(noActionOver72Hours.outcome, 'wait-logistics',
  'a pending no-logistics page without an action must be rechecked instead of permanently paused');
assert.equal(noActionOver72Hours.waitReasonCode, 'no-logistics-over-72-hours-action-unavailable');
assert.equal(noActionOver72Hours.nextCheckAt, '2026-08-15T06:00:01.000Z');
const consumerShipmentPending = extractReturnRefundFacts(`
售后编号：22099206912340
售后类型：退货退款
退款金额：￥27.80
订单编号：260811-561533447772595
售后状态
闪电退货，待消费者寄出退货
`, { actionButtonVisible: true });
assert.equal(consumerShipmentPending.aftersaleStatus, '闪电退货,待消费者寄出退货');
assert.equal(consumerShipmentPending.evidence.fieldSources.aftersaleStatus.source, 'label-following-line');
assert.equal(evaluateReturnRefundRules(consumerShipmentPending, {
  now: Date.parse('2026-08-18T05:10:20.000Z'),
  firstDiscoveredAt: '2026-08-14T05:10:19.000Z',
}).outcome, 'auto-refund',
'an actionable no-logistics case over 72 hours must not require a “待商家” status');

const unlabeledConsumerShipmentPending = extractReturnRefundFacts(`
售后编号：22149009361613
售后类型：退货退款
退款金额：￥19.01
订单编号：260804-491824167251777
待商家处理售后
售后状态
其他售后信息
更多操作
协商详情
处理说明
闪电退货，待消费者寄出退货
`, { actionButtonVisible: true });
assert.equal(unlabeledConsumerShipmentPending.aftersaleStatus, '闪电退货,待消费者寄出退货');
assert.equal(unlabeledConsumerShipmentPending.evidence.fieldSources.aftersaleStatus.source, 'status-text');
assert.equal(evaluateReturnRefundRules(unlabeledConsumerShipmentPending, {
  now: Date.parse('2026-08-18T06:55:46.000Z'),
  firstDiscoveredAt: '2026-08-14T06:55:45.000Z',
}).outcome, 'auto-refund');
const counterpartyPendingDetail = extractReturnRefundFacts(`
售后编号：22236519745215
售后类型：退货退款
退款金额：￥56.00
订单编号：260812-592634243484013
售后状态
商家驳回退货，待买家处理
则此次退款申请关闭，退款失败。
退货失败，商家拒绝退款，待买家处理中
退货物流
快递公司：韵达快递
快递单号：465593934881089
【上海市】您的快件已投递
2026-08-19 12:02:50
`, { actionButtonVisible: false, capturedAt: '2026-08-22T00:00:00.000Z' });
assert.equal(counterpartyPendingDetail.aftersaleStatus, '商家驳回退货,待买家处理');
assert.equal(counterpartyPendingDetail.pageIndicatesPendingCounterparty, true);
assert.equal(counterpartyPendingDetail.pageIndicatesCompleted, true,
  'ancillary refund-failure copy remains visible but is not the scoped aftersale status');
assert.equal(confirmsReturnRefundCompletion(counterpartyPendingDetail), false);
const counterpartyPendingDecision = evaluateReturnRefundRules(counterpartyPendingDetail, {
  now: Date.parse('2026-08-22T00:00:00.000Z'),
});
assert.equal(counterpartyPendingDecision.outcome, 'wait-logistics');
assert.equal(counterpartyPendingDecision.waitReasonCode, 'counterparty-action-pending');
assert.equal(counterpartyPendingDecision.nextCheckAt, '2026-08-22T04:00:00.000Z');
assert.match(counterpartyPendingDecision.reasons[0], /等待买家或消费者处理/u);
assert.equal(evaluateReturnRefundRules({
  ...counterpartyPendingDetail,
  actionButtonVisible: null,
}, { now: Date.parse('2026-08-22T00:00:00.000Z') }).waitReasonCode,
'counterparty-action-pending',
'an indeterminate action observation remains read-only when the scoped status clearly waits for the buyer');
const actionableCounterpartyPending = evaluateReturnRefundRules({
  ...counterpartyPendingDetail,
  actionButtonVisible: true,
  latestLogisticsAt: '2026-08-21T23:00:00.000Z',
  earliestLogisticsAt: '2026-08-18T00:00:00.000Z',
  logisticsTransitSpanHours: 95,
  logisticsContainsChangsha: true,
  logisticsDirectionMatched: true,
}, { now: Date.parse('2026-08-22T00:00:00.000Z') });
assert.equal(actionableCounterpartyPending.outcome, 'auto-refund',
  'a live approve action must continue through the existing amount and logistics rules');
const pendingWithoutAction = evaluateReturnRefundRules({
  ...facts,
  actionButtonVisible: false,
  pageIndicatesCompleted: true,
  pageIndicatesPendingMerchant: true,
  aftersaleStatus: '退款中',
});
assert.notEqual(pendingWithoutAction.outcome, 'manual-completed',
  'generic completed text outside the labeled status must not close a pending refund');
assert.equal(confirmsReturnRefundCompletion({
  ...facts,
  actionButtonVisible: false,
  pageIndicatesCompleted: true,
  aftersaleStatus: '退款中',
}), false);
assert.equal(confirmsReturnRefundCompletion({ ...facts, actionButtonVisible: true }), false);

const terminalWithPendingNavigation = extractReturnRefundFacts(`
售后编号：22029849804346
售后类型：退货退款
退款金额：￥99.99
订单编号：260806377282957753318
售后状态：商家同意退款，本单退款成功
待商家处理售后
`, { actionButtonVisible: false });
assert.equal(terminalWithPendingNavigation.pageIndicatesPendingMerchant, true);
assert.equal(
  terminalWithPendingNavigation.evidence.fieldSources.aftersaleStatus.source,
  'label-inline',
);
assert.equal(confirmsReturnRefundCompletion(terminalWithPendingNavigation), true);
const evaluatedTerminalWithPendingNavigation = evaluateReturnRefundRules(terminalWithPendingNavigation);
assert.equal(evaluatedTerminalWithPendingNavigation.outcome, 'manual-completed',
  'an explicit labeled terminal state must outrank unrelated pending navigation text');
assert.equal(evaluatedTerminalWithPendingNavigation.readOnlyReview, true);
assert.equal(
  evaluatedTerminalWithPendingNavigation.completionMethod,
  'return-refund-read-only-page-completed',
  'the rule evaluator must preserve the automated read-only completion proof for persistence',
);
assert.equal(isAutomatedReturnRefundCompletion(evaluatedTerminalWithPendingNavigation), true);
assert.equal(evaluateReturnRefundRules({
  ...terminalWithPendingNavigation,
  aftersaleType: null,
}).outcome, 'manual-completed',
'a labeled terminal state must remain authoritative when the completed page omits the aftersale type');

const genericCompletedNavigation = extractReturnRefundFacts(`
售后编号：22029849804347
售后类型：退货退款
退款金额：￥99.99
订单编号：260806377282957753319
售后状态：退款中
退款成功通知
`, { actionButtonVisible: false });
assert.equal(genericCompletedNavigation.pageIndicatesCompleted, true);
assert.equal(confirmsReturnRefundCompletion(genericCompletedNavigation), false);
assert.notEqual(evaluateReturnRefundRules(genericCompletedNavigation).outcome, 'manual-completed');
const actionableDetailWithUnrelatedCompletedText = evaluateReturnRefundRules({
  ...genericCompletedNavigation,
  actionButtonVisible: true,
});
assert.equal(actionableDetailWithUnrelatedCompletedText.rules.nonTerminalPage.passed, true,
  'unrelated completed text must not block an actionable pending aftersale');
assert.equal(
  actionableDetailWithUnrelatedCompletedText.rules.nonTerminalPage.actual.scopedTerminalStatusPresent,
  false,
);

const standaloneTerminalStatus = extractReturnRefundFacts(`
售后编号：22029849804348
售后类型：退货退款
退款金额：￥99.99
订单编号：260806377282957753320
退款成功
`, { actionButtonVisible: false });
assert.equal(
  standaloneTerminalStatus.evidence.fieldSources.aftersaleStatus.source,
  'status-text',
);
assert.equal(confirmsReturnRefundCompletion(standaloneTerminalStatus), true);
assert.equal(evaluateReturnRefundRules(standaloneTerminalStatus).outcome, 'manual-completed',
  'an exact standalone terminal status with complete identities and no action must close read-only');

const expiredBuyerActionRefundFailure = extractReturnRefundFacts(`
退款申请单
售后编号：22161669537069
售后类型：退货退款
退款金额：¥65.00
订单编号：260716-606884381101759
售后状态
因为买家逾期未处理或逾期未发货，此次退款失败
`, { actionButtonVisible: false });
assert.equal(expiredBuyerActionRefundFailure.aftersaleStatus,
  '因为买家逾期未处理或逾期未发货,此次退款失败');
assert.equal(expiredBuyerActionRefundFailure.pageIndicatesCompleted, true);
assert.equal(
  expiredBuyerActionRefundFailure.evidence.fieldSources.aftersaleStatus.source,
  'label-following-line',
);
assert.equal(confirmsReturnRefundCompletion(expiredBuyerActionRefundFailure), true);
assert.equal(evaluateReturnRefundRules(expiredBuyerActionRefundFailure).outcome, 'manual-completed',
  'an explicit PDD refund-failed state is terminal and must close without clicking refund');
const expiredBuyerActionResolution = resolveReturnRefundReadOnlyReview(
  expiredBuyerActionRefundFailure,
  evaluateReturnRefundRules(expiredBuyerActionRefundFailure),
);
assert.equal(expiredBuyerActionResolution.readOnlyReview, true);
assert.equal(expiredBuyerActionResolution.completionMethod,
  'return-refund-read-only-page-completed');
assert.equal(isAutomatedReturnRefundCompletion({
  outcome: 'manual-completed',
  readOnlyReview: true,
  completionMethod: 'return-refund-read-only-page-completed',
}), true, 'a system read-only terminal reconciliation counts as automated handling');
assert.equal(isAutomatedReturnRefundCompletion({
  outcome: 'manual-completed',
  readOnlyReview: false,
  completionMethod: 'return-refund-manual-completed',
}), false, 'an operator-completed refund remains manual handling');

const pendingBeforeBuyerShipment = {
  ...facts,
  aftersaleType: null,
  aftersaleStatus: null,
  refundAmount: null,
  hasReturnLogistics: false,
  logisticsTimeline: [],
  latestLogisticsAt: null,
  logisticsContainsChangsha: false,
  actionButtonVisible: false,
  pageIndicatesPendingMerchant: true,
};
assert.equal(evaluateReturnRefundRules(pendingBeforeBuyerShipment).outcome, 'wait-logistics');

const trackingPending = extractReturnRefundFacts(body.replace(
  '已到达湖南长沙转运中心',
  '消费者已填写物流单号，待快递公司返回物流信息',
), { actionButtonVisible: true });
assert.equal(trackingPending.hasReturnLogistics, false);
assert.equal(evaluateReturnRefundRules(trackingPending).outcome, 'wait-logistics');

const splitLabelBody = `
售后编码
22065155904336
售后类型
退货退款
退款金额
待退金额
￥38.64
订单号
260808-428091676232093
售后状态
退货退款，待商家确认收货
退货物流
快件已发往 湖南长沙转运中心
2026-08-12 09:27:28
退货快递单号
777435023839260
`;
const splitFacts = extractReturnRefundFacts(splitLabelBody, { actionButtonVisible: true });
assert.equal(splitFacts.orderNumber, '260808-428091676232093');
assert.equal(splitFacts.aftersaleNumber, '22065155904336');
assert.equal(splitFacts.aftersaleType, '退货退款');
assert.equal(splitFacts.aftersaleStatus, '退货退款,待商家确认收货');
assert.equal(splitFacts.refundAmount, 38.64);
assert.equal(splitFacts.returnTrackingNumber, '777435023839260');
assert.equal(splitFacts.evidence.fieldSources.refundAmount.source, 'label-following-line');
assert.equal(evaluateReturnRefundRules(splitFacts, { now: Date.parse('2026-08-12T02:00:00.000Z') }).outcome, 'auto-refund');

const currentPddCopy = extractReturnRefundFacts(splitLabelBody
  .replace('退货退款\n退款金额', '退货退款,待商家处理\n退款金额')
  .replace('退货退款，待商家确认收货', '买家已发货,待商家处理'), {
  actionButtonVisible: true,
});
assert.equal(currentPddCopy.aftersaleType, '退货退款');
assert.equal(currentPddCopy.aftersaleStatus, '买家已发货,待商家处理');
assert.equal(evaluateReturnRefundRules(currentPddCopy, { now: Date.parse('2026-08-12T02:00:00.000Z') }).outcome, 'auto-refund');

const currentPddLogisticsCopy = extractReturnRefundFacts(splitLabelBody
  .replace('退货快递单号', '快递单号')
  .replace('退货退款\n退款金额', '退货退款待商家处理\n退款金额')
  .replace('退货退款，待商家确认收货\n退货物流', '退货物流'), {
  actionButtonVisible: true,
});
assert.equal(currentPddLogisticsCopy.returnTrackingNumber, '777435023839260');
assert.equal(currentPddLogisticsCopy.aftersaleStatus, '退货退款待商家处理');
assert.equal(currentPddLogisticsCopy.evidence.fieldSources.aftersaleStatus.source, 'aftersale-type-line');
assert.equal(evaluateReturnRefundRules(currentPddLogisticsCopy, {
  now: Date.parse('2026-08-12T02:00:00.000Z'),
}).outcome, 'auto-refund');
assert.deepEqual(currentPddLogisticsCopy.evidence.returnLogisticsPreview.slice(0, 2), [
  '退货物流',
  '快件已发往 湖南长沙转运中心',
]);

const scopedLogisticsFacts = extractReturnRefundFacts(`${splitLabelBody}\n协商详情\n闪电退货\n2026-08-16 09:25:18`, {
  actionButtonVisible: true,
  capturedAt: '2026-08-12T06:00:00.000Z',
  returnLogisticsText: `退货物流\n快件离开【长沙转运中心】，已发往【衡水转运中心】\n2026-08-12 09:27:28\n闪电退货：系统自动同意申请\n2026-08-16 09:25:18`,
  returnLogisticsSource: { status: 'confirmed', strategy: 'test-module' },
});
assert.equal(scopedLogisticsFacts.logisticsTimeline.length, 1);
assert.equal(scopedLogisticsFacts.logisticsTimeline[0].text.includes('长沙'), true);
assert.equal(scopedLogisticsFacts.latestLogisticsAt, '2026-08-12T01:27:28.000Z');
assert.equal(scopedLogisticsFacts.logisticsContainsChangsha, true);

const directionBody = splitLabelBody.replace(
  '快件已发往 湖南长沙转运中心\n2026-08-12 09:27:28',
  '快件到达【保定转运中心】\n2026-08-12 09:27:28',
);
const olderChangshaFacts = extractReturnRefundFacts(directionBody, {
  actionButtonVisible: true,
  capturedAt: '2026-08-12T06:00:00.000Z',
  returnLogisticsText: `退货物流
快件到达【保定转运中心】
2026-08-12 09:27:28
快件离开【长沙转运中心】，正在发往下一站
2026-08-11 09:27:28`,
  returnLogisticsSource: { status: 'confirmed', strategy: 'test-module' },
});
assert.equal(olderChangshaFacts.logisticsTimeline.length, 2);
assert.equal(olderChangshaFacts.logisticsContainsChangsha, true);
assert.equal(evaluateReturnRefundRules(olderChangshaFacts, {
  now: Date.parse('2026-08-12T06:00:00.000Z'),
}).outcome, 'auto-refund');

const extractDirectionFacts = (nodeText) => extractReturnRefundFacts(directionBody, {
  actionButtonVisible: true,
  capturedAt: '2026-08-12T06:00:00.000Z',
  returnLogisticsText: `退货物流\n${nodeText}\n2026-08-12 09:27:28`,
  returnLogisticsSource: { status: 'confirmed', strategy: 'test-module' },
});
const hengshuiJizhouFacts = extractDirectionFacts('快件到达【衡水市冀州区城区集散点】');
assert.equal(hengshuiJizhouFacts.logisticsContainsHengshuiJizhou, true);
assert.deepEqual(hengshuiJizhouFacts.logisticsMatchedDestinations, ['衡水冀州']);
assert.equal(evaluateReturnRefundRules(hengshuiJizhouFacts, {
  now: Date.parse('2026-08-12T06:00:00.000Z'),
}).outcome, 'auto-refund');

for (const nodeText of ['快件到达【衡水市处理中心】', '快件到达【冀州区城区集散点】']) {
  const singleWordFacts = extractDirectionFacts(nodeText);
  assert.equal(singleWordFacts.logisticsContainsHengshuiJizhou, false);
  assert.equal(evaluateReturnRefundRules(singleWordFacts, {
    now: Date.parse('2026-08-12T06:00:00.000Z'),
  }).outcome, 'wait-logistics');
}
const splitHengshuiJizhouFacts = extractReturnRefundFacts(directionBody, {
  actionButtonVisible: true,
  capturedAt: '2026-08-12T06:00:00.000Z',
  returnLogisticsText: `退货物流
快件到达【冀州区城区集散点】
2026-08-12 09:27:28
快件离开【衡水市处理中心】，正在发往下一站
2026-08-11 09:27:28`,
  returnLogisticsSource: { status: 'confirmed', strategy: 'test-module' },
});
assert.equal(splitHengshuiJizhouFacts.logisticsContainsHengshuiJizhou, false);
assert.equal(evaluateReturnRefundRules(splitHengshuiJizhouFacts, {
  now: Date.parse('2026-08-12T06:00:00.000Z'),
}).outcome, 'wait-logistics');

const noLogisticsFacts = {
  ...facts,
  hasReturnLogistics: false,
  logisticsTimeline: [],
  earliestLogisticsAt: null,
  latestLogisticsAt: null,
  logisticsContainsChangsha: false,
  logisticsContainsHengshuiJizhou: false,
  logisticsDirectionMatched: false,
};
assert.equal(evaluateReturnRefundRules(noLogisticsFacts, {
  now: Date.parse('2026-08-12T08:00:00.000Z'),
  firstDiscoveredAt: '2026-08-09T08:00:00.000Z',
}).outcome, 'wait-logistics');
assert.equal(evaluateReturnRefundRules(noLogisticsFacts, {
  now: Date.parse('2026-08-12T08:00:00.001Z'),
  firstDiscoveredAt: '2026-08-09T08:00:00.000Z',
}).outcome, 'auto-refund');

const transitBoundaryFacts = {
  ...facts,
  earliestLogisticsAt: '2026-08-09T08:00:00.000Z',
  latestLogisticsAt: '2026-08-12T08:00:00.000Z',
  logisticsTransitSpanHours: 72,
  logisticsContainsChangsha: false,
  logisticsContainsHengshuiJizhou: false,
  logisticsDirectionMatched: false,
};
assert.equal(evaluateReturnRefundRules(transitBoundaryFacts, {
  now: Date.parse('2026-08-12T08:00:00.000Z'),
}).outcome, 'wait-logistics');
assert.equal(evaluateReturnRefundRules({
  ...transitBoundaryFacts,
  earliestLogisticsAt: '2026-08-09T07:59:59.999Z',
  logisticsTransitSpanHours: 72.0000003,
}, { now: Date.parse('2026-08-12T08:00:00.000Z') }).outcome, 'auto-refund');
assert.equal(evaluateReturnRefundRules({
  ...facts,
  logisticsContainsChangsha: true,
}, { now: Date.parse('2026-08-14T01:27:28.001Z') }).policyReasonCode,
'return-refund-stale-logistics-auto-approved');
const missingStatusWithStaleLogistics = evaluateReturnRefundRules({
  ...facts,
  aftersaleStatus: null,
  logisticsContainsChangsha: true,
}, { now: Date.parse('2026-08-14T01:27:28.001Z') });
assert.equal(missingStatusWithStaleLogistics.outcome, 'auto-refund',
  'an absent status label must not block an otherwise eligible stale-logistics refund');
assert.equal(missingStatusWithStaleLogistics.rules.status.required, false);
assert.equal(evaluateReturnRefundRules({
  ...transitBoundaryFacts,
  earliestLogisticsAt: '2026-08-09T07:59:59.999Z',
  logisticsTransitSpanHours: 72.0000003,
  refundAmount: 500,
}, { now: Date.parse('2026-08-12T08:00:00.000Z') }).manualReasonCode,
'return-refund-direction-timeout',
'direction timeout must remain manual when the amount reaches the automatic limit');

const dispatchTimelineFacts = extractReturnRefundFacts(splitLabelBody, {
  actionButtonVisible: true,
  capturedAt: '2026-08-12T06:00:00.000Z',
  returnLogisticsText: `退货物流\n【宜宾市】派件员正在为您派件\n2026-08-11 09:53:51`,
  returnLogisticsSource: { status: 'confirmed', strategy: 'test-module' },
});
assert.equal(dispatchTimelineFacts.logisticsTimeline.length, 1);
assert.equal(dispatchTimelineFacts.logisticsTimeline[0].text, '【宜宾市】派件员正在为您派件');

const unconfirmedLogisticsFacts = extractReturnRefundFacts(splitLabelBody, {
  actionButtonVisible: true,
  capturedAt: '2026-08-12T06:00:00.000Z',
  returnLogisticsText: `快件离开【长沙转运中心】\n2026-08-12 09:27:28`,
  returnLogisticsSource: { status: 'not-found', strategy: 'test-not-found' },
});
assert.equal(unconfirmedLogisticsFacts.logisticsTimeline.length, 0);
assert.equal(unconfirmedLogisticsFacts.logisticsContainsChangsha, false);
assert.equal(evaluateReturnRefundRules(unconfirmedLogisticsFacts, {
  now: Date.parse('2026-08-12T06:00:00.000Z'),
  firstDiscoveredAt: '2026-08-12T06:00:00.000Z',
}).outcome, 'wait-logistics');

const buyerNotShipped = {
  ...currentPddCopy,
  aftersaleStatus: '买家申请退货,待商家处理',
};
assert.equal(evaluateReturnRefundRules(buyerNotShipped, { now: Date.parse('2026-08-12T02:00:00.000Z') }).outcome, 'auto-refund');

const compactTypeCopy = extractReturnRefundFacts(splitLabelBody
  .replace('退货退款\n退款金额', '退货退款待商家处理\n退款金额')
  .replace('退货退款，待商家确认收货\n退货物流', '退货物流'), {
  actionButtonVisible: true,
});
assert.equal(compactTypeCopy.aftersaleType, '退货退款');
assert.equal(compactTypeCopy.aftersaleStatus, '退货退款待商家处理');

const makeLocator = (items = []) => ({
  count: async () => items.length,
  nth: (index) => ({
    isVisible: async () => items[index]?.visible !== false,
    isEnabled: async () => items[index]?.enabled !== false,
    getAttribute: async (name) => items[index]?.attributes?.[name] ?? null,
    innerText: async () => items[index]?.text || '',
    marker: items[index]?.marker,
  }),
  filter() { return this; },
});

const locatorCalls = [];
const screenshotLikePage = {
  getByRole: (role, options) => {
    locatorCalls.push({ kind: 'role', role, options });
    return makeLocator(role === 'button' && options?.name === '同意退货'
      ? [{ marker: '同意退货主按钮' }]
      : []);
  },
  locator: (selector) => {
    locatorCalls.push({ kind: 'selector', selector });
    return makeLocator([]);
  },
  getByText: (text, options) => {
    locatorCalls.push({ kind: 'text', text, options });
    return makeLocator(text === '同意退款'
      ? [{ marker: '其他操作中的小字同意退款' }]
      : []);
  },
};
const smallTextApprove = await findApproveRefundAction(screenshotLikePage);
assert.equal(smallTextApprove.marker, '其他操作中的小字同意退款');
assert.equal(locatorCalls.some((call) => call.options?.name === '同意退货'), false);

const disabledApprovePage = {
  getByRole: () => makeLocator([]),
  locator: () => makeLocator([]),
  getByText: () => makeLocator([{ marker: 'disabled', enabled: false }]),
};
assert.equal(await findApproveRefundAction(disabledApprovePage), null);

const makeConfirmationContainer = ({ text, actions = [], acknowledgements = [] }) => ({
  isVisible: async () => true,
  innerText: async () => text,
  getByRole: (role) => makeLocator(role === 'checkbox' ? acknowledgements : actions),
  locator: () => makeLocator([]),
  getByText: () => makeLocator([]),
});
const makeConfirmationPage = (containers) => ({
  locator: () => ({
    count: async () => containers.length,
    nth: (index) => containers[index],
  }),
  waitForTimeout: async () => {},
});
const confirmation = await findReturnRefundConfirmationAction(makeConfirmationPage([
  makeConfirmationContainer({ text: '营销活动说明', actions: [{ marker: 'wrong-confirm' }] }),
  makeConfirmationContainer({
    text: '售后编号：22123456789012 售后类型：退货退款 退货物流 确认同意退款 退款金额 ￥48.90',
    actions: [{ marker: 'detail-approve' }],
  }),
  makeConfirmationContainer({
    text: '同意退款 我确认同意退款 确认退款 取消',
    actions: [{ marker: 'refund-confirm' }],
    acknowledgements: [{ marker: 'refund-acknowledgement' }],
  }),
]), { timeoutMs: 0 });
assert.equal(confirmation.action.marker, 'refund-confirm');
assert.equal(confirmation.acknowledgement.marker, 'refund-acknowledgement');
assert.equal(await findReturnRefundConfirmationAction(makeConfirmationPage([
  makeConfirmationContainer({
    text: '售后编号：22123456789012 售后类型：退货退款 退货物流 确认同意退款 退款金额 ￥48.90',
    actions: [{ marker: 'detail-approve' }],
  }),
]), { timeoutMs: 0 }), null, 'the aftersale detail overlay must not be treated as confirmation');
assert.equal(await findReturnRefundConfirmationAction(makeConfirmationPage([
  makeConfirmationContainer({ text: '营销活动说明', actions: [{ marker: 'wrong-confirm' }] }),
]), { timeoutMs: 0 }), null);

let confirmationDomClicks = 0;
let confirmationActionEvaluations = 0;
await clickReturnRefundConfirmationActionOnce({
  action: {
    isEnabled: async () => true,
    getAttribute: async () => null,
    evaluate: async () => {
      confirmationActionEvaluations += 1;
      if (confirmationActionEvaluations === 1) return true;
      confirmationDomClicks += 1;
      return undefined;
    },
  },
});
assert.equal(confirmationDomClicks, 1, 'the irreversible confirmation action must be dispatched once');

let acknowledgementEvaluations = 0;
assert.equal(await clickReturnRefundAcknowledgementOnce({
  evaluate: async () => {
    acknowledgementEvaluations += 1;
    return acknowledgementEvaluations === 1 ? false : true;
  },
}), true);
assert.equal(acknowledgementEvaluations, 2,
  'the acknowledgement must be checked before it receives one DOM click');

let staleAcknowledgementEvaluations = 0;
let freshAcknowledgementEvaluations = 0;
let acknowledgementReacquisitions = 0;
const freshAcknowledgement = {
  evaluate: async () => {
    freshAcknowledgementEvaluations += 1;
    return freshAcknowledgementEvaluations === 1 ? false : true;
  },
};
assert.equal(await clickReturnRefundAcknowledgementOnce({
  evaluate: async () => {
    staleAcknowledgementEvaluations += 1;
    if (staleAcknowledgementEvaluations === 1) return false;
    throw new Error('Element is not attached to the DOM');
  },
}, {
  resolveAcknowledgement: async () => {
    acknowledgementReacquisitions += 1;
    return freshAcknowledgement;
  },
  timeoutMs: 0,
}), true);
assert.equal(acknowledgementReacquisitions, 1,
  'a detached acknowledgement must be reacquired with a bounded retry');
assert.equal(freshAcknowledgementEvaluations, 2);

let confirmationReacquisitions = 0;
let replacedConfirmationClicks = 0;
const disabledConfirmationAction = {
  isEnabled: async () => false,
  getAttribute: async () => null,
  evaluate: async () => false,
};
const enabledConfirmationAction = {
  isEnabled: async () => true,
  getAttribute: async () => null,
  evaluate: async (callback) => callback({
    hasAttribute: () => false,
    className: '',
    click: () => { replacedConfirmationClicks += 1; },
  }),
};
assert.equal(await clickReturnRefundConfirmationActionOnce({
  action: disabledConfirmationAction,
}, {
  timeoutMs: 1_000,
  locatorTimeoutMs: 0,
  resolveConfirmation: async () => {
    confirmationReacquisitions += 1;
    return {
      action: confirmationReacquisitions === 1
        ? disabledConfirmationAction
        : enabledConfirmationAction,
    };
  },
}), true);
assert.equal(confirmationReacquisitions, 2,
  'the confirmation action must be reacquired after a React DOM replacement');
assert.equal(replacedConfirmationClicks, 1,
  'the reacquired irreversible confirmation action must still be dispatched exactly once');

const unchangedPendingSubmission = {
  confirmed: false,
  approveClicked: true,
  confirmationFound: false,
  confirmationClicked: false,
  postconditionRefreshCount: 3,
  facts: {
    orderNumber: '260819-000000000000001',
    aftersaleNumber: '22123456789012',
    aftersaleStatus: '待消费者寄出退货',
    actionButtonVisible: true,
    evidence: {
      fieldSources: {
        aftersaleStatus: { source: 'label-inline', value: '待消费者寄出退货' },
      },
    },
  },
};
assert.deepEqual(classifyReturnRefundSubmission(unchangedPendingSubmission, {
  expectedOrderNumber: unchangedPendingSubmission.facts.orderNumber,
  expectedAftersaleNumber: unchangedPendingSubmission.facts.aftersaleNumber,
}), {
  effectStatus: 'failed',
  retryable: true,
  reason: 'pdd-confirmation-not-dispatched',
});
assert.equal(classifyReturnRefundSubmission({
  ...unchangedPendingSubmission,
  confirmationFound: true,
  confirmationClicked: true,
}, {
  expectedOrderNumber: unchangedPendingSubmission.facts.orderNumber,
  expectedAftersaleNumber: unchangedPendingSubmission.facts.aftersaleNumber,
}).effectStatus, 'unknown', 'an unresolved dispatched confirmation must never be retried');
assert.equal(classifyReturnRefundSubmission({
  ...unchangedPendingSubmission,
  postconditionRefreshCount: 2,
}, {
  expectedOrderNumber: unchangedPendingSubmission.facts.orderNumber,
  expectedAftersaleNumber: unchangedPendingSubmission.facts.aftersaleNumber,
}).effectStatus, 'unknown', 'fewer than three exact refreshed observations are not enough to retry');
assert.equal(classifyReturnRefundSubmission({
  ...unchangedPendingSubmission,
  confirmed: true,
}, {
  expectedOrderNumber: unchangedPendingSubmission.facts.orderNumber,
  expectedAftersaleNumber: unchangedPendingSubmission.facts.aftersaleNumber,
}).effectStatus, 'succeeded');

const exactPendingExistingEffectFacts = {
  orderNumber: '260819-000000000000002',
  aftersaleNumber: '22123456789013',
  aftersaleStatus: '买家已发货,待商家处理',
  actionButtonVisible: true,
  evidence: {
    fieldSources: {
      aftersaleStatus: { source: 'label-following-line', value: '买家已发货,待商家处理' },
    },
  },
};
assert.deepEqual(classifyExistingReturnRefundEffect(exactPendingExistingEffectFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: {
    submission: {
      approveClicked: true,
      confirmationFound: false,
      confirmationClicked: false,
      postconditionRefreshCount: 3,
    },
  },
  expectedOrderNumber: exactPendingExistingEffectFacts.orderNumber,
  expectedAftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber,
}), {
  effectStatus: 'failed',
  retryable: true,
  reason: 'existing-pdd-confirmation-not-dispatched',
});
assert.equal(classifyExistingReturnRefundEffect(exactPendingExistingEffectFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: { submission: { confirmationClicked: true } },
  expectedOrderNumber: exactPendingExistingEffectFacts.orderNumber,
  expectedAftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber,
}).effectStatus, 'unknown', 'a dispatched confirmation must remain protected until read-only proof matures');
assert.deepEqual(classifyExistingReturnRefundEffect(exactPendingExistingEffectFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: { aftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber },
  existingEffectError: {
    reason: 'pdd-return-refund-exception',
    message: "locator.click: Timeout 30000ms exceeded; waiting for getByRole('button', { name: '确认退款' })",
  },
  expectedOrderNumber: exactPendingExistingEffectFacts.orderNumber,
  expectedAftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber,
}), {
  effectStatus: 'failed',
  retryable: true,
  reason: 'legacy-pdd-confirmation-not-dispatched',
});
assert.equal(classifyExistingReturnRefundEffect(exactPendingExistingEffectFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: { aftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber },
  existingEffectError: {
    reason: 'pdd-return-refund-exception',
    message: "locator.click: Timeout 30000ms exceeded; waiting for getByRole('button', { name: '确认退款' })",
  },
  expectedOrderNumber: '260819-999999999999999',
  expectedAftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber,
}).effectStatus, 'unknown', 'a mismatched database order number must keep the effect protected');
assert.equal(classifyExistingReturnRefundEffect({
  ...exactPendingExistingEffectFacts,
  aftersaleStatus: '待消费者寄出退货',
}, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: { aftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber },
  existingEffectError: {
    reason: 'pdd-return-refund-exception',
    message: "locator.click: Timeout 30000ms exceeded; waiting for getByRole('button', { name: '确认退款' })",
  },
  expectedOrderNumber: exactPendingExistingEffectFacts.orderNumber,
  expectedAftersaleNumber: exactPendingExistingEffectFacts.aftersaleNumber,
}).effectStatus, 'unknown', 'a changed consumer-shipment state must not be retried');

const exactConsumerPendingFacts = {
  ...exactPendingExistingEffectFacts,
  aftersaleStatus: '闪电退货,待消费者寄出退货',
  evidence: {
    ...exactPendingExistingEffectFacts.evidence,
    fieldSources: {
      aftersaleStatus: { source: 'label-following-line', value: '闪电退货,待消费者寄出退货' },
    },
  },
};
assert.deepEqual(classifyExistingReturnRefundEffect(exactConsumerPendingFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: {
    submission: {
      approveClicked: true,
      confirmationFound: true,
      confirmationClicked: false,
      acknowledgementFound: true,
      acknowledgementChecked: false,
    },
  },
  expectedOrderNumber: exactConsumerPendingFacts.orderNumber,
  expectedAftersaleNumber: exactConsumerPendingFacts.aftersaleNumber,
}), {
  effectStatus: 'failed',
  retryable: true,
  reason: 'existing-pdd-confirmation-not-dispatched',
}, 'an explicit undispatched confirmation is safe to retry in any exact actionable pending state');

const legacyUnknownReservedAt = '2026-08-19T10:00:00.000Z';
const legacyUnknownObservedAt = '2026-08-19T11:00:00.000Z';
const legacyUnknownFacts = {
  ...exactPendingExistingEffectFacts,
  evidence: {
    ...exactPendingExistingEffectFacts.evidence,
    capturedAt: legacyUnknownObservedAt,
  },
};
const firstLegacyUnknownProof = classifyExistingReturnRefundEffect(legacyUnknownFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: { aftersaleNumber: legacyUnknownFacts.aftersaleNumber },
  existingEffectError: { reason: 'pdd-result-not-confirmed' },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: legacyUnknownFacts.orderNumber,
  expectedAftersaleNumber: legacyUnknownFacts.aftersaleNumber,
});
assert.equal(firstLegacyUnknownProof.effectStatus, 'unknown');
assert.equal(firstLegacyUnknownProof.retryable, false);
assert.equal(firstLegacyUnknownProof.reason, 'pdd-exact-pending-proof-waiting');
assert.equal(firstLegacyUnknownProof.pendingProof.firstObservedAt, legacyUnknownObservedAt);
assert.equal(firstLegacyUnknownProof.pendingProof.recheckAfterAt, '2026-08-19T11:05:00.000Z');
assert.deepEqual(classifyExistingReturnRefundEffect({
  ...legacyUnknownFacts,
  evidence: { ...legacyUnknownFacts.evidence, capturedAt: '2026-08-19T11:05:00.000Z' },
}, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: {
    aftersaleNumber: legacyUnknownFacts.aftersaleNumber,
    reconciliationProof: firstLegacyUnknownProof.pendingProof,
  },
  existingEffectError: { reason: 'pdd-result-not-confirmed' },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: legacyUnknownFacts.orderNumber,
  expectedAftersaleNumber: legacyUnknownFacts.aftersaleNumber,
}), {
  effectStatus: 'failed',
  retryable: true,
  reason: 'pdd-exact-pending-after-unknown-confirmed',
  pendingProof: {
    ...firstLegacyUnknownProof.pendingProof,
    observedAt: '2026-08-19T11:05:00.000Z',
    recheckAfterAt: '2026-08-19T11:05:00.000Z',
  },
});
const consumerPendingObservedAt = '2026-08-19T11:10:00.000Z';
const consumerPendingProofFacts = {
  ...exactConsumerPendingFacts,
  evidence: {
    ...exactConsumerPendingFacts.evidence,
    capturedAt: consumerPendingObservedAt,
  },
};
const firstConsumerPendingProof = classifyExistingReturnRefundEffect(consumerPendingProofFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: { aftersaleNumber: consumerPendingProofFacts.aftersaleNumber },
  existingEffectError: { reason: 'pdd-result-not-confirmed' },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: consumerPendingProofFacts.orderNumber,
  expectedAftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
});
assert.equal(firstConsumerPendingProof.reason, 'pdd-exact-pending-proof-waiting');
assert.equal(classifyExistingReturnRefundEffect({
  ...consumerPendingProofFacts,
  evidence: { ...consumerPendingProofFacts.evidence, capturedAt: '2026-08-19T11:15:00.000Z' },
}, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: {
    aftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
    reconciliationProof: firstConsumerPendingProof.pendingProof,
  },
  existingEffectError: { reason: 'pdd-result-not-confirmed' },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: consumerPendingProofFacts.orderNumber,
  expectedAftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
}).reason, 'pdd-exact-pending-after-unknown-confirmed',
'two stable exact consumer-pending observations may safely release an old unknown effect');
assert.equal(classifyExistingReturnRefundEffect({
  ...consumerPendingProofFacts,
  aftersaleStatus: '待买家处理',
  evidence: {
    ...consumerPendingProofFacts.evidence,
    capturedAt: '2026-08-19T11:15:00.000Z',
    fieldSources: {
      aftersaleStatus: { source: 'label-inline', value: '待买家处理' },
    },
  },
}, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: {
    aftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
    reconciliationProof: firstConsumerPendingProof.pendingProof,
  },
  existingEffectError: { reason: 'pdd-result-not-confirmed' },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: consumerPendingProofFacts.orderNumber,
  expectedAftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
}).reason, 'pdd-exact-pending-proof-waiting',
'a changed pending status must restart the proof window');
const counterpartyNoActionObservedAt = '2026-08-19T11:20:00.000Z';
const counterpartyNoActionFacts = {
  ...exactConsumerPendingFacts,
  actionButtonVisible: false,
  pageIndicatesPendingCounterparty: true,
  evidence: {
    ...exactConsumerPendingFacts.evidence,
    capturedAt: counterpartyNoActionObservedAt,
  },
};
const firstCounterpartyNoActionProof = classifyExistingReturnRefundEffect(
  counterpartyNoActionFacts,
  {
    existingEffectStatus: 'reserved',
    existingEffectReceipt: { aftersaleNumber: counterpartyNoActionFacts.aftersaleNumber },
    existingEffectReservedAt: legacyUnknownReservedAt,
    expectedOrderNumber: counterpartyNoActionFacts.orderNumber,
    expectedAftersaleNumber: counterpartyNoActionFacts.aftersaleNumber,
  },
);
assert.equal(firstCounterpartyNoActionProof.effectStatus, 'unknown');
assert.equal(firstCounterpartyNoActionProof.retryable, false);
assert.equal(firstCounterpartyNoActionProof.reason,
  'pdd-exact-counterparty-pending-no-action-proof-waiting');
assert.equal(firstCounterpartyNoActionProof.pendingProof.strategy,
  'exact-counterparty-pending-no-action-after-unknown');
assert.equal(firstCounterpartyNoActionProof.pendingProof.actionButtonVisible, false);
assert.equal(firstCounterpartyNoActionProof.pendingProof.recheckAfterAt,
  '2026-08-19T11:25:00.000Z');
assert.deepEqual(classifyExistingReturnRefundEffect({
  ...counterpartyNoActionFacts,
  evidence: {
    ...counterpartyNoActionFacts.evidence,
    capturedAt: '2026-08-19T11:25:00.000Z',
  },
}, {
  existingEffectStatus: 'reserved',
  existingEffectReceipt: {
    aftersaleNumber: counterpartyNoActionFacts.aftersaleNumber,
    reconciliationProof: firstCounterpartyNoActionProof.pendingProof,
  },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: counterpartyNoActionFacts.orderNumber,
  expectedAftersaleNumber: counterpartyNoActionFacts.aftersaleNumber,
}), {
  effectStatus: 'failed',
  retryable: false,
  reason: 'pdd-exact-counterparty-pending-no-action-after-unknown-confirmed',
  disposition: 'wait-logistics',
  pendingProof: {
    ...firstCounterpartyNoActionProof.pendingProof,
    observedAt: '2026-08-19T11:25:00.000Z',
    recheckAfterAt: '2026-08-19T11:25:00.000Z',
  },
}, 'a stable exact counterparty state must release the stale effect into normal waiting');
assert.equal(classifyExistingReturnRefundEffect({
  ...counterpartyNoActionFacts,
  aftersaleStatus: '待买家处理',
  evidence: {
    ...counterpartyNoActionFacts.evidence,
    capturedAt: '2026-08-19T11:25:00.000Z',
    fieldSources: {
      aftersaleStatus: { source: 'label-inline', value: '待买家处理' },
    },
  },
}, {
  existingEffectStatus: 'reserved',
  existingEffectReceipt: {
    aftersaleNumber: counterpartyNoActionFacts.aftersaleNumber,
    reconciliationProof: firstCounterpartyNoActionProof.pendingProof,
  },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: counterpartyNoActionFacts.orderNumber,
  expectedAftersaleNumber: counterpartyNoActionFacts.aftersaleNumber,
}).reason, 'pdd-exact-counterparty-pending-no-action-proof-waiting',
'a changed counterparty status must restart the no-action proof window');
assert.equal(classifyExistingReturnRefundEffect({
  ...counterpartyNoActionFacts,
  actionButtonVisible: null,
}, {
  existingEffectStatus: 'reserved',
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: counterpartyNoActionFacts.orderNumber,
  expectedAftersaleNumber: counterpartyNoActionFacts.aftersaleNumber,
}).reason, 'pdd-result-not-confirmed',
'an indeterminate action state must preserve the uncertain effect');
assert.equal(classifyExistingReturnRefundEffect({
  ...counterpartyNoActionFacts,
  evidence: {
    ...counterpartyNoActionFacts.evidence,
    fieldSources: {
      aftersaleStatus: { source: 'status-text', value: counterpartyNoActionFacts.aftersaleStatus },
    },
  },
}, {
  existingEffectStatus: 'reserved',
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: counterpartyNoActionFacts.orderNumber,
  expectedAftersaleNumber: counterpartyNoActionFacts.aftersaleNumber,
}).reason, 'pdd-result-not-confirmed',
'an unlabeled counterparty status must preserve the uncertain effect');
const firstStaleReservedProof = classifyExistingReturnRefundEffect(consumerPendingProofFacts, {
  existingEffectStatus: 'reserved',
  existingEffectReceipt: { aftersaleNumber: consumerPendingProofFacts.aftersaleNumber },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: consumerPendingProofFacts.orderNumber,
  expectedAftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
});
assert.equal(firstStaleReservedProof.reason, 'pdd-exact-pending-proof-waiting',
  'a stale reserved effect must enter read-only proof instead of blocking forever');
assert.equal(classifyExistingReturnRefundEffect({
  ...consumerPendingProofFacts,
  evidence: { ...consumerPendingProofFacts.evidence, capturedAt: '2026-08-19T11:15:00.000Z' },
}, {
  existingEffectStatus: 'reserved',
  existingEffectReceipt: {
    aftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
    reconciliationProof: firstStaleReservedProof.pendingProof,
  },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: consumerPendingProofFacts.orderNumber,
  expectedAftersaleNumber: consumerPendingProofFacts.aftersaleNumber,
}).reason, 'pdd-exact-pending-after-unknown-confirmed',
'a stale reserved effect may be released only after the second stable exact observation');
assert.equal(classifyExistingReturnRefundEffect(legacyUnknownFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: { aftersaleNumber: legacyUnknownFacts.aftersaleNumber },
  existingEffectError: { reason: 'pdd-result-not-confirmed' },
  existingEffectReservedAt: '2026-08-19T10:45:00.001Z',
  expectedOrderNumber: legacyUnknownFacts.orderNumber,
  expectedAftersaleNumber: legacyUnknownFacts.aftersaleNumber,
}).reason, 'pdd-result-not-confirmed', 'an immature unknown effect needs more time before proof starts');
const firstDispatchedUnknownProof = classifyExistingReturnRefundEffect(legacyUnknownFacts, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: {
    aftersaleNumber: legacyUnknownFacts.aftersaleNumber,
    submission: { confirmationClicked: true },
  },
  existingEffectError: { reason: 'pdd-result-not-confirmed' },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: legacyUnknownFacts.orderNumber,
  expectedAftersaleNumber: legacyUnknownFacts.aftersaleNumber,
});
assert.equal(firstDispatchedUnknownProof.reason, 'pdd-exact-pending-proof-waiting',
  'a dispatched confirmation needs two exact pending observations before retry');
assert.deepEqual(classifyExistingReturnRefundEffect({
  ...legacyUnknownFacts,
  evidence: { ...legacyUnknownFacts.evidence, capturedAt: '2026-08-19T11:05:00.000Z' },
}, {
  existingEffectStatus: 'unknown',
  existingEffectReceipt: {
    aftersaleNumber: legacyUnknownFacts.aftersaleNumber,
    submission: { confirmationClicked: true },
    reconciliationProof: firstDispatchedUnknownProof.pendingProof,
  },
  existingEffectError: { reason: 'pdd-return-refund-exception' },
  existingEffectReservedAt: legacyUnknownReservedAt,
  expectedOrderNumber: legacyUnknownFacts.orderNumber,
  expectedAftersaleNumber: legacyUnknownFacts.aftersaleNumber,
}).reason, 'pdd-exact-pending-after-unknown-confirmed');

const paginationPage = {
  getByRole: (role, options) => makeLocator(role === 'button' && options?.name.test('下一页')
    ? [{ marker: 'next-page' }]
    : []),
  locator: () => makeLocator([]),
};
assert.equal((await findNextReturnRefundPageAction(paginationPage)).marker, 'next-page');
const disabledPaginationPage = {
  getByRole: () => makeLocator([{ marker: 'disabled-next', attributes: { 'aria-disabled': 'true' } }]),
  locator: () => makeLocator([]),
};
assert.equal(await findNextReturnRefundPageAction(disabledPaginationPage), null);
const activePaginationPage = {
  locator: () => makeLocator([{ text: '3', attributes: { 'aria-current': 'page' } }]),
};
assert.equal(await readReturnRefundActivePageNumber(activePaginationPage), 3,
  'the active PDD pagination marker must be used as browser truth');
let transitioningPageNumber = 1;
const transitioningPaginationPage = {
  locator: () => makeLocator([{
    text: String(transitioningPageNumber),
    attributes: { 'aria-current': 'page' },
  }]),
  getByText: () => ({
    evaluateAll: async () => transitioningPageNumber === 1
      ? '260825-111111111111111'
      : '260825-222222222222222',
  }),
  waitForTimeout: async () => { transitioningPageNumber = 2; },
};
assert.deepEqual(await waitForReturnRefundPageTransition(transitioningPaginationPage, {
  previousSignature: '1:260825-111111111111111',
  expectedPage: 2,
  timeoutMs: 100,
}), {
  activePage: 2,
  signature: '2:260825-222222222222222',
}, 'pagination must confirm both the selected page and a rendered row signature');

let verificationChecks = 0;
let retryableAttempts = 0;
let bringToFrontCalls = 0;
const stepPage = {
  bringToFront: async () => { bringToFrontCalls += 1; },
  isClosed: () => false,
  waitForTimeout: async () => {},
};
const retryableStep = createVisiblePddStep(stepPage, {
  delayMs: 0,
  onVerification: async () => {
    verificationChecks += 1;
    return retryableAttempts > 0;
  },
});
await retryableStep('retryable-step', async () => {
  retryableAttempts += 1;
  if (retryableAttempts === 1) throw new Error('captcha interrupted action');
});
assert.equal(retryableAttempts, 2);
assert.ok(verificationChecks >= 3);
assert.equal(bringToFrontCalls, 0);

let irreversibleAttempts = 0;
const irreversibleStep = createVisiblePddStep(stepPage, {
  delayMs: 0,
  onVerification: async () => irreversibleAttempts > 0,
});
await irreversibleStep('irreversible-step', async () => {
  irreversibleAttempts += 1;
  throw new Error('captcha interrupted irreversible action');
}, {}, { retryAfterVerification: false });
assert.equal(irreversibleAttempts, 1);

const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent(`
    <section>
      <article><span>订单号 260819-111111111111111</span><button>查看详情</button></article>
      <article><span>订单号 260819-222222222222222</span><span>售后编号 22123456789012</span><button>查看详情</button></article>
      <article><span>订单号 260819-333333333333333</span><button>查看详情</button></article>
      <article><a href="https://mms.pinduoduo.com/aftersales-ssr/detail?id=22123456789044&amp;orderSn=260819-444444444444444">查看详情</a></article>
    </section>
  `);
  const matchingDetailAction = await findMatchingReturnRefundDetailAction(page, {
    orderNumber: '260819-222222222222222',
    aftersaleNumber: '22123456789012',
  });
  assert.ok(matchingDetailAction, 'the exact return-refund list row must be located');
  assert.match(await matchingDetailAction.locator('xpath=ancestor::article').innerText(),
    /260819-222222222222222/u);
  assert.deepEqual(await readReturnRefundListRowIdentity(matchingDetailAction), {
    orderNumber: '260819-222222222222222',
    aftersaleNumber: '22123456789012',
    source: 'list-row-or-detail-link',
    rowDepth: 1,
  }, 'the scan event must bind to the clicked row instead of a stale prior detail snapshot');
  const linkedDetailIdentity = await readReturnRefundListRowIdentity(
    page.getByText('查看详情', { exact: true }).nth(3),
  );
  assert.deepEqual(linkedDetailIdentity, {
    orderNumber: '260819-444444444444444',
    aftersaleNumber: '22123456789044',
    source: 'list-row-or-detail-link',
    rowDepth: 0,
  }, 'a detail link must supply identity even when the list row omits its labels');
  assert.equal(await findMatchingReturnRefundDetailAction(page, {
    orderNumber: '260819-999999999999999',
  }), null, 'a table-wide ancestor must not make an unrelated detail action match');

  const recoveryOrderNumber = '260819-444444444444444';
  const recoveryAftersaleNumber = '22123456789044';
  await page.route('https://mms.pinduoduo.com/aftersales/aftersale_list?recovery-test=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<body>
        <button>待商家处理</button><button>退货退款</button>
        <section>
          <article><span>订单号 260819-555555555555555</span><button>查看详情</button></article>
          <article><span>订单号 ${recoveryOrderNumber}</span>
            <span>售后编号 ${recoveryAftersaleNumber}</span>
            <button onclick="location.href='https://mms.pinduoduo.com/aftersales-ssr/detail?id=${recoveryAftersaleNumber}&orderSn=${recoveryOrderNumber}'">查看详情</button>
          </article>
        </section>
      </body>`,
    });
  });
  await page.route(`https://mms.pinduoduo.com/aftersales-ssr/detail?id=${recoveryAftersaleNumber}&orderSn=${recoveryOrderNumber}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<body><div>订单编号：${recoveryOrderNumber}</div><div>售后编号：${recoveryAftersaleNumber}</div></body>`,
    });
  });
  await page.goto('https://mms.pinduoduo.com/aftersales/aftersale_list?recovery-test=1');
  const reopenedDetail = await reopenReturnRefundDetailFromWorkbench(page, page.context(), {
    orderNumber: recoveryOrderNumber,
    aftersaleNumber: recoveryAftersaleNumber,
    maxPages: 2,
    maxDurationMs: 5_000,
    renderWaitMs: 500,
    delayMs: 0,
  });
  assert.ok(reopenedDetail, 'a failed saved detail URL must recover through the workbench row');
  assert.equal(reopenedDetail.pageNumber, 1);
  assert.equal(new URL(reopenedDetail.page.url()).searchParams.get('id'), recoveryAftersaleNumber);

  let unavailableDetailLoads = 0;
  const unavailableDetailUrl = 'https://mms.pinduoduo.com/aftersales-ssr/detail?id=unavailable';
  await page.route(unavailableDetailUrl, async (route) => {
    unavailableDetailLoads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<body>
        <div>退款申请单</div>
        <div>售后编号：22156161804202</div>
        <div>订单编号：260813-014763968031380</div>
        <div>未查询到相关订单信息</div>
        <div>订单不存在</div>
        <div>售后单不存在</div>
      </body>`,
    });
  });
  await page.goto(unavailableDetailUrl);
  await assert.rejects(() => readReturnRefundDetail(page, {
    delayMs: 0,
    renderWaitMs: 100,
    transientPageStateGraceMs: 0,
  }), (error) => error?.code === 'PDD_RETURN_REFUND_NOT_FOUND');
  assert.equal(unavailableDetailLoads, 1,
    'an explicitly missing aftersale must stop without refreshing first');
  let missingRefundReservation = false;
  const skippedMissingRefund = await processReturnRefund(page, page.context(), {
    detailUrl: unavailableDetailUrl,
    orderNumber: '260813-014763968031380',
    aftersaleNumber: '22156161804202',
    autoApproveEnabled: true,
    reserveEffect: async () => {
      missingRefundReservation = true;
      throw new Error('a missing aftersale must never reserve a refund effect');
    },
    delayMs: 0,
    renderWaitMs: 100,
    transientPageStateGraceMs: 0,
  });
  assert.equal(skippedMissingRefund.outcome, 'skipped-not-found');
  assert.equal(skippedMissingRefund.facts.orderNumber, '260813-014763968031380');
  assert.equal(skippedMissingRefund.facts.aftersaleNumber, '22156161804202');
  assert.equal(missingRefundReservation, false);
  assert.equal(unavailableDetailLoads, 1,
    'permanent not-found classification must not reload the missing aftersale');
  await page.unroute(unavailableDetailUrl);

  let rateLimitedDetailLoads = 0;
  const rateLimitedDetailUrl = 'https://mms.pinduoduo.com/aftersales-ssr/detail?id=rate-limited';
  await page.route(rateLimitedDetailUrl, async (route) => {
    rateLimitedDetailLoads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<body><div>操作太过频繁，请稍后再试！</div></body>',
    });
  });
  await page.goto(rateLimitedDetailUrl);
  await assert.rejects(() => readReturnRefundDetail(page, {
    delayMs: 0,
    renderWaitMs: 100,
    transientPageStateGraceMs: 0,
    rateLimitRetryMs: 180_000,
  }), (error) => error?.code === 'PDD_RATE_LIMITED' && error.retryAfterMs === 180_000);
  assert.equal(rateLimitedDetailLoads, 1,
    'a rate-limited detail must back off without a refresh that can trigger a captcha');
  await page.unroute(rateLimitedDetailUrl);

  await page.setContent(`
    <div>退款申请单</div>
    <div>售后编号：</div><div>22161669537069</div>
    <div>售后类型：</div><div>退货退款</div>
    <div>退款金额：</div><div>¥65.00</div>
    <div>订单编号：</div><div>260716-606884381101759</div>
    <div>售后状态</div>
    <div>因为买家逾期未处理或逾期未发货，此次退款失败</div>
  `);
  let unexpectedRefundReservation = false;
  const terminalUnknownEffectResult = await processReturnRefund(page, page.context(), {
    orderNumber: '260716-606884381101759',
    aftersaleNumber: '22161669537069',
    firstDiscoveredAt: '2026-08-12T04:01:31.192Z',
    autoApproveEnabled: true,
    existingEffectStatus: 'unknown',
    existingEffectReceipt: { aftersaleNumber: '22161669537069' },
    existingEffectError: { reason: 'pdd-result-not-confirmed' },
    reserveEffect: async () => {
      unexpectedRefundReservation = true;
      throw new Error('terminal read-only reconciliation must not reserve a refund effect');
    },
    delayMs: 0,
    renderWaitMs: 100,
  });
  assert.equal(terminalUnknownEffectResult.outcome, 'manual-completed');
  assert.equal(terminalUnknownEffectResult.readOnlyReview, true);
  assert.equal(terminalUnknownEffectResult.completionMethod,
    'return-refund-read-only-page-completed');
  assert.equal(unexpectedRefundReservation, false,
    'a terminal page with an unknown historical effect must not reserve or click again');

  await page.setContent(`
    <div>退款申请单</div>
    <div>售后编号：</div><div>22161669537070</div>
    <div>售后类型：</div><div>退货退款</div>
    <div>退款金额：</div><div>¥65.00</div>
    <div>订单编号：</div><div>260716-606884381101760</div>
    <div>售后状态：</div><div>待商家处理</div>
    <button>同意退款</button>
  `);
  const unknownRecheckStartedAt = Date.now();
  const pendingUnknownEffectResult = await processReturnRefund(page, page.context(), {
    orderNumber: '260716-606884381101760',
    aftersaleNumber: '22161669537070',
    firstDiscoveredAt: '2026-08-12T04:01:31.192Z',
    autoApproveEnabled: true,
    existingEffectStatus: 'unknown',
    existingEffectReceipt: { aftersaleNumber: '22161669537070' },
    existingEffectError: { reason: 'pdd-result-not-confirmed' },
    reserveEffect: async () => {
      throw new Error('an unresolved historical refund must remain read-only');
    },
    delayMs: 0,
    renderWaitMs: 100,
  });
  const unknownRecheckDelayMs = Date.parse(pendingUnknownEffectResult.nextCheckAt)
    - unknownRecheckStartedAt;
  assert.equal(pendingUnknownEffectResult.outcome, 'page-error');
  assert.ok(unknownRecheckDelayMs >= RETURN_REFUND_UNKNOWN_RECHECK_MS
    && unknownRecheckDelayMs < RETURN_REFUND_UNKNOWN_RECHECK_MS + 5_000,
  'an unresolved refund effect must schedule its next read-only check in ten minutes');

  const counterpartyWaitOrderNumber = '260731-053603212833629';
  const counterpartyWaitAftersaleNumber = '22182729041084';
  await page.setContent(`
    <div>退款申请单</div>
    <div>售后编号：</div><div>${counterpartyWaitAftersaleNumber}</div>
    <div>售后类型：</div><div>退货退款</div>
    <div>退款金额：</div><div>¥65.00</div>
    <div>订单编号：</div><div>${counterpartyWaitOrderNumber}</div>
    <div>售后状态：</div><div>待消费者寄出退货</div>
  `);
  const counterpartyProofObservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  let counterpartyWaitReservation = false;
  const counterpartyWaitResult = await processReturnRefund(page, page.context(), {
    orderNumber: counterpartyWaitOrderNumber,
    aftersaleNumber: counterpartyWaitAftersaleNumber,
    firstDiscoveredAt: '2026-08-21T23:18:30.000Z',
    autoApproveEnabled: true,
    existingEffectStatus: 'reserved',
    existingEffectReservedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    existingEffectReceipt: {
      aftersaleNumber: counterpartyWaitAftersaleNumber,
      reconciliationProof: {
        strategy: 'exact-counterparty-pending-no-action-after-unknown',
        orderNumber: counterpartyWaitOrderNumber,
        aftersaleNumber: counterpartyWaitAftersaleNumber,
        observedStatus: '待消费者寄出退货',
        actionButtonVisible: false,
        firstObservedAt: counterpartyProofObservedAt,
        observedAt: counterpartyProofObservedAt,
        recheckAfterAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    },
    reserveEffect: async () => {
      counterpartyWaitReservation = true;
      throw new Error('a counterparty wait must never reserve a new refund effect');
    },
    delayMs: 0,
    renderWaitMs: 100,
  });
  assert.equal(counterpartyWaitResult.outcome, 'wait-logistics');
  assert.equal(counterpartyWaitResult.waitReasonCode, 'counterparty-action-pending');
  assert.equal(counterpartyWaitResult.existingEffectResolution?.effectStatus, 'failed');
  assert.equal(counterpartyWaitResult.existingEffectResolution?.retryable, false);
  assert.equal(counterpartyWaitResult.existingEffectResolution?.disposition, 'wait-logistics');
  assert.equal(counterpartyWaitReservation, false,
    'counterparty waiting must release only the old lock and never click refund');

  await page.setContent(`
    <div>退款申请单</div>
    <div>售后编号：</div><div>22117143637101</div>
    <div>退款金额：</div><div>¥59.00</div>
    <div>订单编号：</div><div>260808-052764414391736</div>
    <div>售后状态</div>
    <div>退款成功</div>
  `);
  const terminalDetailWithoutType = await readReturnRefundDetail(page, {
    delayMs: 0,
    renderWaitMs: 100,
  });
  assert.equal(terminalDetailWithoutType.aftersaleType, null);
  assert.equal(confirmsReturnRefundCompletion(terminalDetailWithoutType), true,
    'a scoped terminal detail must render without an aftersale type');
  assert.equal(evaluateReturnRefundRules(terminalDetailWithoutType).outcome, 'manual-completed',
    'a terminal detail without an aftersale type must close through read-only reconciliation');

  const verifiedOrderNumber = '260819-199491612252313';
  const verifiedAftersaleNumber = '22239357204146';
  await page.setContent(`
    <div>退款申请单</div>
    <div>售后编号：</div><div>${verifiedAftersaleNumber}</div>
    <div>售后类型：</div><div>退货退款</div>
    <div>退款金额：</div><div>¥77.00</div>
    <div>订单编号：</div><div>${verifiedOrderNumber}</div>
    <div>售后状态：</div><div>商家同意退款，本单退款成功</div>
    <div role="dialog"><div>请向右滑块完成拼图</div></div>
  `);
  const terminalUnderVerification = await readReturnRefundCompletionUnderVerification(page, {
    expectedFacts: {
      orderNumber: verifiedOrderNumber,
      aftersaleNumber: verifiedAftersaleNumber,
    },
  });
  assert.equal(terminalUnderVerification?.orderNumber, verifiedOrderNumber);
  assert.equal(confirmsReturnRefundCompletion(terminalUnderVerification), true,
    'an exact terminal result behind a captcha overlay must remain readable as completion');
  assert.equal(await readReturnRefundCompletionUnderVerification(page, {
    expectedFacts: {
      orderNumber: '260819-000000000000000',
      aftersaleNumber: verifiedAftersaleNumber,
    },
  }), null, 'terminal evidence from another order must never reconcile the current refund');

  await page.setContent(`
    <div>退款申请单</div>
    <div>售后编号：</div><div>${verifiedAftersaleNumber}</div>
    <div>售后类型：</div><div>退货退款</div>
    <div>退款金额：</div><div>¥77.00</div>
    <div>订单编号：</div><div>${verifiedOrderNumber}</div>
    <div>售后状态：</div><div>待商家处理</div>
    <button id="approve-refund" onclick="document.body.innerHTML = \`
      <div role='dialog'>
        <div>同意退款</div><div>退款金额 ¥77.00</div>
        <button id='refund-confirm' onclick='document.body.innerHTML = &quot;
          <div>退款申请单</div>
          <div>售后编号：</div><div>${verifiedAftersaleNumber}</div>
          <div>售后类型：</div><div>退货退款</div>
          <div>退款金额：</div><div>¥77.00</div>
          <div>订单编号：</div><div>${verifiedOrderNumber}</div>
          <div>售后状态：</div><div>商家同意退款，本单退款成功</div>
          <div role=\&quot;dialog\&quot;><div>请向右滑块完成拼图</div></div>&quot;'>确认退款</button>
        <button>取消</button>
      </div>\`">同意退款</button>
  `);
  const postSubmitVerification = new Error('检测到人工验证');
  postSubmitVerification.name = 'HumanVerificationRequiredError';
  const recoveredSubmission = await submitReturnRefund(page, {
    delayMs: 0,
    renderWaitMs: 100,
    expectedFacts: {
      orderNumber: verifiedOrderNumber,
      aftersaleNumber: verifiedAftersaleNumber,
    },
    onVerification: async (targetPage, stage) => {
      if (stage === 'return-refund-refresh-after-approve-before') {
        await targetPage.setContent(`
          <div>退款申请单</div>
          <div>售后编号：</div><div>${verifiedAftersaleNumber}</div>
          <div>售后类型：</div><div>退货退款</div>
          <div>退款金额：</div><div>¥77.00</div>
          <div>订单编号：</div><div>${verifiedOrderNumber}</div>
          <div>售后状态：</div><div>商家同意退款，本单退款成功</div>
          <div role="dialog"><div>请向右滑块完成拼图</div></div>
        `);
        throw postSubmitVerification;
      }
      return false;
    },
  });
  assert.equal(recoveredSubmission.confirmed, true);
  assert.equal(recoveredSubmission.postconditionRecoveredUnderVerification, true,
    'post-submit captcha must not hide an exact terminal refund result');

  await page.setContent(`
    <div role="dialog">
      <div>同意退款</div>
      <div>退款金额 ¥59.00</div>
      <label><input id="refund-ack" type="checkbox"
        onchange="document.querySelector('#refund-confirm').disabled = !this.checked">
        我确认同意退款</label>
      <button id="refund-confirm" disabled onclick="window.refundConfirmClicks += 1">确认退款</button>
      <button>取消</button>
    </div>
    <script>window.refundConfirmClicks = 0;</script>
  `);
  let browserConfirmation = await findReturnRefundConfirmationAction(page, { timeoutMs: 0 });
  assert.ok(browserConfirmation?.acknowledgement,
    'the real confirmation DOM must expose its acknowledgement checkbox');
  assert.equal(await clickReturnRefundAcknowledgementOnce(browserConfirmation.acknowledgement), true);
  assert.equal(await page.locator('#refund-ack').isChecked(), true);
  browserConfirmation = await findReturnRefundConfirmationAction(page, { timeoutMs: 0 });
  assert.equal(await clickReturnRefundConfirmationActionOnce(browserConfirmation), true);
  assert.equal(await page.evaluate(() => window.refundConfirmClicks), 1,
    'the enabled confirmation button must receive exactly one DOM click');

  await page.setContent(`
    <div role="dialog">
      <div>同意退款</div><div>退款金额 ¥45.90</div>
      <button id="disabled-refund-confirm" disabled>确认退款</button>
    </div>
  `);
  const disabledConfirmation = await findReturnRefundConfirmationAction(page, { timeoutMs: 0 });
  await assert.rejects(
    () => clickReturnRefundConfirmationActionOnce(disabledConfirmation, { timeoutMs: 0 }),
    (error) => error?.code === 'PDD_RETURN_REFUND_CONFIRMATION_NOT_DISPATCHED'
      && error.confirmationDispatched === false,
  );

  await page.context().route('https://popup.test/**', async (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<body>background navigation target</body>',
  }));
  await page.setContent(`
    <a id="background-link" target="_blank" href="https://popup.test/link-detail">detail</a>
  `);
  const initialPageCount = page.context().pages().length;
  await clickPddActionWithoutForegroundPopup(page, page.locator('#background-link'), {
    forceSameTab: true,
  });
  assert.equal(page.url(), 'https://popup.test/link-detail');
  assert.equal(page.context().pages().length, initialPageCount,
    'target=_blank detail links must navigate the existing tab without creating a foreground popup');

  await page.setContent(`
    <button id="window-open" onclick="window.open('https://popup.test/window-open-detail', '_blank')">
      detail
    </button>
  `);
  await clickPddActionWithoutForegroundPopup(page, page.locator('#window-open'), {
    forceSameTab: true,
  });
  assert.equal(page.url(), 'https://popup.test/window-open-detail');
  assert.equal(page.context().pages().length, initialPageCount,
    'window.open detail actions must not create a foreground popup');

  await page.setContent(`
    <button onclick="window.steps.push('workbench')">售后工作台</button>
    <button onclick="window.steps.push('pending')">待商家处理</button>
    <button onclick="window.steps.push('refund')">退货退款</button>
    <div data-testid="beast-core-modal" role="dialog">
      <button data-testid="beast-core-modal-close-button"
        onclick="this.parentElement.remove()">关闭</button>
      <div>今日平台已支持您发起申诉，打款成功79.47元</div>
      <button>查看详情</button>
    </div>
    <script>window.steps = [];</script>
  `);
  await openReturnRefundWorkbench(page, { delayMs: 0 });
  assert.equal(await page.locator('[data-testid="beast-core-modal"]').count(), 0,
    'a promotional modal must be closed before workbench navigation');
  assert.deepEqual(await page.evaluate(() => window.steps), ['workbench', 'pending', 'refund']);

  await page.setContent(`
    <button onclick="window.steps.push('workbench')">售后工作台</button>
    <button onclick="window.steps.push('refund')">退货退款</button>
    <script>window.steps = [];</script>
  `);
  await openReturnRefundWorkbench(page, { delayMs: 0 });
  assert.deepEqual(await page.evaluate(() => window.steps), ['workbench', 'refund'],
    'a missing merchant-pending navigation entry must not block the refund list');

  let workbenchNoopFallbackLoads = 0;
  await page.route(RETURN_REFUND_WORKBENCH_URL, async (route) => {
    workbenchNoopFallbackLoads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<body>
        <button onclick="window.aftersalesTabClicks += 1; document.querySelector('#refund-panel').hidden = false">
          退款/售后
        </button>
        <div id="refund-panel" hidden>
          <button onclick="window.pendingClicks += 1">待商家处理</button>
          <button onclick="window.refundEntryClicks += 1">退货退款</button>
        </div>
        <script>
          window.aftersalesTabClicks = 0;
          window.pendingClicks = 0;
          window.refundEntryClicks = 0;
        </script>
      </body>`,
    });
  });
  await page.goto('about:blank');
  await page.setContent('<h1>售后工作台</h1><div>售后设置</div>');
  await openReturnRefundWorkbench(page, { delayMs: 0, renderWaitMs: 25 });
  assert.equal(workbenchNoopFallbackLoads, 1,
    'a visible workbench heading that does not navigate must fall back to the canonical workbench URL');
  assert.equal(await page.evaluate(() => window.aftersalesTabClicks), 1,
    'a workbench setup-page variant must enter the refund/aftersales tab before selecting filters');
  assert.equal(await page.evaluate(() => window.pendingClicks), 1);
  assert.equal(await page.evaluate(() => window.refundEntryClicks), 1);
  await page.unroute(RETURN_REFUND_WORKBENCH_URL);
  await page.goto('about:blank');

  let delayedRefundEntryLoads = 0;
  const delayedRefundEntryUrl = 'https://mms.pinduoduo.com/aftersales/aftersale_list?entry-refresh-test=1';
  await page.route(delayedRefundEntryUrl, async (route) => {
    delayedRefundEntryLoads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: delayedRefundEntryLoads === 1
        ? '<body><button>待商家处理</button><div>售后类型加载中</div></body>'
        : `<body>
          <button>待商家处理</button>
          <button onclick="window.refundEntryClicks += 1">退货退款（12+）</button>
          <script>window.refundEntryClicks = 0;</script>
        </body>`,
    });
  });
  await page.goto(delayedRefundEntryUrl);
  await openReturnRefundWorkbench(page, { delayMs: 0, renderWaitMs: 25 });
  assert.equal(delayedRefundEntryLoads, 2,
    'a missing refund entry must trigger exactly one workbench refresh');
  assert.equal(await page.evaluate(() => window.refundEntryClicks), 1,
    'the full-width counted refund entry must be clicked after the refresh');
  await page.unroute(delayedRefundEntryUrl);

  let permanentlyMissingEntryLoads = 0;
  const permanentlyMissingEntryUrl = 'https://mms.pinduoduo.com/aftersales/aftersale_list?entry-missing-test=1';
  await page.route(permanentlyMissingEntryUrl, async (route) => {
    permanentlyMissingEntryLoads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<body><button>待商家处理</button><div>暂无退货退款入口</div></body>',
    });
  });
  await page.goto(permanentlyMissingEntryUrl);
  await assert.rejects(
    () => openReturnRefundWorkbench(page, { delayMs: 0, renderWaitMs: 25 }),
    /PDD页面未找到“退货退款”入口/u,
  );
  assert.equal(permanentlyMissingEntryLoads, 2,
    'an unresolved refund entry must stop after one refresh instead of looping');
  await page.unroute(permanentlyMissingEntryUrl);
  await page.goto('about:blank');

  let resetAfterRefreshLoads = 0;
  const resetAfterRefreshUrl = 'https://mms.pinduoduo.com/aftersales/aftersale_list?refresh-resets-filter-test=1';
  await page.route(resetAfterRefreshUrl, async (route) => {
    resetAfterRefreshLoads += 1;
    const merchantFilterCanRestoreType = resetAfterRefreshLoads > 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<body>
        <button onclick="window.pendingClicks += 1; if (${merchantFilterCanRestoreType}) document.querySelector('#type-entry').hidden = false">待商家处理 99+</button>
        <button onclick="window.directPendingClicks += 1">退货待处理 87</button>
        <button id="type-entry" hidden onclick="window.refundEntryClicks += 1">退货退款(87)</button>
        <script>
          window.pendingClicks = 0;
          window.directPendingClicks = 0;
          window.refundEntryClicks = 0;
        </script>
      </body>`,
    });
  });
  await page.goto(resetAfterRefreshUrl);
  await openReturnRefundWorkbench(page, { delayMs: 0, renderWaitMs: 25 });
  assert.equal(resetAfterRefreshLoads, 2,
    'a slow refund subtype must trigger exactly one workbench refresh');
  assert.equal(await page.evaluate(() => window.pendingClicks), 1,
    'the merchant-pending filter must be selected again after the refresh resets it');
  assert.equal(await page.evaluate(() => window.refundEntryClicks), 1,
    'the restored refund type entry must be selected');
  assert.equal(await page.evaluate(() => window.directPendingClicks), 0,
    'the direct pending shortcut is only a fallback');
  await page.unroute(resetAfterRefreshUrl);
  await page.goto('about:blank');

  let directPendingLoads = 0;
  const directPendingUrl = 'https://mms.pinduoduo.com/aftersales/aftersale_list?direct-pending-entry-test=1';
  await page.route(directPendingUrl, async (route) => {
    directPendingLoads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<body>
        <button>待商家处理 99+</button>
        <button onclick="window.directPendingClicks += 1">退货待处理 87</button>
        <script>window.directPendingClicks = 0;</script>
      </body>`,
    });
  });
  await page.goto(directPendingUrl);
  await openReturnRefundWorkbench(page, { delayMs: 0, renderWaitMs: 25 });
  assert.equal(directPendingLoads, 2,
    'a missing refund subtype must still perform the configured single refresh');
  assert.equal(await page.evaluate(() => window.directPendingClicks), 1,
    'the live direct return-pending shortcut must recover a missing refund subtype');
  await page.unroute(directPendingUrl);
  await page.goto('about:blank');

  await page.setContent(`
    <button onclick="window.steps.push('workbench')">售后工作台</button>
    <button onclick="window.steps.push('pending')">待商家处理</button>
    <button onclick="window.steps.push('refund')">退货退款</button>
    <div data-testid="beast-core-modal" role="dialog">
      <button data-testid="beast-core-modal-close-button"
        onclick="window.captchaCloseClicks += 1; this.parentElement.remove()">关闭</button>
      <div>请完成安全验证</div>
      <div role="slider">向右拖动滑块完成拼图</div>
    </div>
    <script>window.steps = []; window.captchaCloseClicks = 0;</script>
  `);
  let verificationObserved = 0;
  await openReturnRefundWorkbench(page, {
    delayMs: 0,
    onVerification: async () => {
      const captcha = page.locator('[data-testid="beast-core-modal"]');
      if (!await captcha.isVisible().catch(() => false)) return false;
      verificationObserved += 1;
      await captcha.evaluate((element) => element.remove());
      return true;
    },
  });
  assert.equal(verificationObserved, 1,
    'a captcha modal must be preserved for the verification handler');
  assert.equal(await page.evaluate(() => window.captchaCloseClicks), 0,
    'promotion cleanup must never click the captcha close button');
  assert.deepEqual(await page.evaluate(() => window.steps), ['workbench', 'pending', 'refund']);

  let detailRenderRequests = 0;
  await page.context().route('https://mms.pinduoduo.com/aftersales-ssr/render-test**', async (route) => {
    detailRenderRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: detailRenderRequests === 1
        ? '<body><div>loading detail shell</div></body>'
        : `<body>${body}</body>`,
    });
  });
  await page.goto('https://mms.pinduoduo.com/aftersales-ssr/render-test?id=22029849804345');
  const renderedDetailFacts = await readReturnRefundDetail(page, {
    delayMs: 0,
    renderWaitMs: 500,
  });
  assert.equal(detailRenderRequests, 2,
    'an incomplete detail shell must be refreshed exactly once after the render wait');
  assert.equal(renderedDetailFacts.aftersaleNumber, facts.aftersaleNumber);
  assert.equal(renderedDetailFacts.orderNumber, facts.orderNumber);

  await page.setContent(`
    <div>退款申请单</div>
    <div>售后类型：</div><div>退货退款</div>
    <div>退款金额：</div><div>¥49.90</div>
    <div>售后状态：</div><div>买家已发货，待商家处理</div>
    <button>同意退款</button>
  `);
  const fallbackIdentityFacts = await readReturnRefundDetail(page, {
    delayMs: 0,
    renderWaitMs: 100,
    fallbackFacts: {
      orderNumber: '260825-123456789012345',
      aftersaleNumber: '22345678901234',
    },
  });
  assert.equal(fallbackIdentityFacts.orderNumber, '260825-123456789012345');
  assert.equal(fallbackIdentityFacts.aftersaleNumber, '22345678901234');
  assert.equal(fallbackIdentityFacts.refundAmount, 49.9,
    'an exact list-row identity must let a rendered detail proceed without waiting for duplicate identity text');

  const incompleteDetailUrl = 'https://mms.pinduoduo.com/aftersales-ssr/incomplete-render-test?id=1';
  await page.context().route(incompleteDetailUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<body><div>退款申请单</div><div>售后类型：退货退款</div></body>',
  }));
  await page.goto(incompleteDetailUrl);
  await assert.rejects(() => readReturnRefundDetail(page, {
    delayMs: 0,
    renderWaitMs: 500,
  }), (error) => error instanceof PddRenderWaitTimeoutError
    && error.diagnostics.totalBudget === true
    && error.renderObservation.reason === 'incomplete-detail-fields'
    && error.renderObservation.missingFields.includes('orderNumber')
    && error.renderObservation.missingFields.includes('refundAmount'));
  await page.context().unroute(incompleteDetailUrl);

  await page.setContent(`
    <div data-testid="beast-core-modal" role="dialog">
      <button data-testid="beast-core-modal-close-button"
        onclick="this.parentElement.remove()">关闭</button>
      <div>售后编号：22029849804345</div>
      <div>售后类型：退货退款</div>
      <div>退款金额：79.47元</div>
      <div>退货物流</div>
    </div>
  `);
  assert.equal(await closeReturnRefundDetailOverlay(page, { delayMs: 0 }), true,
    'a same-page aftersale detail overlay must be closed after scanning');
  assert.equal(await page.locator('[data-testid="beast-core-modal"]').count(), 0);

  const context = await browser.newContext();
  try {
    await context.route('https://mms.pinduoduo.com/**', async (route) => {
      const url = new URL(route.request().url());
      const verification = url.searchParams.get('verification') === '1';
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: verification
          ? '<body>请完成安全验证<div role="slider">向右拖动滑块完成拼图</div></body>'
          : '<body>售后编号：22029849804345 售后类型：退货退款 退款金额：79.47元</body>',
      });
    });
    const anchorPage = await context.newPage();
    await anchorPage.goto('https://mms.pinduoduo.com/aftersales/work_order/list');
    const pagesBefore = new Set(context.pages());
    setTimeout(async () => {
      const delayedPage = await context.newPage();
      await delayedPage.goto('https://mms.pinduoduo.com/aftersales-ssr/detail?id=delayed');
    }, 50);
    const delayedDetail = await waitForReturnRefundDetailTarget(
      anchorPage,
      context,
      pagesBefore,
      { timeoutMs: 2_000 },
    );
    assert.equal(isReturnRefundDetailUrl(delayedDetail?.url()), true,
      'a delayed detail popup must still be captured');

    const staleDetail = await context.newPage();
    await staleDetail.goto('https://mms.pinduoduo.com/aftersales-ssr/detail?id=stale');
    const verificationDetail = await context.newPage();
    await verificationDetail.goto(
      'https://mms.pinduoduo.com/aftersales-ssr/detail?id=verification&verification=1',
    );
    const cleanup = await closeStaleReturnRefundDetailPages(context, {
      anchorPage,
      preserveVerification: true,
    });
    assert.equal(cleanup.closed >= 2, true, 'all stale non-verification detail tabs must close');
    assert.equal(staleDetail.isClosed(), true);
    assert.equal(delayedDetail.isClosed(), true);
    assert.equal(verificationDetail.isClosed(), false, 'only the active verification detail may remain');
    const finalCleanup = await closeStaleReturnRefundDetailPages(context, { anchorPage });
    assert.equal(finalCleanup.closed, 1);
    assert.equal(verificationDetail.isClosed(), true);
  } finally {
    await context.close();
  }
  await page.close();
} finally {
  await browser.close();
}

console.log('return-refund self-test passed');
