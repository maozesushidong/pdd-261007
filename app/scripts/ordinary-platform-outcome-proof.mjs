const RECALL_OPTION = '已进行召回';
const RECALL_STAGE = 'ordinary-intercept-recall-unsigned-shipment-recalled';

const parseJson = (value) => {
  try { return JSON.parse(String(value || '')); } catch { return null; }
};

const isPddPath = (candidate, pathname) => {
  try {
    const url = new URL(candidate?.url);
    return url.protocol === 'https:'
      && url.hostname === 'mms.pinduoduo.com'
      && url.pathname === pathname;
  } catch { return false; }
};

const successful = (candidate) => candidate?.ok === true
  && Number(candidate.httpStatus) === 200
  && parseJson(candidate.responseText)?.success === true;

export const capturedInterceptRecallPlatformOutcome = ({
  scenarioCode, orderNumber, platformCaseId, effectStatus,
  effectReservedAt, receipt,
} = {}) => {
  const caseId = String(platformCaseId || '');
  const result = receipt?.result;
  if (scenarioCode !== 'intercept-recall'
    || !/^\d{6}-\d{12,20}$/u.test(String(orderNumber || ''))
    || !/^\d{6,30}$/u.test(caseId)
    || effectStatus !== 'succeeded'
    || result?.selectionProof?.stage !== RECALL_STAGE
    || result.selectionProof.orderNumber !== orderNumber
    || (result.selectionProof.missingLabels || []).length
    || (result.selectionProof.wrongFrameLabels || []).length
    || !(Array.isArray(result.selectionProof.selections)
      ? result.selectionProof.selections : [])
      .some((entry) => entry?.actualLabel === RECALL_OPTION)
    || result?.selectedPddOption !== RECALL_OPTION
    || result?.selectedPddOutcome !== RECALL_OPTION
    || result?.submitClicked !== true
    || result?.transitionConfirmed !== true
    || result?.submitReceipt?.success !== true
    || Number(result.submitReceipt.httpStatus) !== 200
    || !isPddPath({ url: result.submitReceipt.requestUrl },
      '/latitude/mallTicket/submitForm')) return null;

  const startedAt = Date.parse(effectReservedAt || '');
  const completedAt = Date.parse(receipt?.completedAt || '');
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
    || completedAt < startedAt) return null;

  const candidates = Array.isArray(result.responseCandidates)
    ? result.responseCandidates : [];
  const submittedIndex = candidates.findIndex((candidate) => {
    if (!isPddPath(candidate, '/latitude/mallTicket/submitForm')
      || !successful(candidate)) return false;
    const request = parseJson(candidate.requestBody);
    const formData = Array.isArray(request?.formDataList)
      ? request.formDataList : [];
    return String(request?.bizId || '') === caseId
      && request?.bizContext?.orderSn === orderNumber
      && formData.some((item) => item?.keyLabel === '收货状态'
        && item.valueLabel === RECALL_OPTION);
  });
  if (submittedIndex < 0) return null;

  const detail = candidates.slice(submittedIndex + 1).find((candidate) => {
    if (!isPddPath(candidate, '/strickland/sop/mms/detail')
      || !successful(candidate)) return false;
    const request = parseJson(candidate.requestBody);
    const body = parseJson(candidate.responseText);
    const flow = body?.result?.todoDetail?.flowList?.[0];
    const flowAt = Number(flow?.createdAt);
    const items = Array.isArray(flow?.itemList) ? flow.itemList : [];
    return String(request?.instanceId || '') === caseId
      && body?.result?.orderSn === orderNumber
      && body.result.problemTitle === '消费者申请退款后提示拦截'
      && body.result.status === 3
      && body.result.todoDetail?.finished === true
      && flow?.title === '已联系快递主动召回'
      && items.some((item) => item?.key === '收货状态'
        && item.value === RECALL_OPTION)
      && Number.isFinite(flowAt)
      && flowAt >= startedAt - 1_000
      && flowAt <= completedAt + 60_000;
  });
  return detail ? RECALL_OPTION : null;
};
