import assert from 'node:assert/strict';
import { analyzeIncompleteWorkflow } from '../apps/api/src/incomplete-workflow-analysis.mjs';

const analyze = (value) => analyzeIncompleteWorkflow({ runtimeStatus: 'failed', currentStep: 'flow-paused', ...value });

assert.equal(analyzeIncompleteWorkflow({
  runtimeStatus: 'completed',
  currentStep: 'full-business-flow-complete',
  completionState: 'confirmed',
}), null);

assert.equal(
  analyzeIncompleteWorkflow({ runtimeStatus: 'completed', currentStep: 'operator-manual-complete' }).reason,
  '工单记录已结束，但缺少平台完成证据。',
);

const remarkAnalysis = analyze({
  payload: { manualReview: { stage: 'pdd-order-remark', reason: '流程需要人工复核（阶段: pdd-order-remark）：拼多多订单信息区域未找到查看详情' } },
});
assert.equal(remarkAnalysis.reasonZh, '拼多多订单备注未完成，需要人工处理。');
assert.equal(remarkAnalysis.reasonEn, 'The PDD order remark was not completed and requires manual handling.');
assert.equal(remarkAnalysis.stoppedStep, 'pdd-order-remark');
assert.equal(remarkAnalysis.stoppedStepZh, '拼多多订单备注阶段');
assert.equal(remarkAnalysis.stoppedStepEn, 'PDD order remark');
assert.match(remarkAnalysis.descriptionZh, /程序停在“拼多多订单备注阶段”/u);
assert.match(remarkAnalysis.descriptionEn, /stopped at the "PDD order remark" step/i);

assert.equal(analyze({
  currentStep: 'manual-review-blocked',
  diagnosticIntervention: { reason: '发货仓库不一致', status: 'open' },
  payload: { tmsAutofillVerification: { actual: { warehouse: '筑越仓' } } },
}).reasonZh, 'OMS 与 TMS 的发货仓库信息不一致。');

const consumerResponseWaitAnalysis = analyzeIncompleteWorkflow({
  runtimeStatus: 'retry-ready',
  currentStep: 'consumer-response-waiting-released',
  payload: {
    pddResolutionFlow: { flowCode: 'consumer-negotiation-followup' },
    pddResolutionSubmission: {
      status: 'followup-waiting',
      consumerResponseWaitStartedAt: '2026-08-24T04:00:00.000Z',
      consumerResponseNextAttemptAt: '2026-08-24T16:00:00.000Z',
    },
    logisticsWait: {
      waitKind: 'consumer-response',
      reason: '拼多多正在等待消费者确认拦截后退款方案，满 12 小时仍无回复后再自动处理',
      lastCheckedAt: '2026-08-24T04:00:00.000Z',
    },
  },
});
assert.equal(consumerResponseWaitAnalysis.reasonZh,
  '正在等待消费者确认拦截退款方案，到期后程序会自动继续。');
assert.equal(consumerResponseWaitAnalysis.reasonEn,
  'The automation is waiting for the consumer response and will continue automatically when the wait expires.');
assert.equal(consumerResponseWaitAnalysis.stoppedStep, 'consumer-response-waiting-released');
assert.equal(consumerResponseWaitAnalysis.stoppedStepZh, '消费者回复等待阶段');

const legacyConsumerResponseWaitAnalysis = analyzeIncompleteWorkflow({
  runtimeStatus: 'retry-ready',
  currentStep: 'logistics-waiting-released',
  payload: {
    pddResolutionFlow: { flowCode: 'consumer-negotiation-followup' },
    pddResolutionSubmission: { status: 'followup-waiting' },
    logisticsWait: {
      reason: '拼多多正在等待消费者确认拦截后退款方案，满 12 小时仍无回复后再自动处理',
    },
  },
});
assert.equal(legacyConsumerResponseWaitAnalysis.stoppedStep,
  'consumer-response-waiting-released',
  'legacy shared wait snapshots must be diagnosed as consumer-response waits before migration');

const staleLogisticsEventConsumerResponseWaitAnalysis = analyzeIncompleteWorkflow({
  runtimeStatus: 'retry-ready',
  currentStep: 'consumer-response-waiting-released',
  diagnosticEvent: {
    stage: 'logistics-waiting-released',
    eventType: 'workflow.progress-replaced',
    reasonCode: 'waiting-logistics',
    message: '拼多多正在等待消费者确认拦截后退款方案，满 12 小时仍无回复后再自动处理',
    occurredAt: '2026-08-24T04:00:01.000Z',
  },
  payload: {
    pddResolutionFlow: { flowCode: 'consumer-negotiation-followup' },
    pddResolutionSubmission: { status: 'followup-waiting' },
    logisticsWait: {
      waitKind: 'consumer-response',
      reason: '拼多多正在等待消费者确认拦截后退款方案，满 12 小时仍无回复后再自动处理',
      lastCheckedAt: '2026-08-24T04:00:00.000Z',
    },
  },
});
assert.equal(staleLogisticsEventConsumerResponseWaitAnalysis.stoppedStep,
  'consumer-response-waiting-released',
  'the authoritative consumer wait must override a stale logistics event stage');
assert.equal(staleLogisticsEventConsumerResponseWaitAnalysis.stoppedStepZh,
  '消费者回复等待阶段');
assert.equal(staleLogisticsEventConsumerResponseWaitAnalysis.source,
  'consumer-response-wait');

assert.equal(analyze({
  diagnosticEvent: {
    stage: 'logistics-waiting-released', eventType: 'workflow.progress-replaced', reasonCode: 'waiting-logistics',
    message: '拼多多当前没有快递、运单号或物流轨迹，等待下一轮物流更新',
  },
  payload: { error: 'oms 标签页不可用' },
}).stoppedStep, 'logistics-waiting-released');

const outcomeMismatchAnalysis = analyzeIncompleteWorkflow({
  runtimeStatus: 'manual-review',
  currentStep: 'pdd-resolution-outcome-mismatch',
  manualReviewReason: '平台已完结但选项错误：预期“已按照建议快递发货”，实际“无法按照建议快递发货”。',
  diagnosticEvent: {
    stage: 'logistics-waiting-released',
    eventType: 'workflow.progress-replaced',
    message: '拼多多当前没有快递、运单号或物流轨迹，等待下一轮物流更新',
  },
  payload: {
    manualReview: {
      stage: 'pdd-resolution-outcome-mismatch',
      reason: '平台已完结但选项错误：预期“已按照建议快递发货”，实际“无法按照建议快递发货”。',
      requiredAt: '2026-08-03T05:56:10.000Z',
    },
  },
});
assert.equal(outcomeMismatchAnalysis.reasonZh, '拼多多最终处理选项与建议结果不一致。');
assert.equal(outcomeMismatchAnalysis.reasonEn, 'The final PDD resolution option does not match the recommended result.');
assert.equal(outcomeMismatchAnalysis.stoppedStep, 'pdd-resolution-outcome-mismatch');
assert.equal(outcomeMismatchAnalysis.diagnosedAt, '2026-08-03T05:56:10.000Z');

assert.equal(analyze({ payload: { error: 'OMS 订单管理页面未渲染订单查询输入框' } }).stoppedStep, 'oms-order-search');
const navigationAnalysis = analyze({ payload: { error: 'page.goto: Target page, context or browser has been closed at workflow.mjs:120' } });
assert.equal(navigationAnalysis.reasonZh, '页面跳转过程中浏览器页面被关闭。');
assert.equal(navigationAnalysis.reasonEn, 'The browser page was closed during navigation.');
assert.doesNotMatch(navigationAnalysis.descriptionZh, /page\.goto|workflow\.mjs/i);
assert.doesNotMatch(navigationAnalysis.descriptionEn, /page\.goto|workflow\.mjs/i);
assert.equal(analyze({ currentStep: 'manual-login-required', manualReviewReason: 'staging reset: start fresh' }).reasonZh, '平台登录状态不可用，正在等待重新登录。');
assert.equal(analyze({ currentStep: 'manual-login-required', diagnosticIntervention: { reason: 'login-required' } }).reasonEn, 'The platform session is unavailable and is waiting for a new login.');

console.log('incomplete workflow analysis self-test passed');
