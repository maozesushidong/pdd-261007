import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  evaluateProductShortage,
  expandOrdinaryPddOptionAliases,
  isValidPlatformPrefilledPhone,
  ordinaryPddOptionsSemanticallyEquivalent,
  resolveOrdinaryPddJudgmentOption,
  resolveOrdinaryPddSemanticOption,
} from '../packages/adapters/src/pdd/ordinary-work-orders.mjs';
import {
  acceptedInTransitAddressChangeMessage,
  evaluateInTransitAddressChange,
  IN_TRANSIT_ADDRESS_CHANGE_CODE,
  IN_TRANSIT_ADDRESS_CHANGE_MESSAGES,
  IN_TRANSIT_ADDRESS_CHANGE_MESSAGE_VARIANTS,
  IN_TRANSIT_ADDRESS_CHANGE_STAGE_CODES,
  parseInTransitAddressChangeState,
} from '../packages/adapters/src/pdd/consumer-address-change-in-transit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = (await fsp.readFile(path.join(root, 'workflow.mjs'), 'utf8'))
  .replace(/\r\n/g, '\n');

const sourceBetween = (startMarker, endMarker) => {
  const start = workflowSource.indexOf(startMarker);
  const end = workflowSource.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `workflow source markers missing: ${startMarker}`);
  return workflowSource.slice(start, end);
};

const formControlSource = [
  sourceBetween(
    'const pddInterceptProgressOutcomeGroup = [',
    '\n\nconst pddPrimaryRefundOutcomeGroup = [',
  ),
  sourceBetween(
    'const pddPrimaryRefundOutcomeGroup = [',
    '\n\nconst analyzeWorkOrderShipping = async',
  ),
  sourceBetween(
    'const waitForPddSubmitButton = async',
    '\n\nconst visibleExactText = async',
  ),
  sourceBetween(
    'const resolveVisiblePddPrimaryRefundOutcome = async',
    '\n\nconst hasVisiblePddDirectRefundOutcome = async',
  ),
  sourceBetween(
    'const pddResolutionFormAnchorOptions = [',
    '\n\nconst ensurePddResolutionSubmissionDetail = async',
  ),
  sourceBetween(
    'const ordinaryFormScope = async',
    '\n\nconst ordinaryPddMessageButtonPattern',
  ),
  sourceBetween(
    'const collectOrdinaryPddDateFieldLookupDiagnostics = async',
    '\n\nconst fillOrdinaryPddField = async',
  ),
  sourceBetween(
    'const fillOrdinaryPddField = async',
    '\n\nconst verifyOrdinaryPddGeneratedMessage = async',
  ),
  sourceBetween(
    'const verifyOrdinaryPddGeneratedMessage = async',
    '\n\nconst selectOrdinaryPddDropdownOption = async',
  ),
  sourceBetween(
    'const selectOrdinaryPddDropdownOption = async',
    '\n\nconst beijingDateAfterDays =',
  ),
  sourceBetween(
    'const applyOrdinaryPddFormDecisionOnce = async',
    '\n\nconst applyOrdinaryPddFormDecision = async',
  ),
].join('\n\n');
const datePickerControlSource = sourceBetween(
  'const ordinaryPddDateParts =',
  '\n\nconst fillOrdinaryPddField = async',
);
const pddSubmitNetworkSource = sourceBetween(
  'const isPddNetworkTarget =',
  '\n\nconst waitForPddSubmitButton = async',
);
const reverseLogisticsControlSource = sourceBetween(
  'const collectReverseSignedRefundLogistics = async',
  '\n\nconst collectOrdinaryScenarioFacts = async',
);
const goodDeedFeedbackSource = sourceBetween(
  'const prepareGoodDeedFeedback = async',
  '\n\nconst isTransientOrdinaryPddPreSubmitFormError =',
);

const progressWrites = [];
const progressState = { orderNumber: '260821-000000000000001' };
const guardedExternalEffects = [];
const ordinaryExecutionUpdates = [];
const uploadedOrdinaryEvidence = [];
const firstVisible = async (candidates) => {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
};
const waitForFirstVisible = async (targetPage, candidates, {
  timeoutMs = 1000,
  pollIntervalMs = 50,
} = {}) => {
  const deadline = Date.now() + timeoutMs;
  do {
    const visible = await firstVisible(candidates);
    if (visible) return visible;
    await targetPage.waitForTimeout(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return null;
};
const pacedAction = async (_page, _stage, action) => action();
const actionDelayFor = () => 0;
const guardedExternalEffect = async (effect, action) => {
  guardedExternalEffects.push(effect);
  return action();
};
const readProgress = () => progressState;
const writeProgress = (patch) => {
  Object.assign(progressState, patch);
  progressWrites.push(patch);
};
const saveWorkflowDiagnostics = async () => {};
const focusSystemPage = async () => {};
const updateOrdinaryExecution = (orderNumber, scenarioCode, patch) => {
  ordinaryExecutionUpdates.push({ orderNumber, scenarioCode, patch });
  return patch;
};
const uploadOrdinaryScenarioEvidence = async (...args) => {
  uploadedOrdinaryEvidence.push(args);
  return { status: 'ready' };
};
const waitForPddSubmitTransition = async () => true;
const isPddDetailUrl = () => true;
const readOrdinaryCompletionAfterSubmit = async (_targetPage, orderNumber) => ({
  isCompleted: true,
  orderMatches: true,
  orderNumber,
  confirmationMethod: 'ui-self-test',
});
const selectedOrdinaryPddDates = [];
const selectOrdinaryPddDateField = async (_page, field, source, labelPattern) => {
  selectedOrdinaryPddDates.push({
    source,
    labelPattern: String(labelPattern),
    fieldId: await field.getAttribute('id'),
  });
  return true;
};
const beijingDateAfterDays = () => '2026-08-26';
const checkForHumanVerification = async () => false;
const readPddResolutionState = async () => ({ isCompleted: false, orderMatches: true });
let preFeedbackCompleted = false;
const ensurePddResolutionDetailReady = async () => ({
  isCompleted: preFeedbackCompleted,
  orderMatches: true,
  confirmationMethod: 'detail-completed',
});
class PddWorkOrderAlreadyCompletedError extends Error {}
class PddSubmitButtonRenderError extends Error {}
class PddSubmitRejectedError extends Error {
  constructor(stage, receipt) {
    super(`submit rejected at ${stage}`);
    this.externalEffectReceipt = receipt;
  }
}
const exactVisibleOption = async (scope, label) => {
  const matches = scope.getByText(label, { exact: true });
  for (let index = 0; index < await matches.count().catch(() => 0); index += 1) {
    const candidate = matches.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
};
const isPddOptionSelected = async (scope, label) => {
  const option = await exactVisibleOption(scope, label);
  if (!option) return false;
  let radio = option.locator('input[type="radio"]').first();
  if (!await radio.count().catch(() => 0)) {
    radio = option.locator('xpath=ancestor::label[1]').locator('input[type="radio"]').first();
  }
  return Boolean(await radio.count().catch(() => 0)
    && await radio.isChecked().catch(() => false));
};
const selectPddRadioOnce = async (_page, scope, label) => {
  const option = await exactVisibleOption(scope, label);
  if (!option) return false;
  await option.click();
  return true;
};
const waitForPddOptionSelected = async (_page, scope, label) => (
  isPddOptionSelected(scope, label)
);
const selectPddRadio = async (page, scope, label) => {
  if (!await selectPddRadioOnce(page, scope, label)) return false;
  return isPddOptionSelected(scope, label);
};
const visibleExactText = async (scope, label) => Boolean(await exactVisibleOption(scope, label));
const testPddRenderWaitMs = 3000;

const sandbox = {
  console,
  Date,
  Error,
  Object,
  Promise,
  RegExp,
  String,
  checkForHumanVerification,
  actionDelayFor,
  beijingDateAfterDays,
  expandOrdinaryPddOptionAliases,
  ensurePddResolutionDetailReady,
  focusSystemPage,
  ordinaryPddOptionsSemanticallyEquivalent,
  resolveOrdinaryPddJudgmentOption,
  resolveOrdinaryPddSemanticOption,
  firstVisible,
  waitForFirstVisible,
  guardedExternalEffect,
  isPddDetailUrl,
  isPddOptionSelected,
  isValidPlatformPrefilledPhone,
  IN_TRANSIT_ADDRESS_CHANGE_CODE,
  IN_TRANSIT_ADDRESS_CHANGE_MESSAGE_VARIANTS,
  IN_TRANSIT_ADDRESS_CHANGE_STAGE_CODES,
  pacedAction,
  pddRenderWaitMs: testPddRenderWaitMs,
  readProgress,
  readOrdinaryCompletionAfterSubmit,
  readPddResolutionState,
  saveWorkflowDiagnostics,
  selectPddRadio,
  selectPddRadioOnce,
  selectOrdinaryPddDateField,
  updateOrdinaryExecution,
  uploadOrdinaryScenarioEvidence,
  visibleExactText,
  waitForPddOptionSelected,
  waitForPddSubmitTransition,
  writeProgress,
  PddSubmitRejectedError,
  PddSubmitButtonRenderError,
  PddWorkOrderAlreadyCompletedError,
};
vm.runInNewContext(
  `${formControlSource}\n${pddSubmitNetworkSource}\n${reverseLogisticsControlSource}\n${goodDeedFeedbackSource}\nglobalThis.__functions = { applyOrdinaryPddFormDecisionOnce, clickPddSubmit, collectReverseSignedRefundLogistics, fillOrdinaryPddField, findVisiblePddResolutionFormScope, prepareGoodDeedFeedback, selectOrdinaryPddDropdownOption, selectOrdinaryPddOption, selectPddCoreResolutionOption, selectVisiblePddInTransitRefundOutcome, submitGoodDeedFeedback, submitProductShortageFeedback, verifyPddSubmitSelections, waitForPddSubmitButton, waitForVisiblePddPrimaryRefundOutcome };`,
  sandbox,
  { filename: 'workflow-pdd-ordinary-form-controls.mjs' },
);
const {
  applyOrdinaryPddFormDecisionOnce,
  clickPddSubmit,
  collectReverseSignedRefundLogistics,
  fillOrdinaryPddField,
  findVisiblePddResolutionFormScope,
  prepareGoodDeedFeedback,
  selectOrdinaryPddDropdownOption,
  selectOrdinaryPddOption,
  selectPddCoreResolutionOption,
  selectVisiblePddInTransitRefundOutcome,
  submitGoodDeedFeedback,
  submitProductShortageFeedback,
  verifyPddSubmitSelections,
  waitForPddSubmitButton,
  waitForVisiblePddPrimaryRefundOutcome,
} = sandbox.__functions;

const datePickerSandbox = {
  Date,
  Error,
  JSON,
  Object,
  Promise,
  RegExp,
  String,
  pacedAction,
};
vm.runInNewContext(
  `${datePickerControlSource}\nglobalThis.__functions = { ordinaryPddDateValueMatches, selectOrdinaryPddDateField };`,
  datePickerSandbox,
  { filename: 'workflow-pdd-date-picker-controls.mjs' },
);
const {
  ordinaryPddDateValueMatches: actualPddDateValueMatches,
  selectOrdinaryPddDateField: actualSelectOrdinaryPddDateField,
} = datePickerSandbox.__functions;

const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'D:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
});

try {
  const page = await browser.newPage();
  assert.equal(actualPddDateValueMatches('2026-08-29', '2026-08-29'), true);
  assert.equal(actualPddDateValueMatches('2026年8月29日', '2026-08-29'), true);
  assert.equal(actualPddDateValueMatches('2026/08/29 00:00:00', '2026-08-29'), true);
  assert.equal(actualPddDateValueMatches('8月29日', '2026-08-29'), true);
  assert.equal(actualPddDateValueMatches('2025年8月29日', '2026-08-29'), false);
  assert.equal(actualPddDateValueMatches('2026年8月30日', '2026-08-29'), false);

  await page.setContent(`
    <div><span>核实时间</span><input id="localized-date" readonly /></div>
    <div id="localized-date-picker" class="datePicker" role="dialog" hidden>
      <button type="button" aria-label="2026年8月29日">29</button>
    </div>
  `);
  await page.locator('#localized-date').evaluate((input) => {
    const picker = document.querySelector('#localized-date-picker');
    input.addEventListener('click', () => { picker.hidden = false; });
    picker.querySelector('button').addEventListener('click', () => {
      setTimeout(() => {
        input.value = '2026年8月29日';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        picker.hidden = true;
      }, 450);
    });
  });
  assert.equal(await actualSelectOrdinaryPddDateField(
    page,
    page.locator('#localized-date'),
    '2026-08-29',
    /核实时间/u,
  ), true, '本地化且延迟回填的拼多多日期控件必须被正确确认');
  assert.equal(await page.locator('#localized-date').inputValue(), '2026年8月29日');

  assert.match(pddSubmitNetworkSource, /targetPage\.on\('request', collectPddRequest\)/u);
  assert.match(pddSubmitNetworkSource, /targetPage\.on\('requestfailed', collectPddRequestFailure\)/u);
  assert.match(pddSubmitNetworkSource, /targetPage\.on\('framenavigated', collectPddFrameNavigation\)/u);
  assert.match(pddSubmitNetworkSource, /readPddSubmitUiFeedback/u);

  await page.setContent(`
    <form id="validation-submit-form">
      <label><input type="radio" name="goods" checked />可以送达</label>
      <button id="validation-submit" type="button">提交</button>
    </form>
  `);
  await page.locator('#validation-submit').evaluate((button) => {
    button.addEventListener('click', () => {
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.textContent = '请选择处理情况';
      document.body.appendChild(alert);
    });
  });
  const validationSubmitResult = await clickPddSubmit(
    page,
    'validation-self-test',
    progressState.orderNumber,
    { guard: false, selectedPddOption: '可以送达' },
  );
  assert.equal(validationSubmitResult.submitReceipt, null);
  assert.equal(validationSubmitResult.requestCandidates.length, 0);
  assert(validationSubmitResult.uiFeedback.some((entry) => entry.text === '请选择处理情况'),
    'visible PDD form validation must be retained when the click emits no business request');

  await page.setContent(`
    <main id="refund-completion-form">
      <label><input type="radio" name="refund-result" checked />同意退款</label>
      <button id="refund-completion-submit" type="button">提交并完结</button>
    </main>
    <button id="unrelated-confirm" type="button">确认</button>
    <script>
      document.querySelector('#refund-completion-submit').addEventListener('click', () => {
        document.querySelector('#refund-completion-form').dataset.submitted = 'true';
      });
      document.querySelector('#unrelated-confirm').addEventListener('click', () => {
        document.body.dataset.unrelatedConfirmed = 'true';
      });
    </script>
  `);
  const completionSubmit = await waitForPddSubmitButton(
    page,
    'resolution',
    1000,
    { selectedPddOption: '同意退款' },
  );
  assert.equal(await completionSubmit.getAttribute('id'), 'refund-completion-submit',
    '拼多多“提交并完结”必须按已选退款表单被精确识别');
  await completionSubmit.click();
  assert.equal(await page.locator('#refund-completion-form').getAttribute('data-submitted'), 'true');
  assert.equal(await page.locator('body').getAttribute('data-unrelated-confirmed'), null,
    '识别“提交并完结”时不得误点其他确认按钮');

  await page.setContent(`
    <main id="intercept-acknowledgement">
      <p>消费者申请退款后提示拦截，请主动联系快递员并上传召回凭证。</p>
      <button id="acknowledge" type="button">我已知晓</button>
    </main>
    <script>
      document.querySelector('#acknowledge').addEventListener('click', () => {
        document.querySelector('#intercept-acknowledgement').innerHTML =
          '<label><input type="radio" name="recall" />已进行召回</label>'
          + '<button type="button">提交</button>';
      });
    </script>
  `);
  assert.equal(await selectOrdinaryPddOption(page, ['已进行召回'], { waitMs: 1000 }), '已进行召回');
  assert.equal(await page.locator('input[name="recall"]').isChecked(), true);
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddDecisionFormEntry?.actionText === '我已知晓'
  )), '消费者申请退款后提示拦截的前置“我已知晓”必须进入正式处理表单');

  await page.setContent(`
    <button id="unrelated-submit" type="button">提交</button>
    <iframe id="ordinary-form-frame"></iframe>
    <script>
      document.querySelector('#unrelated-submit').addEventListener('click', () => {
        document.body.dataset.unrelatedClicked = 'true';
      });
    </script>
  `);
  const ordinaryFormFrame = page.frames().find((frame) => frame !== page.mainFrame());
  assert(ordinaryFormFrame, 'ordinary form iframe must exist');
  await ordinaryFormFrame.setContent(`
    <form id="real-ordinary-form">
      <label><input type="radio" name="result" />无法确认快递单号</label>
      <button id="real-submit" type="button">提交</button>
    </form>
    <script>
      document.querySelector('#real-submit').addEventListener('click', () => {
        document.body.dataset.realClicked = 'true';
      });
    </script>
  `);
  const frameSelectedOption = await selectOrdinaryPddOption(
    page,
    ['无法确认快递单号'],
    { waitMs: testPddRenderWaitMs },
  );
  const frameSubmit = await waitForPddSubmitButton(
    page,
    'iframe-result',
    1000,
    { selectedPddOption: frameSelectedOption },
  );
  await frameSubmit.click();
  assert.equal(await ordinaryFormFrame.locator('body').getAttribute('data-real-clicked'), 'true');
  assert.equal(await page.locator('body').getAttribute('data-unrelated-clicked'), null,
    'an unrelated main-document submit must never be clicked for an iframe option');

  const returnPreferredCalls = [];
  const returnPreferred = await collectReverseSignedRefundLogistics(async (label) => {
    returnPreferredCalls.push(label);
    if (label !== '退货物流') throw new Error('发货物流不应被读取');
    return {
      text: '退货物流',
      analysis: {},
      rawTimeline: [{ text: '退件到达长沙' }],
      timeline: [{ text: '退件到达长沙' }],
      hasData: true,
      emptyStateVisible: false,
    };
  });
  assert.deepEqual(returnPreferredCalls, ['退货物流']);
  assert.equal(returnPreferred.inspection.shippingLogisticsChecked, false);
  assert.equal(returnPreferred.shippingLogisticsTimeline.length, 0,
    '退货物流有数据时不得读取或使用发货物流');

  const shippingFallbackCalls = [];
  const shippingFallback = await collectReverseSignedRefundLogistics(async (label) => {
    shippingFallbackCalls.push(label);
    return label === '退货物流'
      ? {
          text: '暂无退货物流信息',
          analysis: {},
          rawTimeline: [],
          timeline: [],
          hasData: false,
          emptyStateVisible: true,
        }
      : {
          text: '发货物流',
          analysis: {},
          rawTimeline: [{ text: '包裹到达长沙' }],
          timeline: [{ text: '包裹到达长沙' }],
          hasData: true,
          emptyStateVisible: false,
        };
  });
  assert.deepEqual(shippingFallbackCalls, ['退货物流', '发货物流']);
  assert.equal(shippingFallback.inspection.fallbackApplied, true);
  assert.equal(shippingFallback.shippingLogisticsTimeline[0].text, '包裹到达长沙');

  await page.setContent(`
    <style>
      .ant-select-selector { display: block; width: 280px; height: 32px; border: 1px solid #999; }
    </style>
    <main id="resolution-form">
      <div class="form-item">
        <span>送达地址</span>
        <input id="delivery-address" data-mode="clear-first" />
      </div>
      <div class="form-item">
        <span>快递员电话</span>
        <input id="courier-phone" data-mode="clear-trusted" />
      </div>
      <div class="form-item dropdown-field">
        <span style="display:block">未更新</span>
        <span style="display:block">承诺协商</span>
        <div id="promise-combobox" class="ant-select-selector" role="combobox" tabindex="0"></div>
      </div>
      <div id="promise-options" hidden>
        <div role="option">继续等待</div>
        <div role="option">未更新则补发或者退款</div>
      </div>
      <button>提交</button>
    </main>
    <script>
      for (const input of document.querySelectorAll('input')) {
        let cleared = false;
        input.addEventListener('input', (event) => {
          const clear = input.dataset.mode === 'clear-trusted'
            ? event.isTrusted
            : !cleared;
          if (!clear) return;
          cleared = true;
          setTimeout(() => { input.value = ''; }, 20);
        });
      }
      const combobox = document.querySelector('#promise-combobox');
      const options = document.querySelector('#promise-options');
      combobox.addEventListener('click', () => { options.hidden = false; });
      for (const option of options.querySelectorAll('[role="option"]')) {
        option.addEventListener('click', () => {
          combobox.textContent = option.textContent;
          options.hidden = true;
        });
      }
    </script>
  `);

  assert.equal(await fillOrdinaryPddField(page, /送达地址/, '山东省临沂市兰山区'), true);
  assert.equal(await page.locator('#delivery-address').inputValue(), '山东省临沂市兰山区');
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddFieldRecovery?.strategy === 'keyboard-input'
  )), 'a controlled field that loses the first fill must recover through keyboard input');

  assert.equal(await fillOrdinaryPddField(page, /快递员电话/, '13800138000'), true);
  assert.equal(await page.locator('#courier-phone').inputValue(), '13800138000');
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddFieldRecovery?.strategy === 'native-value-setter'
  )), 'a field that rejects trusted input must recover through the native setter');

  const selected = await selectOrdinaryPddDropdownOption(
    page,
    /未更新承诺协商|未更新承诺|物流未更新.*承诺/,
    ['未更新则补发或者退款'],
    { matchAll: ['补发', '退款'] },
  );
  assert.equal(selected, '未更新则补发或者退款');
  assert.equal(await page.locator('#promise-combobox').innerText(), '未更新则补发或者退款');
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddDropdownRecovery?.status === 'located'
    && entry.ordinaryPddDropdownRecovery?.strategy === 'form-context-semantics'
  )), 'a split dropdown label must be recovered from its form-local semantic context');

  await page.setContent(`
    <form id="consumer-waybill-confirmation-form">
      <label><input type="radio" name="waybill" />无法确认快递单号</label>
      <div class="form-item"><span>* 说明</span><textarea id="waybill-explanation"></textarea></div>
      <button type="button">提交</button>
    </form>
  `);
  const waybillExplanation = '当前未查到退货物流轨迹，暂时无法确认消费者退货快递单号。';
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '无法确认快递单号',
      customerMessage: waybillExplanation,
    },
  });
  assert.equal(await page.locator('input[name="waybill"]').isChecked(), true);
  assert.equal(await page.locator('#waybill-explanation').inputValue(), waybillExplanation,
    '物流异常主动服务最终步骤必须填写页面单独标记的“说明”字段');

  const addressChangeOrder = '260923-123456789012345';
  const addressChangeDecision = evaluateInTransitAddressChange({
    orderNumber: addressChangeOrder,
    bodyText: `【待处理】物流在途消费者要求改地址\n订单编号：${addressChangeOrder}\n已发货，待签收\n暂无售后信息`,
    orderDetailText: `订单编号：${addressChangeOrder}\n已发货，待签收\n暂无售后信息`,
    logisticsAnalysis: { carrier: '韵达快递', trackingNumber: '4657094314565937' },
    chatAnalysis: {
      status: 'analyzed', eligible: true, conclusion: 'consumer-new-address-complete',
      analysis: { facts: { newAddressComplete: true, newAddress: '四川省内江市威远县严陵镇湿地花城9栋1单元602',
        recipientName: '李春华', recipientPhone: '18008055383' } },
    },
    omsTmsFlowCompleted: true,
  });
  assert.equal(addressChangeDecision.actionCode, 'pdd-stage-submit');
  const observedAddressMessage = '亲，您可以把修改后的收件人信息发过来哈，我们联系快递公司尝试修改，但按照以往的经验来看会存在修改不成功的情况，而且运输途中快递也无法操作修改，只能在到达派件网点后才能操作修改，所以地址修改成功也会导致送货的时间延后，亲这边也知道下这个情况。';
  const observedAddressMessageWithParticle = IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
    .replace('派送的时间延后，', '送货的时间延后哈，');
  const observedAddressMessageWithOutletAndParticle = IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
    .replace('到达派件网点才能操作修改', '到达派件网点后才能操作修改')
    .replace('派送的时间延后，', '送货的时间延后哈，');
  const observedAddressMessageWithTwoParticles = IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
    .replace('会存在修改不成功的情况，', '会存在修改不成功的情况哈，')
    .replace('派送的时间延后，', '送货的时间延后哈，');
  const observedAddressMessageWithParticlesAndOutlet = IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
    .replace('会存在修改不成功的情况，', '会存在修改不成功的情况哈，')
    .replace('到达派件网点才能操作修改', '到达派件网点后才能操作修改')
    .replace('派送的时间延后，', '派送的时间延后哈，');
  assert(acceptedInTransitAddressChangeMessage(IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact, 'contact'),
    '原有拼多多在途改地址话术仍须通过校验');
  assert(acceptedInTransitAddressChangeMessage(observedAddressMessage, 'contact'),
    '实际拼多多在途改地址推荐话术的细微措辞变化仍须通过校验');
  assert(acceptedInTransitAddressChangeMessage(observedAddressMessageWithParticle, 'contact'),
    '拼多多推荐话术在送货延后后添加语气词时仍须通过校验');
  assert(acceptedInTransitAddressChangeMessage(observedAddressMessageWithOutletAndParticle, 'contact'),
    '实际页面同时出现网点后和送货延后哈时须通过精确话术校验');
  assert(acceptedInTransitAddressChangeMessage(observedAddressMessageWithTwoParticles, 'contact'),
    '拼多多推荐话术在风险提醒及送货延后后均添加语气词时仍须通过校验');
  assert(acceptedInTransitAddressChangeMessage(observedAddressMessageWithParticlesAndOutlet, 'contact'),
    '拼多多推荐话术同时出现双语气词、网点后和派送延后时仍须通过校验');
  assert(!acceptedInTransitAddressChangeMessage(
    observedAddressMessage.replace('会存在修改不成功的情况', '保证修改成功'), 'contact'),
  '话术缺少修改可能失败的提醒时仍须禁止提交');
  assert(!acceptedInTransitAddressChangeMessage(
    observedAddressMessageWithParticle.replace('会存在修改不成功的情况', '保证修改成功'), 'contact'),
  '新增等义话术缺少修改可能失败的提醒时仍须禁止提交');
  assert(!acceptedInTransitAddressChangeMessage(
    observedAddressMessageWithOutletAndParticle.replace('会存在修改不成功的情况', '保证修改成功'), 'contact'),
  '网点后与送货延后哈的组合仍须保留修改可能失败提醒');
  assert(!acceptedInTransitAddressChangeMessage(
    observedAddressMessageWithTwoParticles.replace('会存在修改不成功的情况哈', '保证修改成功'), 'contact'),
  '新增双语气词话术缺少修改可能失败的提醒时仍须禁止提交');
  assert(!acceptedInTransitAddressChangeMessage(
    observedAddressMessageWithParticlesAndOutlet.replace('运输途中快递也无法操作修改', '运输途中保证修改'), 'contact'),
  '新话术缺少运输中无法操作的提醒时仍须禁止提交');
  const addressHistory = parseInTransitAddressChangeState({
    orderNumber: addressChangeOrder,
    bodyText: `【待处理】物流在途消费者要求改地址\n订单编号：${addressChangeOrder}\n服务进度\n尝试联系物流修改收件地址\n处理方式：联系物流协商修改地址\n发送话术：${observedAddressMessage}`,
  });
  assert(addressHistory.stage1Record && addressHistory.stage === 'result',
    '平台历史记录采用新版等义话术时仍应识别第一阶段已完成，避免重复提交');
  const addressHistoryWithOutletAndParticle = parseInTransitAddressChangeState({
    orderNumber: addressChangeOrder,
    bodyText: `【待处理】物流在途消费者要求改地址\n订单编号：${addressChangeOrder}\n服务进度\n尝试联系物流修改收件地址\n处理方式：联系物流协商修改地址\n发送话术：${observedAddressMessageWithOutletAndParticle}`,
  });
  assert(addressHistoryWithOutletAndParticle.stage1Record
    && addressHistoryWithOutletAndParticle.stage === 'result',
  '网点后与送货延后哈的组合写入平台历史后必须识别第一阶段，避免重复提交');
  const addressHistoryWithTwoParticles = parseInTransitAddressChangeState({
    orderNumber: addressChangeOrder,
    bodyText: `【待处理】物流在途消费者要求改地址\n订单编号：${addressChangeOrder}\n服务进度\n尝试联系物流修改收件地址\n处理方式：联系物流协商修改地址\n发送话术：${observedAddressMessageWithTwoParticles}`,
  });
  assert(addressHistoryWithTwoParticles.stage1Record
    && addressHistoryWithTwoParticles.stage === 'result',
  '拼多多双语气词话术已写入平台历史时必须识别第一阶段，避免重复提交');
  const addressHistoryWithParticlesAndOutlet = parseInTransitAddressChangeState({
    orderNumber: addressChangeOrder,
    bodyText: `【待处理】物流在途消费者要求改地址\n订单编号：${addressChangeOrder}\n服务进度\n尝试联系物流修改收件地址\n处理方式：联系物流协商修改地址\n发送话术：${observedAddressMessageWithParticlesAndOutlet}`,
  });
  assert(addressHistoryWithParticlesAndOutlet.stage1Record
    && addressHistoryWithParticlesAndOutlet.stage === 'result',
  '新版话术写入平台历史时必须识别第一阶段，避免重复提交');
  await page.setContent(`
    <form id="in-transit-address-change-form">
      <label><input type="radio" name="address-result" value="reject" />无法修改地址，协商拒绝退款</label>
      <label><input type="radio" name="address-result" value="contact" />尝试联系物流修改收件地址</label>
      <label><input type="radio" name="address-result" value="paid" />需支付费用后修改</label>
      <textarea id="address-message">${observedAddressMessage}</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const staleAddressChangeDecision = {
    ...addressChangeDecision,
    pdd: {
      ...addressChangeDecision.pdd,
      generatedMessageAcceptedVariants: [IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact],
    },
  };
  const addressChangeForm = await applyOrdinaryPddFormDecisionOnce(page, staleAddressChangeDecision);
  assert.equal(addressChangeForm.selectedOption, '尝试联系物流修改收件地址');
  assert.equal(await page.locator('input[value="contact"]').isChecked(), true);
  assert.equal(await page.locator('input[value="reject"]').isChecked(), false);
  assert.equal(await page.locator('input[value="paid"]').isChecked(), false);

  await page.setContent(`
    <form id="in-transit-address-change-form-particles">
      <label><input type="radio" name="address-result" value="contact" />尝试联系物流修改收件地址</label>
      <textarea id="address-message">${observedAddressMessageWithTwoParticles}</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const addressChangeFormWithTwoParticles = await applyOrdinaryPddFormDecisionOnce(
    page, staleAddressChangeDecision,
  );
  assert.equal(addressChangeFormWithTwoParticles.selectedOption, '尝试联系物流修改收件地址');
  assert.equal(await page.locator('input[value="contact"]').isChecked(), true);

  await page.setContent(`
    <form id="in-transit-address-change-form-particles-outlet">
      <label><input type="radio" name="address-result" value="contact" />尝试联系物流修改收件地址</label>
      <textarea id="address-message">${observedAddressMessageWithParticlesAndOutlet}</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const addressChangeFormWithParticlesAndOutlet = await applyOrdinaryPddFormDecisionOnce(
    page, staleAddressChangeDecision,
  );
  assert.equal(addressChangeFormWithParticlesAndOutlet.selectedOption, '尝试联系物流修改收件地址');
  assert.equal(await page.locator('input[value="contact"]').isChecked(), true);

  const observedAddressResultMessage = IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.result
    .replace('有派件网点未修改成功', '若派件网点未修改成功')
    .replace('联系至我们', '联系我们');
  const observedAddressResultMessageExact = observedAddressResultMessage
    .replace('派件的网点才可以操作修改', '派件地的网点才可以操作修改');
  assert(acceptedInTransitAddressChangeMessage(observedAddressResultMessage, 'result'),
    '第二阶段拼多多推荐话术将有改为若、联系至我们改为联系我们时仍须通过');
  assert(acceptedInTransitAddressChangeMessage(observedAddressResultMessageExact, 'result'),
    '第二阶段真实页面将派件的网点写作派件地的网点时仍须通过');
  assert(!acceptedInTransitAddressChangeMessage(
    observedAddressResultMessageExact.replace('快递在运输中是无法修改的', '快递保证修改成功'), 'result'),
  '第二阶段话术缺少运输中不能修改的提醒时仍须禁止提交');
  const addressHistoryWithResult = parseInTransitAddressChangeState({
    orderNumber: addressChangeOrder,
    bodyText: `【已完结】物流在途消费者要求改地址\n订单编号：${addressChangeOrder}\n服务进度\n尝试联系物流修改收件地址\n处理方式：联系物流协商修改地址\n发送话术：${observedAddressMessageWithTwoParticles}\n已联系快递公司修改\n处理结果：已联系快递公司修改\n发送话术：${observedAddressResultMessageExact}\n上传凭证`,
  });
  assert(addressHistoryWithResult.stage1Record && addressHistoryWithResult.stage2Record
    && addressHistoryWithResult.stage === 'completed',
  '第二阶段已提交等义话术的历史记录必须被识别，避免重复提交');

  await page.setContent(`
    <main id="collapsed-work-order">
      <button id="open-decision">处理工单</button>
    </main>
    <script>
      document.querySelector('#open-decision').addEventListener('click', () => {
        setTimeout(() => {
          document.querySelector('#collapsed-work-order').innerHTML = \`
            <form id="recall-decision-form">
              <label><input type="radio" name="recall" value="done" />已完成召回</label>
              <label><input type="radio" name="recall" value="received" />消费者已收到货</label>
              <button type="button">提交</button>
            </form>
          \`;
        }, 150);
      });
    </script>
  `);
  const selectedRecall = await selectOrdinaryPddOption(
    page,
    ['已进行召回'],
    { waitMs: testPddRenderWaitMs },
  );
  assert.equal(selectedRecall, '已完成召回');
  assert.equal(await page.locator('input[value="done"]').isChecked(), true);
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddDecisionFormEntry?.actionText === '处理工单'
  )), 'a collapsed work order must open its decision form before resolving recall aliases');

  await page.setContent(`
    <main id="semantic-recall-form">
      <form>
        <label><input type="radio" name="recall-semantic" value="pending" />快递仍在召回处理中</label>
        <label><input type="radio" name="recall-semantic" value="completed" />快递包裹已成功拦截并退回</label>
        <label><input type="radio" name="recall-semantic" value="failed" />快递召回失败</label>
        <button type="button">提交</button>
      </form>
    </main>
  `);
  const semanticRecall = await selectOrdinaryPddOption(page, ['已进行召回']);
  assert.equal(semanticRecall, '快递包裹已成功拦截并退回');
  assert.equal(await page.locator('input[value="completed"]').isChecked(), true);
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddSemanticOptionSelection?.intent === 'recall-completed'
    && entry.ordinaryPddSemanticOptionSelection?.selectedLabel === '快递包裹已成功拦截并退回'
  )), 'a stable unknown wording must be selected only through its audited semantic intent');

  await page.setContent(`
    <main id="judged-refund-form">
      <form>
        <label><input type="radio" name="judged-refund" value="reject" />暂不处理退款</label>
        <label><input type="radio" name="judged-refund" value="refund" />平台支持原路退还款项给买家</label>
        <button type="button">提交</button>
      </form>
    </main>
  `);
  const judgedRefund = await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '发送拦截',
      completionOption: '同意退款',
    },
  });
  assert.equal(judgedRefund.selectedOption, '平台支持原路退还款项给买家');
  assert.equal(judgedRefund.terminalSelected, true,
    'an audited medium-confidence judgment for the requested terminal intent must remain terminal');
  assert.equal(await page.locator('input[value="refund"]').isChecked(), true);
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddJudgmentOptionSelection?.intent === 'agree-refund'
    && entry.ordinaryPddJudgmentOptionSelection?.selectedLabel === '平台支持原路退还款项给买家'
    && entry.ordinaryPddJudgmentOptionSelection?.representsRequestedIntent === true
  )), 'an unknown option judgment must preserve its visible choices and reasoning in progress');

  const deliveryAddress = '【重庆市】包裹已送货上门签收，如有问题可致电：19332141917。';
  await page.setContent(`
    <form id="delivered-confirmation-form">
      <label><input type="radio" name="confirmation" />告知送达地址并承诺核实</label>
      <div><span>送达地址</span><input id="delivered-address" /></div>
      <div><span>快递员电话</span><input id="delivered-phone" /></div>
      <textarea>亲亲，您的快递显示已经送到${deliveryAddress}，快递员的电话是19332141917。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '告知送达地址并承诺核实',
      deliveryAddress,
      courierPhone: '19332141917',
      generatedMessageRequired: true,
      generatedMessageMustInclude: [deliveryAddress, '19332141917'],
    },
  });
  assert.equal(await page.locator('input[name="confirmation"]').isChecked(), true);
  assert.equal(await page.locator('#delivered-address').inputValue(), deliveryAddress);
  assert.equal(await page.locator('#delivered-phone').inputValue(), '19332141917');

  await page.setContent(`
    <form id="nested-delivered-confirmation-form" class="form-item">
      <label><input type="radio" name="confirmation" />告知送达地址并承诺核实</label>
      <input id="global-search" placeholder="搜索功能/订单/商品/课程/规则/帮助/服务" />
      <div class="field-row"><span>配送员电话</span><input id="nested-delivered-phone" type="text" placeholder="请输入" /></div>
      <div class="field-row"><span>送达地址</span><textarea id="nested-delivered-address" placeholder="请输入快递送达地址"></textarea></div>
      <textarea id="generated-delivery-message">亲亲，您的快递已送到南宁璞悦公馆23栋S106号店，快递员电话是18587715530。</textarea>
      <button type="button">提交</button>
    </form>
    <script>
      const phone = document.querySelector('#nested-delivered-phone');
      phone.addEventListener('input', () => {
        phone.value = phone.value.replace(/[^0-9]/g, '');
      });
    </script>
  `);
  progressState.ordinaryPddFieldRecovery = {
    field: '/送达地址/',
    status: 'failed',
    rejectedValue: '23106',
  };
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '告知送达地址并承诺核实',
      deliveryAddress: '南宁璞悦公馆23栋S106号店',
      courierPhone: '18587715530',
      generatedMessageRequired: true,
      generatedMessageMustInclude: ['南宁璞悦公馆23栋S106号店', '18587715530'],
    },
  });
  assert.equal(await page.locator('#nested-delivered-address').inputValue(), '南宁璞悦公馆23栋S106号店');
  assert.equal(await page.locator('#nested-delivered-phone').inputValue(), '18587715530');
  assert.equal(await page.locator('#global-search').inputValue(), '',
    'ordinary fields must never be written into a nearby search input');
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddFieldRecovery?.status === 'succeeded'
    && entry.ordinaryPddFieldRecovery?.strategy === 'preferred-multiline-control'
    && entry.ordinaryPddFieldRecovery?.selectedControl?.tagName === 'textarea'
  )), 'a successful multiline address retry must replace the stale numeric-field failure state');

  await page.setContent(`
    <form id="delivered-signed-refund-form">
      <fieldset>
        <legend>情况确认</legend>
        <label><input type="radio" name="situation-confirm" />告知送达地址并承诺核实</label>
        <label><input type="radio" name="situation-confirm" />不需要联系物流核实</label>
        <label><input type="radio" name="situation-confirm" />消费者遇到其他问题</label>
      </fieldset>
      <fieldset>
        <legend>消费者问题</legend>
        <label><input type="radio" name="consumer-problem" />已收到快递遇到其他售后问题</label>
        <label><input type="radio" name="consumer-problem" />不想要了想退款</label>
      </fieldset>
      <button id="delivered-signed-refund-confirm" type="button">确认</button>
    </form>
  `);
  const signedRefundFormState = await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '消费者遇到其他问题',
      secondaryOption: '不想要了想退款',
      strictOptionSelection: true,
    },
  });
  assert.equal(await page.locator('input[name="situation-confirm"]').nth(2).isChecked(), true);
  assert.equal(await page.locator('input[name="consumer-problem"]').nth(1).isChecked(), true);
  assert.deepEqual(
    [...signedRefundFormState.selectedOptions],
    ['消费者遇到其他问题', '不想要了想退款'],
  );
  assert.equal(await page.locator('input[name="situation-confirm"]').first().isChecked(), false);
  assert.equal(await page.locator('input[name="consumer-problem"]').first().isChecked(), false);
  const signedRefundConfirm = await waitForPddSubmitButton(
    page,
    'delivered-signed-refund-confirm',
    3_000,
    { selectedPddOption: signedRefundFormState.selectedOption },
  );
  assert.equal(await signedRefundConfirm.getAttribute('id'), 'delivered-signed-refund-confirm',
    '签收退款分支必须点击当前已选表单内的确认按钮');
  assert.equal(await selectOrdinaryPddOption(
    page,
    ['不存在的目标选项'],
    { required: false, waitMs: 0, allowJudgment: false },
  ), null, '严格选项匹配不得自主选择页面中的其他选项');

  await page.setContent(`
    <form id="delivered-evidence-form">
      <label><input type="radio" name="evidence" />发送凭证</label>
      <label><input type="radio" name="evidence" />已经发送过凭证</label>
      <textarea>亲亲，我们已经联系物流帮您核实，后续有反馈我们将第一时间联系您。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: { option: '发送凭证', generatedMessageRequired: true },
  });
  assert.equal(await page.locator('input[name="evidence"]').first().isChecked(), true);

  await page.setContent(`
    <form id="delivered-result-form">
      <label><input type="radio" name="goods" />消费者已经收到</label>
      <label><input type="radio" name="goods" />可以送达</label>
      <label><input type="radio" name="situation" />需要消费者自取</label>
      <label><input type="radio" name="situation" />快递会联系消费者</label>
      <div><span>预计联系时间</span><input id="expected-contact-date" readonly /></div>
      <div><span>自取地址</span><input id="pickup-address" /></div>
      <textarea>亲亲，快递那边反馈说给你送到了重庆市长寿维丰小区店，您可以过去取一下。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const deliveredResultFormState = await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '可以送达',
      secondaryOption: '需要消费者自取',
      pickupAddress: '重庆市长寿维丰小区店',
      generatedMessageRequired: true,
      generatedMessageMustInclude: ['重庆市长寿维丰小区店'],
    },
  });
  assert.equal(await page.locator('input[name="goods"]').nth(1).isChecked(), true);
  assert.equal(await page.locator('input[name="situation"]').first().isChecked(), true);
  assert.equal(await page.locator('#pickup-address').inputValue(), '重庆市长寿维丰小区店');
  // The current PDD layout uses a required textarea (TextArea1). A neighboring
  // phone input and the generated message must not stand in for that field.
  await page.setContent(`
    <form id="pickup-textarea-form">
      <label><input type="radio" name="goods" />可以送达</label>
      <label><input type="radio" name="situation" />需要消费者自取</label>
      <div class="form-item"><span>快递员电话</span><input id="pickup-phone" value="13800138000" /></div>
      <div class="form-item"><span>* 自取地址</span><textarea id="TextArea1" required></textarea></div>
      <textarea id="pickup-generated-message">亲亲，快递已放在重庆市长寿维丰小区店，请前往该地点取件。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '可以送达', secondaryOption: '需要消费者自取',
      pickupAddress: '重庆市长寿维丰小区店', generatedMessageRequired: true,
      generatedMessageMustInclude: ['重庆市长寿维丰小区店'],
    },
  });
  assert.equal(await page.locator('#TextArea1').inputValue(), '重庆市长寿维丰小区店');
  assert.equal(await page.locator('#TextArea1').evaluate(element => element.checkValidity()), true);
  assert.equal(await page.locator('#pickup-phone').inputValue(), '13800138000');
  assert.equal(await page.locator('#pickup-generated-message').inputValue(),
    '亲亲，快递已放在重庆市长寿维丰小区店，请前往该地点取件。');
  assert.deepEqual(
    [...deliveredResultFormState.selectedOptions],
    ['可以送达', '需要消费者自取'],
  );
  const deliveredSelectionProof = await verifyPddSubmitSelections(
    page,
    deliveredResultFormState.selectedOptions,
    { stage: 'delivered-not-received-result', orderNumber: progressState.orderNumber },
  );
  assert.equal(deliveredSelectionProof.selections.length, 2,
    '消费者未收到货最终提交前必须同时证明两组选项保持选中');
  await page.locator('input[name="situation"]').first().evaluate((element) => {
    element.checked = false;
  });
  await assert.rejects(
    () => verifyPddSubmitSelections(
      page,
      deliveredResultFormState.selectedOptions,
      { stage: 'delivered-not-received-result', orderNumber: progressState.orderNumber },
    ),
    /缺少必选项：需要消费者自取/u,
  );

  await page.setContent(`
    <form id="delivered-result-generated-message-only-form">
      <label><input type="radio" name="goods-no-address-field" />消费者已经收到</label>
      <label><input type="radio" name="goods-no-address-field" />可以送达</label>
      <label><input type="radio" name="situation-no-address-field" />需要消费者自取</label>
      <label><input type="radio" name="situation-no-address-field" />快递会联系消费者</label>
      <textarea id="generated-pickup-message">亲亲，快递已放在重庆市长寿维丰小区店，请前往该地点取件。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const generatedMessageOnlyFormState = await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '可以送达',
      secondaryOption: '需要消费者自取',
      pickupAddress: '重庆市长寿维丰小区店',
      generatedMessageRequired: true,
      generatedMessageMustInclude: ['重庆市长寿维丰小区店'],
    },
  });
  assert.deepEqual(
    [...generatedMessageOnlyFormState.selectedOptions],
    ['可以送达', '需要消费者自取'],
    '新版无独立取件地址字段时仍必须保留两组选项',
  );
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddPickupAddressProof?.status === 'verified'
    && entry.ordinaryPddPickupAddressProof?.fieldRendered === false
    && entry.ordinaryPddPickupAddressProof?.confirmationMethod
      === 'generated-message-contains-verified-pickup-address'
  )), '新版无独立取件地址字段时必须记录自动话术地址校验证据');

  await page.setContent(`
    <form id="delivered-result-repairable-message-form">
      <label><input type="radio" name="goods-repairable-message" />可以送达</label>
      <label><input type="radio" name="situation-repairable-message" />需要消费者自取</label>
      <textarea id="repairable-pickup-message">亲亲，我们已经联系物流帮您核实，后续有反馈会第一时间联系您。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const repairedMessageFormState = await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '可以送达',
      secondaryOption: '需要消费者自取',
      pickupAddress: '济南历下区刚子百货商店',
      generatedMessageRequired: true,
      generatedMessageMustInclude: ['济南历下区刚子百货商店'],
      generatedMessageFallback: '亲亲，快递已送达济南历下区刚子百货商店，请您前往该地点取件。',
    },
  });
  assert.deepEqual(
    [...repairedMessageFormState.selectedOptions],
    ['可以送达', '需要消费者自取'],
  );
  assert.equal(
    await page.locator('#repairable-pickup-message').inputValue(),
    '亲亲，快递已送达济南历下区刚子百货商店，请您前往该地点取件。',
  );
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddGeneratedMessageRecovery?.status === 'succeeded'
    && entry.ordinaryPddGeneratedMessageRecovery?.strategy
      === 'unique-editable-recommendation-textarea'
  )), '唯一推荐话术框必须能够受控补入已核实的真实自取点');

  await page.setContent(`
    <form id="delivered-result-ambiguous-message-form">
      <label><input type="radio" name="goods-ambiguous-message" />可以送达</label>
      <label><input type="radio" name="situation-ambiguous-message" />需要消费者自取</label>
      <textarea>第一条未包含地址的话术</textarea>
      <textarea>第二条未包含地址的话术</textarea>
      <button type="button">提交</button>
    </form>
  `);
  await assert.rejects(
    () => applyOrdinaryPddFormDecisionOnce(page, {
      pdd: {
        option: '可以送达',
        secondaryOption: '需要消费者自取',
        pickupAddress: '济南历下区刚子百货商店',
        generatedMessageRequired: true,
        generatedMessageMustInclude: ['济南历下区刚子百货商店'],
        generatedMessageFallback: '亲亲，快递已送达济南历下区刚子百货商店，请您前往该地点取件。',
      },
    }),
    /自动话术未包含必需内容/u,
    '出现多个可编辑话术框时禁止猜测并覆盖',
  );
  assert(progressWrites.some((entry) => (
    entry.ordinaryPddGeneratedMessageRecovery?.status === 'skipped-ambiguous-control'
    && entry.ordinaryPddGeneratedMessageRecovery?.candidateCount === 2
  )), '多个话术框必须保留歧义证据并停止提交');

  await page.setContent(`
    <form id="delivered-result-missing-address-proof-form">
      <label><input type="radio" name="goods-missing-address-proof" />可以送达</label>
      <label><input type="radio" name="situation-missing-address-proof" />需要消费者自取</label>
      <textarea>亲亲，您的快递已送达，请留意取件通知。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  await assert.rejects(
    () => applyOrdinaryPddFormDecisionOnce(page, {
      pdd: {
        option: '可以送达',
        secondaryOption: '需要消费者自取',
        pickupAddress: '重庆市长寿维丰小区店',
        generatedMessageRequired: true,
        generatedMessageMustInclude: ['重庆市长寿维丰小区店'],
      },
    }),
    /自动话术未包含必需内容/u,
    '字段和自动话术都不能证明真实地址时必须拒绝继续',
  );

  await page.setContent(`
    <form id="delivered-result-missing-address-proof-config-form">
      <label><input type="radio" name="goods-missing-address-config" />可以送达</label>
      <label><input type="radio" name="situation-missing-address-config" />需要消费者自取</label>
      <textarea>亲亲，快递已放在重庆市长寿维丰小区店，请前往该地点取件。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  await assert.rejects(
    () => applyOrdinaryPddFormDecisionOnce(page, {
      pdd: {
        option: '可以送达',
        secondaryOption: '需要消费者自取',
        pickupAddress: '重庆市长寿维丰小区店',
        generatedMessageRequired: true,
        generatedMessageMustInclude: [],
      },
    }),
    /未配置包含真实取件地址的自动话术校验/u,
    '无独立字段时必须显式配置真实地址校验，不能因任意话术存在而放行',
  );

  await page.setContent(`
    <form id="delivered-contact-result-form">
      <label><input type="radio" name="goods" />可以送达</label>
      <label><input type="radio" name="situation" />快递会联系消费者</label>
      <div><span>预计联系时间</span><input id="expected-contact-date" readonly /></div>
      <textarea>亲亲，快递员会联系您确认，请保持电话畅通。</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const contactDateCallCount = selectedOrdinaryPddDates.length;
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '可以送达',
      secondaryOption: '快递会联系消费者',
      expectedContactDateOffsetDays: 0,
      generatedMessageRequired: true,
    },
  });
  assert.equal(selectedOrdinaryPddDates.length, contactDateCallCount + 1);
  assert.equal(selectedOrdinaryPddDates.at(-1).source, '2026-08-26');
  assert.match(selectedOrdinaryPddDates.at(-1).labelPattern, /预计联系时间/u);

  await page.setContent(`
    <form id="product-shortage-verification-request-form">
      <label><input type="radio" name="shortage-verification" />去核实，填写核实时间</label>
      <input id="shortage-message-trigger" value="发送话术给消费者" readonly />
      <div><span>核实时间</span><input id="shortage-verification-date" readonly /></div>
      <button type="button">提交</button>
    </form>
  `);
  const shortageDateCallCount = selectedOrdinaryPddDates.length;
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '去核实，填写核实时间',
      verificationDateOffsetDays: 1,
    },
  });
  assert.equal(await page.locator('input[name="shortage-verification"]').isChecked(), true);
  assert.equal(selectedOrdinaryPddDates.length, shortageDateCallCount + 1);
  assert.match(selectedOrdinaryPddDates.at(-1).labelPattern, /核实时间/u);
  assert.equal(selectedOrdinaryPddDates.at(-1).fieldId, 'shortage-verification-date',
    '商品少发核实日期不得误选“发送话术给消费者”输入框');

  await page.setContent(`
    <form id="product-shortage-contact-progress-form">
      <label><input type="radio" name="shortage-progress" />已联系快递或仓库核实</label>
      <label><input type="radio" name="shortage-progress" />确认商品少发</label>
      <div><span>凭证</span><input type="file" /></div>
      <textarea>亲亲，这边已经联系快递和仓库核实重量了，我再去帮您催下，核实后答复您~</textarea>
      <button type="button">提交</button>
    </form>
  `);
  const shortageProgressDateCallCount = selectedOrdinaryPddDates.length;
  const shortageProgressWriteIndex = progressWrites.length;
  const shortageProgressFormState = await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '去核实，填写核实时间',
      verificationDateOffsetDays: 1,
    },
  });
  assert.equal(shortageProgressFormState.selectedOption, '已联系快递或仓库核实');
  assert.equal(await page.locator('input[name="shortage-progress"]').first().isChecked(), true);
  assert.equal(selectedOrdinaryPddDates.length, shortageProgressDateCallCount,
    '商品少发后续“填写核实进度”页面不得继续强制第一阶段日期字段');
  assert(progressWrites.slice(shortageProgressWriteIndex).some((entry) => (
    entry.ordinaryPddStageVariant?.visibleSelectedOption === '已联系快递或仓库核实'
      && entry.ordinaryPddStageVariant?.omittedField === 'verification-date'
  )), '商品少发阶段变体必须记录省略日期字段的原因');

  const noShortageDecision = evaluateProductShortage({
    pddFeedbackEntryAvailable: false,
    chatAnalysis: {
      status: 'analyzed',
      messages: [{ sender: 'buyer', text: '已核对商品件数' }],
      completeness: { complete: true, issues: [] },
      policy: { blockingConflicts: [] },
      eligible: true,
      conclusion: 'no-shortage',
      analysis: { situationDescription: '聊天核对商品件数一致' },
    },
  }, { now: '2026-08-25T00:00:00.000Z' });
  assert.equal(noShortageDecision.pdd.strictOptionSelection, true);
  await assert.rejects(
    () => applyOrdinaryPddFormDecisionOnce(page, noShortageDecision),
    /拼多多未找到场景选项/u,
    '仅显示联系进度与确认少发时，不得将“没有少发”改选成过程或相反结论',
  );
  assert.equal(await page.locator('input[name="shortage-progress"]').first().isChecked(), true,
    '前一个用例已选择的进度项不构成没有少发的新提交证明');
  assert.equal(await page.locator('input[name="shortage-progress"]').nth(1).isChecked(), false);

  await page.setContent(`
    <form id="product-shortage-no-shortage-form">
      <label><input type="radio" name="shortage-result" />已核实，商品没有少发</label>
      <label><input type="radio" name="shortage-reason" />商品件数未少发</label>
      <div><span>情况说明</span><textarea id="shortage-situation"></textarea></div>
      <button type="button">提交</button>
    </form>
  `);
  const noShortageFormState = await applyOrdinaryPddFormDecisionOnce(page, noShortageDecision);
  assert.deepEqual([...noShortageFormState.selectedOptions],
    ['已核实，商品没有少发', '商品件数未少发']);
  assert.equal(await page.locator('#shortage-situation').inputValue(), '聊天核对商品件数一致');

  await page.setContent('<iframe id="product-shortage-date-frame"></iframe>');
  const productShortageDateFrame = page.frames().find((frame) => frame !== page.mainFrame());
  assert(productShortageDateFrame, '商品少发日期控件测试必须存在子框架');
  await productShortageDateFrame.setContent(`
    <form>
      <label><input type="radio" checked />去核实，填写核实时间</label>
      <div><span>核实时间</span><input id="framed-shortage-verification-date" readonly /></div>
    </form>
  `);
  const framedShortageDateCallCount = selectedOrdinaryPddDates.length;
  await fillOrdinaryPddField(
    page,
    /核实时间|核实日期|预计核实时间|预计核实日期/,
    '2026-08-26',
    { datePicker: true },
  );
  assert.equal(selectedOrdinaryPddDates.length, framedShortageDateCallCount + 1);
  assert.equal(selectedOrdinaryPddDates.at(-1).fieldId, 'framed-shortage-verification-date',
    '商品少发核实日期必须能在当前工单子框架中定位');

  await page.setContent(`
    <form>
      <label><input type="radio" checked />去核实，填写核实时间</label>
      <button type="button">提交</button>
    </form>
  `);
  const dateFailureWriteIndex = progressWrites.length;
  await assert.rejects(
    () => fillOrdinaryPddField(
      page,
      /核实时间|核实日期|预计核实时间|预计核实日期/,
      '2026-08-26',
      { datePicker: true },
    ),
    /拼多多未找到.*输入框/u,
  );
  const dateLookupFailure = progressWrites.slice(dateFailureWriteIndex).find(
    (entry) => entry.ordinaryPddDateFieldLookupFailure,
  )?.ordinaryPddDateFieldLookupFailure;
  assert(dateLookupFailure?.frames?.length >= 1,
    '商品少发日期控件缺失时必须保存当前页面和框架诊断');
  assert(dateLookupFailure.frames.some((frame) => (
    frame.relevantLines.some((line) => line.includes('去核实'))
  )), '日期控件诊断必须保留可见业务选项文本');

  await page.setContent(`
    <form id="product-shortage-verification-result-form">
      <label><input type="radio" name="shortage-result" />已核实，填写核实结果</label>
      <div><span>核实结果</span><textarea id="shortage-result-text"></textarea></div>
      <button type="button">提交</button>
    </form>
  `);
  const shortageResultText = '网点核实包裹发出重量异常，确认商品少发一件';
  await applyOrdinaryPddFormDecisionOnce(page, {
    pdd: {
      option: '已核实，填写核实结果',
      verificationResult: shortageResultText,
    },
  });
  assert.equal(await page.locator('input[name="shortage-result"]').isChecked(), true);
  assert.equal(await page.locator('#shortage-result-text').inputValue(), shortageResultText);

  for (const option of ['发送拦截', '同意消费者退款申请']) {
    await page.setContent(`
      <form id="consumer-refusal-form">
        <label><input type="radio" name="refusal" />发送拦截</label>
        <label><input type="radio" name="refusal" />同意消费者退款申请</label>
        <button type="button">提交</button>
      </form>
    `);
    await applyOrdinaryPddFormDecisionOnce(page, { pdd: { option } });
    const selected = option === '发送拦截' ? 0 : 1;
    assert.equal(await page.locator('input[name="refusal"]').nth(selected).isChecked(), true);
  }

  await page.setContent(`
    <form id="reverse-signed-refund-form">
      <label><input type="radio" name="reverse-refund" />同意退款</label>
      <label><input type="radio" name="reverse-refund" />与消费者协商其他处理时间</label>
      <button type="button">提交</button>
    </form>
  `);
  await applyOrdinaryPddFormDecisionOnce(page, { pdd: { option: '同意退款' } });
  assert.equal(await page.locator('input[name="reverse-refund"]').first().isChecked(), true);
  assert.equal(await page.locator('input[name="reverse-refund"]').nth(1).isChecked(), false,
    '逆向物流已签收退款不得选择协商其他处理时间');

  await page.setContent(`
    <main id="good-deed-detail">
      <a id="good-deed-feedback" href="#">点此反馈自行处理</a>
      <div id="good-deed-dialog" role="dialog" style="display:none">
        <h2>问题反馈</h2>
        <div class="form-item">
          <span>手机号</span>
          <input aria-label="手机号" type="tel" value="13800138000" readonly />
        </div>
        <label><input type="radio" name="feedback-reason" />其他原因</label>
        <div class="form-item">
          <span>问题描述</span>
          <textarea></textarea>
        </div>
        <button id="good-deed-confirm" type="button">确认提交</button>
      </div>
    </main>
    <script>
      document.querySelector('#good-deed-feedback').addEventListener('click', (event) => {
        event.preventDefault();
        document.querySelector('#good-deed-dialog').style.display = 'block';
      });
      document.querySelector('#good-deed-confirm').addEventListener('click', () => {
        document.body.dataset.goodDeedSubmitted = 'true';
      });
    </script>
  `);
  const goodDeedOrderNumber = '260825-000000000000001';
  const goodDeedCompletion = await submitGoodDeedFeedback(
    page,
    goodDeedOrderNumber,
    'good-deed-expedited-shipping',
    {
      pdd: {
        option: '反馈',
        reasonOption: '其他原因',
        problemDescription: '此件快递已正常揽收走件',
      },
    },
  );
  assert.equal(goodDeedCompletion.isCompleted, true);
  assert.equal(await page.locator('input[name="feedback-reason"]').isChecked(), true,
    '好人好事反馈必须选择“其他原因”');
  assert.equal(await page.locator('#good-deed-dialog textarea').inputValue(), '此件快递已正常揽收走件',
    '好人好事反馈必须保留业务指定的问题描述');
  assert.equal(await page.locator('body').getAttribute('data-good-deed-submitted'), 'true',
    '好人好事反馈必须点击“确认提交”');
  assert(ordinaryExecutionUpdates.some((entry) => (
    entry.orderNumber === goodDeedOrderNumber
    && entry.scenarioCode === 'good-deed-expedited-shipping'
    && entry.patch.platformPrefilledPhone === '13800138000'
    && entry.patch.feedbackPhoneChecked === true
  )), '好人好事反馈必须读取并记录平台预填手机号');
  assert(uploadedOrdinaryEvidence.some((args) => (
    args[1] === goodDeedOrderNumber && args[2] === 'good-deed-expedited-shipping'
  )), '好人好事反馈必须经过拼多多发货物流凭证上传阶段');
  assert(guardedExternalEffects.some((effect) => (
    effect.effectType === 'pdd-submit'
    && effect.orderNumber === goodDeedOrderNumber
    && effect.stage === 'ordinary-good-deed-feedback'
  )), '好人好事反馈提交必须受外部效果幂等保护');

  await page.evaluate(() => {
    document.querySelector('#good-deed-dialog').style.display = 'none';
    delete document.body.dataset.goodDeedSubmitted;
  });
  const shortageOrderNumber = '260825-000000000000002';
  const shortageCompletion = await submitProductShortageFeedback(
    page,
    shortageOrderNumber,
    'product-shortage',
    { pdd: { reasonOption: '其他原因', feedbackProblemDescription: '订单数量正常，未少发' } },
  );
  assert.equal(shortageCompletion.isCompleted, true);
  assert.equal(await page.locator('#good-deed-dialog textarea').inputValue(), '订单数量正常，未少发');
  assert.equal(await page.locator('body').getAttribute('data-good-deed-submitted'), 'true');
  assert.equal(progressState.ordinaryFeedbackSubmission.orderNumber, shortageOrderNumber);
  assert.equal(progressState.ordinaryFeedbackSubmission.clickAttempted, true);
  assert.equal(progressState.ordinaryFeedbackSubmission.postClickTransitionObserved, true);
  assert(guardedExternalEffects.some((effect) => (
    effect.effectType === 'pdd-submit'
    && effect.orderNumber === shortageOrderNumber
    && effect.stage === 'ordinary-product-shortage-no-shortage-feedback'
  )), '商品少发反馈必须记录受幂等保护的实际点击');
  const effectCountBeforeCompletedFeedback = guardedExternalEffects.length;
  preFeedbackCompleted = true;
  const alreadyCompletedFeedback = await submitProductShortageFeedback(
    page,
    '260825-000000000000003',
    'product-shortage',
    { pdd: { reasonOption: '其他原因', feedbackProblemDescription: '不应重复提交' } },
  );
  preFeedbackCompleted = false;
  assert.equal(alreadyCompletedFeedback.recoveredFromCompletedPage, true);
  assert.equal(guardedExternalEffects.length, effectCountBeforeCompletedFeedback,
    '已经完成的同一订单只能只读恢复，不得再次提交问题反馈');

  await page.setContent(`
    <main id="late-refund-outcome"><p>处理结果加载中</p></main>
    <script>
      setTimeout(() => {
        document.querySelector('#late-refund-outcome').innerHTML =
          '<label><input type="radio" name="refund" />已同意退货退款</label>'
          + '<button type="button">提交</button>';
      }, 50);
    </script>
  `);
  const lateRefundOutcome = await waitForVisiblePddPrimaryRefundOutcome(
    page,
    page.locator('main'),
    '同意退款',
    1000,
  );
  assert.equal(lateRefundOutcome, '已同意退货退款');
  assert.equal(await page.locator('input[name="refund"]').isChecked(), true,
    'a late-rendered equivalent refund outcome must be selected without refreshing first');

  await page.setContent(`
    <main id="in-transit-refund-priority">
      <label><input type="radio" name="in-transit-refund" />同意消费者退款申请</label>
      <label><input type="radio" name="in-transit-refund" />同意退款</label>
      <label><input type="radio" name="in-transit-refund" />已同意退货退款</label>
      <button type="button">提交</button>
    </main>
  `);
  assert.equal(await selectVisiblePddInTransitRefundOutcome(
    page,
    page.locator('main'),
    1000,
  ), '已同意退货退款');
  assert.equal(await page.locator('input[name="in-transit-refund"]').nth(2).isChecked(), true,
    '在途退款多个退款结果同时存在时必须选择最高优先级');

  await page.setContent(`
    <main id="in-transit-handover">
      <label><input type="radio" name="handover" />已交给快递</label>
      <label><input type="radio" name="handover" />未交给快递</label>
      <button id="handover-submit" type="button">提交</button>
    </main>
    <script>
      document.querySelector('#handover-submit').addEventListener('click', () => {
        document.querySelector('#in-transit-handover').innerHTML =
          '<label><input type="radio" name="handover-refund" />同意消费者退款申请</label>'
          + '<label><input type="radio" name="handover-refund" />同意退款</label>'
          + '<label><input type="radio" name="handover-refund" />已同意退货退款</label>'
          + '<button type="button">提交</button>';
      });
    </script>
  `);
  const handoverForm = await findVisiblePddResolutionFormScope(page, {
    allowAnyVisibleOptions: true,
  });
  assert(handoverForm, '在途退款物流交接前置页必须可识别');
  const handoverOutcome = await selectPddCoreResolutionOption(
    page,
    handoverForm.scope,
    ['已交给快递'],
    { stage: 'in-transit-handover', timeoutMs: 1000 },
  );
  assert.equal(handoverOutcome, '已交给快递');
  const handoverSubmit = await waitForPddSubmitButton(
    page,
    'in-transit-handover',
    1000,
    { selectedPddOption: handoverOutcome },
  );
  assert.equal(await handoverSubmit.getAttribute('id'), 'handover-submit',
    '物流交接提交必须绑定已选交接表单');
  await handoverSubmit.click();
  assert.equal(await selectVisiblePddInTransitRefundOutcome(
    page,
    page.locator('main'),
    1000,
  ), '已同意退货退款', '物流交接后仍必须按在途退款固定优先级选择结果');

  await page.setContent(`
    <main id="option-first-in-transit-refund">
      <label><input type="radio" name="option-first-refund" />同意消费者退款申请</label>
      <label><input type="radio" name="option-first-refund" />同意退款</label>
      <label><input type="radio" name="option-first-refund" />已同意退货退款</label>
    </main>
    <script>
      document.querySelector('#option-first-in-transit-refund').addEventListener('change', () => {
        if (document.querySelector('#late-resolution-submit')) return;
        const button = document.createElement('button');
        button.id = 'late-resolution-submit';
        button.type = 'button';
        button.textContent = '提交';
        document.querySelector('#option-first-in-transit-refund').append(button);
      });
    </script>
  `);
  const optionFirstForm = await findVisiblePddResolutionFormScope(page, {
    allowAnyVisibleOptions: true,
  });
  assert(optionFirstForm, '退款选项必须能在提交按钮出现前定位所属表单');
  assert.equal(optionFirstForm.visibleOptions.length, 3);
  const optionFirstOutcome = await selectVisiblePddInTransitRefundOutcome(
    page,
    optionFirstForm.scope,
    1000,
  );
  assert.equal(optionFirstOutcome, '已同意退货退款');
  const lateResolutionSubmit = await waitForPddSubmitButton(
    page,
    'option-first-resolution',
    1000,
    { selectedPddOption: optionFirstOutcome },
  );
  assert.equal(await lateResolutionSubmit.getAttribute('id'), 'late-resolution-submit',
    '选择退款结果后必须定位同一表单新渲染的提交按钮');

  await page.setContent(`
    <main id="in-transit-refund-mixed-stage">
      <label><input type="radio" name="mixed-stage" />快递已拦截成功</label>
      <label><input type="radio" name="mixed-stage" />快递还在拦截中</label>
      <label><input type="radio" name="mixed-stage" />快递拦截失败</label>
      <label><input type="radio" name="mixed-stage" />消费者超12小时未回复</label>
      <label><input type="radio" name="mixed-stage" />同意消费者退款申请</label>
      <label><input type="radio" name="mixed-stage" />同意退款</label>
      <button type="button">提交</button>
    </main>
  `);
  assert.equal(await selectVisiblePddInTransitRefundOutcome(
    page,
    page.locator('main'),
    1000,
  ), '同意退款');
  assert.equal(await page.locator('input[name="mixed-stage"]').nth(5).isChecked(), true,
    '退款、拦截进度和消费者协商选项同时出现时必须选择退款选项');

  await page.setContent(`
    <main id="in-transit-refund-fallback">
      <label><input type="radio" name="in-transit-fallback" />同意消费者退款申请</label>
      <button type="button">提交</button>
    </main>
  `);
  assert.equal(await selectVisiblePddInTransitRefundOutcome(
    page,
    page.locator('main'),
    1000,
  ), '同意消费者退款申请');
  assert.equal(await page.locator('input[name="in-transit-fallback"]').isChecked(), true,
    '在途退款页面只有低优先级退款结果时仍应继续处理');

  await page.setContent(`
    <main id="renamed-core-refund-outcome">
      <label><input type="radio" name="core-refund" value="reject" />暂不处理退款</label>
      <label><input type="radio" name="core-refund" value="approve" />平台支持原路退还款项给买家</label>
      <button type="button">提交</button>
    </main>
  `);
  const renamedCoreRefund = await waitForVisiblePddPrimaryRefundOutcome(
    page,
    page.locator('main'),
    '同意退款',
    1500,
  );
  assert.equal(renamedCoreRefund, '平台支持原路退还款项给买家');
  assert.equal(await page.locator('input[value="approve"]').isChecked(), true);
  assert(progressWrites.some((entry) => (
    entry.pddCoreOptionSelection?.stage === 'primary-refund'
    && entry.pddCoreOptionSelection?.selectionMode === 'judgment'
    && entry.pddCoreOptionSelection?.selectedLabel === '平台支持原路退还款项给买家'
    && entry.pddCoreOptionSelection?.visibleOptions.includes('暂不处理退款')
  )), 'a renamed core refund result must retain its actual label and rejected alternative in audit');

  await page.setContent(`
    <main id="renamed-intercept-progress">
      <label><input type="radio" name="intercept-progress" value="pending" />召回任务仍在处理中</label>
      <label><input type="radio" name="intercept-progress" value="failed" />承运商反馈召回失败</label>
      <button type="button">提交</button>
    </main>
  `);
  const renamedInterceptProgress = await selectPddCoreResolutionOption(
    page,
    page.locator('main'),
    ['快递还在拦截中'],
    { stage: 'intercept-progress', timeoutMs: 1000 },
  );
  assert.equal(renamedInterceptProgress, '召回任务仍在处理中');
  assert.equal(await page.locator('input[value="pending"]').isChecked(), true);

  await page.setContent(`
    <main id="renamed-consumer-response">
      <label><input type="radio" name="consumer-response" value="accepted" />买家接受召回完成后退款</label>
      <label><input type="radio" name="consumer-response" value="timeout" />买家已超过12小时没有回应</label>
      <button type="button">提交</button>
    </main>
  `);
  const renamedConsumerTimeout = await selectPddCoreResolutionOption(
    page,
    page.locator('main'),
    ['消费者超12小时未回复'],
    { stage: 'consumer-negotiation-followup', timeoutMs: 1000 },
  );
  assert.equal(renamedConsumerTimeout, '买家已超过12小时没有回应');
  assert.equal(await page.locator('input[value="timeout"]').isChecked(), true);

  await page.setContent('<main><p>处理结果加载中</p></main>');
  assert.equal(await waitForVisiblePddPrimaryRefundOutcome(
    page,
    page.locator('main'),
    '同意退款',
    50,
  ), null, 'an absent refund outcome must remain a render failure instead of inventing a choice');

  await page.setContent(`
    <main id="contradictory-core-refund-outcome">
      <label><input type="radio" name="contradictory-refund" />拒绝退款</label>
      <label><input type="radio" name="contradictory-refund" />暂不处理退款</label>
      <button type="button">提交</button>
    </main>
  `);
  assert.equal(await waitForVisiblePddPrimaryRefundOutcome(
    page,
    page.locator('main'),
    '同意退款',
    100,
  ), null, 'contradictory core outcomes must remain unselected');
  assert.equal(await page.locator('input[name="contradictory-refund"]:checked').count(), 0);

  await page.setContent(`
    <style>
      [role="combobox"] { display: block; width: 280px; height: 32px; border: 1px solid #999; }
    </style>
    <main id="resolution-form">
      <div><span>其他条件</span><div role="combobox" tabindex="0"></div></div>
      <div><span>备注选项</span><div role="combobox" tabindex="0"></div></div>
      <button>提交</button>
    </main>
  `);
  await assert.rejects(
    () => selectOrdinaryPddDropdownOption(
      page,
      /未更新承诺协商|未更新承诺|物流未更新.*承诺/,
      ['未更新则补发或者退款'],
      { matchAll: ['补发', '退款'] },
    ),
    /未找到.*下拉框/u,
  );
} finally {
  await browser.close();
}

console.log('PDD ordinary controlled-field and dropdown UI self-test passed');
