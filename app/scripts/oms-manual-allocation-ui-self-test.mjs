import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = (await fsp.readFile(path.join(root, 'workflow.mjs'), 'utf8'))
  .replace(/\r\n/g, '\n');

const sourceBetween = (startMarker, endMarker) => {
  const start = workflowSource.indexOf(startMarker);
  const end = workflowSource.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `workflow source markers missing: ${startMarker}`);
  return workflowSource.slice(start, end);
};

const firstVisibleSource = sourceBetween(
  'const firstVisible = async (candidates) => {',
  "\n\n// PDD's QR code expires",
);
const uiFunctionsSource = sourceBetween(
  'const selectOmsOrderRow = async (rowScope, orderCell, targetPage = null) => {',
  '\n\nconst verifyOmsOrderAllocated = async',
);
const verifyAllocatedSource = sourceBetween(
  'const verifyOmsOrderAllocated = async',
  '\n\nconst runOmsManualAllocation = async',
);
const queryInputReadinessSource = sourceBetween(
  'const fillReadyOmsOrderQueryInput = async',
  '\n\nconst ensureOmsOrderManagementPage = async',
);
const runAllocationSource = sourceBetween(
  'const runOmsManualAllocation = async',
  '\n\nconst ensureOmsScenarioPreparation = async',
);

const evaluateFunctions = (source, names, globals = {}) => {
  const sandbox = {
    console,
    Date,
    Error,
    process,
    setTimeout,
    clearTimeout,
    ensureOmsWarehouseMutationAllowed: async () => ({ status: 'confirmed' }),
    ...globals,
  };
  vm.runInNewContext(
    `${source}\nglobalThis.__functions = { ${names.join(', ')} };`,
    sandbox,
    { filename: 'workflow-oms-ui-functions.mjs' },
  );
  return sandbox.__functions;
};

const firstVisible = evaluateFunctions(firstVisibleSource, ['firstVisible']).firstVisible;
const normalizeCarrier = (value) => String(value || '')
  .trim()
  .replace(/(?:快递包裹|快递|速递|物流|速运|快运|包裹)$/u, '');
const selectRecommendedOmsCarrier = (recommendedCarriers, availableCarriers) => {
  for (const recommendedCarrier of recommendedCarriers) {
    const normalizedRecommendation = normalizeCarrier(recommendedCarrier);
    const omsCarrier = availableCarriers.find((candidate) => {
      const normalizedCandidate = normalizeCarrier(candidate);
      return normalizedCandidate.length >= 2
        && (normalizedCandidate.includes(normalizedRecommendation)
          || normalizedRecommendation.includes(normalizedCandidate));
    });
    if (omsCarrier) return { recommendedCarrier, omsCarrier };
  }
  return null;
};
const omsOrderStatusHasPassedAllocation = (value) => (
  ['已配货', '已发货', '已完成'].includes(String(value || '').normalize('NFKC').trim())
);
const omsApiOrderStateHasPassedAllocation = (state = {}) => (
  state.dispatchStatus === 'ALL'
  || ['PART', 'ALL'].includes(state.deliveryStatus)
  || ['DISPATCHED', 'DELIVERED', 'FINISHED', 'COMPLETED'].includes(state.status)
);
const omsOrderStatusFromApiState = (state = {}) => {
  if (['FINISHED', 'COMPLETED'].includes(state.status)) return '已完成';
  if (state.status === 'DELIVERED' || ['PART', 'ALL'].includes(state.deliveryStatus)) return '已发货';
  if (state.status === 'DISPATCHED' || state.dispatchStatus === 'ALL') return '已配货';
  return null;
};
class TestLogisticsRetryRequiredError extends Error {
  constructor(stage, reason, retryAfterMs, details = {}) {
    super(reason);
    this.name = 'LogisticsRetryRequiredError';
    this.stage = stage;
    this.retryAfterMs = retryAfterMs;
    Object.assign(this, details);
  }
}
const uiFunctions = evaluateFunctions(uiFunctionsSource, [
  'selectOmsOrderRow',
  'openOmsManualAllocationDialog',
  'addAllOmsManualAllocationItems',
  'enableOmsManualAllocationWithoutInventoryCheck',
  'chooseOmsManualAllocationCarrier',
], {
  firstVisible,
  selectRecommendedOmsCarrier,
  LogisticsRetryRequiredError: TestLogisticsRetryRequiredError,
});

const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const fixtureMarkup = `
  <style>.hidden { display: none !important; }</style>
  <div class="ag-pinned-left-cols-container">
    <div class="ag-row" row-index="0">
      <input id="row-checkbox" type="checkbox" aria-label="选择订单" onclick="selectRow()">
    </div>
  </div>
  <div class="ag-center-cols-container">
    <div class="ag-row" row-index="0">
      <button id="order-cell" onclick="openOrderDetail()" oncontextmenu="openOrderMenu(event)">260809-000000000000001</button>
    </div>
  </div>
  <button id="toolbar-more-actions" role="button" onclick="openToolbarMoreActions()">更多操作</button>
  <div class="el-dropdown">
    <button id="resend-main" onclick="openBatchResend()">补发</button>
    <button class="el-dropdown__caret-button" aria-label="补发下拉" onclick="openResendMenu()">v</button>
  </div>
  <div id="order-menu" role="menu" class="hidden">
    <button role="menuitem" onmouseover="openNestedOrderMenu()">更多操作</button>
  </div>
  <div id="nested-order-menu" role="menu" class="hidden">
    <button role="menuitem" onclick="openManualAllocation()">手工配货</button>
  </div>
  <div id="batch-resend-dialog" class="el-dialog" role="dialog" aria-label="批量补发">
    <h2>批量补发</h2>
    <button class="el-dialog__headerbtn" aria-label="关闭" onclick="closeBatchResend()">x</button>
  </div>
  <div id="manual-dialog" class="el-dialog hidden" role="dialog" aria-label="手工配货">
    <h2>手工配货</h2>
    <div class="el-loading-mask hidden"><div class="el-loading-spinner">加载中</div></div>
    <div>订单明细</div>
    <div class="el-table">
      <input type="checkbox" aria-label="选择全部商品">
      <span class="source-actions">
        <button onclick="addSingleItem('item-1', this)">添加</button>
        <button onclick="addSingleItem('item-2', this)">添加</button>
      </span>
    </div>
    <button onclick="addAllItems()">添加全部</button>
    <div class="el-table">
      <div class="el-table__body-wrapper"><table><tbody id="selected-items"></tbody></table></div>
    </div>
    <div>原商品剩余数量： <span id="remaining-items">2</span></div>
    <div>已选配货数量： <span id="selected-item-count">0</span></div>
    <div class="el-checkbox" aria-checked="false" onclick="toggleInventory(event)">
      <input type="checkbox"><span>不校验库存</span>
    </div>
    <div class="el-form-item">
      <span>发货快递</span>
      <div class="el-select">
        <div class="el-select__wrapper" role="button" onclick="openCarrierOptions()">
          <span class="selected-carrier">请选择</span>
          <input role="combobox" aria-controls="carrier-list" aria-expanded="false">
        </div>
      </div>
    </div>
    <button id="generate" disabled>生成配货单</button>
  </div>
  <div class="el-popper hidden">
    <div class="el-select-dropdown">
      <ul id="carrier-list" role="listbox">
        <li role="option" class="el-select-dropdown__item" onclick="pickCarrier(this)">拼多多中通</li>
        <li role="option" class="el-select-dropdown__item" onclick="pickCarrier(this)">拼多多申通</li>
        <li role="option" class="el-select-dropdown__item" onclick="pickCarrier(this)">拼多多圆通</li>
      </ul>
    </div>
  </div>
  <div class="status">新建</div>
  <script>
    window.events = [];
    window.resendMainClicked = false;
    window.resendCaretClicked = false;
    window.itemsAdded = false;
    window.inventoryCheckBypassed = false;
    window.selectedCarrier = null;
    function refreshGenerate() {
      document.getElementById('generate').disabled = !(
        window.itemsAdded && window.inventoryCheckBypassed && window.selectedCarrier
      );
    }
    function selectRow() {
      window.events.push('checkbox');
      document.getElementById('order-menu').classList.add('hidden');
    }
    function openOrderDetail() {
      window.events.push('order');
    }
    function openOrderMenu(event) {
      event.preventDefault();
      window.events.push('order-context');
      document.getElementById('order-menu').classList.remove('hidden');
    }
    function openToolbarMoreActions() {
      window.events.push('toolbar-more-actions');
      document.getElementById('nested-order-menu').classList.remove('hidden');
    }
    function openNestedOrderMenu() {
      window.events.push('submenu-hover');
      document.getElementById('nested-order-menu').classList.remove('hidden');
    }
    function openBatchResend() {
      window.resendMainClicked = true;
      window.events.push('resend-main');
      document.getElementById('batch-resend-dialog').classList.remove('hidden');
    }
    function closeBatchResend() {
      window.events.push('batch-close');
      document.getElementById('batch-resend-dialog').classList.add('hidden');
    }
    function openResendMenu() {
      window.resendCaretClicked = true;
      window.events.push('resend-caret');
      document.getElementById('order-menu').classList.remove('hidden');
    }
    function openManualAllocation() {
      window.events.push('manual-allocation');
      document.getElementById('manual-dialog').classList.remove('hidden');
      document.querySelector('#manual-dialog .el-loading-mask').classList.remove('hidden');
      document.getElementById('order-menu').classList.add('hidden');
      document.getElementById('nested-order-menu').classList.add('hidden');
      setTimeout(() => {
        document.querySelector('#manual-dialog .el-loading-mask').classList.add('hidden');
        window.events.push('manual-rendered');
      }, 250);
    }
    function addAllItems() {
      window.events.push('add-all-noop');
    }
    function addSingleItem(itemId, button) {
      if (!document.querySelector('#manual-dialog .el-loading-mask').classList.contains('hidden')) {
        window.events.push('add-during-loading');
        return;
      }
      if (!document.getElementById(itemId)) {
        const row = document.createElement('tr');
        row.id = itemId;
        row.innerHTML = '<td>selected</td>';
        document.getElementById('selected-items').appendChild(row);
      }
      window.itemsAdded = document.querySelectorAll('#selected-items tr').length === 2;
      button.classList.add('hidden');
      const selectedCount = document.querySelectorAll('#selected-items tr').length;
      document.getElementById('remaining-items').textContent = String(2 - selectedCount);
      document.getElementById('selected-item-count').textContent = String(selectedCount);
      window.events.push('add-one');
      refreshGenerate();
    }
    function toggleInventory(event) {
      event.preventDefault();
      window.inventoryCheckBypassed = !window.inventoryCheckBypassed;
      const checkbox = event.currentTarget;
      checkbox.setAttribute('aria-checked', String(window.inventoryCheckBypassed));
      checkbox.querySelector('input').checked = window.inventoryCheckBypassed;
      refreshGenerate();
    }
    function openCarrierOptions() {
      document.querySelector('.el-popper').classList.remove('hidden');
      document.querySelector('[role="combobox"]').setAttribute('aria-expanded', 'true');
    }
    function pickCarrier(option) {
      document.querySelectorAll('.el-select-dropdown__item').forEach((item) => item.classList.remove('selected'));
      option.classList.add('selected');
      window.selectedCarrier = option.textContent.trim();
      document.querySelector('.selected-carrier').textContent = window.selectedCarrier;
      document.querySelector('.el-popper').classList.add('hidden');
      document.querySelector('[role="combobox"]').setAttribute('aria-expanded', 'false');
      refreshGenerate();
    }
    function resetCarrier() {
      window.selectedCarrier = null;
      document.querySelectorAll('.el-select-dropdown__item').forEach((item) => item.classList.remove('selected'));
      document.querySelector('.selected-carrier').textContent = '请选择';
      refreshGenerate();
    }
  </script>`;

try {
  const queryPage = await browser.newPage();
  await queryPage.setContent(`
    <input id="oms-query" placeholder="OMS编号" disabled>
    <script>
      setTimeout(() => {
        const oldInput = document.getElementById('oms-query');
        const readyInput = oldInput.cloneNode();
        readyInput.disabled = false;
        oldInput.replaceWith(readyInput);
      }, 150);
    </script>
  `);
  const queryInputFunctions = evaluateFunctions(
    queryInputReadinessSource,
    ['fillReadyOmsOrderQueryInput'],
    {
      closeUnexpectedOmsPopups: async () => {},
      findOmsOrderQueryInput: async (targetPage) => targetPage.locator('#oms-query'),
      LogisticsRetryRequiredError: TestLogisticsRetryRequiredError,
    },
  );
  const recoveredInput = await queryInputFunctions.fillReadyOmsOrderQueryInput(
    queryPage,
    '260821-071135403672212',
    { preferredInput: queryPage.locator('#oms-query'), timeoutMs: 1_000 },
  );
  assert.equal(await recoveredInput.inputValue(), '260821-071135403672212',
    'OMS query readiness must reacquire a SPA input that becomes editable after mounting');
  await queryPage.locator('#oms-query').evaluate((input) => {
    input.value = '';
    input.disabled = true;
  });
  await assert.rejects(
    queryInputFunctions.fillReadyOmsOrderQueryInput(
      queryPage,
      '260821-071135403672212',
      { preferredInput: queryPage.locator('#oms-query'), timeoutMs: 1_000 },
    ),
    (error) => error instanceof TestLogisticsRetryRequiredError
      && error.code === 'OMS_QUERY_INPUT_TEMPORARILY_UNAVAILABLE'
      && error.retryAfterMs === 30_000,
    'a permanently disabled OMS query input must become a bounded retry signal',
  );
  await queryPage.close();

  const delayedMenuPage = await browser.newPage();
  await delayedMenuPage.setContent(`
    <button id="more" onclick="setTimeout(() => document.getElementById('menu').hidden=false, 1600)">更多操作</button>
    <button id="order" oncontextmenu="window.contextOpened=true; event.preventDefault()">260809-000000000000001</button>
    <div id="menu" role="menu" hidden>
      <button role="menuitem" onclick="document.getElementById('allocation').hidden=false">手工配货</button>
    </div>
    <div id="allocation" class="el-dialog" role="dialog" hidden>手工配货</div>
    <script>window.contextOpened=false;</script>
  `);
  const delayedDialog = await uiFunctions.openOmsManualAllocationDialog(
    delayedMenuPage, delayedMenuPage.locator('#order'),
  );
  assert.equal(await delayedDialog.isVisible(), true,
    'a delayed OMS toolbar menu must be awaited before trying a different menu');
  assert.equal(await delayedMenuPage.evaluate(() => window.contextOpened), false,
    'a rendering toolbar menu must not be interrupted by a row context click');
  await delayedMenuPage.close();

  const page = await browser.newPage();
  await page.setContent(fixtureMarkup);
  const rowScope = page.locator('.ag-center-cols-container .ag-row');
  const orderCell = page.locator('#order-cell');

  await uiFunctions.selectOmsOrderRow(rowScope, orderCell, page);
  assert.deepEqual(await page.evaluate(() => window.events.slice(0, 2)), ['checkbox', 'order'],
    'OMS must select the row before opening the transaction menu');

  const rerenderPage = await browser.newPage();
  await rerenderPage.setContent(`
    <div class="ag-pinned-left-cols-container">
      <div id="pinned-row" class="ag-row" row-index="3">
        <input id="rerender-checkbox" type="checkbox" aria-label="选择订单" onclick="selectRerenderedRow()">
      </div>
    </div>
    <div class="ag-center-cols-container">
      <div class="ag-row" row-index="3">
        <button id="rerender-order-cell" onclick="window.orderOpened = true">260817-211707574683652</button>
      </div>
    </div>
    <script>
      window.checkboxClicks = 0;
      window.orderOpened = false;
      function selectRerenderedRow() {
        window.checkboxClicks += 1;
        const row = document.getElementById('pinned-row');
        if (window.checkboxClicks === 1) {
          row.innerHTML = '<input id="rerender-checkbox" type="checkbox" aria-label="选择订单" onclick="selectRerenderedRow()">';
          return;
        }
        row.classList.add('ag-row-selected');
        row.setAttribute('aria-selected', 'true');
      }
    </script>
  `);
  await uiFunctions.selectOmsOrderRow(
    rerenderPage.locator('.ag-center-cols-container .ag-row'),
    rerenderPage.locator('#rerender-order-cell'),
    rerenderPage,
  );
  assert.equal(await rerenderPage.evaluate(() => window.checkboxClicks), 2,
    'OMS must reacquire and click a checkbox after its first selection is lost to a row rerender');
  assert.equal(await rerenderPage.locator('#pinned-row').getAttribute('aria-selected'), 'true',
    'the reacquired OMS row must be confirmed selected');
  assert.equal(await rerenderPage.evaluate(() => window.orderOpened), true,
    'OMS must continue only after the rerendered row is selected');
  await rerenderPage.close();

  const dialog = await uiFunctions.openOmsManualAllocationDialog(page, orderCell);
  assert.equal(await dialog.isVisible(), true, 'manual-allocation dialog did not open after menu recovery');
  assert.deepEqual(
    await page.evaluate(() => window.events.slice(-3)),
    ['batch-close', 'toolbar-more-actions', 'manual-allocation'],
    'manual allocation must close batch resend and use the toolbar more-actions menu',
  );
  assert.equal(await page.evaluate(() => window.events.includes('order-context')), false,
    'the toolbar path must avoid the row context menu when the action is available');
  assert.equal(await page.evaluate(() => window.resendMainClicked), false,
    'the batch-resend main button must never be clicked');
  assert.equal(await page.evaluate(() => window.resendCaretClicked), false,
    'the manual-allocation flow must not use the batch-resend toolbar control');

  const itemPreparation = await uiFunctions.addAllOmsManualAllocationItems(page, dialog);
  assert.equal(await page.evaluate(() => window.itemsAdded), true, 'all products were not added');
  assert.equal(await page.evaluate(() => window.events.includes('add-during-loading')), false,
    'manual allocation must not force product actions through the loading mask');
  assert.equal(await page.evaluate(() => window.events.indexOf('manual-rendered') < window.events.indexOf('add-one')), true,
    'manual allocation must wait for the dialog render before adding products');
  assert.equal(itemPreparation.selectedItemCount, 2, 'selected item count was not verified');
  assert.equal(await page.evaluate(() => window.events.filter((event) => event === 'add-one').length), 2,
    'every source item must be added through its row action');
  assert.equal(await page.evaluate(() => window.events.includes('add-all-noop')), false,
    'the unreliable add-all action must not be used');
  const inventoryPreparation = await uiFunctions.enableOmsManualAllocationWithoutInventoryCheck(dialog);
  assert.equal(inventoryPreparation.inventoryCheckBypassed, true,
    'OMS inventory validation bypass was not enabled');
  assert.equal(await page.evaluate(() => window.inventoryCheckBypassed), true,
    'the inventory checkbox state did not change');

  const secondChoice = await uiFunctions.chooseOmsManualAllocationCarrier(
    page,
    dialog,
    ['极兔速递', '申通快递', '圆通快递'],
  );
  assert.deepEqual(
    { ...secondChoice },
    { recommendedCarrier: '申通快递', omsCarrier: '拼多多申通' },
    'the second available PDD recommendation was not selected',
  );
  assert.equal(await page.locator('.el-select-dropdown__item.selected').count(), 1,
    'OMS carrier selection must contain exactly one option');

  await page.evaluate(() => window.resetCarrier());
  const thirdChoice = await uiFunctions.chooseOmsManualAllocationCarrier(
    page,
    dialog,
    ['极兔速递', '邮政快递包裹', '圆通快递'],
  );
  assert.deepEqual(
    { ...thirdChoice },
    { recommendedCarrier: '圆通快递', omsCarrier: '拼多多圆通' },
    'the third available PDD recommendation was not selected',
  );
  assert.equal(await page.locator('.el-select-dropdown__item.selected').count(), 1,
    'fallback carrier selection must still contain exactly one option');

  await page.evaluate(() => window.resetCarrier());
  const preparationEvents = [];
  let liveOrderStatus = '新建';
  let simulatedProgress = { omsAnalysis: { orderStatus: '配货异常' } };
  const runFunctions = evaluateFunctions(runAllocationSource, ['runOmsManualAllocation'], {
    firstVisible,
    shopId: 'test-shop',
    omsOrderStatusHasPassedAllocation,
    omsApiOrderStateHasPassedAllocation,
    omsOrderStatusFromApiState,
    readOmsOrderStatus: async () => liveOrderStatus,
    readProgress: () => simulatedProgress,
    writeProgress: (patch) => { simulatedProgress = { ...simulatedProgress, ...patch }; },
    persistBrowserAuth: async () => { preparationEvents.push('persist-auth'); },
    ensureOmsOrderManagementPage: async () => { preparationEvents.push('prepare-order-page'); },
    queryOmsOrderRow: async () => {
      preparationEvents.push('query-order');
      return { orderCell, rowScope };
    },
    selectOmsOrderRow: async () => { preparationEvents.push('select-order'); },
    openOmsManualAllocationDialog: async () => dialog,
    addAllOmsManualAllocationItems: async () => ({ selectedItemCount: 2 }),
    enableOmsManualAllocationWithoutInventoryCheck: async () => ({ inventoryCheckBypassed: true }),
    chooseOmsManualAllocationCarrier: async () => ({
      recommendedCarrier: '申通快递',
      omsCarrier: '申通速递',
    }),
  });
  await assert.rejects(
    runFunctions.runOmsManualAllocation(page, {}, '260809-000000000000001', ['申通快递']),
    /生成配货单.*仍不可用/u,
    'a disabled generate button must block OMS submission',
  );
  assert.deepEqual(
    preparationEvents.slice(0, 2),
    ['prepare-order-page', 'query-order'],
    'manual allocation must restore the OMS order-management page before querying',
  );
  assert.equal(preparationEvents.includes('select-order'), true,
    'an OMS order that still needs allocation must continue to row selection');

  preparationEvents.length = 0;
  liveOrderStatus = '已发货';
  const alreadyShipped = await runFunctions.runOmsManualAllocation(
    page,
    {},
    '260809-000000000000001',
    ['申通快递'],
  );
  assert.equal(alreadyShipped.status, 'already-past-allocation',
    'a recovered order that OMS has already shipped must skip manual allocation');
  assert.equal(alreadyShipped.verifiedOrderStatus, '已发货',
    'the refreshed OMS status must be persisted as the allocation postcondition');
  assert.equal(preparationEvents.includes('select-order'), false,
    'an already-shipped OMS order must not open the manual-allocation action');
  assert.equal(simulatedProgress.omsAnalysis.orderStatus, '已发货',
    'the stale OMS analysis must be refreshed before routing the recovered order');

  preparationEvents.length = 0;
  liveOrderStatus = '配货异常';
  const apiRecoveredFunctions = evaluateFunctions(runAllocationSource, ['runOmsManualAllocation'], {
    firstVisible,
    shopId: 'test-shop',
    omsOrderStatusHasPassedAllocation,
    omsApiOrderStateHasPassedAllocation,
    omsOrderStatusFromApiState,
    readOmsOrderStatus: async () => liveOrderStatus,
    readProgress: () => simulatedProgress,
    writeProgress: (patch) => { simulatedProgress = { ...simulatedProgress, ...patch }; },
    persistBrowserAuth: async () => {},
    ensureOmsOrderManagementPage: async () => {},
    queryOmsOrderRow: async () => ({
      orderCell,
      rowScope,
      omsApiOrderState: {
        status: 'DELIVERED',
        dispatchStatus: 'ALL',
        deliveryStatus: 'ALL',
      },
    }),
    selectOmsOrderRow: async () => { preparationEvents.push('select-order'); },
  });
  const apiRecovered = await apiRecoveredFunctions.runOmsManualAllocation(
    page,
    {},
    '260809-000000000000001',
    ['申通快递'],
  );
  assert.equal(apiRecovered.verifiedOrderStatus, '已发货',
    'the OMS query response must override stale rendered status text');
  assert.equal(preparationEvents.includes('select-order'), false,
    'an API-confirmed shipped order must not attempt manual allocation');

  const renderRecoveryEvents = [];
  const renderRecoveryProgress = [];
  let renderRecoveryQueryCount = 0;
  const renderRecoveryTargetPage = {
    reload: async (options) => renderRecoveryEvents.push(`reload:${options.waitUntil}`),
  };
  const renderRecoveryFunctions = evaluateFunctions(runAllocationSource, ['runOmsManualAllocation'], {
    firstVisible,
    shopId: 'test-shop',
    omsOrderStatusHasPassedAllocation,
    omsApiOrderStateHasPassedAllocation,
    omsOrderStatusFromApiState,
    readOmsOrderStatus: async () => '配货异常',
    readProgress: () => ({ omsAnalysis: { orderStatus: '配货异常' } }),
    writeProgress: (patch) => renderRecoveryProgress.push(patch),
    persistBrowserAuth: async () => renderRecoveryEvents.push('persist-auth'),
    ensureOmsOrderManagementPage: async () => renderRecoveryEvents.push('prepare-order-page'),
    queryOmsOrderRow: async () => {
      renderRecoveryQueryCount += 1;
      return {
        orderCell: {},
        rowScope: {},
        ...(renderRecoveryQueryCount > 1 ? {
          omsApiOrderState: { status: 'DISPATCHED', dispatchStatus: 'ALL' },
        } : {}),
      };
    },
    selectOmsOrderRow: async () => renderRecoveryEvents.push('select-order'),
    openOmsManualAllocationDialog: async () => ({}),
    addAllOmsManualAllocationItems: async () => {
      throw new Error('OMS 手工配货商品明细在 30 秒内未加载完成');
    },
    closeOmsManualAllocationDialog: async () => renderRecoveryEvents.push('close-dialog'),
  });
  const renderRecovered = await renderRecoveryFunctions.runOmsManualAllocation(
    renderRecoveryTargetPage,
    {},
    '260809-000000000000001',
    ['申通快递'],
  );
  assert.equal(renderRecoveryEvents.includes('reload:domcontentloaded'), true,
    'an unrendered OMS allocation dialog must refresh once before giving up');
  assert.equal(renderRecoveryQueryCount, 2,
    'the OMS order must be queried again after the render refresh');
  assert.equal(renderRecovered.status, 'already-allocated',
    'a refresh that reveals an allocated order must finish without opening another dialog');
  assert.equal(renderRecoveryProgress.some((patch) => (
    patch.step === 'oms-manual-allocation-render-reloading'
  )), true, 'the OMS render refresh must be observable in workflow progress');

  const verificationFunctions = evaluateFunctions(verifyAllocatedSource, ['verifyOmsOrderAllocated'], {
    omsOrderStatusHasPassedAllocation,
    omsApiOrderStateHasPassedAllocation,
    omsOrderStatusFromApiState,
    queryOmsOrderRow: async () => ({ rowScope: page.locator('.ag-row') }),
    readOmsOrderStatus: async () => page.locator('.status').innerText(),
  });
  const fastTargetPage = { waitForTimeout: () => new Promise((resolve) => setTimeout(resolve, 1)) };
  await assert.rejects(
    verificationFunctions.verifyOmsOrderAllocated(
      fastTargetPage,
      '260809-000000000000001',
      { timeoutMs: 20 },
    ),
    /未确认订单状态已越过配货阶段/u,
    'an unallocated OMS status must fail postcondition verification',
  );
  await page.locator('.status').evaluate((element) => { element.textContent = '已发货'; });
  const verified = await verificationFunctions.verifyOmsOrderAllocated(
    fastTargetPage,
    '260809-000000000000001',
    { timeoutMs: 20 },
  );
  assert.equal(verified.status, '已发货', 'a status past allocation was not accepted');

  await page.close();
  console.log('OMS manual-allocation Playwright UI self-test passed');
} finally {
  await browser.close();
}
