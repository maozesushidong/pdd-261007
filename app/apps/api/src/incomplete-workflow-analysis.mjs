const completedStatuses = new Set(['completed', 'archived']);
const completionConfirmationMethods = new Set([
  'detail-completed',
  'absent-from-pending-list',
  'recovery-delayed-detail-check',
  'handover-detail-completed',
  'handover-absent-from-pending-list',
]);
const genericSteps = new Set(['flow-paused', 'manual-review-blocked']);
const ignoredEventTypes = new Set(['workflow.progress', 'workflow.snapshot-synchronized']);
const stepLabels = new Map([
  ['flow-paused', ['自动流程暂停点', 'automation pause point']],
  ['manual-review-blocked', ['人工复核等待点', 'manual review checkpoint']],
  ['logistics-waiting-released', ['物流更新等待阶段', 'logistics update wait']],
  ['consumer-response-waiting-released', ['消费者回复等待阶段', 'consumer response wait']],
  ['pdd-order-remark', ['拼多多订单备注阶段', 'PDD order remark']],
  ['pdd-resolution-submit', ['拼多多处理方案提交阶段', 'PDD resolution submission']],
  ['pdd-resolution-outcome-mismatch', ['拼多多处理结果核对阶段', 'PDD resolution result verification']],
  ['tms-autofill-verification', ['TMS 自动填单核对阶段', 'TMS autofill verification']],
  ['oms-order-search', ['OMS 订单查询阶段', 'OMS order search']],
  ['oms-tab-open', ['OMS 页面准备阶段', 'OMS page preparation']],
  ['page-navigation', ['页面跳转阶段', 'page navigation']],
  ['manual-login-required', ['平台登录阶段', 'platform login']],
  ['human-verification-required', ['页面人工验证阶段', 'human verification']],
]);

const text = (value) => String(value || '').trim();

const timestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const unwrapManualReview = (value) => {
  const raw = text(value);
  const match = raw.match(/^流程需要人工复核[（(]\s*阶段\s*[:：]\s*([^)）]+)[)）]\s*[:：]\s*(.+)$/u);
  return match ? { step: text(match[1]), reason: text(match[2]) } : { step: null, reason: raw };
};

const normalizeReason = (value) => {
  const { reason } = unwrapManualReview(value);
  if (/Target page, context or browser has been closed/i.test(reason)) {
    return '页面跳转过程中浏览器或页面上下文被关闭';
  }
  if (/^login-required$/i.test(reason)) return '登录状态不可用，需要重新登录';
  if (/^verification-required$/i.test(reason)) return '页面需要人工验证，自动流程暂时无法继续';
  if (/^staging reset:/i.test(reason)) return '环境重置后登录状态失效，需要重新登录';
  return reason;
};

const enrichReason = (reason, payload) => {
  if (!/发货仓库.*不一致|仓库不一致/u.test(reason)) return reason;
  const omsWarehouse = text(payload?.omsAnalysis?.shippingWarehouse || payload?.omsAnalysis?.warehouse || payload?.omsAnalysis?.warehouseName);
  const tmsWarehouse = text(payload?.tmsAutofillVerification?.actual?.warehouse);
  if (!omsWarehouse && tmsWarehouse) return 'OMS 仓库为空，TMS 显示“' + tmsWarehouse + '”';
  if (omsWarehouse && tmsWarehouse) return 'OMS 仓库“' + omsWarehouse + '”与 TMS“' + tmsWarehouse + '”不一致';
  return reason;
};

const isGenericReason = (value) => {
  const reason = text(value);
  return !reason
    || /^Playwright workflow exited with code \d+$/i.test(reason)
    || reason === '工作流已进入人工复核暂停状态'
    || ['flow-paused', 'manual-review-blocked', 'waiting-logistics', 'verification-required'].includes(reason);
};

const inferStoppedStep = (reason) => {
  const value = text(reason);
  if (/等待消费者.*(?:确认|回复)|消费者.*12\s*小时.*未回复/u.test(value)) {
    return 'consumer-response-waiting-released';
  }
  if (/没有快递|没有.*运单号|物流轨迹|等待.*物流更新/u.test(value)) return 'logistics-waiting-released';
  if (/订单信息区域未找到查看详情|订单详情.*(?:备注|渲染|订单号)|添加备注|修改备注|备注弹窗|红色标记|备注保存/u.test(value)) return 'pdd-order-remark';
  if (/查看详情|第一阶段提交|退款处理阶段|拼多多.*处理方案/u.test(value)) return 'pdd-resolution-submit';
  if (/发货仓库.*不一致|仓库不一致/u.test(value)) return 'tms-autofill-verification';
  if (/OMS.*订单.*查询输入框|订单管理页面.*查询输入框/iu.test(value)) return 'oms-order-search';
  if (/OMS.*标签页.*不可用/iu.test(value)) return 'oms-tab-open';
  if (/页面跳转|Target page|browser.*closed|page\.goto/iu.test(value)) return 'page-navigation';
  if (/登录状态|重新登录|login-required|staging reset/iu.test(value)) return 'manual-login-required';
  if (/人工验证|验证码|verification-required/iu.test(value)) return 'human-verification-required';
  return null;
};

const runtimeFallbackReason = (runtimeStatus, currentStep) => {
  if (currentStep === 'manual-login-required') return '登录状态不可用，流程等待所有者重新登录';
  if (currentStep === 'human-verification-required') return '页面需要人工验证，自动流程暂时无法继续';
  if (currentStep === 'consumer-response-waiting-released') {
    return '拼多多正在等待消费者确认拦截退款方案，满 12 小时未回复后自动继续';
  }
  if (currentStep === 'logistics-waiting-released') return '物流信息尚未更新，流程等待自动复查';
  if (runtimeStatus === 'queued') return '工单仍在等待程序处理';
  if (runtimeStatus === 'processing') return '程序仍在处理中，尚未到达全流程完成节点';
  if (runtimeStatus === 'waiting') return '程序正在等待外部条件满足';
  if (runtimeStatus === 'verification') return '程序正在等待登录或页面验证';
  if (completedStatuses.has(runtimeStatus)) return '数据库记录已结束，但缺少拼多多平台完成证据';
  return '程序已停止，但没有记录到更具体的失败原因';
};

const summarizeReason = ({ reason, reasonCode, stoppedStep, runtimeStatus }) => {
  const value = [reasonCode, reason, stoppedStep].filter(Boolean).join(' ');
  if (/选项错误|预期.+实际|outcome-mismatch/iu.test(value)) {
    return ['拼多多最终处理选项与建议结果不一致。', 'The final PDD resolution option does not match the recommended result.'];
  }
  if (/warehouse-out-of-scope|仓库.*不在.*(?:范围|业务)/iu.test(value)) {
    return ['OMS 发货仓库不在自动处理范围内。', 'The OMS shipping warehouse is outside the automation scope.'];
  }
  if (/发货仓库.*不一致|仓库不一致|warehouse-mismatch|OMS 仓库为空.*TMS|OMS.*与 TMS/iu.test(value)) {
    return ['OMS 与 TMS 的发货仓库信息不一致。', 'The shipping warehouse information differs between OMS and TMS.'];
  }
  if (/unknown-scenario|未识别.*(?:场景|业务)/iu.test(value)) {
    return ['程序无法识别当前工单的业务场景。', 'The automation could not identify the work-order scenario.'];
  }
  if (/human-verification|required-verification|verification-required|验证码|滑块|人工验证/iu.test(value)) {
    return ['页面触发验证码或滑块，正在等待人工验证。', 'The page requires a CAPTCHA or slider verification and is waiting for human action.'];
  }
  if (/manual-login-required|login-required|登录状态|重新登录|staging reset/iu.test(value)) {
    return ['平台登录状态不可用，正在等待重新登录。', 'The platform session is unavailable and is waiting for a new login.'];
  }
  if (/consumer-response-waiting|waiting-consumer-response|等待消费者.*(?:确认|回复)|消费者.*12\s*小时.*未回复/iu.test(value)) {
    return ['正在等待消费者确认拦截退款方案，到期后程序会自动继续。', 'The automation is waiting for the consumer response and will continue automatically when the wait expires.'];
  }
  if (/logistics-waiting|waiting-logistics|没有快递|没有.*运单号|物流轨迹|等待.*物流更新/iu.test(value)) {
    return ['物流信息尚未更新，程序正在等待自动复查。', 'Logistics information has not updated, so the automation is waiting to check again.'];
  }
  if (/pdd-order-remark|订单信息区域未找到查看详情|添加备注|修改备注|备注弹窗|红色标记|备注保存/iu.test(value)) {
    return ['拼多多订单备注未完成，需要人工处理。', 'The PDD order remark was not completed and requires manual handling.'];
  }
  if (/pdd-resolution-submit|第一阶段提交|退款处理阶段|拼多多.*处理方案|查看详情/iu.test(value)) {
    return ['拼多多处理方案尚未完成提交。', 'The PDD resolution has not been submitted successfully.'];
  }
  if (/oms-order-search|OMS.*订单.*查询输入框|订单管理页面.*查询输入框/iu.test(value)) {
    return ['OMS 订单查询页面未准备完成。', 'The OMS order-search page was not ready.'];
  }
  if (/oms-tab-open|OMS.*标签页.*不可用/iu.test(value)) {
    return ['OMS 页面不可用，程序无法继续查询。', 'The OMS page is unavailable, so the automation cannot continue the query.'];
  }
  if (/tms-autofill-verification/iu.test(value)) {
    return ['TMS 自动填单结果未通过核对。', 'The TMS autofill result did not pass verification.'];
  }
  if (/page-navigation|页面跳转|Target page|browser.*closed|page\.goto/iu.test(value)) {
    return ['页面跳转过程中浏览器页面被关闭。', 'The browser page was closed during navigation.'];
  }
  if (/rate-limited|频率限制|请求过于频繁/iu.test(value)) {
    return ['平台请求频率受限，程序正在等待重试。', 'The platform rate-limited the request, so the automation is waiting to retry.'];
  }
  if (completedStatuses.has(runtimeStatus)) {
    return ['工单记录已结束，但缺少平台完成证据。', 'The work order is closed in the system, but platform completion evidence is missing.'];
  }
  if (runtimeStatus === 'queued') return ['工单正在等待程序处理。', 'The work order is queued for automation.'];
  if (runtimeStatus === 'processing') return ['工单仍在处理中，尚未完成全流程。', 'The work order is still processing and has not completed the full workflow.'];
  if (runtimeStatus === 'waiting') return ['程序正在等待外部条件满足。', 'The automation is waiting for an external condition.'];
  return ['自动流程未完成，需要人工核查。', 'The automated workflow did not complete and requires manual review.'];
};

const describeStoppedStep = (stoppedStep) => {
  const labels = stepLabels.get(stoppedStep);
  if (labels) return { stoppedStepZh: labels[0], stoppedStepEn: labels[1] };
  if (!stoppedStep || stoppedStep === 'unknown') {
    return { stoppedStepZh: '未知处理阶段', stoppedStepEn: 'unknown workflow step' };
  }
  return { stoppedStepZh: `流程阶段 ${stoppedStep}`, stoppedStepEn: `workflow step ${stoppedStep}` };
};

const hasConfirmedCompletion = (workOrder, payload) => {
  const completionState = text(workOrder.completion_state ?? workOrder.completionState);
  if (completionState === 'confirmed') return true;
  if (completionState === 'reconciliation-required') return false;
  const submission = payload?.pddResolutionSubmission || {};
  const archive = payload?.completionArchive || {};
  const method = submission.confirmationMethod || archive.confirmationMethod;
  return (submission.status === 'succeeded' || Boolean(archive.orderNumber))
    && completionConfirmationMethods.has(method);
};

const normalizeEvent = (event) => event && ({
  type: text(event.event_type ?? event.eventType),
  step: text(event.stage),
  reasonCode: text(event.reason_code ?? event.reasonCode),
  reason: normalizeReason(event.message || event.reason || event.reason_code || event.reasonCode),
  at: event.occurred_at ?? event.occurredAt ?? null,
});

const latestDiagnosticEvent = (workOrder) => {
  const direct = normalizeEvent(workOrder._analysisEvent ?? workOrder.diagnosticEvent);
  if (direct?.reason && !ignoredEventTypes.has(direct.type)) return direct;
  const events = Array.isArray(workOrder.events) ? workOrder.events : [];
  return events
    .map(normalizeEvent)
    .filter((event) => event?.reason && !ignoredEventTypes.has(event.type))
    .sort((left, right) => timestamp(right.at) - timestamp(left.at))[0] || null;
};

const normalizeIntervention = (intervention) => intervention && ({
  reasonCode: text(intervention.reason_code ?? intervention.reasonCode),
  reason: normalizeReason(intervention.reason),
  status: text(intervention.status),
  at: intervention.created_at ?? intervention.createdAt ?? null,
});

const latestIntervention = (workOrder) => {
  const direct = normalizeIntervention(workOrder._analysisIntervention ?? workOrder.diagnosticIntervention);
  if (direct?.reason) return direct;
  const interventions = Array.isArray(workOrder.interventions) ? workOrder.interventions : [];
  return interventions
    .map(normalizeIntervention)
    .filter((intervention) => intervention?.reason)
    .sort((left, right) => {
      const leftOpen = ['open', 'acknowledged'].includes(left.status) ? 1 : 0;
      const rightOpen = ['open', 'acknowledged'].includes(right.status) ? 1 : 0;
      return rightOpen - leftOpen || timestamp(right.at) - timestamp(left.at);
    })[0] || null;
};

const resolveStoppedStep = ({ candidateStep, reason, currentStep }) => {
  const inferred = inferStoppedStep(reason);
  if (currentStep === 'consumer-response-waiting-released') return currentStep;
  if (candidateStep && !genericSteps.has(candidateStep)) return candidateStep;
  return inferred || candidateStep || currentStep || 'unknown';
};

export function analyzeIncompleteWorkflow(workOrder = {}) {
  const runtimeStatus = text(workOrder.runtime_status ?? workOrder.runtimeStatus ?? workOrder.status) || 'unknown';
  const currentStep = text(workOrder.current_step ?? workOrder.currentStep ?? workOrder.step) || 'unknown';
  const payload = workOrder.payload ?? workOrder._analysisPayload ?? {};
  if (completedStatuses.has(runtimeStatus) && hasConfirmedCompletion(workOrder, payload)) return null;
  const event = latestDiagnosticEvent(workOrder);
  const manualReview = payload?.manualReview || {};
  const manualReviewParsed = unwrapManualReview(manualReview.reason);
  const intervention = latestIntervention(workOrder);
  const interventionParsed = unwrapManualReview(intervention?.reason);
  const storedReasonParsed = unwrapManualReview(workOrder.manual_review_reason ?? workOrder.manualReviewReason);

  const eventCandidate = event && {
    reason: event.reason, reasonCode: event.reasonCode, step: event.step, source: 'workflow-event', at: event.at,
  };
  const manualReviewCandidate = manualReviewParsed.reason && {
    reason: normalizeReason(manualReviewParsed.reason),
    reasonCode: text(manualReview.reasonCode),
    step: text(manualReview.stage) || manualReviewParsed.step,
    source: 'manual-review',
    at: manualReview.at || manualReview.requiredAt || manualReview.blockedAt || null,
  };
  const interventionCandidate = interventionParsed.reason && {
    reason: normalizeReason(interventionParsed.reason),
    reasonCode: intervention?.reasonCode,
    step: interventionParsed.step,
    source: 'manual-intervention',
    at: intervention?.at || null,
  };
  const storedReasonCandidate = storedReasonParsed.reason && {
    reason: normalizeReason(storedReasonParsed.reason),
    reasonCode: text(workOrder.reason_code ?? workOrder.reasonCode),
    step: storedReasonParsed.step || currentStep,
    source: 'work-order',
    at: workOrder.updated_at ?? workOrder.updatedAt ?? null,
  };
  const snapshotCandidate = payload?.error && {
    reason: normalizeReason(payload.error),
    step: null,
    source: 'workflow-snapshot',
    at: payload.updatedAt || null,
  };
  const consumerResponseWait = payload?.logisticsWait?.waitKind === 'consumer-response'
    || payload?.pddResolutionFlow?.flowCode === 'consumer-negotiation-followup'
    || ['followup-waiting', 'followup-ready'].includes(
      payload?.pddResolutionSubmission?.status,
    );
  const logisticsCandidate = payload?.logisticsWait?.reason && {
    reason: normalizeReason(payload.logisticsWait.reason),
    reasonCode: consumerResponseWait ? 'waiting-consumer-response' : 'waiting-logistics',
    step: consumerResponseWait
      ? 'consumer-response-waiting-released'
      : 'logistics-waiting-released',
    source: consumerResponseWait ? 'consumer-response-wait' : 'logistics-wait',
    at: payload.logisticsWait.lastCheckedAt || null,
  };
  const currentManualState = runtimeStatus === 'manual-review'
    || /manual-review|outcome-mismatch/u.test(currentStep);
  const candidates = (consumerResponseWait
    ? [logisticsCandidate, eventCandidate, manualReviewCandidate, interventionCandidate, snapshotCandidate, storedReasonCandidate]
    : currentManualState
      ? [manualReviewCandidate, storedReasonCandidate, interventionCandidate, eventCandidate, snapshotCandidate, logisticsCandidate]
      : [eventCandidate, manualReviewCandidate, interventionCandidate, snapshotCandidate, logisticsCandidate, storedReasonCandidate])
    .filter(Boolean);

  const candidate = candidates.find((item) => !isGenericReason(item.reason)) || candidates[0] || null;
  const diagnosticReason = enrichReason(candidate?.reason || runtimeFallbackReason(runtimeStatus, currentStep), payload);
  const stoppedStep = resolveStoppedStep({ candidateStep: candidate?.step, reason: diagnosticReason, currentStep });
  const [reasonZh, reasonEn] = summarizeReason({
    reason: diagnosticReason,
    reasonCode: candidate?.reasonCode,
    stoppedStep,
    runtimeStatus,
  });
  const { stoppedStepZh, stoppedStepEn } = describeStoppedStep(stoppedStep);

  return {
    reason: reasonZh,
    reasonZh,
    reasonEn,
    descriptionZh: `${reasonZh} 程序停在“${stoppedStepZh}”。`,
    descriptionEn: `${reasonEn} The automation stopped at the "${stoppedStepEn}" step.`,
    stoppedStep,
    stoppedStepZh,
    stoppedStepEn,
    checkpoint: currentStep,
    runtimeStatus,
    source: candidate?.source || 'runtime-status',
    diagnosedAt: candidate?.at || workOrder.latest_event_at || workOrder.latestEventAt || workOrder.updated_at || workOrder.updatedAt || null,
  };
}
