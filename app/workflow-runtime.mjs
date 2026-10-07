import { verifiedProactiveSummaryMatchesCompletion } from './packages/adapters/src/pdd/proactive-terminal-proof.mjs';
import { verifiedInterceptSummaryMatchesCompletion } from './packages/adapters/src/pdd/intercept-terminal-proof.mjs';

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

const exactOrdinaryTerminalOutcomeScenarios = new Set([
  'intercept-recall',
  'proactive-logistics-service',
  'delivered-not-received',
]);

export const ordinaryTerminalOutcomeConflicts = ({ scenarioCode, expectedOutcome, observedOutcome }) => {
  const expected = String(expectedOutcome || '').normalize('NFKC').trim();
  const observed = String(observedOutcome || '').normalize('NFKC').trim();
  if (scenarioCode === 'product-shortage'
    && expected === 'product-shortage-chat-no-shortage-feedback-ready') {
    return ['已同意退货退款', '同意退款', '同意消费者退款申请']
      .some((refundOutcome) => observed.includes(refundOutcome));
  }
  if (!exactOrdinaryTerminalOutcomeScenarios.has(scenarioCode)) return false;
  return Boolean(expected && observed && !observed.includes(expected));
};

const renderedOrdinaryDetailMethods = new Set([
  'detail-completed',
  'refreshed-detail-completed',
  'handover-detail-completed',
  'recall-status-detail-completed',
]);

export const renderedOrdinaryCompletionObservation = (
  state, observedAt, expectedPlatformWorkOrderId = null,
) => {
  if (state?.isCompleted !== true || state?.orderMatches !== true) return null;
  const method = renderedOrdinaryDetailMethods.has(state.confirmationMethod)
    ? state.confirmationMethod
    : state.detailReady === true && state.isExpectedWorkOrderType === true
      ? 'detail-completed' : null;
  if (!method) return null;
  const observedPlatformWorkOrderId = String(state.observedPlatformWorkOrderId || '').trim();
  const expectedCaseId = String(expectedPlatformWorkOrderId || '').trim();
  const observedCaseIsValid = /^\d{6,30}$/u.test(observedPlatformWorkOrderId);
  return {
    isCompleted: true,
    orderMatches: true,
    confirmationMethod: method,
    observedAt,
    ...(observedCaseIsValid ? {
      observedPlatformWorkOrderId,
      ...(/^\d{6,30}$/u.test(expectedCaseId)
        ? { platformCaseMatches: observedPlatformWorkOrderId === expectedCaseId } : {}),
    } : {}),
  };
};

export const legacyResolutionCompletionObservation = (
  state, expectedPlatformWorkOrderId, observedAt,
) => {
  if (state?.confirmationMethod === 'absent-from-pending-list') {
    return { valid: true, observation: null };
  }
  if (state?.detailReady !== true) {
    return { valid: false, reason: 'completed-detail-not-rendered' };
  }
  const observation = renderedOrdinaryCompletionObservation(
    { ...state, confirmationMethod: state.confirmationMethod || 'detail-completed' },
    observedAt,
    expectedPlatformWorkOrderId,
  );
  if (!observation) return { valid: false, reason: 'completed-detail-not-rendered' };
  if (/^\d{6,30}$/u.test(String(expectedPlatformWorkOrderId || '').trim())
    && observation.platformCaseMatches !== true) {
    return { valid: false, reason: 'completed-detail-platform-case-mismatch' };
  }
  return { valid: true, observation };
};

export const rejectedSubmitPendingListAbsenceNeedsReview = (progress, orderNumber) => {
  const recovery = progress?.ordinaryPddStateChangedRecovery;
  const submission = progress?.pddResolutionSubmission;
  return Boolean(recovery?.orderNumber === orderNumber
    && ['reconciling', 'retrying', 'retry-ready'].includes(recovery.status)
    && submission?.submitReceipt?.success !== true);
};

export const archiveReadiness = (progress, completion) => {
  if (completion?.status !== 'succeeded'
    || completion.orderNumber !== progress.orderNumber
    || progress.pddResolutionSubmission?.status !== 'succeeded') {
    return { ready: false, reason: 'completion-incomplete' };
  }
  if (completion.platformCompletionObservation?.platformCaseMatches === false) {
    return { ready: false, reason: 'completion-platform-case-mismatch' };
  }
  if (completion.confirmationMethod === 'exact-order-completed') {
    return { ready: false, reason: 'list-completion-detail-required' };
  }
  if (['absent-from-pending-list', 'handover-absent-from-pending-list']
    .includes(completion.confirmationMethod)
    && completion.submitReceipt?.success !== true
    && rejectedSubmitPendingListAbsenceNeedsReview(progress, completion.orderNumber)) {
    // An exact zero-result only proves the case left the actionable queue.
    // It cannot turn a platform-rejected submit into the planned outcome.
    return { ready: false, reason: 'rejected-submit-pending-absence-only' };
  }
  if ((completion.scenarioCode || progress.scenarioCode) === 'consumer-address-change-in-transit') {
    const proof = completion.completionServiceEvidence || {};
    if (proof.confirmed !== true || proof.orderMatches !== true
      || proof.completedTitle !== true || proof.noForm !== true
      || proof.stage1Record !== true || proof.stage2Record !== true) {
      return { ready: false, reason: 'in-transit-address-change-stages-unverified' };
    }
  }
  const trustedCompletedPageRecovery = completion.recoveredFromCompletedPage === true
    && ['detail-completed', 'handover-detail-completed'].includes(completion.confirmationMethod);
  const trustedDirectSubmission = completion.submitClicked === true
    && completion.submitReceipt?.success === true
    && completion.transitionConfirmed === true;
  // These two scenarios have produced completed pages with a different
  // business result despite a successful submitForm response. A confirmed
  // click proves an action happened, not that the selected result was applied.
  if (completion.submitClicked === true && ordinaryTerminalOutcomeConflicts({
    scenarioCode: completion.scenarioCode || progress.scenarioCode,
    expectedOutcome: completion.outcome,
    observedOutcome: completion.completionEvidence,
  }) && !verifiedProactiveSummaryMatchesCompletion({
    proof: progress.pddProactiveTerminalDetailProof,
    progress,
    completion,
    scenarioCode: completion.scenarioCode || progress.scenarioCode,
    expectedOutcome: completion.outcome,
    observedOutcome: completion.completionEvidence,
    observedResultOption: completion.completionResultOption,
  }) && !verifiedInterceptSummaryMatchesCompletion({
    proof: progress.pddInterceptTerminalDetailProof,
    progress,
    completion,
    scenarioCode: completion.scenarioCode || progress.scenarioCode,
    expectedOutcome: completion.outcome,
    observedOutcome: completion.completionEvidence,
    observedResultOption: completion.completionResultOption,
  })) {
    return { ready: false, reason: 'completion-outcome-mismatch' };
  }
  // Older address-change checkpoints stored both service records in the
  // outcome field. Accept that exact legacy shape only when the same order
  // and platform case have all of the scenario's completed-page proofs.
  const addressChange = progress.consumerAddressChange || {};
  const addressState = addressChange.lastVerifiedState || {};
  const trustedLegacyAddressChange = progress.scenarioCode === 'consumer-address-change'
    && completion.scenarioCode === progress.scenarioCode
    && Boolean(progress.shopId) && completion.shopId === progress.shopId
    && completion.confirmationMethod === 'address-change-completed-with-both-service-records'
    && completion.outcome === '协商退款重拍'
    && completion.completionResultOption === completion.outcome
    && progress.pddResolutionSubmission.outcome === completion.outcome
    && completion.completionEvidence === '不同意修改地址：包裹已打包完成；协商退款重拍'
    && addressChange.orderNumber === completion.orderNumber
    && Boolean(progress.platformCaseKey)
    && addressChange.platformCaseKey === progress.platformCaseKey
    && addressState.titleStatus === '已完结'
    && ['complete', 'noForm', 'orderMatches', 'rejectionProof', 'negotiationProof', 'creationProof']
      .every((field) => addressState[field] === true);
  if (!trustedCompletedPageRecovery
    && !trustedDirectSubmission
    && !trustedLegacyAddressChange
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
}) => {
  const presence = progress.pddResolutionPendingListPresence;
  const pendingListProof = presence?.orderNumber === completion.orderNumber
    && presence.present === false
    && presence.refreshed === true
    && presence.exactShopIdentity === true
    && presence.confirmedAt
    && ['two-pass-exact-order-query', 'exact-order-zero-result']
      .includes(presence.confirmationMethod)
    ? {
      orderNumber: presence.orderNumber,
      present: false,
      refreshed: true,
      exactShopIdentity: true,
      confirmationMethod: presence.confirmationMethod,
      confirmedAt: presence.confirmedAt || null,
    }
    : null;
  const pageObservation = completion.platformCompletionObservation;
  const platformCompletionObservation = pageObservation
    && pageObservation.isCompleted === true
    && pageObservation.orderMatches === true
    && renderedOrdinaryDetailMethods.has(pageObservation.confirmationMethod)
    && pageObservation.observedAt
    ? {
      isCompleted: true,
      orderMatches: true,
      confirmationMethod: pageObservation.confirmationMethod,
      observedAt: pageObservation.observedAt,
      ...(pageObservation.observedPlatformWorkOrderId
        ? { observedPlatformWorkOrderId: pageObservation.observedPlatformWorkOrderId } : {}),
      ...(typeof pageObservation.platformCaseMatches === 'boolean'
        ? { platformCaseMatches: pageObservation.platformCaseMatches } : {}),
    }
    : null;
  return {
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
      ...(completion.completionEvidence
        ? { completionEvidence: completion.completionEvidence } : {}),
      ...(completion.completionResultOption
        ? { completionResultOption: completion.completionResultOption } : {}),
      completedAt: completion.completedAt,
      confirmationMethod: completion.confirmationMethod,
      recoveredFromCompletedPage: completion.recoveredFromCompletedPage === true,
      ...(completion.completionServiceEvidence
        ? { completionServiceEvidence: completion.completionServiceEvidence } : {}),
      ...(platformCompletionObservation ? { platformCompletionObservation } : {}),
      ...(pendingListProof ? { pendingListProof } : {}),
      archivedAt,
    },
    loopState: {
      status: 'processing',
      completedCount,
      currentOrderNumber: null,
      nextPollAt: null,
    },
    error: null,
  };
};

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
  const detailObservation = renderedOrdinaryCompletionObservation({
    isCompleted: true, orderMatches: true, detailReady: true,
    isExpectedWorkOrderType: true,
  }, '2026-07-27T10:00:00.000Z');
  assert(detailObservation?.confirmationMethod === 'detail-completed'
    && detailObservation.orderMatches === true
    && !Object.hasOwn(detailObservation, 'observedPlatformWorkOrderId'),
  '同单已完结的实际详情页应保存观察依据');
  const legacyState = {
    isCompleted: true, orderMatches: true, detailReady: true,
    observedPlatformWorkOrderId: '500012972023345',
  };
  const legacyProof = legacyResolutionCompletionObservation(
    legacyState, '500012972023345', '2026-07-27T10:00:00.000Z',
  );
  assert(legacyProof.valid && legacyProof.observation?.platformCaseMatches === true,
    '旧流程已完结详情必须保存同平台工单号证据');
  assert(legacyResolutionCompletionObservation({
    ...legacyState, observedPlatformWorkOrderId: '500012972023346',
  }, '500012972023345', '2026-07-27T10:00:00.000Z').valid === false,
  '同订单的另一平台工单号不得借已完结页面归档');
  assert(legacyResolutionCompletionObservation({
    ...legacyState, detailReady: false,
  }, '500012972023345', '2026-07-27T10:00:00.000Z').valid === false,
  '未渲染的详情不能作为已完结证据');
  assert(legacyResolutionCompletionObservation({
    confirmationMethod: 'absent-from-pending-list', isCompleted: true,
  }, '500012972023345', '2026-07-27T10:00:00.000Z').valid === true,
  '待办列表双次零结果沿用已有的独立确认流程');
  const matchingCaseObservation = renderedOrdinaryCompletionObservation({
    isCompleted: true, orderMatches: true, confirmationMethod: 'detail-completed',
    observedPlatformWorkOrderId: '500012972023345',
  }, '2026-07-27T10:00:00.000Z', '500012972023345');
  const otherCaseObservation = renderedOrdinaryCompletionObservation({
    isCompleted: true, orderMatches: true, confirmationMethod: 'detail-completed',
    observedPlatformWorkOrderId: '500012972023346',
  }, '2026-07-27T10:00:00.000Z', '500012972023345');
  assert(matchingCaseObservation.platformCaseMatches === true
    && matchingCaseObservation.observedPlatformWorkOrderId === '500012972023345'
    && otherCaseObservation.platformCaseMatches === false,
  '同订单不同平台工单的完成页必须保留实际详情 ID 及匹配结果');
  assert(renderedOrdinaryCompletionObservation({
    isCompleted: true, orderMatches: true,
    confirmationMethod: 'absent-from-pending-list',
  }, '2026-07-27T10:00:00.000Z') === null,
  '列表缺席的合成状态不能冒充已完结详情页');
  assert(renderedOrdinaryCompletionObservation({
    isCompleted: true, orderMatches: false, detailReady: true,
    isExpectedWorkOrderType: true,
  }, '2026-07-27T10:00:00.000Z') === null,
  '其他订单的已完结详情不得成为本单依据');

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
    ordinaryPddStateChangedRecovery: {
      orderNumber: completion.orderNumber,
      status: 'reconciling',
    },
  }, completion).reason === 'rejected-submit-pending-absence-only',
  'PDD 明确拒绝提交后仅凭待办列表消失不得按计划结果归档');
  assert(!rejectedSubmitPendingListAbsenceNeedsReview({
    ...readyProgress,
    ordinaryPddStateChangedRecovery: {
      orderNumber: completion.orderNumber,
      status: 'reconciling',
    },
    pddResolutionSubmission: { ...completion, submitReceipt: { success: true } },
  }, completion.orderNumber), '后续同单成功提交回执不能被旧拒绝标记误拦');
  assert(archiveReadiness({
    ...readyProgress,
    ordinaryPddStateChangedRecovery: {
      orderNumber: completion.orderNumber,
      status: 'reconciling',
    },
  }, {
    ...completion,
    confirmationMethod: 'detail-completed',
    recoveredFromCompletedPage: true,
  }).ready, '同单已完结详情仍允许对账归档');
  const inTransitProgress = {
    ...readyProgress,
    scenarioCode: 'consumer-address-change-in-transit',
  };
  assert(archiveReadiness(readyProgress, {
    ...completion, confirmationMethod: 'exact-order-completed',
    recoveredFromCompletedPage: true,
  }).reason === 'list-completion-detail-required',
  '列表已完结提示不能直接归档，必须保留同平台工单的详情证明');
  const inTransitCompletion = {
    ...completion,
    scenarioCode: 'consumer-address-change-in-transit',
    recoveredFromCompletedPage: true,
    confirmationMethod: 'detail-completed',
  };
  assert(archiveReadiness(inTransitProgress, inTransitCompletion).reason
    === 'in-transit-address-change-stages-unverified',
  '在途改地址仅有“已完结”标题时不得归档');
  assert(archiveReadiness(inTransitProgress, {
    ...inTransitCompletion,
    completionServiceEvidence: {
      confirmed: true, orderMatches: true, completedTitle: true,
      noForm: true, stage1Record: true, stage2Record: true,
    },
  }).ready, '在途改地址同单两阶段完成记录均核实后允许归档');
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
  assert(archiveReadiness(readyProgress, {
    ...completion,
    platformCompletionObservation: {
      isCompleted: true, orderMatches: true,
      confirmationMethod: 'detail-completed',
      platformCaseMatches: false,
    },
  }).reason === 'completion-platform-case-mismatch',
  '已完结页属于同订单另一平台工单时必须禁止归档');
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
  assert(ordinaryTerminalOutcomeConflicts({
    scenarioCode: 'intercept-recall',
    expectedOutcome: '已进行召回',
    observedOutcome: '已同意退货退款',
  }), '召回结果与退款结果不能视为同一处理结论');
  assert(ordinaryTerminalOutcomeConflicts({
    scenarioCode: 'proactive-logistics-service',
    expectedOutcome: '无法确认快递单号',
    observedOutcome: '未收到退货商品',
  }), '未确认快递单号与未收到商品不能视为同一处理结论');
  assert(ordinaryTerminalOutcomeConflicts({
    scenarioCode: 'delivered-not-received',
    expectedOutcome: '可以送达',
    observedOutcome: '已同意退货退款',
  }), '未收到货的送达结果与退款结果不一致时不得归档');
  assert(ordinaryTerminalOutcomeConflicts({
    scenarioCode: 'product-shortage',
    expectedOutcome: 'product-shortage-chat-no-shortage-feedback-ready',
    observedOutcome: '已同意退货退款',
  }), '商品少发选择没有少发反馈后，平台显示同意退货退款不得归档');
  assert(!ordinaryTerminalOutcomeConflicts({
    scenarioCode: 'product-shortage',
    expectedOutcome: 'product-shortage-chat-no-shortage-feedback-ready',
    observedOutcome: null,
  }), '反馈完成页未展示处理结果时不能凭空判定为退款');
  assert(archiveReadiness(readyProgress, {
    ...completion,
    scenarioCode: 'product-shortage',
    outcome: 'product-shortage-chat-no-shortage-feedback-ready',
    completionEvidence: '已同意退货退款',
    submitClicked: true,
    confirmationMethod: 'detail-completed',
  }).reason === 'completion-outcome-mismatch',
  '商品少发反馈即使点击后详情已完结，平台明确显示退款仍不得归档');
  assert(!ordinaryTerminalOutcomeConflicts({
    scenarioCode: 'delivered-not-received',
    expectedOutcome: '可以送达',
    observedOutcome: '可以送达',
  }), '未收到货完成页结果吻合时仍须正常归档');
  assert(!ordinaryTerminalOutcomeConflicts({
    scenarioCode: 'intercept-recall',
    expectedOutcome: '已进行召回',
    observedOutcome: '已进行召回',
  }), '完成页结果吻合时应保持现有自动归档');
  assert(archiveReadiness(readyProgress, {
    ...completion,
    scenarioCode: 'intercept-recall',
    outcome: '已进行召回',
    completionEvidence: '已同意退货退款',
    submitClicked: true,
    submitReceipt: { success: true, httpStatus: 200 },
    transitionConfirmed: true,
    recoveredFromCompletedPage: true,
    confirmationMethod: 'detail-completed',
  }).reason === 'completion-outcome-mismatch',
  '召回场景即使提交接口成功且详情完结，结果不一致仍须禁止归档');
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
  assert(!Object.hasOwn(next.lastCompletedOrder, 'pendingListProof'),
    '无精确列表依据的完结记录不得生成列表证明');
  const pendingListProofNext = nextProgressAfterCompletion({
    progress: {
      ...orphanEvidenceProgress,
      pddResolutionPendingListPresence: {
        ...orphanEvidenceProgress.pddResolutionPendingListPresence,
        exactShopIdentity: true,
        confirmedAt: '2026-07-27T10:00:30.000Z',
      },
    },
    completion: orphanEvidenceRecovery,
    targetWorkOrderTitle: 'recovery',
    browserMode: 'server-headed',
    workflowDataDir: '/var/lib/pdd-workflow/shops/test',
    completedCount: 4,
    archivedAt: '2026-07-27T10:02:00.000Z',
  });
  assert(pendingListProofNext.lastCompletedOrder.pendingListProof?.present === false
    && pendingListProofNext.lastCompletedOrder.pendingListProof?.refreshed === true
    && pendingListProofNext.lastCompletedOrder.pendingListProof?.exactShopIdentity === true
    && pendingListProofNext.lastCompletedOrder.pendingListProof?.confirmedAt
      === '2026-07-27T10:00:30.000Z',
  '精确订单列表缺席的身份和刷新依据应随完结记录保留');
  const listInferenceNext = nextProgressAfterCompletion({
    progress: orphanEvidenceProgress,
    completion: {
      ...orphanEvidenceRecovery,
      platformCompletionObservation: {
        isCompleted: true,
        orderMatches: true,
        confirmationMethod: 'absent-from-pending-list',
        observedAt: '2026-07-27T10:01:30.000Z',
      },
    },
    targetWorkOrderTitle: 'recovery',
    browserMode: 'server-headed',
    workflowDataDir: '/var/lib/pdd-workflow/shops/test',
    completedCount: 4,
    archivedAt: '2026-07-27T10:02:00.000Z',
  });
  assert(!Object.hasOwn(listInferenceNext.lastCompletedOrder,
    'platformCompletionObservation'),
  '仅由待处理列表推断的完结不得伪装成完成详情页观察');
  const recoveredNext = nextProgressAfterCompletion({
    progress: orphanEvidenceProgress,
    completion: {
      ...orphanEvidenceRecovery,
      completionEvidence: '已联系快递公司修改',
      completionResultOption: '已联系快递公司修改',
      completionServiceEvidence: { stage1Record: true, stage2Record: true },
      platformCompletionObservation: {
        isCompleted: true,
        orderMatches: true,
        confirmationMethod: 'detail-completed',
        observedAt: '2026-07-27T10:01:30.000Z',
        observedPlatformWorkOrderId: '500012972023345',
        platformCaseMatches: true,
      },
    },
    targetWorkOrderTitle: 'recovery',
    browserMode: 'server-headed',
    workflowDataDir: '/var/lib/pdd-workflow/shops/test',
    completedCount: 4,
    archivedAt: '2026-07-27T10:02:00.000Z',
  });
  assert(recoveredNext.lastCompletedOrder.recoveredFromCompletedPage === true,
    'completion compaction must preserve the recovered-order metric marker');
  assert(recoveredNext.lastCompletedOrder.completionServiceEvidence.stage1Record === true
    && recoveredNext.lastCompletedOrder.completionServiceEvidence.stage2Record === true,
  '归档进度必须保留两阶段服务记录的核验证据');
  assert(recoveredNext.lastCompletedOrder.completionEvidence === '已联系快递公司修改'
    && recoveredNext.lastCompletedOrder.completionResultOption === '已联系快递公司修改',
  '归档进度必须保留平台完成页的实际结果和结果选项');
  assert(recoveredNext.lastCompletedOrder.platformCompletionObservation?.isCompleted === true
    && recoveredNext.lastCompletedOrder.platformCompletionObservation?.orderMatches === true
    && recoveredNext.lastCompletedOrder.platformCompletionObservation?.confirmationMethod
      === 'detail-completed'
    && recoveredNext.lastCompletedOrder.platformCompletionObservation?.observedPlatformWorkOrderId
      === '500012972023345'
    && recoveredNext.lastCompletedOrder.platformCompletionObservation?.platformCaseMatches === true,
  '归档进度应保留详情页已完结且订单匹配的观察依据');
  assert(calculateNextPollAt(Date.parse('2026-07-27T10:00:00.000Z'), 300000)
    === '2026-07-27T10:05:00.000Z', '空队列轮询时间计算错误');
  console.log('三标签恢复、完成归档和连续队列运行时自测通过');
}
