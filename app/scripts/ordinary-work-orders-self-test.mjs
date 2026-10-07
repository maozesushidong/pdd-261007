import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  ORDINARY_SCENARIO_CODES,
  ORDINARY_SCENARIO_DEPENDENCIES,
  detectPickedUpLogistics,
  detectSignedLogistics,
  detectConsumerRefusalInterception,
  detectDeliveredNotReceivedRefundCase,
  evaluateConsumerRefusal,
  evaluateDeliveryRiskConcern,
  evaluateDeliveredNotReceived,
  evaluateGoodDeedExpeditedShipping,
  evaluateInterceptRecall,
  evaluateOrdinaryWorkOrderScenario,
  evaluateProductShortage,
  evaluateProactiveLogisticsService,
  evaluateReverseLogisticsSignedRefund,
  expandOrdinaryPddOptionAliases,
  ordinaryPddOptionsSemanticallyEquivalent,
  resolveOrdinaryPddJudgmentOption,
  resolveOrdinaryPddSemanticOption,
  classifyOrdinaryPddMessageStage,
  extractDeliveredNotReceivedLogistics,
  extractDeliveryRiskServiceProgress,
  extractOrdinaryListCreatedAt,
  extractOrdinaryWorkOrderTiming,
  isValidPlatformPrefilledPhone,
  matchReverseSignedRefundChangsha,
  classifyProductShortageTmsResult,
  parseOrdinaryBeijingDateTime,
  parseRemainingDurationMs,
  resolveWarehouseContactChannel,
} from '../packages/adapters/src/pdd/ordinary-work-orders.mjs';
import {
  DEFAULT_PDD_RENDER_WAIT_MS,
  PddRenderWaitTimeoutError,
  hasExactPddOrderQueryEmptyResult,
  needsFreshPddDetailLookup,
  waitForPddRenderedResult,
} from '../packages/adapters/src/pdd/render-wait.mjs';

assert.equal(DEFAULT_PDD_RENDER_WAIT_MS, 30_000);
assert.equal(needsFreshPddDetailLookup({
  error: '拼多多普通工单详情订单号渲染刷新后等待 30000 毫秒仍未出现有效结果',
}), true);
assert.equal(needsFreshPddDetailLookup({
  step: 'ordinary-detail-fresh-query-retry-ready',
  error: null,
  transientWorkflowRecovery: {
    lastReason: '拼多多普通工单详情订单号渲染刷新后等待 30000 毫秒仍未出现有效结果',
  },
}), true);
assert.equal(needsFreshPddDetailLookup({
  error: '拼多多凭证上传授权失败（48143）：非法请求',
}), false);
assert.deepEqual(
  expandOrdinaryPddOptionAliases(['未收到退货商品']),
  ['未收到退货商品', '未收到退回的商品', '未收到退回商品', '未收到退货', '未查到退货商品'],
);
assert.deepEqual(
  expandOrdinaryPddOptionAliases(['有查到物流轨迹']),
  ['有退货物流轨迹', '有查到物流轨迹', '查到退货物流轨迹', '已查到退货物流轨迹'],
);
assert.deepEqual(
  expandOrdinaryPddOptionAliases(['同意消费者退款申请']),
  ['同意退款', '同意消费者退款申请', '已同意退货退款'],
);
assert.deepEqual(expandOrdinaryPddOptionAliases(['平台新增选项']), ['平台新增选项']);
assert.equal(
  resolveOrdinaryPddSemanticOption(
    ['已进行召回'],
    ['快递仍在召回处理中', '快递包裹已成功拦截并退回'],
  )?.label,
  '快递包裹已成功拦截并退回',
);
assert.equal(
  resolveOrdinaryPddSemanticOption(
    ['发送拦截'],
    ['通知承运商拦截包裹', '拦截成功后同意退款'],
  )?.label,
  '通知承运商拦截包裹',
);
assert.deepEqual(
  resolveOrdinaryPddSemanticOption(
    ['拦截成功同意退款', '发送拦截'],
    ['通知承运商拦截包裹', '继续等待物流'],
  ),
  {
    label: '通知承运商拦截包裹',
    requestedLabel: '发送拦截',
    intent: 'send-intercept',
    confidence: 'high',
    reason: 'unique-visible-semantic-intent-match',
    equivalentMatches: ['通知承运商拦截包裹'],
  },
  'a staged form must fall through from an absent terminal intent to the visible primary intent',
);
assert.equal(
  resolveOrdinaryPddSemanticOption(
    ['同意退款'],
    ['暂不退款', '直接同意买家退款'],
  )?.label,
  '直接同意买家退款',
);
assert.equal(
  resolveOrdinaryPddSemanticOption(
    ['快递还在拦截中'],
    ['承运商反馈召回失败', '召回任务仍在处理中'],
  )?.label,
  '召回任务仍在处理中',
  'renamed in-progress outcomes must not be confused with a failed recall',
);
assert.equal(
  resolveOrdinaryPddSemanticOption(
    ['消费者超12小时未回复'],
    ['买家接受召回完成后退款', '买家已超过12小时没有回应'],
  )?.label,
  '买家已超过12小时没有回应',
  'renamed consumer-response timeout wording must remain machine-selectable',
);
assert.equal(
  resolveOrdinaryPddSemanticOption(
    ['物流可以更新，能送达'],
    ['物流无法更新', '轨迹已恢复正常并能够派送'],
  )?.label,
  '轨迹已恢复正常并能够派送',
);
assert.equal(
  resolveOrdinaryPddSemanticOption(
    ['已进行召回'],
    ['快递召回失败', '仍在召回处理中'],
  ),
  null,
  'opposite or unfinished options must not be treated as a completed recall',
);
assert.equal(
  ordinaryPddOptionsSemanticallyEquivalent(
    ['已进行召回'],
    '快递包裹已成功拦截并退回',
  ),
  true,
);
assert.equal(
  ordinaryPddOptionsSemanticallyEquivalent(['发送拦截'], '拦截成功后同意退款'),
  false,
);
assert.deepEqual(
  resolveOrdinaryPddJudgmentOption(
    ['同意退款'],
    ['暂不处理退款', '平台支持原路退还款项给买家'],
  ),
  {
    label: '平台支持原路退还款项给买家',
    requestedLabel: '同意退款',
    intent: 'agree-refund',
    confidence: 'medium',
    reason: 'deterministic-business-intent-judgment',
    score: 16,
    matchedFeatures: ['refund', 'agree'],
    representsRequestedIntent: true,
    rejectedOptions: [{ label: '暂不处理退款', conflict: 'rejection' }],
  },
  'unknown refund wording must prefer a non-contradictory refund action',
);
assert.equal(
  resolveOrdinaryPddJudgmentOption(
    ['已进行召回'],
    ['召回失败', '继续等待召回', '承运商反馈包裹原路返仓'],
  )?.label,
  '承运商反馈包裹原路返仓',
  'unknown recall wording must reject failed and waiting choices',
);
assert.deepEqual(
  resolveOrdinaryPddJudgmentOption(
    ['平台新增选项'],
    ['平台新处理方案甲', '转人工处理'],
  ),
  {
    label: '平台新处理方案甲',
    requestedLabel: '平台新增选项',
    intent: 'unknown',
    confidence: 'low',
    reason: 'first-visible-non-contradictory-judgment',
    score: 0,
    matchedFeatures: [],
    representsRequestedIntent: false,
    rejectedOptions: [{ label: '转人工处理', conflict: 'manual' }],
  },
  'a rule-free form may choose only the first non-contradictory option and must stay low confidence',
);
assert.equal(
  resolveOrdinaryPddJudgmentOption(
    ['同意退款'],
    ['拒绝退款', '暂不退款'],
  ),
  null,
  'all contradictory choices must still stop instead of inventing a safe option',
);
assert.equal(
  ordinaryPddOptionsSemanticallyEquivalent(['同意退款'], '平台支持原路退还款项给买家'),
  false,
  'judgment fallback must not weaken strict postcondition equivalence',
);
assert.equal(classifyOrdinaryPddMessageStage({
  buttonText: '提交',
  message: '亲亲，您的订单物流正常运输中，请耐心等待。',
  scopeText: '消费者咨询物流情况/催物流\n提交后，此话术将自动发送给消费者',
  hasDecisionControls: false,
}), 'prefilled-reply-submit');
assert.equal(classifyOrdinaryPddMessageStage({
  buttonText: '提交',
  message: '亲，请确认您的退货快递单号及快递公司。',
  scopeText: '请主动联系消费者确认退货快递单号及快递公司\n提交后，此话术将自动发送给消费者',
  hasDecisionControls: false,
}), 'prefilled-reply-submit');
assert.equal(classifyOrdinaryPddMessageStage({
  buttonText: '提交',
  message: '亲亲，您的订单物流正常运输中，请耐心等待。',
  scopeText: '提交后，此话术将自动发送给消费者',
  hasDecisionControls: false,
}), null, 'generic submit forms must not be classified without the logistics-work-order context');
assert.equal(classifyOrdinaryPddMessageStage({
  buttonText: '提交',
  message: '亲亲，您的订单物流正常运输中，请耐心等待。',
  scopeText: '消费者咨询物流情况/催物流\n提交后，此话术将自动发送给消费者',
  hasDecisionControls: true,
}), null, 'forms with decision controls must continue through controlled option selection');
assert.equal(classifyOrdinaryPddMessageStage({
  buttonText: '发送话术',
  message: '已为您核实。',
  scopeText: '',
}), 'send-script');
assert.equal(hasExactPddOrderQueryEmptyResult('\u5171\u67e5\u8be2\u5230 0 \u4e2a\u5de5\u5355\n\u6682\u65e0\u5de5\u5355'), true);
assert.equal(hasExactPddOrderQueryEmptyResult('\u5171\u67e5\u8be2\u5230 0 \u4e2a\u5de5\u5355'), false);
assert.equal(hasExactPddOrderQueryEmptyResult('\u5171\u67e5\u8be2\u5230 1 \u4e2a\u5de5\u5355\n\u6682\u65e0\u5de5\u5355'), false);

const createRenderWaitPage = () => {
  let reloadCount = 0;
  return {
    get reloadCount() { return reloadCount; },
    reload: async () => { reloadCount += 1; },
    waitForTimeout: (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  };
};

{
  const page = createRenderWaitPage();
  let inspections = 0;
  const result = await waitForPddRenderedResult(page, {
    // Keep enough wall-clock headroom for a loaded production host. The
    // assertion is about returning before refresh, not sub-50ms scheduling.
    timeoutMs: 500,
    pollIntervalMs: 1,
    inspect: async () => (++inspections >= 3 ? { kind: 'ready' } : null),
  });
  assert.equal(result.kind, 'ready');
  assert.equal(result.refreshed, false);
  assert.equal(page.reloadCount, 0);
}

{
  const page = createRenderWaitPage();
  const result = await waitForPddRenderedResult(page, {
    timeoutMs: 5,
    pollIntervalMs: 1,
    inspect: async (_page, { phase }) => (phase === 'refreshed' ? { kind: 'ready' } : null),
  });
  assert.equal(result.refreshed, true);
  assert.equal(page.reloadCount, 1);
}

{
  const page = createRenderWaitPage();
  const phases = [];
  const result = await waitForPddRenderedResult(page, {
    timeoutMs: 5,
    pollIntervalMs: 1,
    inspect: async (_page, { phase }) => {
      phases.push(phase);
      return { kind: 'empty', pending: false };
    },
    refreshOnInitialResult: (initial) => initial.pending === false,
  });
  assert.equal(result.kind, 'empty');
  assert.equal(result.refreshed, true);
  assert.deepEqual(phases, ['initial', 'refreshed']);
  assert.equal(page.reloadCount, 1);
}

{
  const page = createRenderWaitPage();
  await assert.rejects(
    waitForPddRenderedResult(page, {
      timeoutMs: 5,
      pollIntervalMs: 1,
      inspect: async () => null,
    }),
    (error) => error instanceof PddRenderWaitTimeoutError
      && error.code === 'PDD_RENDER_WAIT_TIMEOUT'
      && error.retryable === true,
  );
  assert.equal(page.reloadCount, 1);
}

{
  const page = createRenderWaitPage();
  const startedAt = Date.now();
  await assert.rejects(
    waitForPddRenderedResult(page, {
      timeoutMs: 500,
      totalTimeoutMs: 200,
      initialWaitMs: 120,
      pollIntervalMs: 1,
      inspect: async () => null,
    }),
    (error) => error instanceof PddRenderWaitTimeoutError
      && error.timeoutMs === 200
      && error.diagnostics.totalBudget === true
      && error.diagnostics.initialWaitMs === 120,
  );
  assert.equal(page.reloadCount, 1);
  assert.ok(Date.now() - startedAt < 350,
    'a 200ms total render budget must not become two independent 200ms waits');
}

const HOUR_MS = 60 * 60_000;
const now = '2026-08-15T04:00:00.000Z';
const nowMs = Date.parse(now);
const hoursBefore = (hours) => new Date(nowMs - hours * HOUR_MS).toISOString();

assert.equal(parseOrdinaryBeijingDateTime('2026-08-15 12:34:56'), '2026-08-15T04:34:56.000Z');
assert.equal(parseOrdinaryBeijingDateTime('2026年8月15日 12:34'), '2026-08-15T04:34:00.000Z');
assert.equal(parseOrdinaryBeijingDateTime('2026-08-15T12:34:56+08:00'), '2026-08-15T04:34:56.000Z');
assert.equal(parseOrdinaryBeijingDateTime('2026-02-30 12:00:00'), null);
assert.equal(parseRemainingDurationMs('剩余处理时长：1天 02:03:04'), 26 * HOUR_MS + 3 * 60_000 + 4_000);
assert.equal(parseRemainingDurationMs('02:00:00'), 2 * HOUR_MS);
assert.equal(parseRemainingDurationMs('1小时30分钟'), 1.5 * HOUR_MS);
assert.equal(parseRemainingDurationMs('00:00:00'), 0);
assert.equal(parseRemainingDurationMs('02:60:00'), null);
assert.equal(parseRemainingDurationMs('-1小时'), null);
assert.equal(parseRemainingDurationMs('unknown'), null);
assert.equal(extractOrdinaryListCreatedAt(`
订单号：
260807-628537454211508
创建时间：
2026-08-15 23:35:41
订单问题：消费者申请退款后提示拦截
`), '2026-08-15T15:35:41.000Z');

const realDeliveryRiskProgress = extractDeliveryRiskServiceProgress(`
服务进度
客服已承诺物流未更新则退款或补发
选择核实结果：
物流可以更新，能送达
轨迹更新日期：
2026-08-17 23:59:59
处理人：PANAPOPO医疗器械官方旗舰店居居
2026-08-15 21:17:16
订单信息查看详情
`);
assert.deepEqual(realDeliveryRiskProgress, {
  reminderCompleted: true,
  resultRequired: false,
  finalResultRequired: false,
  logisticsContactedAt: '2026-08-15T13:17:16.000Z',
  logisticsPromiseAt: '2026-08-17T15:59:59.000Z',
  finalResultPromptedAt: null,
});

const reminderResultPrompt = extractDeliveryRiskServiceProgress(`
您已承诺联系快递核实，请回复核实结果
*选择核实结果
物流可以更新，能送达
无法确定物流何时更新
物流有问题，不能送达
已补发
物流已更新
服务进度
系统提示卡片逾期
处理人：测试店铺
2026-08-17 17:07:05
订单信息查看详情
`);
assert.deepEqual(reminderResultPrompt, {
  reminderCompleted: false,
  resultRequired: true,
  finalResultRequired: false,
  logisticsContactedAt: null,
  logisticsPromiseAt: null,
  finalResultPromptedAt: null,
});

const finalResultPrompt = extractDeliveryRiskServiceProgress(`
客服已承诺物流未更新则退款或补发，请您确认最终履约结果剩46时33分48秒
*确认处理结果
物流已恢复更新
已完成退款
已完成补发
已协商一致，消费者愿意等待
服务进度
系统提示卡片逾期
处理人：测试店铺
2026-08-17 21:40:41
订单信息查看详情
`);
assert.deepEqual(finalResultPrompt, {
  reminderCompleted: false,
  resultRequired: false,
  finalResultRequired: true,
  logisticsContactedAt: null,
  logisticsPromiseAt: null,
  finalResultPromptedAt: '2026-08-17T13:40:41.000Z',
});

const extractedTiming = extractOrdinaryWorkOrderTiming({
  bodyText: '工单发起时间：2026-08-15 08:00:00\n剩余时间：01:59:59',
  logisticsTimeline: [{ text: '快件到达转运中心', occurredAt: '2026-08-15 10:00:00' }],
  now,
});
assert.equal(extractedTiming.workOrderCreatedAt, '2026-08-15T00:00:00.000Z');
assert.equal(extractedTiming.latestLogisticsAt, '2026-08-15T02:00:00.000Z');
assert.equal(extractedTiming.remainingDurationMs, 2 * HOUR_MS - 1_000);

assert.deepEqual(ORDINARY_SCENARIO_DEPENDENCIES, {
  'consumer-address-change': { pdd: true, oms: false, tms: false },
  'consumer-address-change-in-transit': { pdd: true, oms: true, tms: true },
  'delivery-risk-concern': { pdd: true, oms: 'conditional', tms: 'conditional' },
  'proactive-logistics-service': { pdd: true, oms: false, tms: false },
  'reverse-logistics-signed-refund': { pdd: true, oms: false, tms: false },
  'intercept-recall': { pdd: true, oms: true, tms: true },
  'good-deed-expedited-shipping': { pdd: true, oms: true, tms: false },
  'delivered-not-received': { pdd: true, oms: true, tms: true },
  'consumer-refusal': { pdd: true, oms: true, tms: true },
  'product-shortage': { pdd: true, oms: true, tms: true },
  'promise-reissue': { pdd: true, oms: true, tms: false },
  'delivered-address-change': { pdd: true, oms: true, tms: true },
});
assert.equal(resolveWarehouseContactChannel({ warehouse: '筑越仓' }).channel, 'tms-public-flow');
assert.equal(resolveWarehouseContactChannel({ warehouse: '捷佑仓', carrier: '韵达' }).channel, 'tms-public-flow');
assert.equal(resolveWarehouseContactChannel({ warehouse: '捷佑仓', carrier: '中通' }).channel, 'tms-public-flow');
assert.equal(resolveWarehouseContactChannel({ warehouse: '简卓仓', carrier: '邮政' }).channel, 'tms-public-flow');
assert.equal(resolveWarehouseContactChannel({}).requiresOmsLookup, true);

const deliveryFacts = ({ latestHoursAgo, ...extra } = {}) => ({
  warehouse: '筑越仓',
  carrier: '中通',
  workOrderCreatedAt: hoursBefore(12),
  logisticsTimeline: latestHoursAgo === undefined ? [] : [{
    text: '快件到达转运中心',
    occurredAt: hoursBefore(latestHoursAgo),
  }],
  ...extra,
});

let result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 24,
  workOrderCreatedAt: hoursBefore(10),
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-reminder');
assert.equal(result.reasonCode, 'recent-logistics-before-work-order-requires-reminder');
assert.equal(result.pdd.option, '需联系物流核实');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 24,
  workOrderCreatedAt: hoursBefore(25),
}), { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '物流已更新');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 2,
  workOrderCreatedAt: hoursBefore(2),
}), { now });
assert.equal(result.actionCode, 'tms-reminder', 'equal node and complaint times are not a later update');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 2,
  workOrderCreatedAt: hoursBefore(1),
  warehouse: null,
}), { now });
assert.equal(result.actionCode, 'oms-warehouse-query');
assert.equal(result.reasonCode, 'recent-logistics-before-work-order-requires-warehouse');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 2,
  workOrderCreatedAt: null,
  workOrderFirstDiscoveredAt: hoursBefore(1),
}), { now });
assert.equal(result.actionCode, 'pdd-complete', 'a first-observed lower bound must not masquerade as platform creation time');

for (const sample of [
  { now: '2026-09-30T03:02:28.426Z', created: '2026-09-30T03:01:19.000Z', latest: '2026-09-29T06:07:36.000Z' },
  { now: '2026-09-30T03:14:00.652Z', created: '2026-09-30T03:05:03.000Z', latest: '2026-09-30T00:47:59.000Z' },
  { now: '2026-09-30T03:46:51.762Z', created: '2026-09-30T03:37:43.000Z', latest: '2026-09-29T13:55:36.000Z' },
]) {
  const decision = evaluateDeliveryRiskConcern(deliveryFacts({
    workOrderCreatedAt: sample.created,
    logisticsTimeline: [{ text: '快件到达转运中心', occurredAt: sample.latest }],
  }), { now: sample.now });
  assert.equal(decision.actionCode, 'tms-reminder', 'real rejected timing must enter the established reminder path before submission');
  assert.equal(decision.reasonCode, 'recent-logistics-before-work-order-requires-reminder');
}

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 14,
  warehouse: null,
  platformLogisticsUpdateRejection: {
    errorCode: 190001,
    errorMessage: '物流轨迹未更新，请如实填写',
    option: '物流已更新',
    latestLogisticsAt: hoursBefore(14),
    rejectedAt: hoursBefore(1),
  },
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'oms-warehouse-query');
assert.equal(result.reasonCode, 'platform-rejected-logistics-update-requires-warehouse');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 14,
  warehouse: '代发聚水潭-众邦',
  platformLogisticsUpdateRejection: {
    errorCode: 190001,
    errorMessage: '物流轨迹未更新，请如实填写',
    option: '物流已更新',
    latestLogisticsAt: hoursBefore(14),
    rejectedAt: hoursBefore(1),
  },
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-reminder');
assert.equal(result.reasonCode, 'platform-rejected-logistics-update-requires-reminder');
assert.equal(result.pdd.option, '需联系物流核实');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 14,
  warehouse: '代发聚水潭-众邦',
  platformLogisticsUpdateRejection: {
    errorCode: 190001,
    errorMessage: '物流轨迹未更新，请如实填写',
    option: '物流已更新',
    latestLogisticsAt: null,
    rejectedAt: hoursBefore(1),
  },
}), { now });
assert.equal(result.actionCode, 'tms-reminder');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 1,
  warehouse: '代发聚水潭-众邦',
  platformLogisticsUpdateRejection: {
    errorCode: 190001,
    errorMessage: '物流轨迹未更新，请如实填写',
    option: '物流已更新',
    latestLogisticsAt: hoursBefore(14),
    rejectedAt: hoursBefore(1),
  },
}), { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '物流已更新');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 30,
  workOrderCreatedAt: hoursBefore(40),
}), { now });
assert.equal(result.reasonCode, 'logistics-updated-after-work-order-created');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 2,
  deliveryRiskReminderResultRequired: true,
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-reminder');
assert.equal(result.reasonCode, 'platform-reminder-result-requires-tms-confirmation');
assert.equal(result.pdd.resultOption, '物流可以更新，能送达');
assert.equal(result.evidence.required[0].source, 'tms-reminder-evidence');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 1,
  deliveryRiskFinalResultRequired: true,
  deliveryRiskFinalResultPromptedAt: hoursBefore(2),
  remainingDurationMs: 46 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'delivery-risk-final-logistics-update-confirmed');
assert.equal(result.pdd.option, '物流已恢复更新');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  deliveryRiskFinalResultRequired: true,
  deliveryRiskFinalResultPromptedAt: hoursBefore(2),
  remainingDurationMs: 46 * HOUR_MS,
  logisticsTimeline: [{
    text: '【厦门市】您的包裹因收件地址不详，暂时无法为您配送，请及时联系客服',
    occurredAt: hoursBefore(1),
  }],
}), { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'delivery-risk-consumer-confirmation-required');
assert.equal(result.pdd, null, 'a blocking new trace must never be reported as logistics recovery');
assert.match(result.evidence.latestLogisticsText, /收件地址不详/u);

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 1,
  deliveryRiskFinalResultRequired: true,
  deliveryRiskFinalResultPromptedAt: hoursBefore(2),
  remainingDurationMs: 46 * HOUR_MS,
  platformLogisticsUpdateRejection: {
    errorCode: 190001,
    errorMessage: '该订单物流状态异常，请先和消费者确认',
    option: '物流已恢复更新',
    latestLogisticsAt: hoursBefore(1),
    rejectedAt: hoursBefore(0.5),
  },
}), { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'delivery-risk-consumer-confirmation-required');
assert.equal(result.pdd, null, 'a consumer-confirmation rejection must not retry any automatic option');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 3,
  deliveryRiskFinalResultRequired: true,
  deliveryRiskFinalResultPromptedAt: hoursBefore(2),
  remainingDurationMs: 46 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'delivery-risk-final-result-awaiting-facts');
assert.equal(result.nextAttemptAt, new Date(nowMs + 30 * 60_000).toISOString());

result = evaluateDeliveryRiskConcern({
  shippingLogisticsTimeline: [{ text: '快件运输中', occurredAt: hoursBefore(2) }],
  deliveryRiskReminderResultRequired: true,
}, { now });
assert.equal(result.actionCode, 'oms-warehouse-query');
assert.equal(result.reasonCode, 'platform-reminder-result-requires-warehouse');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 48,
  workOrderCreatedAt: hoursBefore(12),
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-reminder');
assert.equal(result.pdd.option, '需联系物流核实');
assert.equal(result.pdd.resultOption, '物流可以更新，能送达');
assert.equal(result.pdd.resultRequiredAfterPrimary, true);
assert.equal(result.pdd.trajectoryUpdateDateOffsetDays, 2);
assert.deepEqual(result.pdd.unupdatedPromiseMatchAll, ['补发', '退款']);
assert.equal(result.evidence.required[0].source, 'tms-reminder-evidence');
assert.deepEqual(result.evidence.required[0].mustInclude, [
  'order-number', 'tracking-number', 'reminder-request',
]);

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 48.0001,
  workOrderCreatedAt: hoursBefore(12),
}), { now });
assert.equal(result.actionCode, 'tms-lost-and-oms-reissue');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: undefined,
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'no-shipping-logistics-within-24-hours-of-work-order');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: undefined,
  logisticsLookupCompleted: true,
}), { now });
assert.equal(result.outcome, 'wait');

result = evaluateDeliveryRiskConcern({
  warehouse: '筑越仓',
  logisticsTimeline: [],
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'work-order-created-time-missing-without-logistics');

result = evaluateDeliveryRiskConcern({
  warehouse: '筑越仓',
  workOrderCreatedAt: hoursBefore(10),
  logisticsTimeline: [{ text: '快件到达转运中心' }],
}, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-reminder');
assert.equal(result.reasonCode, 'shipping-logistics-time-missing-conservative-reminder');
assert.equal(result.evidence.timeSelectionStrategy, 'missing-node-time-conservative-reminder');

result = evaluateDeliveryRiskConcern({
  warehouse: '筑越仓',
  workOrderCreatedAt: hoursBefore(1),
  logisticsTimeline: [{ text: '快件到达转运中心', occurredAt: hoursBefore(-1) }],
}, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-reminder');
assert.equal(result.reasonCode, 'future-shipping-time-conservative-reminder');

result = evaluateDeliveryRiskConcern({
  warehouse: '筑越仓',
  workOrderCreatedAt: hoursBefore(-1),
  workOrderFirstDiscoveredAt: hoursBefore(2),
  logisticsTimeline: [],
}, { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.evidence.workOrderAgeSource, 'first-observed-lower-bound');

result = evaluateDeliveryRiskConcern({
  warehouse: '筑越仓',
  workOrderCreatedAt: hoursBefore(-1),
  logisticsTimeline: [],
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'work-order-created-time-in-future');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: undefined,
  workOrderCreatedAt: hoursBefore(24),
}), { now });
assert.equal(result.outcome, 'wait');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: undefined,
  workOrderCreatedAt: hoursBefore(24.0001),
}), { now });
assert.equal(result.actionCode, 'tms-reminder');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: undefined,
  workOrderCreatedAt: hoursBefore(48),
}), { now });
assert.equal(result.actionCode, 'tms-reminder');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: undefined,
  workOrderCreatedAt: hoursBefore(48.0001),
}), { now });
assert.equal(result.actionCode, 'tms-lost-and-oms-reissue');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: undefined,
  workOrderCreatedAt: hoursBefore(72),
  logisticsContactedAt: hoursBefore(47),
  remainingDurationMs: 30 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.nextAttemptAt, hoursBefore(-1));

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 34,
  workOrderCreatedAt: undefined,
  logisticsContactedAt: '2026-08-15T13:17:16.000Z',
  logisticsPromiseAt: '2026-08-17T15:59:59.000Z',
  remainingDurationMs: 45 * HOUR_MS,
}), { now: '2026-08-15T16:06:42.000Z' });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'first-logistics-reminder-follow-up-pending');
assert.equal(result.nextAttemptAt, '2026-08-17T15:59:59.000Z');

result = evaluateDeliveryRiskConcern({
  workOrderCreatedAt: hoursBefore(72),
  logisticsContactedAt: hoursBefore(48),
  logisticsTimeline: [],
  remainingDurationMs: 24 * HOUR_MS,
}, { now });
assert.equal(result.actionCode, 'pdd-reminder-extension');
assert.deepEqual(result.requiredSystems, ['PDD']);
assert.equal(result.external.createTms, false);

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  logisticsContactedAt: hoursBefore(47),
  remainingDurationMs: 30 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.nextAttemptAt, hoursBefore(-1));

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  logisticsContactedAt: hoursBefore(48),
  remainingDurationMs: 24 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.actionCode, 'pdd-reminder-extension');
assert.equal(result.reasonCode, 'second-logistics-reminder-required');
assert.equal(result.pdd.option, '需联系物流核实');
assert.equal(result.pdd.resultOption, '物流可以更新，能送达');
assert.match(result.pdd.unupdatedPromiseOption, /补发.*退款/u);
assert.equal(result.evidence.required[0].source, 'tms-reminder-evidence');
assert.deepEqual(result.requiredSystems, ['PDD']);
assert.equal(result.external.createTms, false);

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(60),
  logisticsContactedAt: hoursBefore(48),
}), { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.actionCode, 'pdd-reminder-extension');
assert.equal(result.reasonCode, 'second-logistics-reminder-with-unreadable-deadline');
assert.equal(result.evidence.deadlineSelectionStrategy, 'unreadable-deadline-repeat-reminder');

result = evaluateDeliveryRiskConcern({
  workOrderCreatedAt: hoursBefore(12),
  logisticsTimeline: [{ text: '快件到达转运中心', occurredAt: hoursBefore(48) }],
}, { now });
assert.equal(result.actionCode, 'oms-warehouse-query');
assert.deepEqual(result.requiredSystems, ['OMS']);
assert.equal(result.external.action, 'query-shipping-warehouse');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  logisticsContactedAt: hoursBefore(48),
  remainingDurationMs: 24 * HOUR_MS - 1,
}), { now });
assert.equal(result.actionCode, 'tms-lost-and-oms-reissue');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 1,
  workOrderCreatedAt: hoursBefore(60),
  logisticsContactedAt: hoursBefore(48),
  remainingDurationMs: 20 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '物流已正常更新');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 2,
  workOrderCreatedAt: hoursBefore(60),
  logisticsContactedAt: hoursBefore(1),
  remainingDurationMs: 30 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'first-logistics-reminder-follow-up-pending');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(60),
  logisticsContactedAt: hoursBefore(48),
  remainingDurationMs: 24 * HOUR_MS,
}), { now });
assert.equal(result.actionCode, 'pdd-reminder-extension');
assert.equal(result.pdd.option, '需联系物流核实');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueOrderCreated: true,
  workOrderFirstDiscoveredAt: hoursBefore(1),
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'reissue-created-time-missing-lower-bound-wait');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueOrderCreated: true,
  workOrderFirstDiscoveredAt: hoursBefore(4),
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.reasonCode, 'reissue-created-time-missing-query-now');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueOrderCreated: true,
  reissueCreatedAt: hoursBefore(2.999),
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'reissue-tracking-within-three-hour-wait');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueOrderCreated: true,
  reissueCreatedAt: hoursBefore(3),
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'oms-reissue-tracking-check');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueOrderCreated: true,
  reissueCreatedAt: hoursBefore(3),
  reissueTrackingLookupCompleted: true,
  reissueTrackingCheckedAt: now,
}), { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'reissue-tracking-recheck-waiting');
assert.equal(result.nextAttemptAt, new Date(nowMs + 30 * 60_000).toISOString());

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueOrderCreated: true,
  reissueCreatedAt: hoursBefore(4),
  reissueTrackingLookupCompleted: true,
  reissueTrackingCheckedAt: hoursBefore(1),
}), { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'oms-reissue-tracking-check');
assert.equal(result.reasonCode, 'reissue-tracking-recheck-due');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueOrderCreated: true,
  reissueCreatedAt: hoursBefore(4),
  reissueTrackingLookupCompleted: true,
  reissueTrackingCheckedAt: now,
  remainingDurationMs: 2 * HOUR_MS,
}), { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'reissue-tracking-missing-near-deadline');

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 50,
  workOrderCreatedAt: hoursBefore(12),
  reissueTrackingNumber: 'YT123456789',
}), { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.completionOption, '已补发');
assert.equal(result.pdd.customerMessageOptional, true);
assert.match(result.pdd.customerMessage, /YT123456789/u);

for (const publicTmsWarehouse of [
  { warehouse: '捷佑仓', carrier: '韵达' },
  { warehouse: '洁文代发仓', carrier: '圆通' },
]) {
  result = evaluateDeliveryRiskConcern(deliveryFacts({
    latestHoursAgo: 30,
    workOrderCreatedAt: hoursBefore(12),
    warehouse: publicTmsWarehouse.warehouse,
    carrier: publicTmsWarehouse.carrier,
  }), { now });
  assert.equal(result.outcome, 'external-action');
  assert.equal(result.actionCode, 'tms-reminder');
  assert.equal(result.external.channel.channel, 'tms-public-flow');
}

result = evaluateDeliveryRiskConcern(deliveryFacts({
  latestHoursAgo: 10,
  requiresUnableToDeliverNegotiation: true,
}), { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'delivery-exception-refund-negotiation-required');

result = evaluateProactiveLogisticsService({
  returnLogisticsTimeline: [{ text: '快件到达长沙转运中心', occurredAt: hoursBefore(120) }],
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.resultOption, '有退货物流轨迹');
assert.equal(result.pdd.resultRequiredAfterPrimary, true);

result = evaluateProactiveLogisticsService({
  workOrderCreatedAt: hoursBefore(48),
  returnLogisticsTimeline: [],
}, { now });
assert.equal(result.pdd.resultOption, '未查到退货物流轨迹');
assert.equal(result.reasonCode, 'return-logistics-not-found-within-48-hours');
assert.equal(result.pdd.resultRequiredAfterPrimary, true);
assert.equal(result.pdd.reasonOption, undefined);
assert.equal(result.pdd.customerMessage, undefined);
assert.equal(result.evidence.required[0].source, 'pdd-return-logistics-screenshot');
assert.equal(result.evidence.required[0].required, false);

result = evaluateProactiveLogisticsService({
  workOrderCreatedAt: hoursBefore(48),
  returnLogisticsTimeline: [],
  pddEvidenceUploadFailed: true,
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.resultOption, '未查到退货物流轨迹');

result = evaluateProactiveLogisticsService({
  returnLogisticsTimeline: [{ text: '快件离开转运中心', occurredAt: hoursBefore(60) }],
  returnLogisticsAbnormal: true,
}, { now });
assert.equal(result.pdd.resultOption, '有退货物流轨迹');

result = evaluateProactiveLogisticsService({
  returnLogisticsTimeline: [{ text: '快件离开转运中心', occurredAt: hoursBefore(60) }],
  pddEvidenceUploadFailed: true,
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.resultOption, '有退货物流轨迹');

result = evaluateProactiveLogisticsService({
  workOrderCreatedAt: hoursBefore(1),
  returnLogisticsTimeline: [{
    text: '消费者已填写物流单号，待快递公司返回物流信息',
    occurredAt: hoursBefore(1),
  }],
}, { now });
assert.equal(result.reasonCode, 'return-logistics-not-found-within-48-hours');
assert.equal(result.pdd.resultOption, '未查到退货物流轨迹');

result = evaluateProactiveLogisticsService({
  workOrderCreatedAt: hoursBefore(48.0001),
  returnLogisticsTimeline: [],
}, { now });
assert.equal(result.pdd.reasonOption, undefined);
assert.equal(result.pdd.customerMessage, undefined);

result = evaluateProactiveLogisticsService({ returnLogisticsTimeline: [] }, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'return-logistics-not-found-with-unreadable-time');
assert.equal(result.evidence.workOrderAgeSource, 'unreadable-time-not-required-for-current-option');

result = evaluateProactiveLogisticsService({
  workOrderFirstDiscoveredAt: hoursBefore(12),
  returnLogisticsTimeline: [],
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'return-logistics-not-found-within-48-hours');
assert.equal(result.evidence.workOrderAgeSource, 'first-observed-lower-bound');

result = evaluateProactiveLogisticsService({
  workOrderFirstDiscoveredAt: hoursBefore(48.0001),
  returnLogisticsTimeline: [],
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'return-logistics-not-found-over-48-hours');
assert.equal(result.evidence.workOrderAgeSource, 'first-observed-lower-bound');

result = evaluateProactiveLogisticsService({
  workOrderFirstDiscoveredAt: hoursBefore(-1),
  returnLogisticsTimeline: [],
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'return-logistics-not-found-with-unreadable-time');

result = evaluateProactiveLogisticsService({
  workOrderCreatedAt: hoursBefore(-1),
  returnLogisticsTimeline: [],
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'return-logistics-not-found-with-unreadable-time');

result = evaluateProactiveLogisticsService({
  pageText: '请主动联系消费者确认退货快递单号及快递公司，并根据真实情况填写沟通结果。',
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.reasonCode, 'consumer-return-waybill-unconfirmed-without-logistics');
assert.equal(result.pdd.stageCode, 'consumer-waybill-confirmation');
assert.equal(result.pdd.option, '无法确认快递单号');
assert.match(result.pdd.customerMessage, /未查到退货物流轨迹/u);
assert.equal(result.evidence.required[0].source, 'pdd-return-logistics-screenshot');
assert.equal(result.evidence.required[0].required, true);

result = evaluateProactiveLogisticsService({
  pageText: '请与消费者确认退货快递单号及快递公司。',
  returnLogisticsTimeline: [{ text: '退货包裹运输中', occurredAt: hoursBefore(1) }],
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.reasonCode, 'consumer-return-waybill-confirmed-from-logistics');
assert.equal(result.pdd.option, '快递单号正确');
assert.match(result.pdd.customerMessage, /退货快递单号与页面物流信息一致/u);
assert.equal(result.evidence.required[0].required, true);

result = evaluateProactiveLogisticsService({
  workOrderCreatedAt: hoursBefore(1),
  returnLogisticsTimeline: [],
  pddEvidenceUploadFailed: true,
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.evidence.required[0].required, false);

result = evaluateReverseLogisticsSignedRefund({
  returnLogisticsTimeline: [
    { text: '退件已离开广州转运中心', occurredAt: hoursBefore(3) },
    { text: '退件到达长沙转运中心', occurredAt: hoursBefore(2) },
    { text: '退件已在仓库签收', occurredAt: hoursBefore(1) },
  ],
  shippingLogisticsTimeline: [{ text: '发货物流经过北京', occurredAt: hoursBefore(24) }],
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.reasonCode, 'reverse-logistics-changsha-matched');
assert.equal(result.pdd.option, '同意退款');
assert.deepEqual(result.requiredSystems, ['PDD']);
assert.equal(result.evidence.changsha.matchedSource, 'return');
assert.match(result.evidence.changsha.matchedNode.text, /长沙/u);

result = evaluateReverseLogisticsSignedRefund({
  returnLogisticsTimeline: [{ text: '退件已在广州仓库签收', occurredAt: hoursBefore(1) }],
  shippingLogisticsTimeline: [{ text: '发货包裹经过长沙', occurredAt: hoursBefore(24) }],
}, { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'reverse-logistics-changsha-not-found');
assert.equal(result.evidence.changsha.shippingMatched, null,
  '有退货物流时不得降级使用包含长沙的发货物流');
assert.equal(result.evidence.changsha.shippingLogisticsNodeCount, 0);

result = evaluateReverseLogisticsSignedRefund({
  returnLogisticsTimeline: [{ text: '暂无退货物流信息' }],
  shippingLogisticsTimeline: [
    { text: '包裹已由长沙雨花网点揽收', occurredAt: hoursBefore(48) },
  ],
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'shipping-logistics-changsha-fallback-matched');
assert.equal(result.evidence.changsha.matchedSource, 'shipping');
assert.equal(result.evidence.changsha.returnLogisticsHasData, false);

result = evaluateReverseLogisticsSignedRefund({
  returnLogisticsTimeline: [],
  shippingLogisticsTimeline: [{ text: '包裹已到达广州分拨中心', occurredAt: hoursBefore(1) }],
}, { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'shipping-logistics-changsha-not-found-after-return-empty');
assert.equal(result.nextAttemptAt, hoursBefore(-0.5));
assert.deepEqual(matchReverseSignedRefundChangsha({
  returnLogisticsTimeline: [{ text: '长沙转运中心已签收' }],
  shippingLogisticsTimeline: [],
}).matchedSource, 'return');

assert.equal(detectSignedLogistics([{ text: '快件已签收', occurredAt: now }]).status, 'signed');
assert.equal(detectSignedLogistics([{ text: '快件正在派送', occurredAt: now }]).status, 'unsigned');
assert.equal(detectSignedLogistics([{ text: '快件已取件', occurredAt: now }]).status, 'unsigned');
assert.equal(detectSignedLogistics([{ text: '签收人信息待确认', occurredAt: now }]).status, 'unsigned');
assert.equal(detectSignedLogistics([{ text: '等待签收', occurredAt: now }]).status, 'unsigned');
assert.equal(detectSignedLogistics([{ text: '快件已妥投', occurredAt: now }]).status, 'signed');
assert.equal(detectSignedLogistics([]).status, 'unknown');

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '本人已签收', occurredAt: hoursBefore(1) }],
}, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'oms-tms-common-flow');

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '本人已签收', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '消费者已收到货');
assert.deepEqual(result.requiredSystems, ['PDD', 'OMS', 'TMS']);

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-recall');

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '本人已签收', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
  pddEvidenceUploadFailed: true,
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'pdd-shipping-evidence-upload-failed');

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
  tmsRecallCompleted: true,
}, { now });
assert.equal(result.actionCode, 'tms-recall');
assert.equal(result.external.action, 'capture-tms-recall-evidence');

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '本人已签收', occurredAt: hoursBefore(1) }],
  shippingSigned: false,
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.actionCode, 'tms-recall');
assert.equal(result.pdd.pendingOption, '已进行召回');

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
  pddEvidenceUploadFailed: true,
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'pdd-tms-recall-evidence-upload-failed');
assert.match(result.reason, /^拼多多上传 TMS 召回凭证失败/);
assert.match(result.reason, /TMS 召回工单和凭证已生成/);
assert.doesNotMatch(result.reason, /^TMS 召回凭证上传失败/);

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
  tmsRecallCompleted: true,
  tmsEvidenceReady: true,
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '已进行召回');

result = evaluateInterceptRecall({ shippingLogisticsTimeline: [] }, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'oms-tms-common-flow');
assert.equal(result.pdd.pendingOption, '已进行召回');
assert.equal(result.evidence.selectionStrategy, 'unknown-treated-as-unsigned');

result = evaluateInterceptRecall({
  shippingLogisticsTimeline: [],
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'tms-recall');
assert.equal(result.reasonCode, 'unknown-sign-status-recall-required');
assert.equal(result.evidence.observedSignedStatus, 'unknown');
assert.equal(result.evidence.selectionStrategy, 'unknown-treated-as-unsigned');

const doorstepSignedTimeline = [{
  text: '【重庆市】您的包裹已送货上门签收，签收方式：其他类型。服务由 重庆市长寿维丰小区店 提供。如有问题可致电：19332141917。感谢您的耐心等待。投诉电话：13274912700。',
  occurredAt: hoursBefore(1),
}];
const doorstepDelivery = extractDeliveredNotReceivedLogistics(doorstepSignedTimeline);
assert.equal(doorstepDelivery.status, 'ready');
assert.equal(doorstepDelivery.courierPhone, '19332141917');
assert.equal(doorstepDelivery.pickupAddress, '重庆市长寿维丰小区店');
assert.equal(doorstepDelivery.signType, 'DOORSTEP');
assert.equal(doorstepDelivery.situationConfirm, '快递会联系消费者');

const stationDelivery = extractDeliveredNotReceivedLogistics([{
  text: '【长沙市】包裹已签收，服务由 长沙市雨花区菜鸟驿站 提供。如有问题可致电：13800138000。',
  occurredAt: hoursBefore(1),
}]);
assert.equal(stationDelivery.signType, 'STATION');
assert.equal(stationDelivery.situationConfirm, '需要消费者自取');
assert.equal(stationDelivery.pickupAddress, '长沙市雨花区菜鸟驿站');

const pickupCodeStationTimeline = [{
  text: '【代收点】您的快件已投递，收件人凭取件码在【松村羌营村公共服务站(06点00-20点00)(已签收签收人是本人)】领取，如有疑问请电联代收点：15135521611，快递员：王小晶(18735529879)。',
  occurredAt: hoursBefore(1),
}];
const pickupCodeStationDelivery = extractDeliveredNotReceivedLogistics(pickupCodeStationTimeline);
assert.equal(pickupCodeStationDelivery.signType, 'STATION');
assert.equal(pickupCodeStationDelivery.situationConfirm, '需要消费者自取');
assert.equal(
  pickupCodeStationDelivery.pickupAddress,
  '松村羌营村公共服务站(06点00-20点00)(已签收签收人是本人)',
);
assert.equal(pickupCodeStationDelivery.courierPhone, '18735529879');

const standaloneDoorstepDelivery = extractDeliveredNotReceivedLogistics([{
  text: '【成都市】包裹已签收并放到消费者门口，如有问题可致电：13900139000。',
  occurredAt: hoursBefore(1),
}]);
assert.equal(standaloneDoorstepDelivery.signType, 'DOORSTEP');
assert.equal(standaloneDoorstepDelivery.situationConfirm, '快递会联系消费者');

const inTransitDelivery = extractDeliveredNotReceivedLogistics([{
  text: '【武汉市】快递员正在派送，如有问题可致电：13700137000。',
  occurredAt: hoursBefore(1),
}]);
assert.equal(inTransitDelivery.status, 'ready');
assert.equal(inTransitDelivery.signType, 'IN_TRANSIT');
assert.equal(inTransitDelivery.situationConfirm, '快递会联系消费者');

const signedRefundAftersaleFacts = {
  orderDetailText: `
    订单信息
    售后信息
    售后类型：退款
    售后状态：退款处理中
    物流轨迹
  `,
  shippingLogisticsTimeline: doorstepSignedTimeline,
};
assert.deepEqual(
  {
    matched: detectDeliveredNotReceivedRefundCase(signedRefundAftersaleFacts).matched,
    shippingSigned: detectDeliveredNotReceivedRefundCase(signedRefundAftersaleFacts).shippingSigned,
    hasAftersaleInfo: detectDeliveredNotReceivedRefundCase(signedRefundAftersaleFacts).hasAftersaleInfo,
    aftersaleType: detectDeliveredNotReceivedRefundCase(signedRefundAftersaleFacts).aftersaleType,
  },
  {
    matched: true,
    shippingSigned: true,
    hasAftersaleInfo: true,
    aftersaleType: '退款',
  },
);
result = evaluateDeliveredNotReceived(signedRefundAftersaleFacts, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '消费者遇到其他问题');
assert.equal(result.pdd.secondaryOption, '不想要了想退款');
assert.equal(result.pdd.strictOptionSelection, true);
assert.deepEqual(result.requiredSystems, ['PDD']);

result = evaluateDeliveredNotReceived({
  ...signedRefundAftersaleFacts,
  orderDetailText: '订单信息\n售后信息\n售后类型：退货退款\n物流轨迹',
}, { now });
assert.equal(result.actionCode, 'delivered-not-received-oms-tms-flow',
  '退货退款不得误判为售后类型“退款”');

result = evaluateDeliveredNotReceived({
  ...signedRefundAftersaleFacts,
  orderDetailText: '订单信息\n售后信息\n暂无售后信息\n售后类型：退款\n物流轨迹',
}, { now });
assert.equal(result.actionCode, 'delivered-not-received-oms-tms-flow',
  '明确无售后信息时不得进入退款分支');

result = evaluateDeliveredNotReceived({
  ...signedRefundAftersaleFacts,
  shippingLogisticsTimeline: [{
    text: '【武汉市】快递员正在派送，如有问题可致电：13700137000。',
    occurredAt: hoursBefore(1),
  }],
}, { now });
assert.equal(result.actionCode, 'delivered-not-received-oms-tms-flow',
  '发货物流未签收时必须保留原流程');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: doorstepSignedTimeline,
}, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'delivered-not-received-oms-tms-flow');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: doorstepSignedTimeline,
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.actionCode, 'pdd-stage-submit');
assert.equal(result.pdd.stageCode, 'confirmation');
assert.equal(result.pdd.option, '告知送达地址并承诺核实');
assert.equal(result.pdd.courierPhone, '19332141917');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: doorstepSignedTimeline,
  omsTmsFlowCompleted: true,
  completedPddStages: ['confirmation'],
}, { now });
assert.equal(result.actionCode, 'pdd-stage-submit');
assert.equal(result.pdd.stageCode, 'evidence');
assert.equal(result.pdd.option, '发送凭证');
assert.equal(result.evidence.required[0].source, 'tms-delivery-contact-evidence');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: [],
  omsTmsFlowCompleted: true,
  completedPddStages: ['confirmation'],
}, { now });
assert.equal(result.actionCode, 'pdd-stage-submit');
assert.equal(result.pdd.stageCode, 'evidence');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: doorstepSignedTimeline,
  omsTmsFlowCompleted: true,
  completedPddStages: ['confirmation', 'evidence'],
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '可以送达');
assert.equal(result.pdd.secondaryOption, '快递会联系消费者');
assert.equal(result.pdd.expectedContactDateOffsetDays, 0);

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: [{
    text: '【长沙市】包裹已签收，服务由 长沙市雨花区菜鸟驿站 提供。',
    occurredAt: hoursBefore(1),
  }],
  omsTmsFlowCompleted: true,
  completedPddStages: ['confirmation', 'evidence'],
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.secondaryOption, '需要消费者自取');
assert.equal(result.pdd.pickupAddress, '长沙市雨花区菜鸟驿站');
assert.equal(
  result.pdd.generatedMessageFallback,
  '亲亲，快递已送达长沙市雨花区菜鸟驿站，请您前往该地点取件。',
);

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: pickupCodeStationTimeline,
  omsTmsFlowCompleted: true,
  completedPddStages: ['confirmation', 'evidence'],
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.secondaryOption, '需要消费者自取');
assert.equal(
  result.pdd.generatedMessageMustInclude[0],
  '松村羌营村公共服务站(06点00-20点00)(已签收签收人是本人)',
);

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: [{
    text: '【合肥市】包裹已签收，放置地点见本条轨迹，派送电话：13800138000。',
    occurredAt: hoursBefore(1),
  }],
  omsTmsFlowCompleted: true,
  completedPddStages: ['confirmation', 'evidence'],
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.secondaryOption, '需要消费者自取');
assert.match(result.pdd.pickupAddress, /合肥市/u);
assert.equal(result.evidence.delivery.pickupAddressSource, 'complete-trace-fallback');
assert.equal(
  result.evidence.delivery.situationSelectionStrategy,
  'unknown-signed-default-self-pickup',
);

assert.equal(extractDeliveredNotReceivedLogistics([{
  text: '包裹已签收，配送完成，联系电话未标注，手机号 13900139000。',
  occurredAt: hoursBefore(1),
}]).courierPhone, '13900139000');

assert.equal(extractDeliveredNotReceivedLogistics([{
  text: '包裹已到达中转仓，如有疑问请联系：17637081932，投诉电话：13274912700。',
  occurredAt: hoursBefore(1),
}]).courierPhone, '17637081932');

const multiPhonePickupDelivery = extractDeliveredNotReceivedLogistics([{
  text: '快件正在派送中，如有疑问请电联快递员【卢春娟，电话:18587715530】或揽投部【电话:18077776740】。',
  occurredAt: hoursBefore(2),
}, {
  text: '您的快件已派送至【南宁璞悦公馆23栋S106号店】，自提点电话:18607855423，如有疑问请电联快递员【电话:18587715530】，揽投部【电话:18077776740】，投诉电话【电话:18269020612】。',
  occurredAt: hoursBefore(1),
}]);
assert.equal(multiPhonePickupDelivery.courierPhone, '18587715530');
assert.equal(multiPhonePickupDelivery.pickupAddress, '南宁璞悦公馆23栋S106号店');
assert.equal(multiPhonePickupDelivery.confirmationAddress, '南宁璞悦公馆23栋S106号店');
assert.equal(multiPhonePickupDelivery.signType, 'STATION');
assert.equal(multiPhonePickupDelivery.situationConfirm, '需要消费者自取');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: [{
    text: '您的快件已派送至【南宁璞悦公馆23栋S106号店】，自提点电话:18607855423，如有疑问请电联快递员【电话:18587715530】，揽投部【电话:18077776740】。',
    occurredAt: hoursBefore(1),
  }],
}, { now });
assert.equal(result.outcome, 'external-action');
assert.equal(result.actionCode, 'delivered-not-received-oms-tms-flow');
assert.equal(result.evidence.delivery.courierPhone, '18587715530');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: [{
    text: '您的快件已派送至【南宁璞悦公馆23栋S106号店】，自提点电话:18607855423，如有疑问请电联快递员【电话:18587715530】，揽投部【电话:18077776740】，投诉电话【电话:18269020612】。',
    occurredAt: hoursBefore(1),
  }],
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.pdd.deliveryAddress, '南宁璞悦公馆23栋S106号店');
assert.deepEqual(result.pdd.generatedMessageMustInclude, [
  '南宁璞悦公馆23栋S106号店',
  '18587715530',
]);
assert.match(result.evidence.delivery.deliveryAddress, /投诉电话/u,
  'the complete logistics trace must remain available as evidence');

const longDoorstepDelivery = extractDeliveredNotReceivedLogistics([{
  text: `【重庆市】您的包裹已送货上门签收，签收方式：其他类型。${'配送详情'.repeat(30)}如有问题可致电：19332141917。`,
  occurredAt: hoursBefore(1),
}]);
assert.equal(longDoorstepDelivery.confirmationAddress.length, 100,
  'a non-station confirmation address must fit the bounded PDD address field');
assert(longDoorstepDelivery.deliveryAddress.length > longDoorstepDelivery.confirmationAddress.length
  && longDoorstepDelivery.deliveryAddress.length <= 200,
  'the longer delivery evidence must remain separate from the form value');

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: [{
    text: '【武汉市】快递员正在派送，如有问题可致电：13700137000。',
    occurredAt: hoursBefore(1),
  }],
  omsTmsFlowCompleted: true,
  completedPddStages: ['confirmation', 'evidence'],
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '可以送达');
assert.equal(result.pdd.secondaryOption, '快递会联系消费者');
assert.equal(result.pdd.expectedContactDateOffsetDays, 0);
assert.equal(result.pdd.pickupAddress, undefined);

result = evaluateDeliveredNotReceived({
  shippingLogisticsTimeline: [{
    text: '【长沙市】包裹已签收，服务由 长沙市雨花区菜鸟驿站 提供。',
    occurredAt: hoursBefore(1),
  }],
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'courier-phone-not-found');

result = evaluateConsumerRefusal({
  shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
}, { now });
assert.equal(result.actionCode, 'consumer-refusal-oms-tms-flow');

result = evaluateConsumerRefusal({
  shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.actionCode, 'pdd-stage-submit');
assert.equal(result.pdd.option, '发送拦截');

result = evaluateConsumerRefusal({
  shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
  completedPddStages: ['intercept-request'],
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '同意退款');

result = evaluateConsumerRefusal({
  shippingLogisticsTimeline: [{ text: '快件已经退回寄件网点', occurredAt: hoursBefore(1) }],
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '拦截成功同意退款');

assert.equal(detectConsumerRefusalInterception({
  tmsMatchedReplyResult: '网点反馈拦截成功，退回寄件网点',
}).status, 'success');
assert.equal(detectConsumerRefusalInterception({
  tmsCarrierReply: '派送中无法拦截',
}).status, 'failed');

result = evaluateProductShortage({}, { now });
assert.equal(result.actionCode, 'product-shortage-verification-flow');
assert.deepEqual(result.requiredSystems, ['OMS', 'TMS']);

const confirmedNoShortageChat = {
  status: 'analyzed',
  messages: [{ sender: 'buyer', text: '商品数量已确认' }],
  completeness: { complete: true, issues: [] },
  policy: { blockingConflicts: [] },
  eligible: true,
  conclusion: 'no-shortage',
  analysis: { situationDescription: '聊天记录核对商品件数一致' },
};
result = evaluateProductShortage({
  chatAnalysis: confirmedNoShortageChat,
  pddFeedbackEntryAvailable: false,
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '已核实，商品没有少发');
assert.equal(result.pdd.strictOptionSelection, true,
  '没有少发的终态选项不能被“已联系快递或仓库核实”等过程选项代替');

result = evaluateProductShortage({
  omsTmsFlowCompleted: true,
}, { now });
assert.equal(result.actionCode, 'pdd-stage-submit');
assert.equal(result.pdd.option, '去核实，填写核实时间');
assert.equal(result.pdd.verificationDateOffsetDays, 1);
assert.equal(result.pdd.waitAfterSubmitMs, 30 * 60_000);

const productShortageProgressPage = '填写核实进度 请核实商品少发情况 已联系快递或仓库核实 确认商品少发';
result = evaluateProductShortage({
  omsTmsFlowCompleted: true,
  bodyText: productShortageProgressPage,
  completedPddStages: ['verification-request'],
  productShortageTmsResultCheckedAt: now,
  tmsMatchedReplyResult: '处理中，等待网点回复',
}, { now });
assert.equal(result.actionCode, 'pdd-stage-submit');
assert.equal(result.pdd.stageCode, 'verification-contact-progress');
assert.equal(result.pdd.option, '已联系快递或仓库核实');
assert.equal(result.pdd.verificationDateOffsetDays, undefined);
assert.equal(result.evidence.required[0].source, 'tms-product-shortage-contact-evidence');

result = evaluateProductShortage({
  omsTmsFlowCompleted: true,
  bodyText: productShortageProgressPage,
  completedPddStages: ['verification-request'],
  productShortageTmsResultCheckedAt: now,
  tmsMatchedReplyResult: '网点核实包裹发出重量异常，确认商品少发一件',
  tmsMatchedTaskStatus: '已完成',
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '确认商品少发');
assert.equal(result.evidence.required[0].source, 'tms-product-shortage-contact-evidence');

result = evaluateProductShortage({
  omsTmsFlowCompleted: true,
  bodyText: productShortageProgressPage,
  completedPddStages: ['verification-request'],
  productShortageTmsResultCheckedAt: now,
  tmsMatchedReplyResult: '仓库复核未少发，发出重量正常',
}, { now });
assert.equal(result.actionCode, 'pdd-stage-submit');
assert.equal(result.pdd.option, '已联系快递或仓库核实');

result = evaluateProductShortage({
  omsTmsFlowCompleted: true,
  completedPddStages: ['verification-request'],
  productShortageTmsResultCheckedAt: hoursBefore(1),
  tmsMatchedReplyResult: '网点核实包裹发出重量异常，确认商品少发一件',
  tmsMatchedTaskStatus: '已完成',
}, { now });
assert.equal(result.actionCode, 'pdd-complete');
assert.equal(result.pdd.option, '已核实，填写核实结果');
assert.equal(result.pdd.verificationResult, '网点核实包裹发出重量异常，确认商品少发一件');

result = evaluateProductShortage({
  omsTmsFlowCompleted: true,
  completedPddStages: ['verification-request'],
  productShortageTmsResultCheckedAt: hoursBefore(1),
  tmsMatchedReplyResult: '处理中，等待网点回复',
}, { now });
assert.equal(result.actionCode, 'product-shortage-tms-result-check');

result = evaluateProductShortage({
  omsTmsFlowCompleted: true,
  completedPddStages: ['verification-request'],
  productShortageTmsResultCheckedAt: now,
  tmsMatchedTaskStatus: '已完成',
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'product-shortage-tms-completed-without-result');

assert.equal(classifyProductShortageTmsResult({
  tmsMatchedReplyResult: '核实中，请稍后',
}).status, 'pending');
assert.equal(classifyProductShortageTmsResult({
  tmsMatchedReplyResult: '仓库复核未少发，发出重量正常',
}).status, 'ready');
assert.equal(detectConsumerRefusalInterception({
  tmsCarrierReply: '网点最新反馈拦截失败',
  shippingLogisticsTimeline: [{ text: '系统历史备注：曾显示拦截成功', occurredAt: hoursBefore(2) }],
}).status, 'failed');

assert.equal(detectPickedUpLogistics([{ text: '快件已揽收', occurredAt: now }]).status, 'picked-up');
assert.equal(detectPickedUpLogistics([{ text: '商家已发货，等待揽收', occurredAt: now }]).status, 'not-picked-up');
assert.equal(detectPickedUpLogistics([{ text: '快递员正在揽收', occurredAt: now }]).status, 'not-picked-up');

result = evaluateGoodDeedExpeditedShipping({}, { now });
assert.equal(result.actionCode, 'oms-allocation-check');

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: false,
  shippingLogisticsTimeline: [{ text: '快件已揽件', occurredAt: hoursBefore(1) }],
  remainingDurationMs: HOUR_MS,
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '已揽件');

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: false,
  shippingLogisticsTimeline: [],
  remainingDurationMs: HOUR_MS,
  platformPrefilledPhone: '13800138000',
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '反馈');

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: true,
  shippingLogisticsTimeline: [{ text: '快件已揽件', occurredAt: hoursBefore(1) }],
  remainingDurationMs: HOUR_MS,
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '已揽件');

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: true,
  shippingLogisticsTimeline: [{ text: '商家已发货，等待揽收', occurredAt: hoursBefore(1) }],
  remainingDurationMs: 2 * HOUR_MS,
}, { now });
assert.equal(result.outcome, 'wait');
assert.equal(result.reasonCode, 'not-picked-up-with-at-least-two-hours-remaining');

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: true,
  shippingLogisticsTimeline: [],
  remainingDurationMs: 2 * HOUR_MS - 1,
  platformPrefilledPhone: '13800138000',
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.pdd.option, '反馈');
assert.equal(result.pdd.reasonOption, '其他原因');
assert.equal(result.pdd.problemDescription, '此件快递已正常揽收走件');
assert.equal(result.evidence.captureEvenWithoutTrajectory, true);

assert.equal(isValidPlatformPrefilledPhone('+86 138-0013-8000'), true);
assert.equal(isValidPlatformPrefilledPhone('138****8000'), true);
assert.equal(isValidPlatformPrefilledPhone('138***8000'), false);

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: true,
  shippingLogisticsTimeline: [],
  remainingDurationMs: HOUR_MS,
  platformPrefilledPhone: '',
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'platform-prefilled-phone-invalid');

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: true,
  shippingLogisticsTimeline: [],
  remainingDurationMs: HOUR_MS,
  platformPrefilledPhone: '13800138000',
  pddEvidenceUploadFailed: true,
}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'pdd-shipping-evidence-upload-failed');

result = evaluateGoodDeedExpeditedShipping({
  omsAllocated: true,
  shippingLogisticsTimeline: [],
  platformPrefilledPhone: '138****8000',
}, { now });
assert.equal(result.outcome, 'auto-submit');
assert.equal(result.reasonCode, 'not-picked-up-with-unreadable-deadline-immediate-feedback');
assert.equal(result.evidence.deadlineSelectionStrategy, 'unreadable-deadline-immediate-feedback');

result = evaluateOrdinaryWorkOrderScenario('unknown-scenario', {}, { now });
assert.equal(result.outcome, 'manual-review');
assert.equal(result.reasonCode, 'unsupported-ordinary-scenario');

assert.throws(() => evaluateDeliveryRiskConcern({}, {}), /options\.now/u);
assert.throws(() => evaluateProactiveLogisticsService({}, { now: 'invalid' }), /options\.now/u);
assert.throws(() => evaluateReverseLogisticsSignedRefund({}, { now: 'invalid' }), /options\.now/u);

const contractDecisions = [
  evaluateOrdinaryWorkOrderScenario('delivery-risk-concern', deliveryFacts({
    latestHoursAgo: 24,
    workOrderCreatedAt: hoursBefore(10),
  }), { now }),
  evaluateOrdinaryWorkOrderScenario('proactive-logistics-service', {
    returnLogisticsTimeline: [{ text: '快件运输中', occurredAt: hoursBefore(1) }],
  }, { now }),
  evaluateOrdinaryWorkOrderScenario('reverse-logistics-signed-refund', {
    returnLogisticsTimeline: [{ text: '退件到达长沙转运中心', occurredAt: hoursBefore(1) }],
  }, { now }),
  evaluateOrdinaryWorkOrderScenario('intercept-recall', {
    shippingLogisticsTimeline: [{ text: '快件运输中', occurredAt: hoursBefore(1) }],
  }, { now }),
  evaluateOrdinaryWorkOrderScenario('good-deed-expedited-shipping', {}, { now }),
  evaluateOrdinaryWorkOrderScenario('delivered-not-received', {
    shippingLogisticsTimeline: doorstepSignedTimeline,
  }, { now }),
  evaluateOrdinaryWorkOrderScenario('consumer-refusal', {
    shippingLogisticsTimeline: [{ text: '快件正在运输', occurredAt: hoursBefore(1) }],
  }, { now }),
  evaluateOrdinaryWorkOrderScenario('product-shortage', {}, { now }),
];
for (const policyDecision of contractDecisions) {
  assert.equal(typeof policyDecision.scenarioCode, 'string');
  assert.match(policyDecision.outcome, /^(?:auto-submit|wait|manual-review|external-action)$/u);
  assert.equal(typeof policyDecision.actionCode, 'string');
  assert.equal(typeof policyDecision.reasonCode, 'string');
  assert.equal(typeof policyDecision.reason, 'string');
  assert.equal(Array.isArray(policyDecision.requiredSystems), true);
  assert.equal(policyDecision.nextAttemptAt, policyDecision.retryAfterAt);
  if (policyDecision.outcome === 'wait') {
    assert.equal(Number.isFinite(Date.parse(policyDecision.nextAttemptAt)), true);
  }
}

const deterministicFacts = Object.freeze({
  workOrderCreatedAt: hoursBefore(10),
  logisticsTimeline: Object.freeze([Object.freeze({
    text: '快件到达转运中心',
    occurredAt: hoursBefore(2),
  })]),
});
assert.deepEqual(
  evaluateDeliveryRiskConcern(deterministicFacts, { now }),
  evaluateDeliveryRiskConcern(deterministicFacts, { now }),
);

assert.deepEqual(Object.values(ORDINARY_SCENARIO_CODES), [
  'delivery-risk-concern',
  'proactive-logistics-service',
  'reverse-logistics-signed-refund',
  'intercept-recall',
  'good-deed-expedited-shipping',
  'delivered-not-received',
  'consumer-refusal',
  'product-shortage',
  'promise-reissue',
  'consumer-address-change',
  'consumer-address-change-in-transit',
  'delivered-address-change',
]);

const workflowSource = readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const completionHelperSource = workflowSource.slice(
  workflowSource.indexOf('const ordinaryCompletionFromPendingListAbsence ='),
  workflowSource.indexOf('const ordinaryRetryDelayMs ='),
);
const completionFromList = vm.runInNewContext(
  `${workflowSource.slice(workflowSource.indexOf('class ManualReviewRequiredError extends Error'),
    workflowSource.indexOf('class LogisticsRetryRequiredError extends Error'))}
${completionHelperSource}\nordinaryCompletionFromPendingListAbsence`,
  {
    readProgress: () => ({ orderNumber: '260926-123', platformWorkOrderId: '500013400001234' }),
    rejectedSubmitPendingListAbsenceNeedsReview: () => false,
    ordinaryCompletionFromState: (_order, _scenario, decision, state) => ({ decision, state }),
    completedPddStateFromPendingListAbsence: (orderNumber) => ({ orderNumber }),
  },
);
assert.throws(() => completionFromList('260926-123', 'in-transit-refund', {},
  { confirmationMethod: 'exact-order-completed' }), /ordinary-list-completion-unverified/u,
  'a list label alone cannot stand in for the exact completed detail');
const exactCompleted = completionFromList('260926-123', 'in-transit-refund',
  { pdd: { completionOption: '已同意退款' } },
  { confirmationMethod: 'exact-order-completed', completedState: {
    detailReady: true, isCompleted: true, orderMatches: true,
    observedPlatformWorkOrderId: '500013400001234', completedOutcome: '已同意退货退款',
  } });
assert.equal(exactCompleted.decision.reasonCode, '已同意退货退款');
assert.equal(exactCompleted.decision.outcome, 'read-only-completed');
assert.equal(exactCompleted.decision.pdd.completionOption, undefined,
  'an already-completed row must not be reported as our planned submit option');
assert.equal(exactCompleted.state.confirmationMethod, 'detail-completed');
const exactEmpty = completionFromList('260926-123', 'in-transit-refund',
  { pdd: { completionOption: '已同意退款' } });
assert.equal(exactEmpty.decision.reasonCode, 'refreshed-exact-empty-pending-list');
assert.equal(exactEmpty.state.confirmationMethod, 'absent-from-pending-list');
assert.match(
  workflowSource,
  /selectedOption = await selectOrdinaryPddOption\([\s\S]{0,240}\[\.\.\.terminalLabels, \.\.\.primaryLabels\]/u,
  'a staged delivery-risk form must select the option rendered on the current page',
);
assert.match(
  workflowSource,
  /judgmentRepresentsTerminal = judgmentSelection\?\.selectedLabel === selectedOption[\s\S]{0,420}ordinaryPddOptionsSemanticallyEquivalent\(terminalLabels, selectedOption\)[\s\S]{0,120}judgmentRepresentsTerminal/u,
  'an audited judgment may classify a terminal option without weakening strict semantic equivalence',
);
assert.doesNotMatch(
  workflowSource,
  /expandedPrimaryLabels\.includes\(selectedOption\)[\s\S]{0,180}pdd\.resultRequiredAfterPrimary === true[\s\S]{0,180}selectOrdinaryPddOption\(targetPage, terminalLabels\)/u,
  'a two-level form must not search for its result option before the first confirmation advances the page',
);
assert.doesNotMatch(
  workflowSource,
  /if \(!terminalSelected\) \{\s*await selectOrdinaryPddOption\(targetPage, terminalLabels\)/u,
  'the initial reminder form must not require a later follow-up result option before submit',
);
assert.match(
  workflowSource,
  /selectedPddOption = formState\?\.selectedOption \|\| selectedPddOption[\s\S]{0,700}selectedOption: selectedPddOption/u,
  'submission state must preserve the exact option selected on the current PDD stage',
);
assert.match(
  workflowSource,
  /const stagedResultRequired = decision\.pdd\?\.resultRequiredAfterPrimary === true/u,
  'a two-level PDD form must persist its primary outcome separately from its result option',
);
assert.match(workflowSource, /stagedResultRequired\s*\? decision\.pdd\?\.option/u);
assert.match(workflowSource, /resultOption: stagedResultRequired \? decision\.pdd\?\.resultOption/u);
assert.match(workflowSource, /effectStage: `\$\{baseStage\}:primary`/u);
assert.match(workflowSource, /effectStage: `\$\{baseStage\}:result`/u);
assert.match(workflowSource, /status: requireCompleted \? 'succeeded' : 'stage-succeeded'/u);
assert.match(workflowSource, /completedAt: requireCompleted \? new Date\(\)\.toISOString\(\) : null/u);
assert.match(workflowSource, /stageCompletedAt: requireCompleted \? null : new Date\(\)\.toISOString\(\)/u);
assert.match(workflowSource, /PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE/u);
assert.match(
  workflowSource,
  /ordinary-pdd-result-stage-refreshed[\s\S]{0,1800}status: 'refreshed-after-initial-render-wait'/u,
  'a two-stage PDD form must refresh once after the initial 30-second result render wait',
);
assert.match(
  workflowSource,
  /waitForPddRenderedResult\(targetPage, \{[\s\S]{0,300}stage: '普通工单最终处理选项渲染'[\s\S]{0,400}totalTimeoutMs: 30_000[\s\S]{0,120}initialWaitMs: 0/u,
  'an unavailable result stage must get one bounded post-refresh render window before retry',
);
assert.match(
  workflowSource,
  /status: 'retry-ready',[\s\S]{0,160}retryAfterMs: 30_000,[\s\S]{0,100}refreshAttempted: true/u,
  'a failed result-stage transition may retry only after the controlled refresh was attempted',
);
assert.match(
  workflowSource,
  /recoverFollowupStage = false[\s\S]{0,2600}findOrdinaryPddMessageStage\(followupPage\)[\s\S]{0,1800}advanceOrdinaryPddMessageStageIfPresent\(/u,
  'a successful terminal result must advance a rendered consumer-message follow-up before completion is rejected',
);
assert.match(
  workflowSource,
  /recoverFollowupStage: requireCompleted,[\s\S]{0,120}scenarioCode,[\s\S]{0,120}decision,/u,
  'ordinary terminal submissions must enable the separately guarded post-result follow-up recovery',
);
assert.match(workflowSource, /const executeExtendedOrdinaryScenario = async/u);
assert.match(
  workflowSource,
  /evaluateOrdinaryWorkOrderScenario\(scenarioCode, facts, \{ now: new Date\(\) \}\)/u,
);
assert.match(
  workflowSource,
  /await executeExtendedOrdinaryScenario\([\s\S]{0,200}extendedScenarioCode/u,
);
const extendedScenarioResumeSource = workflowSource.slice(
  workflowSource.indexOf('const extendedProgress = readProgress();'),
  workflowSource.indexOf('let completedOrderNumber;'),
);
assert.match(
  extendedScenarioResumeSource,
  /reopenPddDetailForResolution\([\s\S]{0,500}hasConfirmedPendingListAbsence/u,
  'extended ordinary scenarios must re-query the exact pending order before reusing a saved detail',
);
assert.match(
  extendedScenarioResumeSource,
  /refreshed-exact-empty-pending-list[\s\S]{0,500}ordinaryCompletionFromState/u,
  'a refreshed exact zero result must recover an extended ordinary order as completed',
);
const requestedOrderRecoverySource = workflowSource.slice(
  workflowSource.indexOf("step: 'requested-order-pending-absence-confirmed'"),
  workflowSource.indexOf("logRunStep('verified-detail-recovered-after-pending-miss'"),
);
assert.match(
  requestedOrderRecoverySource,
  /pddResolutionPendingListPresence: pendingListPresence[\s\S]{0,1600}if \(exactShopIdentity && refreshedExactEmpty && selectedScenarioCode\)/u,
  'a requested-order zero result must preserve refreshed completion evidence',
);
assert.match(
  requestedOrderRecoverySource,
  /if \(exactShopIdentity && refreshedExactEmpty && selectedScenarioCode\)[\s\S]{0,500}ordinaryCompletionFromPendingListAbsence/u,
  'a refreshed zero result may complete only with exact shop identity and a known scenario',
);
assert.match(
  requestedOrderRecoverySource,
  /ordinaryCompletionFromPendingListAbsence\([\s\S]{0,240}\{ confirmationMethod \}/u,
  'an exact completed row must retain its own proof method',
);
assert.match(
  requestedOrderRecoverySource,
  /ordinaryCompletionFromPendingListAbsence[\s\S]{0,900}if \(!recoveryUrl\)[\s\S]{0,900}openSavedPddDetailPage/u,
  'a stale saved detail URL must not override refreshed exact pending-list absence',
);
for (const actionCode of [
  'oms-warehouse-query',
  'tms-reminder',
  'oms-tms-common-flow',
  'tms-recall',
  'oms-manual-allocation',
  'tms-lost-and-oms-reissue',
  'oms-reissue-tracking-check',
  'product-shortage-verification-flow',
  'product-shortage-tms-result-check',
]) {
  assert.match(workflowSource, new RegExp(`decision\\.actionCode === '${actionCode}'`, 'u'));
}
assert.match(workflowSource, /effectType: 'oms-reissue-create'/u);
assert.match(workflowSource, /businessType: '快递责任补发'/u);
assert.match(workflowSource, /allowFirstAvailableCarrier:\s*true/u);
assert.match(workflowSource, /const terminalOption = pdd\.completionOption \|\| pdd\.resultOption/u);
assert.match(workflowSource, /\[\.\.\.terminalLabels, \.\.\.primaryLabels\]/u);
assert.match(workflowSource, /required: pdd\.customerMessageOptional !== true/u);
assert.match(workflowSource,
  /stableTmsEffectFormDecision[\s\S]*decidedAt: _decidedAt[\s\S]*formDecision: stableTmsEffectFormDecision\(formDecision\)/u,
  'TMS effect request hashing must omit volatile decision timestamps so a succeeded receipt can be rehydrated');
assert.match(workflowSource,
  /tms-product-shortage-contact-evidence[\s\S]*resolveReadyTmsEvidence/u,
  '商品少发核实进度凭证必须复用本流程 TMS 行截图');
assert.match(workflowSource,
  /refreshProductShortageTmsResult[\s\S]*runOrdinaryTmsAction[\s\S]*ordinary-product-shortage-verification-v1/u,
  '商品少发只读复查缺失状态时必须通过同一幂等 TMS 阶段恢复，不得新建第二张工单');
assert.match(workflowSource, /while \(!field && Date\.now\(\) < deadline\)/u);
assert.match(workflowSource, /previewTiming\.remainingDurationMs < 2 \* 60 \* 60_000[\s\S]*prepareGoodDeedFeedback/u);
assert.match(workflowSource, /feedbackPhoneChecked: true/u);
const goodDeedOmsStatusSource = workflowSource.slice(
  workflowSource.indexOf('const orderStatus = await readOmsOrderStatus'),
  workflowSource.indexOf('const markAnalysis = await readOmsOrderMark'),
);
assert.match(goodDeedOmsStatusSource,
  /GOOD_DEED_EXPEDITED_SHIPPING[\s\S]*oms-order-status-analyzed[\s\S]*return omsAnalysis/u,
  'good-deed OMS analysis must return after reading order status and before warehouse/mark parsing');
assert.match(workflowSource, /normalizeOrdinaryPddOptionText/u);
assert.match(workflowSource, /const listVisibleOrdinaryPddOptions = async/u);
assert.match(
  workflowSource,
  /const semanticMatch = resolveOrdinaryPddSemanticOption\(candidates, visibleOptions\)[\s\S]{0,240}const selectedMatch = semanticMatch \|\| judgmentMatch/u,
  'stable visible option variants must use an audited semantic selection',
);
assert.match(workflowSource, /ordinaryPddSemanticOptionSelection: selectionAudit/u);
assert.match(
  workflowSource,
  /ordinaryPddJudgmentOptionSelection:[\s\S]{0,360}representsRequestedIntent/u,
  'unknown visible choices must preserve their deterministic judgment audit',
);
assert.match(
  workflowSource,
  /expandedTerminalLabels\.includes\(selectedOption\)[\s\S]{0,160}ordinaryPddOptionsSemanticallyEquivalent\(terminalLabels, selectedOption\)/u,
  'semantic terminal variants must retain terminal-stage classification',
);
assert.ok(expandOrdinaryPddOptionAliases(['物流可以更新，能送达']).includes('物流可以更新,能送达'));
assert.match(workflowSource, /const currentScopes = async/u);
assert.match(workflowSource, /ordinary-\$\{scenarioCode\}-reminder-extension-\$\{reminderExtensionCount\}/u);
assert.match(workflowSource, /\{ requireCompleted: false, effectStage \}/u);
assert.match(workflowSource, /const findNextPendingWorkOrderAcrossPages = async/u);
assert.match(workflowSource, /findNextPendingWorkOrderAcrossPages\(pddPage, skippedSelectionKeys\)/u);
assert.match(workflowSource, /const discoveryKey = String\(selection\.discoveryKey \|\| rowFingerprint/u);
assert.match(workflowSource, /rememberDiscoverySelection\(skippedSelectionKeys, selection\)/u);
assert.match(workflowSource, /\{ refresh: pageNumber === 1, pageNumber \}/u);
assert.match(workflowSource, /PDD_RENDER_WAIT_MS/u);
assert.match(workflowSource, /waitForOrdinaryListRenderState/u);
assert.match(workflowSource, /const ensureOrdinaryListQueryControls = async/u);
assert.match(
  workflowSource,
  /const submitPendingOrderQuery = async[\s\S]*await ensureOrdinaryListQueryControls\(targetPage, stagePrefix\)/u,
);
assert.match(
  workflowSource,
  /ensureOrdinaryListQueryControls[\s\S]*timeoutMs: pddRenderWaitMs[\s\S]*ordinary-list-query-controls-after-refresh/u,
);
assert.match(workflowSource, /hasExactPddOrderQueryEmptyResult\(pageText\)/u);
assert.match(workflowSource, /inputValue\(\)[\s\S]*=== orderNumber/u);
assert.match(workflowSource, /hasVisiblePddLoadingState\(targetPage\)/u);
assert.match(
  workflowSource,
  /const tabWaitMs = Math\.max\(1_000, Math\.min\(30_000, pddRenderWaitMs\)\)[\s\S]*const waitForTab[\s\S]*targetPage\.reload[\s\S]*刷新并等待 \$\{tabWaitMs\} 毫秒后仍未找到“\$\{label\}”标签/u,
  'a missing PDD logistics tab must wait, refresh once, and only then fail safely',
);
assert.match(workflowSource, /const boundedWaitMs = Math\.max\(0, Math\.min\(pddRenderWaitMs/u);
assert.match(workflowSource, /selectPddRadioOnce\(targetPage, currentScope, label/u);
assert.match(workflowSource, /const selectOrdinaryPddDropdownOption = async/u);
assert.match(workflowSource, /unupdatedPromiseMatchAll/u);
assert.match(workflowSource, /'tms-recall-evidence'[\s\S]{0,200}'tms-reminder-evidence'/u);
assert.match(workflowSource, /TMS 截图克隆区域缺少当前订单运单号/u);
assert.match(workflowSource, /TMS 截图克隆区域的物流问题或客服备注与本次要求不匹配/u);
assert.match(workflowSource, /tmsEvidenceDecisionMatches/u);
assert.match(workflowSource, /compareExistingTmsTicketDecision/u);
assert.match(workflowSource, /completedReturnCoversLossDecision/u);
assert.match(workflowSource, /completed-return-covers-loss-decision/u);
assert.match(workflowSource, /completed-intercept-covers-low-value-refund/u);
assert.match(
  workflowSource,
  /Number\(candidateCount\) === 1[\s\S]{0,500}taskStatus === '已完成'[\s\S]{0,300}已在退回/u,
  'completed return compatibility must stay limited to one exact completed TMS row with a positive courier result',
);
assert.match(workflowSource, /const pddInterceptProgressOutcomeGroup = \[/u);
assert.match(workflowSource, /hasInterceptProgressStep[\s\S]{0,300}'intercept-progress'/u);
assert.match(workflowSource, /resolvePddInterceptProgressOutcome\(readProgress\(\)\)/u);
assert.match(workflowSource, /duplicateCheck\.status === 'matched'/u);
assert.match(workflowSource, /const pddConsumerNegotiationOutcomeGroup = \[/u);
assert.match(workflowSource, /pdd-consumer-negotiation-followup-waiting/u);
assert.match(workflowSource, /consumer-negotiation-followup-v1/u);
assert.match(workflowSource, /pending-detail-outcome-transition/u);
const pddResolutionDetailReopenSource = workflowSource.slice(
  workflowSource.indexOf('const reopenPddDetailForResolution'),
  workflowSource.indexOf('const isRecoverablePddResolutionFormError'),
);
assert.match(pddResolutionDetailReopenSource, /普通工单详情恢复列表渲染/u);
assert.match(pddResolutionDetailReopenSource, /waitForPddRenderedResult\(pddPage/);
assert.match(pddResolutionDetailReopenSource, /submitPendingOrderQuery\(pddPage, orderNumber, 'resolution'\)/);
assert.match(pddResolutionDetailReopenSource, /confirmEmptyAfterRefresh: true/);
assert.match(workflowSource, /const consumerNegotiationFollowup = Boolean\(/);
assert.match(workflowSource, /pddResolutionSubmission: current\.pddResolutionSubmission/);
assert.match(workflowSource, /consumerNegotiationFollowupRecovery: current\.consumerNegotiationFollowupRecovery/);
assert.match(
  workflowSource,
  /const isTransientPddResolutionStateChangedRejection = \(error\) => \([\s\S]{0,200}isDefinitivePddStateChangedRejection\(error\)[\s\S]{0,200}error\.stage === 'subjective-reason'/u,
  'a definitive state-change rejection at the non-committing subjective-reason step must refresh and re-evaluate',
);
assert.match(
  workflowSource,
  /const isDefinitivePddStateChangedRejection = \(error\) => \([\s\S]{0,300}PddSubmitRejectedError[\s\S]{0,300}工单状态发生变动\.\*刷新重试/u,
  'all definitive PDD state-change rejections must share the safe refresh classification',
);
assert.match(
  workflowSource,
  /isDefinitivePddStateChangedRejection\(error\)[\s\S]{0,1200}rejected-not-applied[\s\S]{0,1200}reopenPddDetailForResolution\([\s\S]{0,400}forcePendingList: true/u,
  'a definitive rejected submit must query the pending list before a bounded retry',
);
assert.match(
  workflowSource,
  /PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE[\s\S]{0,900}ordinary-pdd-state-changed-retry-ready/u,
  'exhausted state-change recovery must stay automatically retryable instead of becoming manual review',
);
assert.match(
  workflowSource,
  /isPddEvidenceUploadAuthorizationError\(error\)[\s\S]{0,120}isTransientPddResolutionStateChangedRejection\(error\)[\s\S]{0,180}maxAttempts = Math\.max\(maxAttempts, 3\)/u,
  'transient state-change recovery must remain bounded to three form attempts',
);
assert.match(workflowSource, /已有 TMS 工单的物流问题或客服备注与本次处理要求不一致/u);
assert.match(workflowSource, /soleRowText\.includes\(identifier\)/u);
assert.match(workflowSource, /saved-ticket-identifier-only-row/u);
assert.match(workflowSource, /TMS 物流问题选项未实际选中/u);
assert.match(workflowSource, /TMS 客服备注填写后回读不一致/u);
assert.match(workflowSource, /ordinaryEvidenceUpload: null,[\s\S]{0,160}logisticsWait/u);
assert.match(workflowSource, /const applyOrdinaryPddFormDecisionOnce = async/u);
assert.match(workflowSource, /const advanceOrdinaryPddMessageStageIfPresent = async/u);
assert.match(
  workflowSource,
  /advanceOrdinaryPddMessageStageIfPresent\([\s\S]{0,320}messageStageState\?\.messageStageSubmitted/u,
);
assert.match(workflowSource, /required-prefilled-message-stage-not-rendered/u);
assert.match(workflowSource, /messageStageSubmitted: true/u);
assert.match(workflowSource, /ordinary-pdd-message-submitted-awaiting-completion/u);
assert.match(workflowSource, /ordinary-\$\{scenarioCode\}-send-script-v1/u);
assert.match(
  workflowSource,
  /if \(state\?\.isCompleted && state\?\.orderMatches\)[\s\S]{0,500}ordinaryCompletionFromState\(orderNumber, scenarioCode, decision, state\)/u,
);
assert.match(workflowSource, /ordinary-stage-completed-directly/u);
assert.match(workflowSource, /const selectOrdinaryPddDateField = async/u);
assert.match(workflowSource, /data-testid\*="datePicker"/u);
assert.match(workflowSource, /element\.removeAttribute\('readonly'\)/u);
assert.match(workflowSource, /\{ datePicker: true \}/u);
assert.match(
  workflowSource,
  /step: 'ordinary-pdd-option-refreshing'[\s\S]{0,900}targetPage\.reload\(\{ waitUntil: 'domcontentloaded'/u,
);
assert.match(
  workflowSource,
  /currentPlatformWorkOrderId !== expectedPlatformWorkOrderId[\s\S]{0,300}navigateSystemPage\(targetPage, detailUrl, 'ordinary-pdd-option-recovery-detail'\)/u,
);
assert.match(
  workflowSource,
  /const recoveryRenderWaitMs = Math\.min\(pddRenderWaitMs, 30_000\)[\s\S]{0,300}waitForPddResolutionDetail\(targetPage, orderNumber,[\s\S]{0,200}settleMs: recoveryRenderWaitMs/u,
);
assert.match(
  workflowSource,
  /status: 'detail-ready'[\s\S]{0,900}status: 'retrying'[\s\S]{0,500}applyOrdinaryPddFormDecisionOnce/u,
);
assert.match(
  workflowSource,
  /status: 'failed'[\s\S]{0,600}pauseForTransientRetry\(targetPage, 'pdd-resolution-detail-loading', 'PDD_DETAIL_TEMPORARILY_UNAVAILABLE'/u,
  'a detail page that is still unreadable after refresh must enter bounded automatic retry without a manual notification',
);
assert.match(
  workflowSource,
  /const extractPddDetailWorkOrderType = [\s\S]{0,1000}const ordinaryWorkOrderTypesEquivalent =/u,
  'the rendered PDD detail title must be parsed independently from list discovery text',
);
assert.match(
  workflowSource,
  /ensurePddResolutionDetailReady[\s\S]{0,1400}return assertPddDetailWorkOrderType\(state\)/u,
  'resolution must reject a mismatched rendered work-order type before selecting or submitting any option',
);
assert.match(
  workflowSource,
  /reason: 'unsupported-detail-work-order-type'[\s\S]{0,900}continue;/u,
  'an unsupported real detail type must be skipped so it cannot inherit another scenario rule or block discovery',
);
assert.match(
  workflowSource,
  /const resolvedSelection = detailTypeMismatch \? \{[\s\S]{0,500}scenarioCode: detailScenario\.code/u,
  'a known detail type must replace a stale or mis-scoped list classification',
);
assert.match(
  workflowSource,
  /ordinaryPddOptionLookupFailure:[\s\S]{0,300}saveWorkflowDiagnostics\(targetPage, 'ordinary-pdd-option-missing'/u,
);
assert.match(
  workflowSource,
  /result = await applyOrdinaryPddFormDecisionOnce[\s\S]{0,500}status: 'failed'[\s\S]{0,200}throw retryError/u,
);
assert.match(
  workflowSource,
  /recoverCompletedDuringOptionSelection[\s\S]{0,1200}completed-page-detected[\s\S]{0,1200}if \(completedBeforeRefresh\) return completedBeforeRefresh/u,
);
assert.match(
  workflowSource,
  /completedAfterRefresh[\s\S]{0,120}return completedAfterRefresh/u,
);
const guardedOrdinarySubmitSource = workflowSource.slice(
  workflowSource.indexOf('const submitOrdinaryPddAction = async'),
  workflowSource.indexOf('const deleteOrdinaryEvidenceFile'),
);
assert.match(
  guardedOrdinarySubmitSource,
  /const guardedSubmission = await guardedExternalEffect\(\{[\s\S]*const formState = await applyOrdinaryPddFormDecision/u,
  'the PDD submit effect must be reserved before an option click can trigger verification or completion',
);
assert.match(
  guardedOrdinarySubmitSource,
  /clickPddSubmit\(targetPage, stage, orderNumber, \{[\s\S]{0,120}guard: false/u,
  'the final submit button must reuse the surrounding option-to-submit guard',
);
assert.match(
  guardedOrdinarySubmitSource,
  /completedDuringGuardedOptionSelection: true[\s\S]{0,260}completionTriggeredDuring: 'option-selection'/u,
  'completion triggered while selecting an option must remain auditable as a guarded automation action',
);
assert.match(
  guardedOrdinarySubmitSource,
  /let submitClickAttempted = false[\s\S]{0,4200}submitClickAttempted = true/u,
  'the PDD form recovery guard must track whether the final submit click was attempted',
);
assert.match(
  guardedOrdinarySubmitSource,
  /let submitAttemptCount = previousSubmitAttemptCount;[\s\S]{0,260}reservationAttemptCount/u,
  'reserving a PDD effect must not consume a real submit attempt',
);
assert.match(
  guardedOrdinarySubmitSource,
  /markOrdinaryPddSubmissionActionAttempt[\s\S]{0,260}submitAttemptCount = previousSubmitAttemptCount \+ 1/u,
  'a real PDD action must be the only place that consumes a submit attempt',
);
for (const trigger of [
  'option-selection-completed',
  'option-selection-or-render-transition-completed',
  'submit-button',
]) {
  assert.match(
    guardedOrdinarySubmitSource,
    new RegExp(`markOrdinaryPddSubmissionActionAttempt\\([\\s\\S]{0,80}'${trigger}'`, 'u'),
    `the ${trigger} action must persist its submit-attempt evidence`,
  );
}
assert.doesNotMatch(
  guardedOrdinarySubmitSource,
  /const submitAttemptCount = previousSubmitAttemptCount \+ 1/u,
  'a pre-submit reservation must never spend the submit-attempt budget',
);
assert.match(
  guardedOrdinarySubmitSource,
  /classifyOrdinaryPddPreSubmitFailure\([\s\S]{0,1200}status: 'form-retry'[\s\S]{0,300}submitAttemptCount: previousSubmitAttemptCount/u,
  'a read-only pending-page proof must restore the submit-attempt budget before retry',
);
assert.match(
  guardedOrdinarySubmitSource,
  /PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE[\s\S]{0,260}externalEffectStatus = 'failed'/u,
  'a proven pre-submit form failure must close the reserved effect as definitively not applied',
);
assert.match(
  guardedOrdinarySubmitSource,
  /submissionAfterFailure\?\.orderNumber === orderNumber[\s\S]{0,180}submitAttemptCount[\s\S]{0,350}throw error;[\s\S]*if \(isPddSessionExpiredError\(error\)\)/u,
  'after a submit click, upload or login recovery must not click the same PDD form again',
);
assert.match(workflowSource, /same-order-pending-editable-before-submit/u);
assert.match(
  workflowSource,
  /Object\.defineProperty\(reopenedError, 'ordinaryPddRecoveryTargetPage'[\s\S]{0,500}throw reopenedError/u,
  'a failed form on a reopened detail page must carry that page into read-only reconciliation',
);
assert.match(
  guardedOrdinarySubmitSource,
  /const proofPage = error\.ordinaryPddRecoveryTargetPage[\s\S]{0,700}readPddResolutionState\(proofPage[\s\S]{0,300}countVisibleEditableOrdinaryPddControls\(proofPage/u,
  'pre-submit reconciliation must inspect the current reopened detail page instead of a stale tab',
);
assert.match(
  workflowSource,
  /else if \(!knownCreatedTicket && filtered\.count > 1\) \{\s*row = filtered\.exactRows\.first\(\);\s*selectionStrategy = 'first-row';/u,
);
assert.match(workflowSource, /candidateCount: Number\(selection\?\.count \|\| 0\)/u);
assert.match(workflowSource, /selectionStrategy: selection\?\.selectionStrategy \|\| null/u);
assert.match(
  workflowSource,
  /step: 'pdd-scenario-evidence-failed'[\s\S]{0,260}status: 'failed'/u,
);
assert.match(
  workflowSource,
  /step: exhausted \? 'ordinary-evidence-upload-exhausted' : 'ordinary-evidence-upload-retrying'/u,
);
assert.match(workflowSource, /status: exhausted \? 'exhausted' : 'retrying'/u);
assert.match(workflowSource, /attempts: attempt,[\s\S]{0,180}failures,/u);
assert.match(workflowSource, /ordinaryInstanceId: entry\.ordinaryInstanceId \|\| null/u);
assert.match(workflowSource, /platformWorkOrderId: entry\.platformWorkOrderId \|\| null/u);
assert.match(workflowSource, /platformCaseKey: entry\.platformCaseKey \|\| null/u);
assert.match(
  workflowSource,
  /step: releasedDeferredWaitStep\(normalizedWaitKind\),[\s\S]{0,320}ordinaryInstanceId,[\s\S]{0,80}platformWorkOrderId,[\s\S]{0,80}platformCaseKey,/u,
  'deferred waits must retain ordinary identity while selecting the stage from the wait kind',
);
assert.match(workflowSource, /const verifyOrdinaryPddGeneratedMessage = async/u);
assert.match(workflowSource, /if \(pdd\.secondaryOption\)[\s\S]{0,180}selectOrdinaryPddOption/u);
assert.match(
  workflowSource,
  /if \(pdd\.deliveryAddress\)[\s\S]{0,420}送达地址[\s\S]{0,180}textareaPreferred: true/u,
);
assert.match(workflowSource, /if \(pdd\.courierPhone\)[\s\S]{0,160}快递员电话/u);
assert.match(workflowSource, /if \(pdd\.pickupAddress\)[\s\S]{0,140}自取地址/u);
assert.match(workflowSource, /decision\.actionCode === 'pdd-stage-submit'/u);
assert.match(workflowSource, /ordinary-\$\{scenarioCode\}-\$\{stageCode\}-v1/u);
assert.match(workflowSource, /delivered-not-received-oms-tms-flow/u);
assert.match(workflowSource, /consumer-refusal-oms-tms-flow/u);
assert.match(workflowSource, /tms-delivery-contact-evidence/u);
assert.match(workflowSource, /ordinary-delivered-not-received-contact-v1/u);
assert.match(workflowSource, /problemType: deliveredNotReceived \? '签收未收到' : '拦截退回'/u);
assert.match(workflowSource, /消费者明确拒收，请拦截退回包裹/u);
assert.match(
  workflowSource,
  /const collectReverseSignedRefundLogistics = async[\s\S]{0,420}returned\.hasData \? null : await readOpenLogistics\('发货物流'\)/u,
  '逆向物流已签收退款必须仅在退货物流无数据时读取发货物流',
);
assert.match(
  workflowSource,
  /\$\{stagePrefix\}-\$\{label === '退货物流' \? 'return' : 'shipping'\}-logistics-render[\s\S]{0,260}30_000/u,
  '物流标签渲染失败必须使用 30 秒自动复查而不是转人工',
);
assert.match(
  workflowSource,
  /const hasData = rawTimeline\.length > 0;[\s\S]{0,260}emptyStateVisible: !hasData/u,
  '当前已展开物流标签解析出的有效节点必须优先于页面其他区域的空状态文字',
);

console.log('ordinary work-order policy self-test passed');
