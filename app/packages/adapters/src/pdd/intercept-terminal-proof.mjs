import crypto from 'node:crypto';

const STAGE = 'ordinary-intercept-recall-consumer-received-shipment';
const OPTION = '消费者已收到货';
const COMPLETION_SUMMARY = '已同意退货退款';

const pathOf = (candidate) => {
  try { return new URL(candidate?.url).pathname; } catch { return null; }
};

const successful = (candidate) => {
  if (Number(candidate?.httpStatus) !== 200 || candidate?.ok !== true) return false;
  try { return JSON.parse(String(candidate.responseText || '')).success === true; }
  catch { return false; }
};

const exactCaseInRequest = (candidate, platformWorkOrderId) => {
  const request = `${candidate?.url || ''} ${candidate?.requestBody || ''}`;
  return new RegExp(`(?:^|\\D)${platformWorkOrderId}(?:\\D|$)`, 'u').test(request);
};

export const verifyInterceptTerminalDetailProof = ({
  scenarioCode, stage, orderNumber, platformWorkOrderId, selectedOption,
  selectionProof, submitClicked, submitReceipt, transitionConfirmed,
  effectStartedAt, submittedAt, responseCandidates,
} = {}) => {
  if (scenarioCode !== 'intercept-recall' || stage !== STAGE
    || selectedOption !== OPTION || !/^\d{6,30}$/u.test(String(platformWorkOrderId || ''))
    || !/^\d{6}-\d{12,20}$/u.test(String(orderNumber || ''))
    || submitClicked !== true || submitReceipt?.success !== true
    || Number(submitReceipt?.httpStatus) !== 200 || transitionConfirmed !== true
    || selectionProof?.status !== 'verified'
    || selectionProof.orderNumber !== orderNumber
    || selectionProof.stage !== stage
    || (selectionProof.missingLabels || []).length > 0
    || (selectionProof.wrongFrameLabels || []).length > 0
    || !(selectionProof.selections || []).some((entry) => entry?.actualLabel === OPTION)) return null;

  const startedAtMs = Date.parse(effectStartedAt || '');
  const submittedAtMs = Date.parse(submittedAt || '');
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(submittedAtMs)
    || submittedAtMs < startedAtMs) return null;

  const candidates = Array.isArray(responseCandidates) ? responseCandidates : [];
  const submitIndex = candidates.findIndex((candidate) => (
    pathOf(candidate) === '/latitude/mallTicket/submitForm'
    && successful(candidate)
    && exactCaseInRequest(candidate, platformWorkOrderId)
    && String(candidate.requestBody || '').includes(OPTION)
  ));
  if (submitIndex < 0) return null;
  const detailIndex = candidates.findIndex((candidate, index) => (
    index > submitIndex
    && pathOf(candidate) === '/strickland/sop/mms/detail'
    && successful(candidate)
    && exactCaseInRequest(candidate, platformWorkOrderId)
  ));
  if (detailIndex < 0) return null;

  const detail = candidates[detailIndex];
  let body;
  try { body = JSON.parse(String(detail.responseText || '')); }
  catch { return null; }
  const result = body?.result;
  const latestFlow = result?.todoDetail?.flowList?.[0];
  const flowAtMs = Number(latestFlow?.createdAt);
  if (result?.orderSn !== orderNumber
    || result?.problemTitle !== '消费者申请退款后提示拦截'
    || result?.status !== 3 || result?.todoDetail?.finished !== true
    || latestFlow?.title !== OPTION
    || !(latestFlow?.itemList || []).some((item) => item?.value === OPTION)
    || !Number.isFinite(flowAtMs)
    || flowAtMs < startedAtMs - 1_000
    || flowAtMs > submittedAtMs + 60_000) return null;

  return {
    status: 'verified',
    kind: 'exact-pdd-intercept-completed-detail-flow-after-submit',
    orderNumber,
    platformWorkOrderId: String(platformWorkOrderId),
    scenarioCode,
    effectStage: stage,
    finalOption: OPTION,
    completionSummary: COMPLETION_SUMMARY,
    finalFlowCreatedAt: new Date(flowAtMs).toISOString(),
    detailResponseSha256: crypto.createHash('sha256')
      .update(String(detail.responseText)).digest('hex'),
    verifiedAt: new Date().toISOString(),
  };
};

export const verifiedInterceptSummaryMatchesCompletion = ({
  proof, progress = {}, completion = {}, scenarioCode,
  expectedOutcome, observedOutcome, observedResultOption,
} = {}) => Boolean(
  scenarioCode === 'intercept-recall'
  && proof?.status === 'verified'
  && proof.kind === 'exact-pdd-intercept-completed-detail-flow-after-submit'
  && proof.scenarioCode === scenarioCode
  && proof.orderNumber === completion.orderNumber
  && proof.orderNumber === progress.orderNumber
  && proof.platformWorkOrderId === String(progress.platformWorkOrderId || '')
  && /^[a-f0-9]{64}$/u.test(proof.detailResponseSha256 || '')
  && completion.platformDetailProof?.detailResponseSha256 === proof.detailResponseSha256
  && proof.finalOption === OPTION
  && proof.completionSummary === COMPLETION_SUMMARY
  && expectedOutcome === OPTION
  && observedOutcome === COMPLETION_SUMMARY
  && (!observedResultOption || observedResultOption === OPTION)
  && completion.submitClicked === true
  && completion.submitReceipt?.success === true
  && Number(completion.submitReceipt?.httpStatus) === 200
  && completion.transitionConfirmed === true
  && completion.confirmationMethod === 'detail-completed'
);
