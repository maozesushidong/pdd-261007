import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { legacyResolutionCompletionObservation } from '../workflow-runtime.mjs';

const source = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const between = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing source: ${start}`);
  return source.slice(first, last);
};
const order = '260928-569754304861718', otherOrder = '260928-569754304861719';
const caseId = '500013441854075';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PDD_BROWSER_EXECUTABLE_PATH
    || 'D:/pdd-native/runtime/chrome-for-testing/151.0.7922.34/chrome.exe' });
let checks = 0;
try {
  const page = await browser.newPage();
  const scope = vm.createContext({
    hasVisiblePddLoadingState: async () => false,
    hasExactPddOrderQueryEmptyResult: (text) => /共0条/u.test(text),
    firstVisible: async () => null,
    ordinaryListPageSignature: async () => null,
  });
  const api = vm.runInContext([
    between('const locateWorkOrderAction = async', '\n\nconst expandEvidencePanelForScreenshot'),
    between('const pddListEmptyStatePattern =', '\n\nconst waitForOrdinaryListRenderState'),
    '({ inspect: inspectOrdinaryListRenderState })',
  ].join('\n'), scope);
  const row = (number, status, action) => `<section role="row"><span>${number}</span><p>工单状态：${status}</p><button>${action}</button></section>`;
  await page.setContent(row(order, '已完结', '立即查看'));
  const completed = await api.inspect(page, { orderNumber: order });
  assert.equal(completed.kind, 'completion-candidate');
  assert.equal(completed.completedRow.requiresExactDetail, true); checks++;
  await page.setContent(row(order, '待处理', '立即处理') + row(otherOrder, '已完结', '立即查看'));
  assert.equal((await api.inspect(page, { orderNumber: order })).pending, true); checks++;
  await page.setContent(row(order, '加载中', '稍后查看') + row(otherOrder, '已完结', '立即查看'));
  assert.equal(await api.inspect(page, { orderNumber: order }), null); checks++;
  await page.setContent(row(order, '加载中', '稍后查看') + `<div style="display:none">${row(order, '已完结', '立即查看')}</div>`);
  assert.equal(await api.inspect(page, { orderNumber: order }), null); checks++;
  await page.setContent(row(order, '待处理', '立即处理') + row(order, '已完结', '立即查看'));
  assert.equal((await api.inspect(page, { orderNumber: order })).pending, true); checks++;
  await page.setContent(`<input value="${order}"><p>共0条</p>`);
  assert.equal((await api.inspect(page, { orderNumber: order })).confirmationMethod, 'exact-order-zero-result'); checks++;

  let progress = { orderNumber: order, platformWorkOrderId: caseId };
  let state = { detailReady: true, isCompleted: true, orderMatches: true,
    isExpectedWorkOrderType: true, orderNumber: order,
    observedPlatformWorkOrderId: caseId, completedOutcome: '已处理' };
  let identityMatches = true, urlAvailable = true, opened = 0;
  const writes = [];
  class ManualReviewRequiredError extends Error {}
  const detailScope = vm.createContext({
    readProgress: () => progress,
    verifiedPddDetailRecoveryUrl: () => urlAvailable ? `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${caseId}` : null,
    openSavedPddDetailPage: async (url) => { opened++; return { url: () => url }; },
    closeDeviceAccessIfPrompted: async () => {}, checkForHumanVerification: async () => {},
    waitForPddResolutionDetail: async () => state, pddDetailSettleMs: 1000,
    capturePddShopIdentity: async () => identityMatches,
    legacyResolutionCompletionObservation, ManualReviewRequiredError,
    pauseForManualReview: async () => { throw new ManualReviewRequiredError('unverified'); },
    writeProgress: (patch) => { writes.push(patch); progress = { ...progress, ...patch }; },
  });
  const inspectDetail = vm.runInContext(between('const readCompletedOrdinaryListDetail = async',
    '\n\nconst refreshPddResolutionStateOnce') + '\nreadCompletedOrdinaryListDetail', detailScope);
  const detail = await inspectDetail(order, completed);
  assert.equal(detail.state.confirmationMethod, 'detail-completed');
  assert.equal(writes.at(-1).ordinaryListCompletionDetailProof.platformCompletionObservation.platformCaseMatches, true);
  assert.equal(opened, 1); checks++;
  const goodState = structuredClone(state);
  for (const patch of [{ observedPlatformWorkOrderId: '500013441854076' },
    { isCompleted: false }, { orderMatches: false }, { detailReady: false },
    { isExpectedWorkOrderType: false }]) {
    state = { ...goodState, ...patch };
    await assert.rejects(inspectDetail(order, completed), ManualReviewRequiredError); checks++;
  }
  state = goodState; identityMatches = false;
  await assert.rejects(inspectDetail(order, completed), ManualReviewRequiredError); checks++;
  identityMatches = true; urlAvailable = false;
  const openedBefore = opened;
  await assert.rejects(inspectDetail(order, completed), ManualReviewRequiredError);
  assert.equal(opened, openedBefore); checks++;

  let listResult = { pending: false, confirmationMethod: 'exact-order-completed' };
  const presence = vm.runInNewContext(between('const queryPendingOrderPresence = async',
    '\n\nconst confirmOrderAbsentFromPendingList') + '\nqueryPendingOrderPresence', {
    ensurePddLogin: async () => {}, submitPendingOrderQuery: async () => {},
    waitForOrdinaryListRenderState: async () => listResult, context: {}, listUrl: 'https://mms.pinduoduo.com/aftersales/work_order/list',
  });
  assert.equal(await presence(page, order), true); checks++;
  listResult = { pending: false, confirmationMethod: 'exact-order-zero-result' };
  assert.equal(await presence(page, order), false); checks++;

  const complete = vm.runInNewContext(between('const ordinaryCompletionFromPendingListAbsence =',
    '\n\nconst ordinaryRetryDelayMs') + '\nordinaryCompletionFromPendingListAbsence', {
    readProgress: () => progress, ManualReviewRequiredError,
    rejectedSubmitPendingListAbsenceNeedsReview: () => false,
    ordinaryCompletionFromState: (_order, _scenario, decision, observed) => ({ decision, observed }),
    completedPddStateFromPendingListAbsence: () => { throw new Error('synthetic completion forbidden for list candidate'); },
  });
  assert.throws(() => complete(order, 'intercept-recall', {}, { confirmationMethod: 'exact-order-completed' }), ManualReviewRequiredError); checks++;
  const plan = { pdd: { option: '已进行召回' }, reasonCode: 'planned-recall' };
  const recovered = complete(order, 'intercept-recall', plan,
    { confirmationMethod: 'exact-order-completed', completedState: goodState });
  assert.equal(recovered.observed.confirmationMethod, 'detail-completed');
  assert.equal(recovered.decision.pdd.option, undefined); checks++;
  progress = { ...progress, pddResolutionSubmission: { orderNumber: order, submitClicked: true } };
  const ownSubmit = complete(order, 'intercept-recall', plan,
    { confirmationMethod: 'exact-order-completed', completedState: goodState });
  assert.equal(ownSubmit.decision.pdd.option, '已进行召回', 'keep original option for terminal mismatch protection'); checks++;

  const processHead = between('const processOneWorkOrder = async () => {',
    "  if (reconcileExternalStateOnly && reconcileExternalEffectTypes.has('oms-reissue-create'))");
  const guardedProgress = { orderNumber: order, platformWorkOrderId: caseId,
    ordinaryInstanceId: 'exact-instance', pddShopIdentity: { mallId: 'exact-mall' },
    ordinaryListCompletionReadOnlyRecovery: { protectedReadOnly:true,
      ordinaryInstanceId:'exact-instance', platformWorkOrderId:caseId, mallId:'exact-mall' } };
  const runGuarded = async (readOnly, effectTypes) => {
    const fn = vm.runInNewContext(processHead +
      "throw Error('unexpected-business-fallthrough');\n};processOneWorkOrder", {
      assertActiveResidentCommandIdentity: () => {}, readProgress: () => progress,
      reconcileExternalStateOnly: readOnly, reconcileExternalEffectTypes: new Set(effectTypes),
      ManualReviewRequiredError, persistSystemTabs: () => {}, resetCurrentOrderForRerun: () => {},
      requestedOrderNumber: order, readCompletedOrdinaryListDetail: inspectDetail,
      shopId:'exact-shop',
      writeProgress: patch => { progress = {...progress,...patch}; },
    });
    return fn();
  };
  progress = structuredClone(guardedProgress); state = goodState; urlAvailable = true;
  const readBack = await runGuarded(true, ['pdd-list-completion-proof']);
  assert.equal(readBack.observation.effectType, 'pdd-list-completion-proof');
  assert.equal(readBack.observation.externalActionsReplayed, false);
  assert.equal(progress.pddResolutionSubmission.submitClicked, false); checks++;
  progress = structuredClone(guardedProgress);
  await assert.rejects(runGuarded(false, []), ManualReviewRequiredError); checks++;
  await assert.rejects(runGuarded(true, ['pdd-submit']), ManualReviewRequiredError); checks++;
  progress = structuredClone(guardedProgress); state = {...goodState,isCompleted:false};
  await assert.rejects(runGuarded(true, ['pdd-list-completion-proof']), ManualReviewRequiredError); checks++;
  console.log(`普通工单列表完结只读详情核验 ${checks} 项通过`);
} finally {
  await browser.close();
}
