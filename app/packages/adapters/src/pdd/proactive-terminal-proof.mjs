import crypto from 'node:crypto';

const FINAL_STAGE = 'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics';
const FINAL_OPTION = '无法确认快递单号';
const RESULT_OPTION = '未查到退货物流轨迹';
const COMPLETION_SUMMARY = '未收到退货商品';

const responsePath = (candidate) => {
  try { return new URL(candidate?.url).pathname; } catch { return null; }
};

const responseIsSuccessful = (candidate) => {
  if (Number(candidate?.httpStatus) !== 200 || candidate?.ok !== true) return false;
  try { return JSON.parse(String(candidate.responseText || '')).success === true; }
  catch { return false; }
};

const hasExactCaseId = (candidate, platformWorkOrderId) => {
  const request = `${candidate?.url || ''} ${candidate?.requestBody || ''}`;
  return new RegExp(`(?:^|\\D)${platformWorkOrderId}(?:\\D|$)`, 'u').test(request);
};

const flowHasValue = (flow, value) => (flow?.itemList || [])
  .some((item) => String(item?.value || '').includes(value));

export const verifyProactiveTerminalDetailProof = ({
  scenarioCode, stage, orderNumber, platformWorkOrderId,
  selectedOption, selectionProof, submitClicked, submitReceipt,
  transitionConfirmed, effectStartedAt, submittedAt, responseCandidates,
} = {}) => {
  if (scenarioCode !== 'proactive-logistics-service' || stage !== FINAL_STAGE
    || selectedOption !== FINAL_OPTION || !/^\d{6,30}$/u.test(String(platformWorkOrderId || ''))
    || !/^\d{6}-\d{12,20}$/u.test(String(orderNumber || ''))
    || submitClicked !== true || submitReceipt?.success !== true
    || Number(submitReceipt?.httpStatus) !== 200 || transitionConfirmed !== true
    || selectionProof?.status !== 'verified'
    || selectionProof.orderNumber !== orderNumber
    || selectionProof.stage !== stage
    || (selectionProof.missingLabels || []).length > 0
    || (selectionProof.wrongFrameLabels || []).length > 0
    || !(selectionProof.selections || []).some((entry) => entry?.actualLabel === FINAL_OPTION)) return null;

  const startedAtMs = Date.parse(effectStartedAt || '');
  const submittedAtMs = Date.parse(submittedAt || '');
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(submittedAtMs)
    || submittedAtMs < startedAtMs) return null;

  const candidates = Array.isArray(responseCandidates) ? responseCandidates : [];
  const submitIndex = candidates.findIndex((candidate) => (
    responsePath(candidate) === '/latitude/mallTicket/submitForm'
    && responseIsSuccessful(candidate)
    && String(candidate.requestBody || '').includes(FINAL_OPTION)
    && String(candidate.requestBody || '').includes(RESULT_OPTION)
  ));
  if (submitIndex < 0) return null;
  const detailIndex = candidates.findIndex((candidate, index) => (
    index > submitIndex
    && responsePath(candidate) === '/strickland/sop/mms/detail'
    && responseIsSuccessful(candidate)
    && hasExactCaseId(candidate, platformWorkOrderId)
  ));
  if (detailIndex < 0) return null;

  const detail = candidates[detailIndex];
  let body;
  try { body = JSON.parse(String(detail.responseText || '')); }
  catch { return null; }
  const result = body?.result;
  const flows = result?.todoDetail?.flowList;
  const finalFlow = Array.isArray(flows) ? flows[0] : null;
  const secondaryFlow = Array.isArray(flows) ? flows[1] : null;
  const finalFlowAtMs = Number(finalFlow?.createdAt);
  if (result?.orderSn !== orderNumber
    || !String(result?.problemTitle || '').includes('物流异常主动服务')
    || result?.status !== 3 || result?.todoDetail?.finished !== true
    || finalFlow?.title !== FINAL_OPTION
    || !flowHasValue(finalFlow, FINAL_OPTION)
    || !flowHasValue(finalFlow, RESULT_OPTION)
    || !String(secondaryFlow?.title || '').includes(RESULT_OPTION)
    || !flowHasValue(secondaryFlow, RESULT_OPTION)
    || !Number.isFinite(finalFlowAtMs)
    || finalFlowAtMs < startedAtMs - 1_000
    || finalFlowAtMs > submittedAtMs + 60_000) return null;

  return {
    status: 'verified',
    kind: 'exact-pdd-completed-detail-flow-after-submit',
    orderNumber,
    platformWorkOrderId: String(platformWorkOrderId),
    scenarioCode,
    effectStage: stage,
    finalOption: FINAL_OPTION,
    resultOption: RESULT_OPTION,
    completionSummary: COMPLETION_SUMMARY,
    finalFlowCreatedAt: new Date(finalFlowAtMs).toISOString(),
    detailResponseSha256: crypto.createHash('sha256')
      .update(String(detail.responseText)).digest('hex'),
    verifiedAt: new Date().toISOString(),
  };
};

export const verifiedProactiveSummaryMatchesCompletion = ({
  proof, progress = {}, completion = {}, scenarioCode,
  expectedOutcome, observedOutcome, observedResultOption,
} = {}) => Boolean(
  scenarioCode === 'proactive-logistics-service'
  && proof?.status === 'verified'
  && proof.kind === 'exact-pdd-completed-detail-flow-after-submit'
  && proof.scenarioCode === scenarioCode
  && proof.orderNumber === completion.orderNumber
  && proof.orderNumber === progress.orderNumber
  && proof.platformWorkOrderId === String(progress.platformWorkOrderId || '')
  && /^[a-f0-9]{64}$/u.test(proof.detailResponseSha256 || '')
  && completion.platformDetailProof?.detailResponseSha256 === proof.detailResponseSha256
  && proof.finalOption === FINAL_OPTION
  && proof.resultOption === RESULT_OPTION
  && proof.completionSummary === COMPLETION_SUMMARY
  && expectedOutcome === FINAL_OPTION
  && observedOutcome === COMPLETION_SUMMARY
  && (!observedResultOption || observedResultOption === RESULT_OPTION)
  && completion.submitClicked === true
  && completion.submitReceipt?.success === true
  && Number(completion.submitReceipt?.httpStatus) === 200
  && completion.transitionConfirmed === true
  && completion.confirmationMethod === 'detail-completed'
);
