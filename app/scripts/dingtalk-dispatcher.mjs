import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const readSecret = async (name) => {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try { return (await fsp.readFile(file, 'utf8')).trim(); } catch { return ''; }
  }
  return String(process.env[name] || '').trim();
};

export const signDingTalkUrl = (webhook, secret, timestamp = Date.now()) => {
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
  const url = new URL(webhook);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', signature);
  return url.toString();
};

const compact = (value, maxLength = 180) => {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : '未获取';
};

const line = (label, value, maxLength) => `- **${label}：** ${compact(value, maxLength)}`;

const evidenceAssetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const isPrivateOrLoopbackHost = (hostname) => {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/gu, '');
  if (!normalized || normalized === 'localhost' || normalized === '::1') return true;
  if (/^127\./u.test(normalized) || /^10\./u.test(normalized) || /^192\.168\./u.test(normalized)) return true;
  const private172 = normalized.match(/^172\.(\d{1,3})\./u);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
};

export const buildDingTalkEvidenceImageUrl = (assetId, publicBaseUrl) => {
  const normalizedAssetId = String(assetId || '').trim();
  if (!evidenceAssetIdPattern.test(normalizedAssetId)) return null;
  try {
    const base = new URL(String(publicBaseUrl || '').trim());
    if (base.protocol !== 'https:' || isPrivateOrLoopbackHost(base.hostname)) return null;
    return new URL(`/api/v1/evidence/${encodeURIComponent(normalizedAssetId)}/content`, base.origin).toString();
  } catch {
    return null;
  }
};

const notificationWarehouse = (snapshot = {}) => String(
  snapshot.omsAnalysis?.shippingWarehouse
    || snapshot.omsAnalysis?.warehouse
    || snapshot.omsAnalysis?.warehouseName
    || snapshot.omsWarehouseParse?.parsedValue
    || snapshot.tmsAutofillVerification?.actual?.warehouse
    || '',
).trim() || null;

const extendedOrdinaryScenarioCodes = new Set([
  'delivery-risk-concern',
  'proactive-logistics-service',
  'reverse-logistics-signed-refund',
  'intercept-recall',
  'good-deed-expedited-shipping',
  'delivered-not-received',
  'consumer-refusal',
]);
// Automatic DingTalk delivery is reserved for business rules that explicitly
// require a human decision. Technical/platform states stay in the owner
// diagnostics and are never sent as automatic group notifications.
const automaticBusinessDingTalkReasonCodes = new Set([
  'warehouse-out-of-scope',
  'unknown-scenario',
  'ordinary-manual-review',
]);
const returnRefundReasonCodes = new Set([
  'return-refund-manual-review',
]);
const technicalDingTalkReasonPattern = /验证码|滑块|人机验证|人工验证|需要验证|验证页面|captcha|challenge|verification|登录(?:页|失败|过期|状态)?|重新登录|未登录|会话|session|waiting|物流等待|限流|限速|请求频率|rate.?limit|flow[-_. ]?paused|external[-_. ]?state|pdd[-_. ]?(?:upload|submit)|image[-_. ]?upload|页面(?:加载|渲染)|渲染失败|提交(?:结果)?未确认|未确认(?:成功|回执)|locator[.]click|timeout|超时|浏览器|browser|chromium|network|网络|上传(?:授权|失败)|upload(?: authorization)?|48143|非法请求/iu;
const pddUploadAuthorizationProblemZh = '拼多多凭证图片上传失败：上传授权接口返回 48143 非法请求，自动重试已结束';
const legacyPddUploadAuthorizationProblemZh = '拼多多凭证图片上传失败：上传授权接口返回 48143 非法请求，已连续重试 3 次';

const notificationPayloadText = (payload = {}) => [
  payload.reasonCode,
  payload.evidenceReasonCode,
  payload.reason,
  payload.evidenceReason,
  payload.problemZh,
  payload.problemEn,
  payload.incompleteAnalysis?.reasonZh,
  payload.incompleteAnalysis?.reasonEn,
  payload.incompleteAnalysis?.descriptionZh,
  payload.incompleteAnalysis?.descriptionEn,
].filter(Boolean).join(' ');

export const isTechnicalDingTalkPayload = (payload = {}) => (
  technicalDingTalkReasonPattern.test(notificationPayloadText(payload))
);

const notificationReasonFromRow = (row = {}) => {
  const snapshot = row.workOrderPayload || row.payload || {};
  const reason = row.manual_review_reason
    || row.manualReviewReason
    || snapshot.manualReview?.reason
    || snapshot.ordinaryScenarioDecision?.reason
    || snapshot.error;
  return reason ? compact(reason, 220) : '';
};

const notificationReasonCodeFromRow = (row = {}) => {
  const snapshot = row.workOrderPayload || row.payload || {};
  return String(
    snapshot.manualReview?.reasonCode
      || snapshot.ordinaryScenarioDecision?.reasonCode
      || row.current_step
      || row.currentStep
      || 'ordinary-manual-review',
  ).trim();
};

const notificationShopName = (row = {}) => String(
  row.shop_name || row.shopName || row.expected_shop_name || row.expectedShopName || row.shop_id || '',
).trim() || row.shop_id;

const latestStructuredValue = (value) => {
  if (Array.isArray(value)) {
    return [...value].reverse().find((item) => item && typeof item === 'object' && !Array.isArray(item)) || {};
  }
  return value && typeof value === 'object' ? value : {};
};

const hasPendingImageUploadRecovery = (snapshot = {}) => [
  snapshot.ordinaryEvidenceUploadRecovery,
  snapshot.pddResolutionRecovery,
]
  .map(latestStructuredValue)
  .some((recovery) => ['waiting', 'waiting-login', 'retrying'].includes(String(recovery.status || '')));

export const buildDingTalkMessage = (payload, recipients, evidencePublicBaseUrl) => {
  const mentions = recipients.map((recipient) => `@${recipient.name}`).join(' ');
  const analysis = payload.incompleteAnalysis || {};
  const descriptionZh = analysis.descriptionZh || analysis.reasonZh || payload.problemZh
    || '自动流程未完成，需要人工核查。';
  const descriptionEn = analysis.descriptionEn || analysis.reasonEn
    || 'The automated workflow did not complete and requires manual review.';
  const returnRefund = payload.recipientScope === 'return-refund';
  const tmsEvidenceAssetAvailable = evidenceAssetIdPattern.test(
    String(payload.tmsEvidenceAssetId || '').trim(),
  );
  const tmsEvidenceImageUrl = returnRefund ? null : (
    buildDingTalkEvidenceImageUrl(payload.tmsEvidenceAssetId, evidencePublicBaseUrl)
      || (/^https:\/\//iu.test(String(payload.tmsEvidenceImageUrl || ''))
        ? String(payload.tmsEvidenceImageUrl).trim()
        : null)
  );
  return {
    msgtype: 'markdown',
    markdown: {
      title: returnRefund ? '拼多多退货退款待处理' : '拼多多工单待处理',
      text: [
        returnRefund ? '## 拼多多退货退款待处理' : '## 拼多多工单待处理',
        '',
        ...(returnRefund ? [
          line('店铺', payload.shopName || payload.shopId),
          line('订单号', payload.orderNumber),
          line('售后编号', payload.aftersaleNumber),
          line('退款金额', payload.refundAmount == null ? null : `¥${payload.refundAmount}`),
          line('工单类型', payload.workOrderType),
        ] : [
          line('店铺', payload.shopName || payload.shopId),
          line('订单号', payload.orderNumber),
          line('工单类型', payload.workOrderType),
          line('OMS发货仓库', payload.warehouse || '未读取'),
          ...(tmsEvidenceImageUrl ? [
            '- **TMS凭证图片：**',
            `![TMS凭证图片](${tmsEvidenceImageUrl})`,
            `[查看或保存TMS凭证原图](${tmsEvidenceImageUrl})`,
          ] : [line(
            'TMS凭证图片',
            tmsEvidenceAssetAvailable
              ? '已生成；当前未配置钉钉可访问的 HTTPS 凭证地址，请在前端查看'
              : '未生成或暂不可访问',
          )]),
        ]),
        line('问题', payload.problemZh || analysis.reasonZh || '自动流程未完成，需要人工核查。', 100),
        '',
        '### 未完成流程分析',
        line('中文', descriptionZh, 220),
        line('English', descriptionEn, 260),
        '',
        mentions,
      ].join('\n'),
    },
    at: {
      atMobiles: recipients.map((recipient) => String(recipient.mobile || '')).filter(Boolean),
      atUserIds: recipients.map((recipient) => String(recipient.userId || '')).filter(Boolean),
      isAtAll: false,
    },
  };
};

export const buildDailySummaryMessage = ({
  todayProcessed,
  historicalProcessed,
  messageText,
}) => ({
  msgtype: 'markdown',
  markdown: {
    title: '拼多多Agent执行汇报',
    text: [
      '### 拼多多Agent执行汇报',
      '',
      ...(String(messageText || '').trim()
        ? String(messageText).split(/\r?\n/gu)
          .map((item) => item.replace(/^\s*[-*·•]\s*/u, '').trim())
          .filter(Boolean)
          .map((item) => `- ${item}`)
        : [
          `- 今日Agent已处理单量 ${Number(todayProcessed || 0)} 单`,
          `- Agent历史总处理单量 ${Number(historicalProcessed || 0)} 单`,
        ]),
    ].join('\n'),
  },
  at: { atMobiles: [], atUserIds: [], isAtAll: false },
});

export const dingtalkDailySummarySchedule = ({
  now = new Date(),
  automaticEnabled = false,
  startDate = null,
} = {}) => {
  const clock = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const summaryDate = `${clock.year}-${clock.month}-${clock.day}`;
  const normalizedStartDate = String(startDate || '').trim();
  const afterSendTime = Number(clock.hour) > 18
    || (Number(clock.hour) === 18 && Number(clock.minute) >= 30);
  return {
    summaryDate,
    due: automaticEnabled
      && /^\d{4}-\d{2}-\d{2}$/u.test(normalizedStartDate)
      && summaryDate >= normalizedStartDate
      && afterSendTime,
  };
};

export const isAllowedDingTalkPayload = (payload = {}) => {
  if (payload.deliverySource === 'owner-manual') return true;
  if (isTechnicalDingTalkPayload(payload)) return false;
  return automaticBusinessDingTalkReasonCodes.has(payload.reasonCode)
    || returnRefundReasonCodes.has(payload.reasonCode);
};

const shanghaiDateKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const isDingTalkDeliveryDateEligible = (payload = {}, now = new Date()) => (
  payload.deliverySource === 'owner-manual'
  || (payload.deliverySource === 'automatic'
    && Boolean(payload.occurredAt)
    && shanghaiDateKey(payload.occurredAt) === shanghaiDateKey(now))
);

export const dingTalkDeliveryThrottleDelayMs = ({
  lastDeliveryStartedAt = 0,
  now = Date.now(),
  minimumIntervalMs = 3_200,
} = {}) => Math.max(0, Number(lastDeliveryStartedAt || 0)
  + Math.max(0, Number(minimumIntervalMs || 0)) - Number(now || 0));

export const hasExhaustedPddUploadAuthorizationFailure = (snapshot = {}) => {
  const recovery = snapshot.pddResolutionRecovery || {};
  const failures = Array.isArray(recovery.failures) ? recovery.failures : [];
  const authorizationFailures = failures.filter((failure) => {
    const authorization = failure?.uploadAuthorizationFailure || {};
    const codeMatches = failure?.code === 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED'
      || authorization.code === 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED';
    return codeMatches
      && Number(authorization.errorCode) === 48143
      && /非法请求/u.test(String(authorization.errorMessage || failure?.message || ''));
  });
  const submissionStatus = String(snapshot.pddResolutionSubmission?.status || '');
  const legacyExhausted = recovery.status === 'exhausted'
    && Number(recovery.attempts || failures.length) >= 3
    && authorizationFailures.length >= 3
    && submissionStatus !== 'succeeded';
  if (legacyExhausted) return true;

  const ordinaryUpload = latestStructuredValue(snapshot.ordinaryEvidenceUpload);
  const ordinaryRecovery = latestStructuredValue(snapshot.ordinaryEvidenceUploadRecovery);
  const ordinaryAuthorization = ordinaryUpload.diagnostics?.authorizationFailure || {};
  const ordinaryFailures = Array.isArray(ordinaryRecovery.failures) ? ordinaryRecovery.failures : [];
  const maxAttempts = Math.max(3, Number(ordinaryRecovery.maxAttempts || 3));
  const recordedAttempts = Number(ordinaryRecovery.attempts || ordinaryRecovery.attempt || 0);
  // Old extended-scenario snapshots recorded retries 1 and 2, then threw on
  // attempt 3 before persisting the exhausted marker.
  const effectiveAttempts = ordinaryRecovery.status === 'exhausted'
    ? recordedAttempts
    : ordinaryUpload.status === 'failed' && recordedAttempts === maxAttempts - 1
      ? maxAttempts
      : recordedAttempts;
  const ordinaryAuthorizationFailure = ordinaryUpload.status === 'failed'
    && Number(ordinaryAuthorization.errorCode) === 48143
    && (ordinaryAuthorization.code === 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED'
      || /48143|非法请求/u.test(String(ordinaryUpload.error || snapshot.error || '')));
  const ordinaryFailureEvidence = ordinaryFailures.some((failure) => (
    failure?.code === 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED'
    || Number(failure?.uploadAuthorizationFailure?.errorCode) === 48143
  ));
  const definitiveFailure = ordinaryRecovery.status === 'exhausted'
    && ordinaryRecovery.definitiveAuthorizationFailure === true
    && ordinaryAuthorizationFailure
    && ordinaryFailureEvidence;
  if (definitiveFailure) return true;
  return ordinaryAuthorizationFailure
    && effectiveAttempts >= maxAttempts
    && (ordinaryRecovery.status === 'exhausted'
      || ordinaryFailureEvidence
      || /48143|非法请求/u.test(String(snapshot.error || ordinaryUpload.error || '')));
};

export const detectFinalImageUploadFailure = (snapshot = {}) => {
  const candidates = [
    {
      field: 'tmsAttachmentTransfer',
      system: 'tms',
      value: snapshot.tmsAttachmentTransfer,
      finalStatuses: new Set(['failed']),
      recovery: null,
      fallbackStage: 'tms-attachment-upload-failed',
    },
    {
      field: 'ordinaryEvidenceUpload',
      system: 'pdd',
      value: snapshot.ordinaryEvidenceUpload,
      finalStatuses: new Set(['failed', 'unknown']),
      recovery: snapshot.ordinaryEvidenceUploadRecovery,
      fallbackStage: 'ordinary-evidence-upload-exhausted',
    },
    {
      field: 'pddEvidenceUpload',
      system: 'pdd',
      value: snapshot.pddEvidenceUpload,
      finalStatuses: new Set(['failed', 'unknown']),
      recovery: snapshot.pddResolutionRecovery,
      fallbackStage: 'pdd-evidence-upload-failed',
    },
  ];
  for (const candidate of candidates) {
    const value = latestStructuredValue(candidate.value);
    const recovery = latestStructuredValue(candidate.recovery);
    const status = String(value.status || '');
    const recoveryStatus = String(recovery.status || '');
    if (!candidate.finalStatuses.has(status)
      || ['waiting', 'waiting-login', 'retrying'].includes(recoveryStatus)) continue;
    return {
      field: candidate.field,
      system: candidate.system,
      status,
      orderNumber: value.orderNumber || recovery.orderNumber || null,
      error: String(value.error
        || recovery.error
        || recovery.lastError
        || snapshot.error
        || '未记录上传错误').trim(),
      stage: candidate.fallbackStage,
      occurredAt: value.failedAt
        || recovery.updatedAt
        || recovery.retryAt
        || null,
    };
  }
  if (hasExhaustedPddUploadAuthorizationFailure(snapshot)) {
    return {
      field: 'pddEvidenceUpload',
      system: 'pdd',
      status: 'failed',
      orderNumber: snapshot.pddResolutionRecovery?.orderNumber
        || snapshot.ordinaryEvidenceUploadRecovery?.orderNumber
        || null,
      error: String(snapshot.pddResolutionRecovery?.lastError
        || snapshot.ordinaryEvidenceUploadRecovery?.error
        || snapshot.error
        || '拼多多上传签名接口返回 48143 非法请求').trim(),
      stage: 'pdd-resolution-recovery-exhausted',
      occurredAt: snapshot.pddResolutionRecovery?.updatedAt
        || snapshot.ordinaryEvidenceUploadRecovery?.updatedAt
        || null,
    };
  }
  return null;
};

const exhaustedPddSubmitReconciliation = (snapshot = {}) => {
  const observation = snapshot.externalStateReconciliation || {};
  const submitAttemptCount = Number(observation.submitAttemptCount || 0);
  const maximumAutomaticSubmitAttempts = Number(
    observation.maximumAutomaticSubmitAttempts
      || snapshot.pddResolutionSubmission?.maximumAutomaticSubmitAttempts
      || 0,
  );
  if (observation.effectType !== 'pdd-submit'
    || observation.state !== 'unresolved'
    || observation.automaticRetryExhausted !== true
    || submitAttemptCount < 1
    || maximumAutomaticSubmitAttempts < 1
    || submitAttemptCount < maximumAutomaticSubmitAttempts) return null;
  return {
    effectId: observation.effectId || snapshot.pddResolutionSubmission?.effectId || null,
    submitAttemptCount,
    maximumAutomaticSubmitAttempts,
    observedAt: observation.observedAt || null,
  };
};

export const isDingTalkDeliveryEligible = (row = {}) => {
  const payload = row.payload || {};
  const snapshot = row.workOrderPayload || {};
  const workOrderId = String(row.workOrderId || '');
  const shopId = String(row.workOrderShopId || '');
  const orderNumber = String(row.externalOrderNumber || '');
  if (!isAllowedDingTalkPayload(payload)
    || !workOrderId
    || String(payload.workOrderId || '') !== workOrderId
    || String(payload.shopId || '') !== shopId
    || String(payload.orderNumber || '') !== orderNumber
    || !['open', 'acknowledged'].includes(row.interventionStatus)
    || row.frontendVisibility === 'recovery-audit'
    || ['completed', 'archived'].includes(row.workOrderStatus)
    || ['completed', 'archived'].includes(row.workOrderRuntimeStatus)
    || row.completionState === 'confirmed') return false;

  if (payload.deliverySource === 'owner-manual') return true;
  if (payload.reasonCode !== row.interventionReasonCode) return false;
  if (returnRefundReasonCodes.has(payload.reasonCode)) {
    if (!['paused', 'retry-ready'].includes(row.workOrderStatus)) return false;
  } else if (row.workOrderStatus !== 'paused') return false;

  if (payload.reasonCode === 'warehouse-out-of-scope') {
    const warehouse = String(snapshot.omsWarehouseParse?.parsedValue || '').trim();
    return snapshot.omsWarehouseParse?.status === 'out-of-scope'
      && Boolean(warehouse)
      && String(payload.warehouse || '').trim() === warehouse;
  }
  if (payload.reasonCode === 'unknown-scenario') {
    const evidenceStage = [row.currentStep, snapshot.step, snapshot.manualReview?.stage]
      .filter(Boolean).join(' ');
    const evidenceReason = String(snapshot.manualReview?.reason || '');
    return !String(row.scenarioCode || '').trim()
      && (/unknown-scenario|unsupported-scenario/.test(evidenceStage)
        || /未识别.*(?:场景|工单)/u.test(evidenceReason));
  }
  if (payload.reasonCode === 'pdd-upload-authorization-failed') {
    return [pddUploadAuthorizationProblemZh, legacyPddUploadAuthorizationProblemZh]
      .includes(payload.problemZh)
      && hasExhaustedPddUploadAuthorizationFailure(snapshot);
  }
  if (payload.reasonCode === 'image-upload-failed') {
    const failure = detectFinalImageUploadFailure(snapshot);
    return Boolean(failure
      && payload.uploadField === failure.field
      && payload.uploadStatus === failure.status
      && payload.system === failure.system);
  }
  if (payload.reasonCode === 'pdd-submit-reconciliation-exhausted') {
    const reconciliation = exhaustedPddSubmitReconciliation(snapshot);
    return Boolean(reconciliation
      && row.currentStep === 'external-state-unresolved'
      && String(row.currentOrdinaryInstanceId || '') === String(payload.ordinaryInstanceId || '')
      && Number(payload.submitAttemptCount) === reconciliation.submitAttemptCount
      && Number(payload.maximumAutomaticSubmitAttempts)
        === reconciliation.maximumAutomaticSubmitAttempts
      && String(payload.effectId || '') === String(reconciliation.effectId || ''));
  }
  if (payload.reasonCode === 'ordinary-manual-review') {
    return extendedOrdinaryScenarioCodes.has(String(row.scenarioCode || ''))
      && String(row.currentOrdinaryInstanceId || '') === String(payload.ordinaryInstanceId || '')
      && payload.evidenceReasonCode === notificationReasonCodeFromRow(row)
      && payload.evidenceReason === notificationReasonFromRow(row);
  }
  if (returnRefundReasonCodes.has(payload.reasonCode)) {
    return row.scenarioCode === 'return-refund'
      && payload.aftersaleNumber === row.aftersaleNumber
      && payload.actionState === row.returnRefundActionState
      && payload.reasonCode === `return-refund-${row.returnRefundActionState}`;
  }
  return false;
};

export const durableWarehouseNotificationPayload = (row = {}) => {
  const snapshot = row.payload || {};
  const warehouse = String(snapshot.omsWarehouseParse?.parsedValue || '').trim();
  if (row.status !== 'paused'
    || row.completion_state === 'confirmed'
    || snapshot.omsWarehouseParse?.status !== 'out-of-scope'
    || !warehouse) return null;
  const problemZh = `OMS 发货仓库“${warehouse}”不在业务处理范围，已禁止进入 TMS 和拼多多提交`;
  return {
    workOrderId: row.work_order_id,
    shopId: row.shop_id,
    shopName: notificationShopName(row),
    orderNumber: row.external_order_number,
    warehouse,
    tmsEvidenceAssetId: row.tms_evidence_asset_id || null,
    trackingNumber: snapshot.logisticsAnalysis?.trackingNumber || null,
    workOrderType: row.work_order_type || snapshot.workOrderType || null,
    problemZh,
    incompleteAnalysis: {
      reasonZh: 'OMS 发货仓库不在自动处理范围内。',
      reasonEn: 'The OMS shipping warehouse is outside the automation scope.',
      descriptionZh: problemZh,
      descriptionEn: `The OMS shipping warehouse "${warehouse}" is outside the automation scope, so TMS creation and Pinduoduo submission were blocked.`,
      stoppedStep: row.current_step || 'oms-warehouse-out-of-scope',
    },
    reasonCode: 'warehouse-out-of-scope',
    riskLevel: 'high',
    system: 'oms',
    stage: row.current_step || 'oms-warehouse-out-of-scope',
    occurredAt: snapshot.omsWarehouseParse?.checkedAt || row.updated_at || new Date().toISOString(),
    deliverySource: 'automatic',
  };
};

export const durablePddUploadAuthorizationNotificationPayload = (row = {}) => {
  const snapshot = row.payload || {};
  if (row.status !== 'paused'
    || row.completion_state === 'confirmed'
    || !hasExhaustedPddUploadAuthorizationFailure(snapshot)) return null;
  const problemZh = pddUploadAuthorizationProblemZh;
  return {
    workOrderId: row.work_order_id,
    ordinaryInstanceId: row.current_ordinary_instance_id || null,
    shopId: row.shop_id,
    shopName: notificationShopName(row),
    orderNumber: row.external_order_number,
    warehouse: notificationWarehouse(snapshot),
    tmsEvidenceAssetId: row.tms_evidence_asset_id || null,
    trackingNumber: snapshot.logisticsAnalysis?.trackingNumber || null,
    workOrderType: row.work_order_type || snapshot.workOrderType || null,
    problemZh,
    incompleteAnalysis: {
      reasonZh: problemZh,
      reasonEn: 'Pinduoduo rejected the image upload authorization request as illegal.',
      descriptionZh: '凭证图片上传被拼多多签名接口以 48143 非法请求明确拒绝，自动重试已结束，最终提交未执行。',
      descriptionEn: 'Pinduoduo explicitly rejected the evidence upload signature request with error 48143. Automatic retries ended and the final submission was not executed.',
      stoppedStep: row.current_step || 'pdd-resolution-recovery-exhausted',
    },
    reasonCode: 'pdd-upload-authorization-failed',
    riskLevel: 'high',
    system: 'pdd',
    stage: row.current_step || 'pdd-resolution-recovery-exhausted',
    occurredAt: snapshot.pddResolutionRecovery?.updatedAt
      || snapshot.ordinaryEvidenceUploadRecovery?.updatedAt
      || snapshot.ordinaryEvidenceUploadRecovery?.retryAt
      || row.updated_at
      || new Date().toISOString(),
    deliverySource: 'automatic',
  };
};

export const durableImageUploadFailureNotificationPayload = (row = {}) => {
  const snapshot = row.payload || {};
  const failure = detectFinalImageUploadFailure(snapshot);
  if (row.status !== 'paused'
    || row.completion_state === 'confirmed'
    || !failure
    || hasExhaustedPddUploadAuthorizationFailure(snapshot)
    || (failure.orderNumber && String(failure.orderNumber) !== String(row.external_order_number || ''))) {
    return null;
  }
  const systemName = failure.system === 'tms' ? 'TMS' : '拼多多';
  const outcome = failure.status === 'unknown' ? '上传结果未确认成功' : '上传失败';
  const problemZh = `${systemName}凭证图片${outcome}：${compact(failure.error, 100)}`;
  return {
    workOrderId: row.work_order_id,
    ordinaryInstanceId: row.current_ordinary_instance_id || null,
    shopId: row.shop_id,
    shopName: notificationShopName(row),
    orderNumber: row.external_order_number,
    warehouse: notificationWarehouse(snapshot),
    tmsEvidenceAssetId: row.tms_evidence_asset_id || null,
    trackingNumber: snapshot.logisticsAnalysis?.trackingNumber || null,
    workOrderType: row.work_order_type || snapshot.workOrderType || null,
    problemZh,
    incompleteAnalysis: {
      reasonZh: `${systemName}凭证图片${outcome}。`,
      reasonEn: `${systemName} evidence image upload ${failure.status === 'unknown' ? 'could not be confirmed' : 'failed'}.`,
      descriptionZh: `自动流程已停止在图片上传阶段。错误：${compact(failure.error, 160)}`,
      descriptionEn: `The automated workflow stopped at the image upload stage. Error: ${compact(failure.error, 180)}`,
      stoppedStep: row.current_step || failure.stage,
    },
    reasonCode: 'image-upload-failed',
    riskLevel: 'high',
    system: failure.system,
    stage: row.current_step || failure.stage,
    uploadField: failure.field,
    uploadStatus: failure.status,
    occurredAt: failure.occurredAt || row.updated_at || new Date().toISOString(),
    deliverySource: 'automatic',
  };
};

export const durablePddSubmitReconciliationExhaustedNotificationPayload = (row = {}) => {
  const snapshot = row.payload || {};
  const reconciliation = exhaustedPddSubmitReconciliation(snapshot);
  if (row.status !== 'paused'
    || row.completion_state === 'confirmed'
    || row.current_step !== 'external-state-unresolved'
    || !row.current_ordinary_instance_id
    || !reconciliation) return null;
  const problemZh = `拼多多提交结果未确认，已达到自动提交上限 ${reconciliation.submitAttemptCount}/${reconciliation.maximumAutomaticSubmitAttempts}，禁止重复提交`;
  return {
    workOrderId: row.work_order_id,
    ordinaryInstanceId: row.current_ordinary_instance_id,
    shopId: row.shop_id,
    shopName: notificationShopName(row),
    orderNumber: row.external_order_number,
    warehouse: notificationWarehouse(snapshot),
    tmsEvidenceAssetId: row.tms_evidence_asset_id || null,
    trackingNumber: snapshot.logisticsAnalysis?.trackingNumber || null,
    workOrderType: row.work_order_type || snapshot.workOrderType || null,
    problemZh,
    incompleteAnalysis: {
      reasonZh: '自动化已完成只读对账，但平台仍未确认工单完结。',
      reasonEn: 'Read-only reconciliation could not confirm completion on Pinduoduo.',
      descriptionZh: `${problemZh}。人工只能核对平台当前状态，不能直接再次提交。`,
      descriptionEn: 'The per-order submit limit has been reached. Verify the current platform state manually and do not submit again without confirmation.',
      stoppedStep: 'external-state-unresolved',
    },
    reasonCode: 'pdd-submit-reconciliation-exhausted',
    riskLevel: 'high',
    system: 'pdd',
    stage: 'external-state-unresolved',
    effectId: reconciliation.effectId,
    submitAttemptCount: reconciliation.submitAttemptCount,
    maximumAutomaticSubmitAttempts: reconciliation.maximumAutomaticSubmitAttempts,
    occurredAt: reconciliation.observedAt || row.updated_at || new Date().toISOString(),
    deliverySource: 'automatic',
  };
};

export const durableOrdinaryManualReviewNotificationPayload = (row = {}) => {
  const snapshot = row.payload || {};
  const scenarioCode = String(row.scenario_code || '');
  const reason = notificationReasonFromRow(row);
  const reasonCode = notificationReasonCodeFromRow(row);
  const excludedReason = isTechnicalDingTalkPayload({
    reasonCode: 'ordinary-manual-review',
    evidenceReasonCode: reasonCode,
    evidenceReason: reason,
    problemZh: reason,
    stage: row.current_step,
  });
  if (row.status !== 'paused'
    || row.completion_state === 'confirmed'
    || !row.current_ordinary_instance_id
    || !extendedOrdinaryScenarioCodes.has(scenarioCode)
    || !reason
    || excludedReason
    || hasPendingImageUploadRecovery(snapshot)
    || detectFinalImageUploadFailure(snapshot)
    || hasExhaustedPddUploadAuthorizationFailure(snapshot)
    || snapshot.omsWarehouseParse?.status === 'out-of-scope') return null;
  return {
    workOrderId: row.work_order_id,
    ordinaryInstanceId: row.current_ordinary_instance_id,
    shopId: row.shop_id,
    shopName: notificationShopName(row),
    orderNumber: row.external_order_number,
    warehouse: notificationWarehouse(snapshot),
    tmsEvidenceAssetId: row.tms_evidence_asset_id || null,
    workOrderType: row.work_order_type || snapshot.workOrderType || null,
    problemZh: '新增普通工单需要人工处理',
    incompleteAnalysis: {
      reasonZh: reason,
      reasonEn: 'An extended ordinary work order entered a confirmed manual-review state.',
      descriptionZh: `新增普通工单已停止自动处理。原因：${reason}`,
      descriptionEn: `The extended ordinary work order stopped for manual review. Evidence code: ${reasonCode}.`,
      stoppedStep: row.current_step || 'ordinary-scenario-manual-review',
    },
    reasonCode: 'ordinary-manual-review',
    evidenceReasonCode: reasonCode,
    evidenceReason: reason,
    riskLevel: 'high',
    system: 'pdd',
    stage: row.current_step || 'ordinary-scenario-manual-review',
    occurredAt: row.updated_at || new Date().toISOString(),
    deliverySource: 'automatic',
  };
};

export const durableReturnRefundNotificationPayload = (row = {}) => {
  const actionState = String(row.return_refund_action_state || '');
  if (row.completion_state === 'confirmed'
    || actionState !== 'manual-review'
    || !row.aftersale_number) return null;
  const reason = compact(
    row.manual_review_reason
      || row.payload?.returnRefundResult?.reasons?.join('；')
      || row.payload?.returnRefundResult?.error
      || row.return_refund_reason
      || '退货退款需要人工核查',
    220,
  );
  const stateLabels = {
    'manual-review': '退货退款规则要求转人工处理',
  };
  if (isTechnicalDingTalkPayload({
    reasonCode: `return-refund-${actionState}`,
    evidenceReason: reason,
    problemZh: stateLabels[actionState],
    stage: row.current_step,
  })) return null;
  const descriptionZh = `${stateLabels[actionState]}。原因：${reason}`;
  return {
    workOrderId: row.work_order_id,
    shopId: row.shop_id,
    shopName: notificationShopName(row),
    orderNumber: row.external_order_number,
    aftersaleNumber: row.aftersale_number,
    refundAmount: row.refund_amount,
    actionState,
    workOrderType: '退货退款',
    problemZh: stateLabels[actionState],
    incompleteAnalysis: {
      reasonZh: reason,
      reasonEn: 'A return/refund case requires manual attention.',
      descriptionZh,
      descriptionEn: `The return/refund workflow requires manual attention. State: ${actionState}.`,
      stoppedStep: row.current_step || `return-refund-${actionState}`,
    },
    reasonCode: `return-refund-${actionState}`,
    riskLevel: 'high',
    system: 'pdd',
    stage: row.current_step || `return-refund-${actionState}`,
    occurredAt: row.return_refund_updated_at || row.updated_at || new Date().toISOString(),
    recipientScope: 'return-refund',
    deliverySource: 'automatic',
  };
};

const selfTest = async () => {
  const url = signDingTalkUrl('https://example.com/robot?access_token=test', 'secret', 1700000000000);
  if (!url.includes('timestamp=1700000000000') || !url.includes('sign=')) throw new Error('sign self-test failed');
  const message = buildDingTalkMessage({
    shopId: 'shop',
    orderNumber: '260804-test',
    workOrderType: '消费者申请退款后提示拦截',
    warehouse: '筑越仓',
    tmsEvidenceAssetId: '04685a3d-0f4d-4f40-ac08-770b53bc50d4',
    reason: 'Error: page.goto failed\n    at workflow.mjs:123:45',
    problemZh: '页面触发验证码或滑块，正在等待人工验证。',
    incompleteAnalysis: {
      descriptionZh: '页面触发验证码或滑块，正在等待人工验证。程序停在“页面人工验证阶段”。',
      descriptionEn: 'The page requires verification. The automation stopped at the "human verification" step.',
    },
  }, [{ name: 'operator', mobile: '1' }], 'https://dashboard.example');
  if (message.msgtype !== 'markdown' || !message.markdown.text.includes('拼多多工单待处理')) throw new Error('message self-test failed');
  if (!message.markdown.text.includes('中文') || !message.markdown.text.includes('English')) throw new Error('bilingual analysis self-test failed');
  if (message.markdown.text.includes('人工复制区')
    || !message.markdown.text.includes('- **店铺：** shop')
    || !message.markdown.text.includes('- **订单号：** 260804-test')
    || !message.markdown.text.includes('- **工单类型：** 消费者申请退款后提示拦截')
    || !message.markdown.text.includes('- **OMS发货仓库：** 筑越仓')
    || !message.markdown.text.includes('![TMS凭证图片](https://dashboard.example/api/v1/evidence/04685a3d-0f4d-4f40-ac08-770b53bc50d4/content)')
    || !message.markdown.text.includes('查看或保存TMS凭证原图')) {
    throw new Error('copyable OMS warehouse and actual TMS evidence image self-test failed');
  }
  if (buildDingTalkEvidenceImageUrl('invalid', 'https://dashboard.example')
    || buildDingTalkEvidenceImageUrl('04685a3d-0f4d-4f40-ac08-770b53bc50d4', 'http://127.0.0.1:4173')) {
    throw new Error('TMS evidence public URL guard self-test failed');
  }
  const localEvidenceMessage = buildDingTalkMessage({
    shopId: 'shop',
    orderNumber: '260804-local-evidence',
    workOrderType: '消费者反馈未收到货',
    tmsEvidenceAssetId: '04685a3d-0f4d-4f40-ac08-770b53bc50d4',
  }, [], 'http://127.0.0.1:4173');
  if (!localEvidenceMessage.markdown.text.includes('已生成；当前未配置钉钉可访问的 HTTPS 凭证地址')
    || localEvidenceMessage.markdown.text.includes('TMS凭证图片：** 未生成或暂不可访问')) {
    throw new Error('existing local TMS evidence must not be reported as missing');
  }
  if (message.markdown.text.includes('page.goto') || message.markdown.text.includes('workflow.mjs')) throw new Error('log redaction self-test failed');
  if (!isAllowedDingTalkPayload({ reasonCode: 'warehouse-out-of-scope', deliverySource: 'automatic' })) throw new Error('automatic allow-list self-test failed');
  const shanghaiBoundaryNow = new Date('2026-08-19T07:00:00.000Z');
  if (!isDingTalkDeliveryDateEligible({
    deliverySource: 'automatic', occurredAt: '2026-08-18T16:00:00.000Z',
  }, shanghaiBoundaryNow)) throw new Error('same Shanghai business date must be eligible');
  if (isDingTalkDeliveryDateEligible({
    deliverySource: 'automatic', occurredAt: '2026-08-18T15:59:59.999Z',
  }, shanghaiBoundaryNow)) throw new Error('previous Shanghai business date must be rejected');
  if (!isDingTalkDeliveryDateEligible({
    deliverySource: 'owner-manual', occurredAt: '2026-08-01T00:00:00.000Z',
  }, shanghaiBoundaryNow)) throw new Error('owner manual delivery must remain explicitly available');
  if (dingTalkDeliveryThrottleDelayMs({
    lastDeliveryStartedAt: 10_000,
    now: 12_000,
    minimumIntervalMs: 3_200,
  }) !== 1_200) throw new Error('DingTalk delivery throttle self-test failed');
  if (dingTalkDeliveryThrottleDelayMs({
    lastDeliveryStartedAt: 10_000,
    now: 13_200,
    minimumIntervalMs: 3_200,
  }) !== 0) throw new Error('DingTalk delivery throttle release self-test failed');
  if (isAllowedDingTalkPayload({ reasonCode: 'pdd-upload-authorization-failed', deliverySource: 'automatic' })) throw new Error('upload authorization technical notification must be rejected');
  if (isAllowedDingTalkPayload({ reasonCode: 'image-upload-failed', deliverySource: 'automatic' })) throw new Error('image upload technical notification must be rejected');
  if (isAllowedDingTalkPayload({ reasonCode: 'pdd-submit-reconciliation-exhausted', deliverySource: 'automatic' })) throw new Error('submit reconciliation technical notification must be rejected');
  if (isAllowedDingTalkPayload({ reasonCode: 'flow-paused', deliverySource: 'automatic' })) throw new Error('paused-flow technical notification must be rejected');
  if (isAllowedDingTalkPayload({
    reasonCode: 'ordinary-manual-review', evidenceReasonCode: 'captcha-required',
    evidenceReason: '页面出现验证码，等待人工验证', deliverySource: 'automatic',
  })) throw new Error('verification technical notification must be rejected');
  if (!isAllowedDingTalkPayload({ reasonCode: 'owner-selected', deliverySource: 'owner-manual' })) throw new Error('manual delivery self-test failed');
  if (isAllowedDingTalkPayload({ reasonCode: 'external-system-error', deliverySource: 'automatic' })) throw new Error('automatic allow-list rejection self-test failed');
  const durablePayload = durableWarehouseNotificationPayload({
    work_order_id: 'work-order', shop_id: 'shop', shop_name: '店铺', external_order_number: '260810-test',
    work_order_type: '已发货无轨迹退款', status: 'paused', completion_state: 'pending', current_step: 'flow-paused',
    payload: { omsWarehouseParse: { status: 'out-of-scope', parsedValue: '代发聚水潭-迅发' } },
  });
  if (durablePayload?.warehouse !== '代发聚水潭-迅发' || durablePayload.deliverySource !== 'automatic') {
    throw new Error('durable automatic warehouse notification self-test failed');
  }
  if (durableWarehouseNotificationPayload({
    status: 'paused', completion_state: 'pending',
    payload: { error: 'OMS 发货仓库可能异常' },
  })) throw new Error('unstructured warehouse error must not trigger automatic notification');
  const eligibleWarehouseRow = {
    payload: durablePayload,
    workOrderId: 'work-order',
    workOrderShopId: 'shop',
    externalOrderNumber: '260810-test',
    interventionStatus: 'open',
    interventionReasonCode: 'warehouse-out-of-scope',
    frontendVisibility: 'operational',
    workOrderStatus: 'paused',
    workOrderRuntimeStatus: 'manual-review',
    completionState: 'pending',
    scenarioCode: 'shipped-no-tracking-refund',
    currentStep: 'manual-review-blocked',
    workOrderPayload: { omsWarehouseParse: { status: 'out-of-scope', parsedValue: '代发聚水潭-迅发' } },
  };
  if (!isDingTalkDeliveryEligible(eligibleWarehouseRow)) throw new Error('verified delivery eligibility self-test failed');
  if (isDingTalkDeliveryEligible({ ...eligibleWarehouseRow, completionState: 'confirmed' })) {
    throw new Error('completed work order must not be delivered');
  }
  if (isDingTalkDeliveryEligible({
    ...eligibleWarehouseRow,
    workOrderPayload: { omsWarehouseParse: { status: 'out-of-scope', parsedValue: '' } },
  })) throw new Error('automatic delivery without structured evidence must be rejected');
  if (isDingTalkDeliveryEligible({
    ...eligibleWarehouseRow,
    payload: { ...durablePayload, orderNumber: 'different-order' },
  })) throw new Error('mismatched work order identity must be rejected');
  const uploadFailureSnapshot = {
    pddResolutionRecovery: {
      status: 'exhausted', attempts: 3, lastErrorCode: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
      updatedAt: '2026-08-10T06:17:59.602Z',
      failures: [1, 2, 3].map((attempt) => ({
        attempt,
        code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
        message: '拼多多凭证上传授权失败（48143）：非法请求',
        uploadAuthorizationFailure: {
          code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
          errorCode: 48143,
          errorMessage: '非法请求',
        },
      })),
    },
    pddResolutionSubmission: { status: 'retry-authorized' },
  };
  const uploadFailurePayload = durablePddUploadAuthorizationNotificationPayload({
    work_order_id: 'upload-work-order', shop_id: 'shop', shop_name: '店铺',
    external_order_number: '260810-upload', work_order_type: '已发货无轨迹退款',
    status: 'paused', completion_state: 'pending', current_step: 'manual-review-blocked',
    payload: uploadFailureSnapshot,
  });
  if (uploadFailurePayload?.problemZh !== pddUploadAuthorizationProblemZh) {
    throw new Error('durable upload authorization notification self-test failed');
  }
  const eligibleUploadFailureRow = {
    payload: uploadFailurePayload,
    workOrderId: 'upload-work-order',
    workOrderShopId: 'shop',
    externalOrderNumber: '260810-upload',
    interventionStatus: 'open',
    interventionReasonCode: 'pdd-upload-authorization-failed',
    frontendVisibility: 'operational',
    workOrderStatus: 'paused',
    workOrderRuntimeStatus: 'paused',
    completionState: 'pending',
    scenarioCode: 'shipped-no-tracking-refund',
    currentStep: 'manual-review-blocked',
    workOrderPayload: uploadFailureSnapshot,
  };
  if (isDingTalkDeliveryEligible(eligibleUploadFailureRow)) {
    throw new Error('technical upload authorization delivery must be rejected');
  }
  if (isDingTalkDeliveryEligible({
    ...eligibleUploadFailureRow,
    workOrderPayload: {
      ...uploadFailureSnapshot,
      pddResolutionRecovery: { ...uploadFailureSnapshot.pddResolutionRecovery, attempts: 2,
        failures: uploadFailureSnapshot.pddResolutionRecovery.failures.slice(0, 2) },
    },
  })) throw new Error('upload authorization notification must require three failed attempts');
  const ordinaryUploadFailureSnapshot = {
    error: '拼多多凭证上传授权失败（48143）：非法请求',
    ordinaryEvidenceUpload: {
      status: 'failed',
      error: '拼多多凭证上传授权失败（48143）：非法请求',
      diagnostics: {
        authorizationFailure: {
          code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
          errorCode: 48143,
          errorMessage: '非法请求',
        },
      },
    },
    ordinaryEvidenceUploadRecovery: {
      attempt: 2,
      maxAttempts: 3,
      error: '拼多多凭证上传授权失败（48143）：非法请求',
    },
  };
  const ordinaryUploadPayload = durablePddUploadAuthorizationNotificationPayload({
    work_order_id: 'ordinary-upload-work-order',
    current_ordinary_instance_id: 'ordinary-instance',
    shop_id: 'shop',
    shop_name: '店铺',
    external_order_number: '260810-ordinary-upload',
    work_order_type: '消费者申请退款后提示拦截',
    status: 'paused',
    completion_state: 'pending',
    current_step: 'flow-paused',
    payload: ordinaryUploadFailureSnapshot,
  });
  if (ordinaryUploadPayload?.ordinaryInstanceId !== 'ordinary-instance') {
    throw new Error('extended ordinary upload failure must create an instance-bound notification');
  }
  if (isDingTalkDeliveryEligible({
    ...eligibleUploadFailureRow,
    payload: ordinaryUploadPayload,
    workOrderId: 'ordinary-upload-work-order',
    externalOrderNumber: '260810-ordinary-upload',
    scenarioCode: 'intercept-recall',
    currentStep: 'flow-paused',
    workOrderPayload: ordinaryUploadFailureSnapshot,
  })) throw new Error('technical ordinary upload delivery must be rejected');
  if (hasExhaustedPddUploadAuthorizationFailure({
    ...ordinaryUploadFailureSnapshot,
    ordinaryEvidenceUploadRecovery: {
      ...ordinaryUploadFailureSnapshot.ordinaryEvidenceUploadRecovery,
      attempt: 1,
    },
  })) throw new Error('extended ordinary upload notification must require the final failed attempt');
  const definitiveSingleAttemptSnapshot = {
    error: '拼多多凭证上传授权失败（48143）：非法请求',
    ordinaryEvidenceUpload: {
      status: 'failed',
      error: '拼多多凭证上传授权失败（48143）：非法请求',
      diagnostics: {
        authorizationFailure: {
          code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
          errorCode: 48143,
          errorMessage: '非法请求',
        },
      },
    },
    ordinaryEvidenceUploadRecovery: {
      status: 'exhausted',
      attempt: 1,
      attempts: 1,
      maxAttempts: 1,
      definitiveAuthorizationFailure: true,
      failures: [{
        code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
        uploadAuthorizationFailure: {
          code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
          errorCode: 48143,
          errorMessage: '非法请求',
        },
      }],
    },
  };
  if (!hasExhaustedPddUploadAuthorizationFailure(definitiveSingleAttemptSnapshot)) {
    throw new Error('definitive 48143 rejection must notify after the configured retry limit ends');
  }
  if (hasExhaustedPddUploadAuthorizationFailure({
    ...definitiveSingleAttemptSnapshot,
    ordinaryEvidenceUploadRecovery: {
      ...definitiveSingleAttemptSnapshot.ordinaryEvidenceUploadRecovery,
      status: 'retrying',
    },
  })) throw new Error('a retrying 48143 upload must not notify before retry exhaustion');
  const genericUploadFailureSnapshot = {
    pddEvidenceUpload: {
      orderNumber: '260810-generic-upload',
      status: 'unknown',
      error: '等待上传结果超时',
      failedAt: '2026-08-10T06:18:00.000Z',
    },
  };
  const genericUploadPayload = durableImageUploadFailureNotificationPayload({
    work_order_id: 'generic-upload-work-order',
    shop_id: 'shop',
    shop_name: '店铺',
    external_order_number: '260810-generic-upload',
    work_order_type: '在途无理由退款处理',
    status: 'paused',
    completion_state: 'pending',
    current_step: 'flow-paused',
    payload: genericUploadFailureSnapshot,
  });
  if (genericUploadPayload?.reasonCode !== 'image-upload-failed'
    || genericUploadPayload.uploadStatus !== 'unknown') {
    throw new Error('generic PDD image upload failure notification self-test failed');
  }
  if (isDingTalkDeliveryEligible({
    ...eligibleUploadFailureRow,
    payload: genericUploadPayload,
    workOrderId: 'generic-upload-work-order',
    externalOrderNumber: '260810-generic-upload',
    interventionReasonCode: 'image-upload-failed',
    workOrderPayload: genericUploadFailureSnapshot,
  })) throw new Error('technical image upload delivery must be rejected');
  if (detectFinalImageUploadFailure({
    ordinaryEvidenceUpload: { status: 'failed', error: '上传失败' },
    ordinaryEvidenceUploadRecovery: { status: 'retrying' },
  })) throw new Error('image upload retry must not be treated as a final failure');
  const tmsUploadPayload = durableImageUploadFailureNotificationPayload({
    work_order_id: 'tms-upload-work-order',
    shop_id: 'shop',
    shop_name: '店铺',
    external_order_number: '260810-tms-upload',
    status: 'paused',
    completion_state: 'pending',
    current_step: 'tms-attachment-upload-failed',
    payload: {
      tmsAttachmentTransfer: {
        orderNumber: '260810-tms-upload',
        status: 'failed',
        error: 'TMS 附件接口返回失败',
      },
    },
  });
  if (tmsUploadPayload?.system !== 'tms' || tmsUploadPayload.uploadField !== 'tmsAttachmentTransfer') {
    throw new Error('TMS image upload failure notification self-test failed');
  }
  const exhaustedReconciliationSnapshot = {
    omsAnalysis: { shippingWarehouse: '代发聚水潭-筑越' },
    externalStateReconciliation: {
      state: 'unresolved',
      effectType: 'pdd-submit',
      effectId: 'submit-effect',
      submitAttemptCount: 1,
      maximumAutomaticSubmitAttempts: 1,
      automaticRetryExhausted: true,
      observedAt: '2026-08-19T02:36:17.000Z',
    },
  };
  const exhaustedReconciliationPayload = durablePddSubmitReconciliationExhaustedNotificationPayload({
    work_order_id: 'reconciliation-work-order',
    current_ordinary_instance_id: 'reconciliation-instance',
    shop_id: 'shop',
    shop_name: '店铺',
    external_order_number: '260817-reconciliation',
    work_order_type: '消费者申请退款后提示拦截',
    status: 'paused',
    completion_state: 'pending',
    current_step: 'external-state-unresolved',
    tms_evidence_asset_id: '04685a3d-0f4d-4f40-ac08-770b53bc50d4',
    payload: exhaustedReconciliationSnapshot,
  });
  if (exhaustedReconciliationPayload?.maximumAutomaticSubmitAttempts !== 1
    || exhaustedReconciliationPayload.warehouse !== '代发聚水潭-筑越'
    || exhaustedReconciliationPayload.tmsEvidenceAssetId
      !== '04685a3d-0f4d-4f40-ac08-770b53bc50d4') {
    throw new Error('exhausted PDD submit reconciliation notification self-test failed');
  }
  const eligibleExhaustedReconciliationRow = {
    payload: exhaustedReconciliationPayload,
    workOrderId: 'reconciliation-work-order',
    workOrderShopId: 'shop',
    externalOrderNumber: '260817-reconciliation',
    currentOrdinaryInstanceId: 'reconciliation-instance',
    interventionStatus: 'open',
    interventionReasonCode: 'pdd-submit-reconciliation-exhausted',
    frontendVisibility: 'operational',
    workOrderStatus: 'paused',
    workOrderRuntimeStatus: 'paused',
    completionState: 'pending',
    scenarioCode: 'intercept-recall',
    currentStep: 'external-state-unresolved',
    workOrderPayload: exhaustedReconciliationSnapshot,
  };
  if (isDingTalkDeliveryEligible(eligibleExhaustedReconciliationRow)) {
    throw new Error('technical submit reconciliation delivery must be rejected');
  }
  if (isDingTalkDeliveryEligible({
    ...eligibleExhaustedReconciliationRow,
    workOrderPayload: {
      ...exhaustedReconciliationSnapshot,
      externalStateReconciliation: {
        ...exhaustedReconciliationSnapshot.externalStateReconciliation,
        automaticRetryExhausted: false,
      },
    },
  })) throw new Error('reconciliation notification must require an exhausted submit limit');
  const ordinaryReviewRow = {
    work_order_id: 'ordinary-review-work-order',
    current_ordinary_instance_id: 'ordinary-review-instance',
    shop_id: 'shop',
    shop_name: '店铺',
    external_order_number: '260817-ordinary-review',
    work_order_type: '物流异常主动服务',
    scenario_code: 'proactive-logistics-service',
    status: 'paused',
    completion_state: 'pending',
    current_step: 'ordinary-scenario-manual-review',
    manual_review_reason: '工单剩余处理时间缺失，无法安全判断',
    payload: { ordinaryScenarioDecision: { reasonCode: 'work-order-remaining-time-missing' } },
  };
  const ordinaryReviewPayload = durableOrdinaryManualReviewNotificationPayload(ordinaryReviewRow);
  if (ordinaryReviewPayload?.ordinaryInstanceId !== 'ordinary-review-instance') {
    throw new Error('extended ordinary manual-review notification self-test failed');
  }
  if (!isDingTalkDeliveryEligible({
    payload: ordinaryReviewPayload,
    workOrderId: ordinaryReviewRow.work_order_id,
    workOrderShopId: ordinaryReviewRow.shop_id,
    externalOrderNumber: ordinaryReviewRow.external_order_number,
    interventionStatus: 'open',
    interventionReasonCode: 'ordinary-manual-review',
    frontendVisibility: 'operational',
    workOrderStatus: 'paused',
    workOrderRuntimeStatus: 'manual-review',
    completionState: 'pending',
    scenarioCode: ordinaryReviewRow.scenario_code,
    currentStep: ordinaryReviewRow.current_step,
    currentOrdinaryInstanceId: ordinaryReviewRow.current_ordinary_instance_id,
    manualReviewReason: ordinaryReviewRow.manual_review_reason,
    workOrderPayload: ordinaryReviewRow.payload,
  })) throw new Error('extended ordinary delivery eligibility self-test failed');
  if (!durableOrdinaryManualReviewNotificationPayload({
    ...ordinaryReviewRow,
    work_order_type: '消费者担忧货物无法送达',
    scenario_code: 'delivery-risk-concern',
  })) throw new Error('business manual-review notification must not be filtered by scenario type');
  if (!durableOrdinaryManualReviewNotificationPayload({
    ...ordinaryReviewRow,
    work_order_type: '消费者反馈未收到货',
    scenario_code: 'delivered-not-received',
  })) throw new Error('business manual-review notification must not be filtered by scenario type');
  if (durableOrdinaryManualReviewNotificationPayload({
    ...ordinaryReviewRow,
    manual_review_reason: '页面出现验证码，等待人工验证',
  })) throw new Error('verification wait must not create an ordinary business notification');

  const refundReviewRow = {
    work_order_id: 'refund-review-work-order',
    shop_id: 'shop',
    shop_name: '店铺',
    external_order_number: '260817-refund-review',
    status: 'paused',
    completion_state: 'pending',
    current_step: 'return-refund-manual-review',
    return_refund_action_state: 'manual-review',
    return_refund_reason: '退款金额超出自动处理范围',
    aftersale_number: '310001234567890',
    refund_amount: '599.00',
    payload: {},
  };
  const refundReviewPayload = durableReturnRefundNotificationPayload(refundReviewRow);
  if (refundReviewPayload?.recipientScope !== 'return-refund'
    || refundReviewPayload.reasonCode !== 'return-refund-manual-review') {
    throw new Error('return-refund notification payload self-test failed');
  }
  const refundRecipients = [
    { name: '狄云', mobile: '18038786876' },
    { name: '霜寒', mobile: '15348369537' },
  ];
  const refundMessage = buildDingTalkMessage(refundReviewPayload, refundRecipients);
  if (!refundMessage.markdown.text.includes('售后编号')
    || !refundMessage.markdown.text.includes('@狄云')
    || refundMessage.at.atMobiles.length !== 2) {
    throw new Error('return-refund recipients self-test failed');
  }
  if (!isDingTalkDeliveryEligible({
    payload: refundReviewPayload,
    workOrderId: refundReviewRow.work_order_id,
    workOrderShopId: refundReviewRow.shop_id,
    externalOrderNumber: refundReviewRow.external_order_number,
    interventionStatus: 'open',
    interventionReasonCode: 'return-refund-manual-review',
    frontendVisibility: 'operational',
    workOrderStatus: 'paused',
    workOrderRuntimeStatus: 'manual-review',
    completionState: 'pending',
    scenarioCode: 'return-refund',
    currentStep: refundReviewRow.current_step,
    aftersaleNumber: refundReviewRow.aftersale_number,
    returnRefundActionState: refundReviewRow.return_refund_action_state,
    workOrderPayload: {},
  })) throw new Error('return-refund delivery eligibility self-test failed');
  if (durableReturnRefundNotificationPayload({
    ...refundReviewRow,
    return_refund_action_state: 'waiting-logistics',
  })) throw new Error('normal return-refund logistics wait must not notify');
  if (durableReturnRefundNotificationPayload({
    ...refundReviewRow,
    return_refund_action_state: 'page-error',
  })) throw new Error('retryable return-refund page errors must not notify');
  const refundVerificationPayload = durableReturnRefundNotificationPayload({
    ...refundReviewRow,
    current_step: 'return-refund-verification-required',
    return_refund_action_state: 'verification-required',
    return_refund_reason: '退款页面仍有人工验证，禁止重复点击',
  });
  if (refundVerificationPayload) {
    throw new Error('return-refund verification must not create a DingTalk handoff');
  }

  const summaryMessage = buildDailySummaryMessage({
    todayProcessed: 12,
    historicalProcessed: 345,
  });
  if (!summaryMessage.markdown.text.includes('- 今日Agent已处理单量 12 单')
    || !summaryMessage.markdown.text.includes('- Agent历史总处理单量 345 单')
    || summaryMessage.markdown.text.includes('统计日期')
    || summaryMessage.at.atMobiles.length !== 0) {
    throw new Error('daily summary message self-test failed');
  }
  const editedSummaryMessage = buildDailySummaryMessage({
    messageText: '今日Agent已处理单量 18 单\nAgent历史总处理单量 2026 单',
  });
  if (!editedSummaryMessage.markdown.text.includes('- 今日Agent已处理单量 18 单')
    || !editedSummaryMessage.markdown.text.includes('- Agent历史总处理单量 2026 单')) {
    throw new Error('edited daily summary message self-test failed');
  }
  if (dingtalkDailySummarySchedule({
    now: new Date('2026-08-30T10:29:59.000Z'),
    automaticEnabled: true,
    startDate: '2026-08-30',
  }).due) throw new Error('daily summary must not send before 18:30 Beijing time');
  if (!dingtalkDailySummarySchedule({
    now: new Date('2026-08-30T10:30:00.000Z'),
    automaticEnabled: true,
    startDate: '2026-08-30',
  }).due) throw new Error('daily summary must become due at 18:30 Beijing time');
  if (dingtalkDailySummarySchedule({
    now: new Date('2026-08-30T12:00:00.000Z'),
    automaticEnabled: true,
    startDate: '2026-08-31',
  }).due) throw new Error('daily summary start date must prevent same-day backfill');
  const dispatcherSource = await fsp.readFile(fileURLToPath(import.meta.url), 'utf8');
  if (!/\$1::boolean AND w\.status = 'paused'\s+AND w\.updated_at >= \(date_trunc\('day', now\(\) AT TIME ZONE 'Asia\/Shanghai'\)\s+AT TIME ZONE 'Asia\/Shanghai'\)/u
    .test(dispatcherSource)) {
    throw new Error('automatic ordinary candidates must be restricted to the current Shanghai day');
  }
  if (!/refund\.updated_at >= \(date_trunc\('day', now\(\) AT TIME ZONE 'Asia\/Shanghai'\)\s+AT TIME ZONE 'Asia\/Shanghai'\)/u
    .test(dispatcherSource)) {
    throw new Error('automatic return/refund candidates must be restricted to the current Shanghai day');
  }
  if (!/ORDER BY greatest\(w\.updated_at, coalesce\(refund\.updated_at, w\.updated_at\)\) DESC LIMIT 100/u
    .test(dispatcherSource)) {
    throw new Error('automatic DingTalk candidates must prefer the newest actionable rows');
  }
  console.log('DingTalk dispatcher self-test passed');
};

if (process.argv.includes('--self-test')) {
  await selfTest();
  process.exit(0);
}

const enabled = String(process.env.DINGTALK_NOTIFICATIONS_ENABLED || 'false').toLowerCase() === 'true';
const pollMs = Math.max(5000, Number(process.env.DINGTALK_POLL_INTERVAL_MS || 15000));
const dashboardUrl = process.env.DASHBOARD_PUBLIC_URL || 'http://127.0.0.1:4173';
const evidencePublicBaseUrl = process.env.DINGTALK_EVIDENCE_PUBLIC_BASE_URL || dashboardUrl;
const dryRun = process.argv.includes('--dry-run');
const once = process.argv.includes('--once');
const dailySummaryOnly = String(process.env.DINGTALK_DAILY_SUMMARY_ONLY || 'false').toLowerCase() === 'true';

if (!enabled && !dryRun) {
  console.log('[钉钉通知] 未启用；仅保留待发送 Outbox，不会请求外部 Webhook');
  setInterval(() => {}, 60_000);
} else {
  const [{ default: pg }, webhook, signingSecret, recipientsText, returnRefundRecipientsText] = await Promise.all([
    import('pg'),
    readSecret('DINGTALK_WEBHOOK'),
    readSecret('DINGTALK_SIGNING_SECRET'),
    readSecret('DINGTALK_RECIPIENTS'),
    readSecret('DINGTALK_RETURN_REFUND_RECIPIENTS'),
  ]);
  const recipients = JSON.parse(recipientsText || '[]');
  const returnRefundRecipients = JSON.parse(returnRefundRecipientsText || recipientsText || '[]');
  if (!dryRun && (!webhook || !signingSecret)) {
    throw new Error('DingTalk is enabled but webhook/signing secret are not configured');
  }
  if (!dryRun && !returnRefundRecipients.length) {
    throw new Error('DingTalk return/refund recipients are not configured');
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const requestTimeoutMs = Math.min(
    60_000,
    Math.max(5_000, Number(process.env.DINGTALK_REQUEST_TIMEOUT_MS || 20_000)),
  );
  const staleSendingMs = Math.max(
    requestTimeoutMs * 3,
    Number(process.env.DINGTALK_STALE_SENDING_MS || 5 * 60_000),
  );
  const minimumDeliveryIntervalMs = Math.max(
    3_200,
    Number(process.env.DINGTALK_MIN_DELIVERY_INTERVAL_MS || 3_200),
  );
  pool.on('error', (error) => {
    console.error('[钉钉通知] PostgreSQL 空闲连接异常，调度循环将继续重试', {
      code: error?.code || null,
      message: error?.message || String(error),
    });
  });
  const dailySummaryRefreshMs = Math.max(
    30_000,
    Number(process.env.DINGTALK_DAILY_SUMMARY_REFRESH_MS || 60_000),
  );
  const shanghaiClock = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  let lastDailySummaryRefreshAt = 0;
  let lastDailySummarySnapshotDate = null;

  const enqueueDailySummary = async () => {
    const now = new Date();
    const clock = Object.fromEntries(shanghaiClock.formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]));
    const summaryDate = `${clock.year}-${clock.month}-${clock.day}`;
    const afterScheduledSnapshot = Number(clock.hour) > 18
      || (Number(clock.hour) === 18 && Number(clock.minute) >= 25);
    const scheduledSnapshotDue = afterScheduledSnapshot
      && lastDailySummarySnapshotDate !== summaryDate;
    const initialRefresh = lastDailySummaryRefreshAt === 0;
    const refreshDue = now.getTime() - lastDailySummaryRefreshAt >= dailySummaryRefreshMs;
    if (!refreshDue && !scheduledSnapshotDue) return 0;

    const result = await pool.query(`
      WITH successful_outcomes AS (
        SELECT 'ordinary-instance:' || instance.id::text AS unit_key,
          instance.completed_at AS processed_at,
          (
            instance.completion_method = ANY(ARRAY[
              'detail-completed',
              'absent-from-pending-list',
              'recovery-delayed-detail-check',
              'handover-detail-completed',
              'handover-absent-from-pending-list'
            ])
            AND coalesce(work_order.handling_classification, 'automated') = 'automated'
            AND coalesce(work_order.classification_source, 'system') = 'system'
            AND coalesce(
              (work_order.payload->'pddResolutionSubmission'->>'recoveredFromCompletedPage')::boolean,
              (work_order.payload->'lastCompletedOrder'->>'recoveredFromCompletedPage')::boolean,
              (work_order.payload->'completionArchive'->>'recoveredFromCompletedPage')::boolean,
              false
            ) = false
            AND NOT EXISTS (
              SELECT 1 FROM manual_interventions intervention
              WHERE intervention.work_order_id = work_order.id
                AND (
                  intervention.ordinary_instance_id = instance.id
                  OR (
                    intervention.ordinary_instance_id IS NULL
                    AND (
                      SELECT count(*) FROM ordinary_work_order_instances related_instance
                      WHERE related_instance.work_order_id = work_order.id
                    ) <= 1
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM data_corrections correction
              WHERE correction.work_order_id = work_order.id
                AND correction.rolled_back_at IS NULL
                AND (
                  correction.ordinary_instance_id = instance.id
                  OR (
                    correction.ordinary_instance_id IS NULL
                    AND (
                      SELECT count(*) FROM ordinary_work_order_instances related_instance
                      WHERE related_instance.work_order_id = work_order.id
                    ) <= 1
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM operator_commands command
              WHERE command.work_order_id = work_order.id
                AND command.status <> 'cancelled'
                AND (
                  command.ordinary_instance_id = instance.id
                  OR (
                    command.ordinary_instance_id IS NULL
                    AND (
                      SELECT count(*) FROM ordinary_work_order_instances related_instance
                      WHERE related_instance.work_order_id = work_order.id
                    ) <= 1
                  )
                )
            )
          ) AS strict_automated,
          true AS completed
        FROM ordinary_work_order_instances instance
        JOIN work_orders work_order ON work_order.id = instance.work_order_id
        WHERE instance.completed_at IS NOT NULL
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        UNION ALL
        SELECT 'ordinary-legacy:' || work_order.id::text,
          work_order.completion_confirmed_at,
          (
            work_order.completion_confirmation_method = ANY(ARRAY[
              'detail-completed',
              'absent-from-pending-list',
              'recovery-delayed-detail-check',
              'handover-detail-completed',
              'handover-absent-from-pending-list'
            ])
            AND coalesce(work_order.handling_classification, 'automated') = 'automated'
            AND coalesce(work_order.classification_source, 'system') = 'system'
            AND coalesce(
              (work_order.payload->'pddResolutionSubmission'->>'recoveredFromCompletedPage')::boolean,
              (work_order.payload->'lastCompletedOrder'->>'recoveredFromCompletedPage')::boolean,
              (work_order.payload->'completionArchive'->>'recoveredFromCompletedPage')::boolean,
              false
            ) = false
            AND NOT EXISTS (
              SELECT 1 FROM manual_interventions intervention
              WHERE intervention.work_order_id = work_order.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM data_corrections correction
              WHERE correction.work_order_id = work_order.id
                AND correction.rolled_back_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM operator_commands command
              WHERE command.work_order_id = work_order.id
                AND command.status <> 'cancelled'
            )
          ) AS strict_automated,
          true AS completed
        FROM work_orders work_order
        WHERE work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.completion_state = 'confirmed'
          AND work_order.completion_confirmed_at IS NOT NULL
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
          AND NOT EXISTS (
            SELECT 1 FROM ordinary_work_order_instances instance
            WHERE instance.work_order_id = work_order.id
          )
        UNION ALL
        SELECT 'return-refund:' || refund.shop_id || ':' || refund.aftersale_number,
          refund.completed_at,
          (
            (
              (
                refund.action_state = 'auto-refunded'
                AND refund.completion_method = 'return-refund-button-disappeared'
              )
              OR (
                refund.action_state = 'manual-completed'
                AND refund.completion_method = 'return-refund-read-only-page-completed'
              )
            )
            AND coalesce(work_order.handling_classification, 'automated') = 'automated'
            AND coalesce(work_order.classification_source, 'system') = 'system'
            AND NOT EXISTS (
              SELECT 1 FROM manual_interventions intervention
              WHERE intervention.work_order_id = work_order.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM data_corrections correction
              WHERE correction.work_order_id = work_order.id
                AND correction.rolled_back_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM operator_commands command
              WHERE command.work_order_id = work_order.id
                AND command.status <> 'cancelled'
            )
          ) AS strict_automated,
          true AS completed
        FROM return_refunds refund
        JOIN work_orders work_order ON work_order.id = refund.work_order_id
        WHERE refund.completed_at IS NOT NULL
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        UNION ALL
        SELECT 'return-refund:' || refund.shop_id || ':' || refund.aftersale_number,
          event.occurred_at,
          false AS strict_automated,
          false AS completed
        FROM workflow_events event
        JOIN return_refunds refund ON refund.work_order_id = event.work_order_id
        JOIN work_orders work_order ON work_order.id = event.work_order_id
        WHERE event.event_type IN ('return-refund.decision', 'return-refund.result')
          AND event.payload->>'outcome' = 'wait-logistics'
          AND coalesce(
            nullif(event.payload->'rules', 'null'::jsonb),
            '{}'::jsonb
          ) <> '{}'::jsonb
          AND coalesce(
            nullif(event.payload->'evidence', 'null'::jsonb),
            nullif(event.payload #> '{facts,evidence}', 'null'::jsonb),
            '{}'::jsonb
          ) <> '{}'::jsonb
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      ), successfully_processed_units AS (
        SELECT unit_key, max(processed_at) AS processed_at,
          bool_or(strict_automated) AS strict_automated,
          bool_or(completed) AS completed
        FROM successful_outcomes
        GROUP BY unit_key
      ), statistics AS (
        SELECT count(*) FILTER (
            WHERE processed_at >= ((($1::date - 1) + time '18:30')
                AT TIME ZONE 'Asia/Shanghai')
              AND processed_at < (($1::date + time '18:30')
                AT TIME ZONE 'Asia/Shanghai')
          )::int AS today_processed,
          count(*) FILTER (
            WHERE processed_at >= ((($1::date - 1) + time '18:30')
                AT TIME ZONE 'Asia/Shanghai')
              AND processed_at < (($1::date + time '18:30')
                AT TIME ZONE 'Asia/Shanghai')
              AND strict_automated
          )::int AS today_strict_automated,
          count(*) FILTER (
            WHERE processed_at >= ((($1::date - 1) + time '18:30')
                AT TIME ZONE 'Asia/Shanghai')
              AND processed_at < (($1::date + time '18:30')
                AT TIME ZONE 'Asia/Shanghai')
              AND completed
          )::int AS today_completed,
          count(*)::int AS historical_processed
        FROM successfully_processed_units
      )
      INSERT INTO dingtalk_daily_summaries
        (summary_date, timezone, today_processed, today_completed, today_strict_automated,
         historical_processed, message_text, status, statistics_refreshed_at)
      SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date,
        'Asia/Shanghai', statistics.today_processed, statistics.today_completed,
        statistics.today_strict_automated,
        statistics.historical_processed,
        concat(
          '今日Agent已处理单量 ', statistics.today_processed, ' 单', E'\\n',
          'Agent历史总处理单量 ', statistics.historical_processed, ' 单'
        ),
        'pending', now()
      FROM statistics
      ON CONFLICT (summary_date) DO UPDATE SET
        today_processed = EXCLUDED.today_processed,
        today_completed = EXCLUDED.today_completed,
        today_strict_automated = EXCLUDED.today_strict_automated,
        historical_processed = EXCLUDED.historical_processed,
        message_text = CASE
          WHEN dingtalk_daily_summaries.edited_at IS NULL
            AND dingtalk_daily_summaries.send_requested_at IS NULL
            AND dingtalk_daily_summaries.status = 'pending'
          THEN EXCLUDED.message_text
          ELSE dingtalk_daily_summaries.message_text
        END,
        statistics_refreshed_at = now(),
        updated_at = now()
      RETURNING summary_date::text`, [summaryDate]);
    lastDailySummaryRefreshAt = now.getTime();
    if (scheduledSnapshotDue) {
      lastDailySummarySnapshotDate = summaryDate;
      console.log(`[钉钉通知] 已完成 ${summaryDate} 18:25 每日汇总统计快照`);
    } else if (result.rowCount && initialRefresh) {
      console.log(`[钉钉通知] 已生成并持续刷新 ${result.rows[0].summary_date} 每日处理汇总`);
    }
    return result.rowCount;
  };

  const enqueueDurableAutomaticNotifications = async () => {
    const enabledResult = await pool.query(`
      SELECT key, value, updated_at FROM system_settings
      WHERE key IN (
        'dingtalk-automatic-enabled',
        'dingtalk-extended-ordinary-enabled',
        'return-refund-dingtalk-enabled'
      )`);
    const settings = new Map(enabledResult.rows.map((row) => [row.key, row]));
    const automaticEnabled = settings.get('dingtalk-automatic-enabled')?.value === true;
    const extendedOrdinaryEnabled = settings.get('dingtalk-extended-ordinary-enabled')?.value === true;
    const returnRefundEnabled = settings.get('return-refund-dingtalk-enabled')?.value === true;
    const extendedOrdinaryEnabledAt = settings.get('dingtalk-extended-ordinary-enabled')?.updated_at || new Date();
    const returnRefundEnabledAt = settings.get('return-refund-dingtalk-enabled')?.updated_at || new Date();
    if (!automaticEnabled && !returnRefundEnabled) return 0;
    const candidates = await pool.query(`
      SELECT w.id AS work_order_id, w.shop_id, w.current_ordinary_instance_id,
        shop.name AS shop_name,
        shop.expected_shop_name AS expected_shop_name,
        w.external_order_number, w.work_order_type, w.scenario_code, w.status,
        w.current_step, w.manual_review_reason, w.completion_state, w.updated_at, w.payload,
        tms_evidence.id::text AS tms_evidence_asset_id,
        refund.aftersale_number, refund.refund_amount,
        refund.action_state AS return_refund_action_state,
        refund.updated_at AS return_refund_updated_at,
        coalesce(refund.decision, refund.action_state) AS return_refund_reason
      FROM work_orders w
      JOIN shops shop ON shop.id = w.shop_id
      LEFT JOIN LATERAL (
        SELECT evidence.id
        FROM evidence_assets evidence
        WHERE evidence.work_order_id = w.id
          AND evidence.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
          AND evidence.kind = 'tms-evidence'
          AND evidence.status = 'ready'
          AND evidence.deleted_at IS NULL
        ORDER BY evidence.created_at DESC LIMIT 1
      ) tms_evidence ON true
      LEFT JOIN return_refunds refund ON refund.work_order_id = w.id
      WHERE coalesce(w.completion_state, 'pending') <> 'confirmed'
        -- Disabled/test shops must never create production DingTalk notices.
        -- This also prevents claim self-test fixtures from leaking into the
        -- real notification queue when a test and dispatcher overlap.
        AND shop.enabled IS TRUE
        AND (
          ($1::boolean AND w.status = 'paused'
            AND w.updated_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')
              AT TIME ZONE 'Asia/Shanghai')
            AND (
            (w.payload #>> '{omsWarehouseParse,status}' = 'out-of-scope'
              AND nullif(w.payload #>> '{omsWarehouseParse,parsedValue}', '') IS NOT NULL)
            OR w.payload #>> '{pddResolutionRecovery,status}' = 'exhausted'
            OR w.payload #>> '{pddEvidenceUpload,status}' IN ('failed', 'unknown')
            OR w.payload #>> '{ordinaryEvidenceUpload,status}' IN ('failed', 'unknown')
            OR w.payload #>> '{tmsAttachmentTransfer,status}' = 'failed'
            OR (w.current_step = 'external-state-unresolved'
              AND w.payload #>> '{externalStateReconciliation,effectType}' = 'pdd-submit'
              AND w.payload #>> '{externalStateReconciliation,state}' = 'unresolved'
              AND w.payload #>> '{externalStateReconciliation,automaticRetryExhausted}' = 'true')
            OR ($4::boolean AND w.scenario_code = ANY($3::text[])
              AND w.current_ordinary_instance_id IS NOT NULL
              AND w.updated_at >= $5::timestamptz
              AND nullif(coalesce(w.manual_review_reason,
                w.payload #>> '{manualReview,reason}', w.payload->>'error'), '') IS NOT NULL)
          ))
          OR ($2::boolean AND w.scenario_code = 'return-refund'
            AND refund.updated_at >= $6::timestamptz
            AND refund.updated_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')
              AT TIME ZONE 'Asia/Shanghai')
            AND refund.action_state = 'manual-review')
        )
      ORDER BY greatest(w.updated_at, coalesce(refund.updated_at, w.updated_at)) DESC LIMIT 100`, [
      automaticEnabled,
      returnRefundEnabled,
      [...extendedOrdinaryScenarioCodes],
      extendedOrdinaryEnabled,
      extendedOrdinaryEnabledAt,
      returnRefundEnabledAt,
    ]);
    if (!candidates.rowCount) return 0;
    const client = await pool.connect();
    let created = 0;
    try {
      await client.query('BEGIN');
      for (const row of candidates.rows) {
        const specificPayloads = automaticEnabled ? [
          durableWarehouseNotificationPayload(row),
          durablePddUploadAuthorizationNotificationPayload(row),
          durableImageUploadFailureNotificationPayload(row),
          durablePddSubmitReconciliationExhaustedNotificationPayload(row),
        ].filter(Boolean) : [];
        // Technical payloads are retained for owner diagnostics, but must not
        // suppress a separate business-rule manual-review notification for
        // the same work order.
        const allowedSpecificPayloads = specificPayloads
          .filter((payload) => isAllowedDingTalkPayload(payload));
        const payloads = [
          ...allowedSpecificPayloads,
          ...(automaticEnabled && extendedOrdinaryEnabled
            ? [durableOrdinaryManualReviewNotificationPayload(row)] : []),
          ...(returnRefundEnabled ? [durableReturnRefundNotificationPayload(row)] : []),
        ].filter(Boolean);
        for (const payload of payloads) {
          if (!isAllowedDingTalkPayload(payload)
            || !isDingTalkDeliveryDateEligible(payload)) continue;
          const interventionId = crypto.randomUUID();
          const deduplicationKey = `dingtalk:automatic:${row.work_order_id}:${row.current_ordinary_instance_id || 'no-instance'}:${payload.reasonCode}`;
          const intervention = await client.query(`
            INSERT INTO manual_interventions
              (id, shop_id, work_order_id, ordinary_instance_id, channel,
               reason_code, reason, risk_level, deduplication_key)
            SELECT $1,$2,$3,$4,'dingtalk',$5,$6,'high',$7
            WHERE NOT EXISTS (
              SELECT 1 FROM manual_interventions existing
              WHERE existing.work_order_id = $3
                AND existing.channel = 'dingtalk'
                AND existing.reason_code = $5
                AND (existing.ordinary_instance_id IS NULL
                  OR existing.ordinary_instance_id IS NOT DISTINCT FROM $4::uuid)
            )
            ON CONFLICT (deduplication_key) DO NOTHING RETURNING id`,
          [interventionId, row.shop_id, row.work_order_id, row.current_ordinary_instance_id,
            payload.reasonCode, payload.problemZh, deduplicationKey]);
          if (!intervention.rowCount) continue;
          await client.query(`
            INSERT INTO notification_outbox (id, intervention_id, payload)
            VALUES ($1,$2,$3::jsonb)`,
          [crypto.randomUUID(), interventionId, JSON.stringify(payload)]);
          created += 1;
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (created) console.log(`[钉钉通知] 已从持久业务证据补建 ${created} 条真实通知`);
    return created;
  };

  const recoverStaleDeliveries = async () => {
    const [result, dailySummaryResult] = await Promise.all([
      pool.query(`
      UPDATE notification_outbox SET
        status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'pending' END,
        next_attempt_at = CASE WHEN attempt_count >= 3 THEN next_attempt_at ELSE now() END,
        last_error = jsonb_build_object(
          'name', 'DingTalkDeliveryInterrupted',
          'message', 'Notifier exited before the DingTalk delivery outcome was persisted',
          'recoveredAt', now()
        ),
        updated_at = now()
      WHERE status = 'sending'
        AND updated_at < now() - ($1::double precision * interval '1 millisecond')
      RETURNING id, status`, [staleSendingMs]),
      pool.query(`
        UPDATE dingtalk_daily_summaries SET
          status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'pending' END,
          next_attempt_at = CASE WHEN attempt_count >= 3 THEN next_attempt_at ELSE now() END,
          last_error = jsonb_build_object(
            'name', 'DingTalkDailySummaryDeliveryInterrupted',
            'message', 'Notifier exited before the daily summary outcome was persisted',
            'recoveredAt', now()
          ),
          updated_at = now()
        WHERE status = 'sending'
          AND updated_at < now() - ($1::double precision * interval '1 millisecond')
        RETURNING summary_date::text`, [staleSendingMs]),
    ]);
    if (result.rowCount) {
      console.warn(`[钉钉通知] 已恢复 ${result.rowCount} 条中断的发送任务`);
    }
    if (dailySummaryResult.rowCount) {
      console.warn(`[钉钉通知] 已恢复 ${dailySummaryResult.rowCount} 条中断的每日汇总发送任务`);
    }
    return result.rowCount + dailySummaryResult.rowCount;
  };

  const claimAutomaticDailySummary = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const settingsResult = await client.query(`
        SELECT key, value FROM system_settings
        WHERE key IN (
          'dingtalk-daily-summary-automatic-enabled',
          'dingtalk-daily-summary-automatic-start-date'
        )`);
      const settings = new Map(settingsResult.rows.map((row) => [row.key, row.value]));
      const schedule = dingtalkDailySummarySchedule({
        automaticEnabled: settings.get('dingtalk-daily-summary-automatic-enabled') === true,
        startDate: settings.get('dingtalk-daily-summary-automatic-start-date'),
      });
      if (!schedule.due) {
        await client.query('COMMIT');
        return null;
      }
      const result = await client.query(`
        UPDATE dingtalk_daily_summaries SET
          status = 'sending', attempt_count = attempt_count + 1,
          send_requested_by = 'automatic-daily-summary', send_requested_at = now(),
          last_error = NULL, updated_at = now()
        WHERE summary_date = $1::date
          AND status IN ('pending', 'failed')
          AND next_attempt_at <= now()
          AND attempt_count < 3
          AND summary_date >= $2::date
        RETURNING summary_date::text AS "summaryDate", message_text AS "messageText",
          attempt_count AS "attemptCount"`,
      [schedule.summaryDate, String(settings.get('dingtalk-daily-summary-automatic-start-date'))]);
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const deliverAutomaticDailySummary = async (summary) => {
    if (dryRun) {
      await pool.query(`
        UPDATE dingtalk_daily_summaries SET status = 'pending',
          attempt_count = greatest(attempt_count - 1, 0), updated_at = now()
        WHERE summary_date = $1::date AND status = 'sending'`, [summary.summaryDate]);
      console.log(`[钉钉通知] dry-run 已验证 ${summary.summaryDate} 每日汇总自动发送条件`);
      return;
    }
    let responseStatus = null;
    let responsePayload = null;
    let deliveryError = null;
    try {
      const response = await fetch(signDingTalkUrl(webhook, signingSecret), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDailySummaryMessage({ messageText: summary.messageText })),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      responseStatus = response.status;
      responsePayload = await response.json().catch(() => ({ parseError: true }));
      if (!response.ok || Number(responsePayload?.errcode || 0) !== 0) {
        throw new Error(`DingTalk rejected daily summary (${response.status}, ${responsePayload?.errcode ?? 'unknown'})`);
      }
    } catch (error) {
      deliveryError = { name: error.name, message: error.message };
    }
    const succeeded = !deliveryError;
    const attempt = Number(summary.attemptCount || 1);
    await pool.query(`
      UPDATE dingtalk_daily_summaries SET
        status = $2,
        next_attempt_at = CASE
          WHEN $2 = 'sent' THEN next_attempt_at
          ELSE now() + ($3::int * interval '1 minute')
        END,
        response_status = $4,
        response_payload = $5::jsonb,
        last_error = $6::jsonb,
        sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
        updated_at = now()
      WHERE summary_date = $1::date AND status = 'sending'`, [
      summary.summaryDate,
      succeeded ? 'sent' : attempt >= 3 ? 'failed' : 'pending',
      attempt === 1 ? 1 : 5,
      responseStatus,
      JSON.stringify(responsePayload),
      JSON.stringify(deliveryError),
    ]);
    if (succeeded) console.log(`[钉钉通知] 已自动发送 ${summary.summaryDate} 每日汇总`);
    else console.error(`[钉钉通知] ${summary.summaryDate} 每日汇总发送失败，将按策略重试`, deliveryError);
  };

  const cancelUndeliverableNotifications = async () => {
    const result = await pool.query(`
      UPDATE notification_outbox outbox SET
        status = 'cancelled',
        last_error = jsonb_build_object('reason', 'business-evidence-not-current'),
        updated_at = now()
      FROM manual_interventions intervention, work_orders work_order
      WHERE outbox.intervention_id = intervention.id
        AND work_order.id = intervention.work_order_id
        AND outbox.status IN ('pending', 'failed')
        AND (
          intervention.status NOT IN ('open', 'acknowledged')
          OR coalesce(work_order.frontend_visibility, 'operational') = 'recovery-audit'
          OR work_order.status IN ('completed', 'archived')
          OR work_order.runtime_status IN ('completed', 'archived')
          OR work_order.completion_state = 'confirmed'
          OR (
            coalesce(outbox.payload->>'deliverySource', 'automatic') <> 'owner-manual'
            AND (
              outbox.payload->>'reasonCode' NOT IN (
                'warehouse-out-of-scope', 'unknown-scenario',
                'ordinary-manual-review', 'return-refund-manual-review'
              )
              OR concat_ws(' ',
                outbox.payload->>'reasonCode', outbox.payload->>'evidenceReasonCode',
                outbox.payload->>'evidenceReason', outbox.payload->>'problemZh',
                outbox.payload #>> '{incompleteAnalysis,reasonZh}',
                outbox.payload #>> '{incompleteAnalysis,descriptionZh}'
              ) ~* '(验证码|滑块|人机验证|登录|会话|session|waiting|物流等待|限流|rate.?limit|flow[-_. ]?paused|external[-_. ]?state|页面(加载|渲染)|渲染失败|提交(结果)?未确认|未确认(成功|回执)|locator[.]click|timeout|超时|浏览器|browser|chromium|network|网络|上传(授权|失败)|upload|48143|非法请求)'
            )
          )
        )
      RETURNING outbox.id`);
    if (result.rowCount) {
      console.log(`[钉钉通知] 已清理 ${result.rowCount} 条终态或已失效的待发送消息`);
    }
    return result.rowCount;
  };

  const claim = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE notification_outbox SET status = 'sending',
          attempt_count = attempt_count + 1, updated_at = now()
        WHERE id = (
          SELECT outbox.id FROM notification_outbox outbox
          JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id
          WHERE outbox.status IN ('pending', 'failed') AND outbox.next_attempt_at <= now()
            AND outbox.attempt_count < 3
            AND intervention.status IN ('open', 'acknowledged')
            AND (
              outbox.payload->>'deliverySource' = 'owner-manual'
              OR intervention.reason_code IN (
                'warehouse-out-of-scope', 'unknown-scenario',
                'ordinary-manual-review', 'return-refund-manual-review'
              )
            )
          ORDER BY outbox.created_at FOR UPDATE OF outbox SKIP LOCKED LIMIT 1
        ) RETURNING *`);
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const deliver = async (claimedRow) => {
    const observed = await pool.query(`
        SELECT outbox.*, intervention.work_order_id::text AS "workOrderId",
          intervention.reason_code AS "interventionReasonCode",
          intervention.status AS "interventionStatus",
          work_order.shop_id AS "workOrderShopId",
          work_order.external_order_number AS "externalOrderNumber",
          work_order.current_ordinary_instance_id::text AS "currentOrdinaryInstanceId",
          work_order.scenario_code AS "scenarioCode",
          work_order.status AS "workOrderStatus",
          work_order.runtime_status AS "workOrderRuntimeStatus",
          work_order.completion_state AS "completionState",
          work_order.frontend_visibility AS "frontendVisibility",
          work_order.current_step AS "currentStep",
          work_order.manual_review_reason AS "manualReviewReason",
          work_order.payload AS "workOrderPayload",
          shop.name AS "shopName",
          shop.expected_shop_name AS "expectedShopName",
          tms_evidence.id::text AS "tmsEvidenceAssetId",
          refund.aftersale_number AS "aftersaleNumber",
          refund.action_state AS "returnRefundActionState"
        FROM notification_outbox outbox
        JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id
        JOIN work_orders work_order ON work_order.id = intervention.work_order_id
        JOIN shops shop ON shop.id = work_order.shop_id
        LEFT JOIN LATERAL (
          SELECT evidence.id
          FROM evidence_assets evidence
          WHERE evidence.work_order_id = work_order.id
            AND evidence.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
            AND evidence.kind = 'tms-evidence'
            AND evidence.status = 'ready'
            AND evidence.deleted_at IS NULL
          ORDER BY evidence.created_at DESC LIMIT 1
        ) tms_evidence ON true
        LEFT JOIN return_refunds refund ON refund.work_order_id = work_order.id
        WHERE outbox.id = $1 AND outbox.status = 'sending'
        `, [claimedRow.id]);
    if (!observed.rowCount) return;
    const row = observed.rows[0];
    const payload = {
      ...(row.payload || {}),
      // Older outbox rows did not always snapshot the shop label. Resolve it
      // at delivery time without changing the existing deduplication key.
      shopName: row.payload?.shopName || row.shopName || row.expectedShopName || row.workOrderShopId,
      warehouse: row.payload?.warehouse || notificationWarehouse(row.workOrderPayload || {}),
      tmsEvidenceAssetId: row.tmsEvidenceAssetId || null,
    };
    if (!isDingTalkDeliveryEligible(row)
      || !isDingTalkDeliveryDateEligible(row.payload)) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const rejection = JSON.stringify({ reason: 'business-evidence-not-current' });
        const cancelled = await client.query(`
          UPDATE notification_outbox SET status = 'cancelled', updated_at = now(),
            last_error = $2::jsonb
          WHERE id = $1 AND status = 'sending'
          RETURNING intervention_id`, [row.id, rejection]);
        if (cancelled.rowCount) {
          await client.query(`UPDATE manual_interventions SET status = 'cancelled', resolved_at = now(),
            resolved_by = 'dingtalk-delivery-evidence-guard'
            WHERE id = $1 AND status IN ('open', 'acknowledged')`,
          [cancelled.rows[0].intervention_id]);
        }
        await client.query('COMMIT');
        if (cancelled.rowCount) {
          console.log(`[钉钉通知] 已取消不再满足真实业务条件的消息 ${row.id}`);
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return;
    }
    if (dryRun) {
      await pool.query(`
        UPDATE notification_outbox SET status = 'pending',
          attempt_count = greatest(attempt_count - 1, 0), updated_at = now()
        WHERE id = $1 AND status = 'sending'`, [row.id]);
      console.log(`[钉钉通知] dry-run 已验证真实业务条件 ${row.id}`);
      return;
    }

    const attempt = Number(claimedRow.attempt_count || row.attempt_count || 1);
    let responseStatus = null;
    let responsePayload = null;
    let deliveryError = null;
    try {
      const response = await fetch(signDingTalkUrl(webhook, signingSecret), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDingTalkMessage(
          payload,
          payload.recipientScope === 'return-refund' ? returnRefundRecipients : recipients,
          evidencePublicBaseUrl,
        )),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      responseStatus = response.status;
      responsePayload = await response.json().catch(() => ({ parseError: true }));
      if (!response.ok || Number(responsePayload?.errcode || 0) !== 0) {
        throw new Error(`DingTalk rejected request (${response.status}, ${responsePayload?.errcode ?? 'unknown'})`);
      }
    } catch (error) {
      deliveryError = { name: error.name, message: error.message };
    }
    const succeeded = !deliveryError;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`
        SELECT id FROM notification_outbox
        WHERE id = $1 AND status = 'sending'
        FOR UPDATE OF notification_outbox`, [row.id]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query(`INSERT INTO notification_deliveries
          (id, outbox_id, attempt, status, response_status, response_payload, error)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [crypto.randomUUID(), row.id, attempt, succeeded ? 'sent' : 'failed', responseStatus,
        JSON.stringify(responsePayload), JSON.stringify(deliveryError)]);
      await client.query(`UPDATE notification_outbox SET status = $2,
          next_attempt_at = now() + ($3 * interval '1 minute'),
          last_error = $4::jsonb, updated_at = now()
        WHERE id = $1`, [row.id, succeeded ? 'sent' : attempt >= 3 ? 'failed' : 'pending',
        attempt === 1 ? 1 : 5, JSON.stringify(deliveryError)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  let stopping = false;
  let consecutiveLoopFailures = 0;
  let lastDeliveryStartedAt = 0;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  do {
    try {
      await recoverStaleDeliveries();
      const dailySummaryCreated = await enqueueDailySummary();
      if (!dailySummaryOnly) {
        await enqueueDurableAutomaticNotifications();
        await cancelUndeliverableNotifications();
      }
      const automaticDailySummary = await claimAutomaticDailySummary();
      if (automaticDailySummary) {
        const throttleDelayMs = dingTalkDeliveryThrottleDelayMs({
          lastDeliveryStartedAt,
          minimumIntervalMs: minimumDeliveryIntervalMs,
        });
        if (throttleDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, throttleDelayMs));
        }
        lastDeliveryStartedAt = Date.now();
        await deliverAutomaticDailySummary(automaticDailySummary);
      }
      const row = dailySummaryOnly ? null : await claim();
      if (row) {
        const throttleDelayMs = dingTalkDeliveryThrottleDelayMs({
          lastDeliveryStartedAt,
          minimumIntervalMs: minimumDeliveryIntervalMs,
        });
        if (throttleDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, throttleDelayMs));
        }
        lastDeliveryStartedAt = Date.now();
        await deliver(row);
      }
      consecutiveLoopFailures = 0;
      if (once || stopping) break;
      await new Promise((resolve) => setTimeout(resolve,
        row || automaticDailySummary ? 0 : dailySummaryCreated ? 1000 : pollMs));
    } catch (error) {
      consecutiveLoopFailures += 1;
      console.error('[钉钉通知] 调度循环异常，将自动退避重试', {
        code: error?.code || null,
        message: error?.message || String(error),
        consecutiveFailures: consecutiveLoopFailures,
      });
      if (once) throw error;
      if (stopping) break;
      const retryDelayMs = Math.min(60_000, Math.max(5_000, pollMs)
        * (2 ** Math.min(3, consecutiveLoopFailures - 1)));
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  } while (!stopping);
  await pool.end();
}

if (process.argv[1] === fileURLToPath(import.meta.url) && once && !enabled && !dryRun) process.exit(0);
