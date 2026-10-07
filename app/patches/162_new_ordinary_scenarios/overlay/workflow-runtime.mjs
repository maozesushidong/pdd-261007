export const resolveSystemUrl = (candidate, expectedOrigin, fallback) => {
  try {
    const parsed = new URL(candidate || fallback);
    return parsed.origin === expectedOrigin ? parsed.href : fallback;
  } catch {
    return fallback;
  }
};

export const resolveBusinessUrl = (
  candidate,
  expectedOrigin,
  fallback,
  rejectedPathPatterns = [],
) => {
  const resolved = resolveSystemUrl(candidate, expectedOrigin, fallback);
  const parsed = new URL(resolved);
  return rejectedPathPatterns.some((pattern) => pattern.test(parsed.pathname)) ? fallback : resolved;
};

export const archiveReadiness = (progress, completion) => {
  if (completion?.status !== 'succeeded'
    || completion.orderNumber !== progress.orderNumber
    || progress.pddResolutionSubmission?.status !== 'succeeded') {
    return { ready: false, reason: 'completion-incomplete' };
  }
  const trustedCompletedPageRecovery = completion.recoveredFromCompletedPage === true
    && ['detail-completed', 'handover-detail-completed'].includes(completion.confirmationMethod);
  const trustedDirectSubmission = completion.submitClicked === true
    && completion.submitReceipt?.success === true
    && completion.transitionConfirmed === true;
  if (!trustedCompletedPageRecovery
    && !trustedDirectSubmission
    && completion.completionEvidence
    && completion.outcome
    && completion.completionEvidence !== completion.outcome) {
    return { ready: false, reason: 'completion-outcome-mismatch' };
  }
  const evidenceConsumed = (evidence) => evidence == null || evidence.status === 'deleted';
  if (!evidenceConsumed(progress.pddEvidenceScreenshot)
    || !evidenceConsumed(progress.tmsEvidenceScreenshot)
    || !evidenceConsumed(progress.tmsEvidenceDisposition)) {
    return { ready: false, reason: 'evidence-not-consumed' };
  }
  return { ready: true, reason: null };
};

export const canDiscardRecoveredCompletionOrphanEvidence = (progress, completion) => {
  if (completion?.status !== 'succeeded'
    || completion.orderNumber !== progress?.orderNumber
    || completion.recoveredFromCompletedPage !== true
    || progress?.pddEvidenceScreenshot?.status !== 'ready'
    || progress.pddEvidenceScreenshot.orderNumber !== completion.orderNumber
    || progress.tmsWorkOrder != null
    || progress.tmsEvidenceScreenshot != null
    || progress.tmsEvidenceDisposition != null
    || progress.pddEvidenceUpload != null) return false;

  if (['detail-completed', 'handover-detail-completed'].includes(completion.confirmationMethod)) {
    return true;
  }
  if (!['absent-from-pending-list', 'handover-absent-from-pending-list']
    .includes(completion.confirmationMethod)) return false;

  const presence = progress.pddResolutionPendingListPresence;
  return presence?.orderNumber === completion.orderNumber
    && presence.present === false
    && presence.refreshed === true
    && ['two-pass-exact-order-query', 'exact-order-zero-result']
      .includes(presence.confirmationMethod);
};

export const canDiscardConsumerNegotiationFollowupEvidence = (progress, completion) => {
  const recovery = progress?.consumerNegotiationFollowupRecovery
    || progress?.consumerNegotiationFollowupRecovery206
    || {};
  return completion?.status === 'succeeded'
    && completion.orderNumber === progress?.orderNumber
    && completion.recoveredFromCompletedPage === true
    && completion.confirmationMethod === 'detail-completed'
    && ['同意退款', '已同意退货退款'].includes(completion.outcome)
    && progress?.pddResolutionFlow?.flowCode === 'consumer-negotiation-followup'
    && recovery.strategy === 'resume-pdd-followup-without-oms-or-tms-replay';
};

export const bypassedTmsPddEvidenceCleanupMode = (progress, completion, shopId) => {
  if (progress?.scenarioCode !== 'abnormal-network-warning'
    || completion?.status !== 'succeeded'
    || !completion.orderNumber
    || completion.orderNumber !== progress?.orderNumber
    || progress?.tmsBypass?.status !== 'skipped') return 'not-applicable';

  const bypass = progress.tmsBypass;
  if (bypass.orderNumber !== completion.orderNumber
    || (bypass.shopId && bypass.shopId !== shopId)) return 'unsafe';

  const evidence = progress.pddEvidenceScreenshot;
  if (evidence == null) return 'not-created';
  const orderMatches = evidence.orderNumber === completion.orderNumber;
  const shopMatches = !evidence.shopId || evidence.shopId === shopId;
  if (evidence.status === 'deleted' && orderMatches && shopMatches) return 'already-deleted';
  if (evidence.status === 'ready' && orderMatches && shopMatches) return 'delete-ready';
  return 'unsafe';
};

export const nextProgressAfterCompletion = ({
  progress,
  completion,
  targetWorkOrderTitle,
  browserMode,
  workflowDataDir,
  completedCount,
  archivedAt,
}) => ({
  run: 'continuous-work-order-loop',
  step: 'next-order-ready',
  targetWorkOrderTitle,
  browserMode,
  workflowDataDir,
  systemTabs: progress.systemTabs,
  authHealth: progress.authHealth,
  authCheckpoint: progress.authCheckpoint,
  pddShopIdentity: progress.pddShopIdentity,
  lastCompletedOrder: {
    orderNumber: completion.orderNumber,
    ordinaryInstanceId: progress.ordinaryInstanceId || completion.ordinaryInstanceId || null,
    platformWorkOrderId: progress.platformWorkOrderId || completion.platformWorkOrderId || null,
    platformCaseKey: progress.platformCaseKey || completion.platformCaseKey || null,
    outcome: completion.outcome,
    completedAt: completion.completedAt,
    confirmationMethod: completion.confirmationMethod,
    recoveredFromCompletedPage: completion.recoveredFromCompletedPage === true,
    archivedAt,
  },
  loopState: {
    status: 'processing',
    completedCount,
    currentOrderNumber: null,
    nextPollAt: null,
  },
  error: null,
});

export const calculateNextPollAt = (nowMs, pollMs) => new Date(nowMs + pollMs).toISOString();

if (process.argv.includes('--self-test')) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  assert(resolveSystemUrl('https://mms.pinduoduo.com/path', 'https://mms.pinduoduo.com', 'fallback')
    === 'https://mms.pinduoduo.com/path', '同源业务 URL 应保留');
  assert(resolveSystemUrl('https://example.com/path', 'https://mms.pinduoduo.com', 'fallback')
    === 'fallback', '跨域恢复 URL 必须回退');
  assert(resolveBusinessUrl(
    'https://www.jeoms.com/xianma/login',
    'https://www.jeoms.com',
    'https://www.jeoms.com/xianma/trade/sales',
    [/\/xianma\/login(?:\/|$)/],
  ) === 'https://www.jeoms.com/xianma/trade/sales', '登录页 URL 必须回退到业务页面');
  assert(resolveBusinessUrl(
    'https://www.jeoms.com/xianma/trade/sales',
    'https://www.jeoms.com',
    'https://www.jeoms.com/xianma/trade/sales',
    [/\/xianma\/login(?:\/|$)/],
  ) === 'https://www.jeoms.com/xianma/trade/sales', '有效业务 URL 应保留');

  const completion = {
    status: 'succeeded',
    orderNumber: '260724-623923709552188',
    outcome: '同意退款',
    completedAt: '2026-07-27T10:00:00.000Z',
    confirmationMethod: 'absent-from-pending-list',
  };
  const readyProgress = {
    orderNumber: completion.orderNumber,
    ordinaryInstanceId: '00000000-0000-4000-8000-000000000001',
    platformWorkOrderId: '500012345678901',
    platformCaseKey: 'pdd-work-order:500012345678901',
    pddResolutionSubmission: completion,
    pddEvidenceScreenshot: { status: 'deleted' },
    tmsEvidenceScreenshot: { status: 'deleted' },
    tmsEvidenceDisposition: { status: 'deleted' },
    systemTabs: { activeSystem: 'pdd' },
    pddShopIdentity: { status: 'detected', actualShopName: 'Self-test shop' },
  };
  assert(archiveReadiness(readyProgress, completion).ready, '证据已消费的完成订单应允许归档');
  assert(archiveReadiness({
    ...readyProgress,
    pddEvidenceScreenshot: null,
    tmsEvidenceScreenshot: null,
    tmsEvidenceDisposition: null,
  }, completion).ready, '从未生成证据对象的完成订单也应允许归档');
  assert(!archiveReadiness({
    ...readyProgress,
    pddEvidenceScreenshot: {},
  }, completion).ready, '已存在但状态不明的证据对象必须禁止归档');
  assert(!archiveReadiness({
    ...readyProgress,
    tmsEvidenceScreenshot: { status: 'ready' },
  }, completion).ready, 'TMS 截图未消费时必须禁止归档');
  assert(archiveReadiness(readyProgress, {
    ...completion,
    completionEvidence: '无法按照建议快递发货',
    outcome: '已按照建议快递发货',
  }).reason === 'completion-outcome-mismatch', '平台完结结果与预期不一致时必须禁止归档');

  assert(archiveReadiness(readyProgress, {
    ...completion,
    completionEvidence: '同意退款',
    outcome: '已进行召回',
    recoveredFromCompletedPage: true,
    confirmationMethod: 'detail-completed',
  }).ready, '详情页明确完结时不应因平台结果文案与规则选项不同而阻止归档');
  assert(archiveReadiness(readyProgress, {
    ...completion,
    outcome: '消费者已收到货',
    completionEvidence: '已同意退货退款',
    submitClicked: true,
    submitReceipt: { success: true, httpStatus: 200 },
    transitionConfirmed: true,
  }).ready, '本次提交有成功回执且页面已跳转时，完成页其他业务文案不得阻止归档');
  assert(archiveReadiness(readyProgress, {
    ...completion,
    outcome: '消费者已收到货',
    completionEvidence: '已同意退货退款',
    submitClicked: true,
    submitReceipt: { success: true, httpStatus: 200 },
    transitionConfirmed: false,
  }).reason === 'completion-outcome-mismatch', '只有成功回执但没有页面跳转证据时仍必须禁止结果不一致归档');

  const orphanEvidenceRecovery = {
    ...completion,
    recoveredFromCompletedPage: true,
  };
  const orphanEvidenceProgress = {
    ...readyProgress,
    pddResolutionSubmission: orphanEvidenceRecovery,
    pddEvidenceScreenshot: { status: 'ready', orderNumber: completion.orderNumber },
    tmsEvidenceScreenshot: null,
    tmsEvidenceDisposition: null,
    pddResolutionPendingListPresence: {
      orderNumber: completion.orderNumber,
      present: false,
      refreshed: true,
      confirmationMethod: 'exact-order-zero-result',
    },
  };
  assert(canDiscardRecoveredCompletionOrphanEvidence(
    orphanEvidenceProgress,
    orphanEvidenceRecovery,
  ), 'refreshed exact-zero recovery should permit orphan evidence cleanup');
  assert(!canDiscardRecoveredCompletionOrphanEvidence({
    ...orphanEvidenceProgress,
    pddResolutionPendingListPresence: {
      ...orphanEvidenceProgress.pddResolutionPendingListPresence,
      refreshed: false,
    },
  }, orphanEvidenceRecovery), 'unrefreshed absence must not permit evidence cleanup');
  assert(!canDiscardRecoveredCompletionOrphanEvidence({
    ...orphanEvidenceProgress,
    tmsWorkOrder: { status: 'created' },
  }, orphanEvidenceRecovery), 'existing TMS state must retain the normal evidence guard');

  assert(canDiscardConsumerNegotiationFollowupEvidence({
    ...orphanEvidenceProgress,
    pddResolutionFlow: { flowCode: 'consumer-negotiation-followup' },
    consumerNegotiationFollowupRecovery206: {
      strategy: 'resume-pdd-followup-without-oms-or-tms-replay',
    },
  }, {
    ...orphanEvidenceRecovery,
    outcome: '同意退款',
    confirmationMethod: 'detail-completed',
  }), 'confirmed consumer-negotiation completion should permit its stale temporary evidence cleanup');
  assert(!canDiscardConsumerNegotiationFollowupEvidence({
    ...orphanEvidenceProgress,
    pddResolutionFlow: { flowCode: 'consumer-negotiation-followup' },
  }, {
    ...orphanEvidenceRecovery,
    outcome: '同意退款',
    confirmationMethod: 'detail-completed',
  }), 'consumer-negotiation cleanup must require an explicit direct-resume recovery marker');

  const abnormalCompletion = {
    status: 'succeeded',
    orderNumber: completion.orderNumber,
  };
  const abnormalBypassProgress = {
    orderNumber: completion.orderNumber,
    scenarioCode: 'abnormal-network-warning',
    tmsBypass: {
      status: 'skipped',
      shopId: 'shop-a',
      orderNumber: completion.orderNumber,
    },
    pddEvidenceScreenshot: null,
  };
  assert(bypassedTmsPddEvidenceCleanupMode(
    abnormalBypassProgress,
    abnormalCompletion,
    'shop-a',
  ) === 'not-created', '异常网点跳过 TMS 且未创建拼多多截图时应直接完成收尾');
  assert(bypassedTmsPddEvidenceCleanupMode({
    ...abnormalBypassProgress,
    pddEvidenceScreenshot: {
      status: 'ready',
      shopId: 'shop-a',
      orderNumber: completion.orderNumber,
    },
  }, abnormalCompletion, 'shop-a') === 'delete-ready', '当前店铺的有效临时截图应按原逻辑清理');
  assert(bypassedTmsPddEvidenceCleanupMode({
    ...abnormalBypassProgress,
    pddEvidenceScreenshot: {
      status: 'ready',
      shopId: 'shop-b',
      orderNumber: completion.orderNumber,
    },
  }, abnormalCompletion, 'shop-a') === 'unsafe', '其他店铺的截图不得被异常网点收尾逻辑删除');

  const next = nextProgressAfterCompletion({
    progress: readyProgress,
    completion,
    targetWorkOrderTitle: '订单问题：在途无理由退款处理',
    browserMode: 'server-headed',
    workflowDataDir: '/var/lib/pdd-workflow/shops/test',
    completedCount: 3,
    archivedAt: '2026-07-27T10:01:00.000Z',
  });
  assert(next.loopState.completedCount === 3
    && next.loopState.currentOrderNumber === null
    && next.lastCompletedOrder.orderNumber === completion.orderNumber
    && next.lastCompletedOrder.ordinaryInstanceId === readyProgress.ordinaryInstanceId
    && next.lastCompletedOrder.platformCaseKey === readyProgress.platformCaseKey
    && next.lastCompletedOrder.recoveredFromCompletedPage === false
    && next.pddShopIdentity === readyProgress.pddShopIdentity
    && !Object.hasOwn(next, 'tmsWorkOrder'), '下一单进度必须清除订单级字段');
  const recoveredNext = nextProgressAfterCompletion({
    progress: orphanEvidenceProgress,
    completion: orphanEvidenceRecovery,
    targetWorkOrderTitle: 'recovery',
    browserMode: 'server-headed',
    workflowDataDir: '/var/lib/pdd-workflow/shops/test',
    completedCount: 4,
    archivedAt: '2026-07-27T10:02:00.000Z',
  });
  assert(recoveredNext.lastCompletedOrder.recoveredFromCompletedPage === true,
    'completion compaction must preserve the recovered-order metric marker');
  assert(calculateNextPollAt(Date.parse('2026-07-27T10:00:00.000Z'), 300000)
    === '2026-07-27T10:05:00.000Z', '空队列轮询时间计算错误');
  console.log('三标签恢复、完成归档和连续队列运行时自测通过');
}
