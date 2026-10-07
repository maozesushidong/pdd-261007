import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { classifyTmsOmsQueryHttpStatus } from '../packages/adapters/src/tms/query-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = (await fsp.readFile(path.join(root, 'workflow.mjs'), 'utf8'))
  .replace(/\r\n/g, '\n');
const helperStart = workflowSource.indexOf('const firstDefinedTmsIdentityValue =');
const helperEnd = workflowSource.indexOf('\n\nconst verifyTmsAutofill = async', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'TMS autofill candidate helper source is missing');
const helperSource = workflowSource.slice(helperStart, helperEnd);
const verifyEnd = workflowSource.indexOf('\n\nconst uploadPddEvidenceToTms = async', helperEnd);
const verifySource = workflowSource.slice(helperEnd, verifyEnd);
const tmsLoginRenderStart = workflowSource.indexOf('const tmsLoginPageRendered = async');
const tmsLoginRenderEnd = workflowSource.indexOf('\n\nconst tmsCustomerRegistrationReady = async', tmsLoginRenderStart);
const tmsNewTicketStart = workflowSource.indexOf('const findTmsNewTicketButton = async');
const tmsNewTicketEnd = workflowSource.indexOf('\n\nconst refreshTmsAuthorization = async', tmsNewTicketStart);
const tmsFilterStart = workflowSource.indexOf('const findTmsFilterPanel = async');
const tmsFilterEnd = workflowSource.indexOf('\n\nconst readTmsRowIdentity =', tmsFilterStart);
assert(tmsLoginRenderStart >= 0 && tmsLoginRenderEnd > tmsLoginRenderStart,
  'TMS rendered-login detector source is missing');
assert(tmsNewTicketStart >= 0 && tmsNewTicketEnd > tmsNewTicketStart,
  'TMS new-ticket entry recovery source is missing');
assert(tmsFilterStart >= 0 && tmsFilterEnd > tmsFilterStart,
  'TMS filter recovery source is missing');
const tmsLoginRenderSource = workflowSource.slice(tmsLoginRenderStart, tmsLoginRenderEnd);
const tmsNewTicketSource = workflowSource.slice(tmsNewTicketStart, tmsNewTicketEnd);
const tmsFilterSource = workflowSource.slice(tmsFilterStart, tmsFilterEnd);
assert.match(helperSource, /first-row-user-authorized/);
assert.match(verifySource, /business-fields-matched-row/);
assert.match(verifySource, /selectTmsAutofillCandidate/);
assert.equal(classifyTmsOmsQueryHttpStatus(401), 'authorization-recovery');
assert.equal(classifyTmsOmsQueryHttpStatus(403), 'authorization-recovery');
assert.equal(classifyTmsOmsQueryHttpStatus(429), 'transient-retry');
assert.equal(classifyTmsOmsQueryHttpStatus(503), 'transient-retry');
assert.equal(classifyTmsOmsQueryHttpStatus(422), 'terminal');
assert.match(workflowSource,
  /TmsOmsQueryAuthorizationError[\s\S]*refreshTmsAuthorization[\s\S]*tms-oms-query-authorization-recovery-exhausted/u,
  'TMS API authorization failures must refresh the current TMS session once before yielding');
assert.match(workflowSource,
  /refreshTmsAuthorization[\s\S]*localStorage\.clear\(\)[\s\S]*clearCookies[\s\S]*ensureTmsLoginOnce/u,
  'TMS API authorization recovery must clear only the current TMS origin and perform a controlled login');
assert.match(workflowSource, /物流场景数据池/u,
  'TMS navigation must recognize the current logistics scenario pool menu');
assert.match(workflowSource, /物流问题登记表/u,
  'TMS navigation must recognize the current customer logistics registration page');
assert.match(workflowSource, /const findTmsFilterPanel = async/u,
  'TMS filtering must locate the current page form instead of relying on one legacy panel class');
assert.match(tmsFilterSource, /recoveryPasses = 2/u,
  'TMS filtering must use bounded page recovery when the panel is delayed');
assert.match(tmsFilterSource, /recover-tms-filter-panel-/u,
  'TMS filtering must reload the registration route before yielding');
assert.doesNotMatch(
  workflowSource.slice(
    workflowSource.indexOf('const tmsCustomerRegistrationReady = async'),
    workflowSource.indexOf('\n\nconst waitForTmsCustomerRegistration = async'),
  ),
  /getByText\('客服登记'/u,
  'a rendered sidebar label must not make the TMS customer-registration page ready');
assert.match(tmsNewTicketSource, /recoveryPass <= 2/u,
  'TMS new-ticket entry must use two bounded render/recovery passes');
assert.match(tmsNewTicketSource, /tmsLoginPageRendered[\s\S]*openTmsCustomerRegistration/u,
  'TMS new-ticket entry must recover an asynchronous login redirect');
assert.match(workflowSource, /openTmsNewTicketDialog\(targetPage, browserContext\)/u,
  'TMS new-ticket entry recovery requires the current browser context');

const progressUpdates = [];
const actions = [];
const sandbox = {
  Date,
  Error,
  console,
  writeProgress: (patch) => progressUpdates.push(patch),
  pacedAction: async (_page, action, operation) => {
    actions.push(action);
    return operation();
  },
  normalizeBusinessText: (value) => String(value || '').replace(/\s+/gu, '').trim(),
  warehouseCategories: [],
  carrierCategories: [],
  matchBusinessCategories: (value) => {
    const normalized = String(value || '').replace(/\s+/gu, '').trim();
    const key = normalized.includes('筑越') ? 'zhuyue'
      : normalized.includes('邮政') || normalized.includes('EMS') ? 'postal'
        : normalized.includes('中通') ? 'zhongtong' : null;
    return { normalized, matches: key ? [{ key, label: normalized }] : [] };
  },
  matchCarrierCategories: (value) => {
    const normalized = String(value || '').replace(/\s+/gu, '').trim();
    const key = normalized.includes('邮政') || normalized.includes('EMS') ? 'postal'
      : normalized.includes('中通') ? 'zhongtong' : null;
    return { normalized, matches: key ? [{ key, label: normalized }] : [] };
  },
  escapeRegex: (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  tmsFormItem: (scope, label) => scope.locator('.el-form-item').filter({ hasText: label }).first(),
};
vm.runInNewContext(
  `${helperSource}\nglobalThis.tmsFunctions = { tmsExistingTicketSuborderComparison, tmsAutofillCandidatesFromPayload, reconcileTmsAutofillWarehouseMismatch, evaluateTmsAutofillCandidate, uniqueTmsEmptyCarrierCandidateIndex, selectTmsAutofillCandidate, selectTmsExactCarrierWhenAutofillIsEmpty };`,
  sandbox,
  { filename: 'workflow-tms-autofill-functions.mjs' },
);
const {
  tmsExistingTicketSuborderComparison,
  tmsAutofillCandidatesFromPayload,
  reconcileTmsAutofillWarehouseMismatch,
  evaluateTmsAutofillCandidate,
  uniqueTmsEmptyCarrierCandidateIndex,
  selectTmsAutofillCandidate,
  selectTmsExactCarrierWhenAutofillIsEmpty,
} = sandbox.tmsFunctions;

const reconciledWarehouse = reconcileTmsAutofillWarehouseMismatch({
  actual: {
    orderNumber: 'SO-EXACT-SHIPMENT',
    tradeId: '260817-000000000000001',
    warehouse: 'WAREHOUSE-B',
    trackingNumber: 'TRACKING-1',
    carrier: 'CARRIER-A',
  },
  orderNumber: '260817-000000000000001',
  logisticsAnalysis: { trackingNumber: 'TRACKING-1', carrier: 'CARRIER-A' },
  omsAnalysis: { shippingWarehouse: 'WAREHOUSE-A' },
  warehouseMatches: false,
});
assert.equal(reconciledWarehouse.accepted, true,
  'an exact linked shipment may use the non-empty TMS autofilled warehouse as authoritative');
assert.equal(reconciledWarehouse.strategy, 'tms-linked-oms-exact-shipment-authoritative');
assert.equal(reconcileTmsAutofillWarehouseMismatch({
  actual: { ...reconciledWarehouse, orderNumber: 'SO-EXACT-SHIPMENT', tradeId: '260817-000000000000001', warehouse: 'WAREHOUSE-B', trackingNumber: 'OTHER', carrier: 'CARRIER-A' },
  orderNumber: '260817-000000000000001',
  logisticsAnalysis: { trackingNumber: 'TRACKING-1', carrier: 'CARRIER-A' },
  omsAnalysis: { shippingWarehouse: 'WAREHOUSE-A' },
  warehouseMatches: false,
}).accepted, false, 'a different tracking number must never reconcile a warehouse mismatch');
assert.equal(reconcileTmsAutofillWarehouseMismatch({
  actual: { orderNumber: 'SO-EXACT-SHIPMENT', tradeId: '260817-000000000000001', warehouse: 'WAREHOUSE-B', trackingNumber: 'TRACKING-1', carrier: 'CARRIER-B' },
  orderNumber: '260817-000000000000001',
  logisticsAnalysis: { trackingNumber: 'TRACKING-1', carrier: 'CARRIER-A' },
  omsAnalysis: { shippingWarehouse: 'WAREHOUSE-A' },
  warehouseMatches: false,
}).accepted, false, 'a different carrier must never reconcile a warehouse mismatch');

const distinctSuborder = tmsExistingTicketSuborderComparison({
  identity: {
    text: '260811-000000000000001 L00000001',
    values: {
      ['\u8ba2\u5355\u53f7']: 'SO-FIRST',
      ['\u8fd0\u5355\u53f7']: '79130000000000',
      ['\u53d1\u8d27\u4ed3\u5e93']: 'WAREHOUSE-A',
      ['\u8d23\u4efb\u5feb\u9012']: 'CARRIER-A',
    },
  },
  record: {},
  progress: {
    omsGridCells: [{ colId: 'salesOrderCode', text: 'SO-SECOND' }],
    logisticsAnalysis: { trackingNumber: '9818000000000' },
  },
  orderNumber: '260811-000000000000001',
  candidateCount: 1,
  tracking: '',
  warehouse: '',
  carrier: '',
});
assert.equal(distinctSuborder.provablyDifferent, true);
assert.equal(distinctSuborder.omsOrderDistinct, true);
assert.equal(distinctSuborder.trackingDistinct, true);
assert.equal(tmsExistingTicketSuborderComparison({
  identity: { text: '260811-000000000000001', values: {
    ['\u8ba2\u5355\u53f7']: 'SO-FIRST',
    ['\u8fd0\u5355\u53f7']: '79130000000000',
  } },
  record: {},
  progress: {
    omsGridCells: [{ colId: 'salesOrderCode', text: 'SO-SECOND' }],
    logisticsAnalysis: { trackingNumber: '9818000000000' },
  },
  orderNumber: '260811-000000000000001',
  candidateCount: 2,
}).provablyDifferent, false, 'multiple old TMS rows must remain blocked');
assert.equal(tmsExistingTicketSuborderComparison({
  identity: { text: '260811-000000000000001', values: {
    ['\u8ba2\u5355\u53f7']: 'SO-FIRST',
  } },
  record: {},
  progress: {
    omsGridCells: [{ colId: 'salesOrderCode', text: 'SO-SECOND' }],
    logisticsAnalysis: { trackingNumber: '9818000000000' },
  },
  orderNumber: '260811-000000000000001',
  candidateCount: 1,
}).provablyDifferent, false, 'missing old tracking evidence must remain blocked');

const apiCandidates = tmsAutofillCandidatesFromPayload({ data: [
  {
    orderNo: 'SO-FIRST',
    tradeId: '260811-000000000000001',
    warehouse: '筑越仓',
    trackingNo: '79130000000000',
    logisticsCompany: '拼多多中通',
  },
  {
    orderNo: 'SO-SECOND',
    tradeId: '260811-000000000000001',
    warehouse: '筑越仓',
    trackingNo: '9818000000000',
    logisticsCompany: '菜鸟邮政',
  },
] });
const evaluations = apiCandidates.map((candidate) => evaluateTmsAutofillCandidate(
  candidate,
  '260811-000000000000001',
  { trackingNumber: '9818000000000', carrier: '邮政快递包裹' },
  { shippingWarehouse: '筑越仓' },
));
assert.equal(evaluations[0].matches, false);
assert.equal(evaluations[0].trackingMatches, false);
assert.equal(evaluations[1].matches, true);
const emptyCarrierEvaluations = [apiCandidates[0], {
  ...apiCandidates[1], logisticsCompany: '',
}].map((candidate) => evaluateTmsAutofillCandidate(
  candidate,
  '260811-000000000000001',
  { trackingNumber: '9818000000000', carrier: '邮政快递包裹' },
  { shippingWarehouse: '筑越仓' },
));
assert.equal(uniqueTmsEmptyCarrierCandidateIndex(
  emptyCarrierEvaluations, '邮政快递包裹',
), 1, 'the only exact order/tracking/warehouse row with an empty carrier must be selected');
assert.equal(uniqueTmsEmptyCarrierCandidateIndex([
  emptyCarrierEvaluations[1], emptyCarrierEvaluations[1],
], '邮政快递包裹'), -1, 'ambiguous empty-carrier rows must not be selected automatically');
assert.equal(uniqueTmsEmptyCarrierCandidateIndex([
  emptyCarrierEvaluations[0],
], '邮政快递包裹'), -1, 'a mismatched tracking number must not qualify');

const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  path.join(root, '..', 'runtime', 'chrome-for-testing', '151.0.7922.34', 'chrome.exe'),
  'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

try {
  const page = await browser.newPage();
  const newTicketActions = [];
  const newTicketRecovery = { registration: 0, navigation: 0, mode: 'recover' };
  const firstVisibleElement = async (candidates) => {
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      for (let index = 0; index < count; index++) {
        const element = candidate.nth(index);
        if (await element.isVisible().catch(() => false)) return element;
      }
    }
    return null;
  };
  const newTicketSandbox = {
    Date,
    console,
    firstVisible: firstVisibleElement,
    pacedAction: async (_page, action, operation) => {
      newTicketActions.push(action);
      return operation();
    },
    tmsNavigationPollIntervalMs: 10,
    tmsNewTicketEntryTimeoutMs: 150,
    tmsLogisticsUrl: 'http://tms.test/logistics',
    logRunStep: () => {},
    navigateSystemPage: async () => {
      newTicketRecovery.navigation++;
    },
    openTmsCustomerRegistration: async (targetPage) => {
      newTicketRecovery.registration++;
      if (newTicketRecovery.mode === 'fail') {
        await targetPage.setContent('<main><span>客服登记</span></main>');
        return;
      }
      await targetPage.setContent(`
        <main><button onclick="document.querySelector('.logistics-dialog').style.display='block'">新建</button></main>
        <div class="el-dialog logistics-dialog" style="display:none">新建工单</div>
      `);
    },
    closeUnexpectedTmsPopups: async () => {},
  };
  vm.runInNewContext(
    `${tmsLoginRenderSource}\n${tmsNewTicketSource}\nglobalThis.tmsNewTicketFunctions = { openTmsNewTicketDialog };`,
    newTicketSandbox,
    { filename: 'workflow-tms-new-ticket-functions.mjs' },
  );
  const { openTmsNewTicketDialog } = newTicketSandbox.tmsNewTicketFunctions;

  const filterActions = [];
  const filterRecovery = { navigation: 0 };
  const filterSandbox = {
    Date,
    Error,
    URL,
    console,
    context: {},
    firstVisible: firstVisibleElement,
    escapeRegex: (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    tmsFormItem: (scope, label) => scope.locator('.el-form-item').filter({ hasText: label }).first(),
    writeProgress: (patch) => progressUpdates.push(patch),
    pacedAction: async (_page, action, operation) => {
      filterActions.push(action);
      return operation();
    },
    tmsLogisticsUrl: 'http://tms.test/logistics',
    navigateSystemPage: async (targetPage) => {
      filterRecovery.navigation++;
      await targetPage.setContent(`
        <div class="toolbar"><button id="filter">筛选</button></div>
        <div class="table-container"><div class="el-table__body-wrapper"><table><tbody></tbody></table></div></div>
        <script>
          document.querySelector('#filter').addEventListener('click', () => {
            const panel = document.createElement('div');
            panel.className = 'filter-panel';
            panel.innerHTML = '<div class="el-form-item">交易号<input value=""><button>应用</button></div>';
            document.body.appendChild(panel);
            panel.querySelector('input').value = '260811-000000000000001';
            panel.querySelector('button').addEventListener('click', () => {
              fetch('http://tms.test/api/logistics/tickets?tradeId=260811-000000000000001');
              document.querySelector('.el-table__body-wrapper tbody').innerHTML =
                '<tr><td>260811-000000000000001</td></tr>';
            });
          });
        </script>
      `);
    },
    openTmsCustomerRegistration: async () => {},
    closeUnexpectedTmsPopups: async () => {},
  };
  vm.runInNewContext(
    `${tmsFilterSource}\nglobalThis.tmsFilterFunctions = { filterTmsTicketsByOrder };`,
    filterSandbox,
    { filename: 'workflow-tms-filter-functions.mjs' },
  );
  const { filterTmsTicketsByOrder } = filterSandbox.tmsFilterFunctions;

  await page.setContent(`
    <aside><span id="sidebar-new">新建</span></aside>
    <main id="business-toolbar"></main>
    <div class="el-dialog logistics-dialog" style="display:none">新建工单</div>
    <script>
      window.sidebarNewClicks = 0;
      document.querySelector('#sidebar-new').addEventListener('click', () => window.sidebarNewClicks++);
      setTimeout(() => {
        const button = document.createElement('button');
        button.textContent = '新建';
        button.onclick = () => { document.querySelector('.logistics-dialog').style.display = 'block'; };
        document.querySelector('#business-toolbar').appendChild(button);
      }, 60);
    </script>
  `);
  const delayedDialog = await openTmsNewTicketDialog(page, {});
  assert.equal(await delayedDialog.isVisible(), true,
    'a delayed TMS new-ticket button must open the dialog within the bounded wait');
  assert.equal(await page.evaluate(() => window.sidebarNewClicks), 0,
    'the TMS entry locator must never click a same-named sidebar label');
  assert.deepEqual(newTicketActions, ['open-new-tms-ticket']);

  await page.setContent('<div class="el-dialog logistics-dialog">已打开的新建工单</div>');
  const reusedDialog = await openTmsNewTicketDialog(page, {});
  assert.equal(await reusedDialog.isVisible(), true);
  assert.deepEqual(newTicketActions, ['open-new-tms-ticket'],
    'an already-open TMS dialog must be reused without another click');

  await page.setContent(`
    <main><span>客服登记</span></main>
    <script>
      setTimeout(() => {
        document.body.innerHTML = '<form>账号登录<input type="password"></form>';
      }, 40);
    </script>
  `);
  const recoveredDialog = await openTmsNewTicketDialog(page, {});
  assert.equal(await recoveredDialog.isVisible(), true,
    'an asynchronous TMS login redirect must recover and reopen customer registration');
  assert.equal(newTicketRecovery.registration, 1);
  assert.equal(newTicketRecovery.navigation, 0,
    'a rendered login page must use login recovery instead of a blind business-route refresh');

  newTicketRecovery.mode = 'fail';
  await page.setContent('<main><span>客服登记</span></main>');
  await assert.rejects(
    openTmsNewTicketDialog(page, {}),
    /两轮等待后仍未找到新建按钮或窗口/u,
    'TMS new-ticket entry must fail only after both bounded recovery passes are exhausted',
  );
  assert.equal(newTicketRecovery.registration, 2,
    'two failed passes must perform exactly one controlled customer-registration recovery');

  await page.route('**/api/logistics/tickets*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }));
  await page.setContent('<main><span>客服登记</span></main>');
  const filtered = await filterTmsTicketsByOrder(
    page,
    '260811-000000000000001',
    { browserContext: {} },
  );
  assert.equal(filtered.count, 1,
    'TMS filter recovery must re-open the registration route when the panel is absent');
  assert.equal(filterRecovery.navigation, 1,
    'TMS filter recovery must use exactly one bounded route reload for a missing panel');
  assert.deepEqual(filterActions, ['expand-tms-filter', 'fill-tms-ticket-filter', 'apply-tms-ticket-filter']);

  const recoveriesBeforeSlowList = filterRecovery.navigation;
  await page.setContent(`
    <div class="toolbar"><button id="slow-filter">筛选</button></div>
    <div class="table-container">
      <div class="el-loading-mask">列表加载中</div>
      <div class="el-table__body-wrapper"><table><tbody></tbody></table></div>
    </div>
    <script>
      window.listReady = false;
      window.filterClicks = 0;
      document.querySelector('#slow-filter').addEventListener('click', () => {
        window.filterClicks++;
        if (!window.listReady) return;
        const panel = document.createElement('div');
        panel.className = 'filter-panel';
        panel.innerHTML = '<div class="el-form-item">交易号<input><button>应用</button></div>';
        document.body.appendChild(panel);
        panel.querySelector('button').addEventListener('click', () => {
          fetch('http://tms.test/api/logistics/tickets?tradeId=260811-000000000000001');
          document.querySelector('.el-table__body-wrapper tbody').innerHTML =
            '<tr><td>260811-000000000000001</td></tr>';
        });
      });
      setTimeout(() => {
        window.listReady = true;
        document.querySelector('.el-loading-mask').remove();
      }, 550);
    </script>
  `);
  const afterSlowList = await filterTmsTicketsByOrder(
    page, '260811-000000000000001', { browserContext: {} },
  );
  assert.equal(afterSlowList.count, 1,
    'TMS filtering must wait for the initial list to settle before opening its panel');
  assert.equal(await page.evaluate(() => window.filterClicks), 1,
    'the filter must not be clicked during the initial list loading mask');
  assert.equal(filterRecovery.navigation, recoveriesBeforeSlowList,
    'a slow initial list must not trigger a registration-page reload');

  const recoveriesBeforeSlowRender = filterRecovery.navigation;
  await page.setContent(`
    <main id="late-tms-page"></main>
    <script>
      setTimeout(() => {
        document.querySelector('#late-tms-page').innerHTML =
          '<div class="toolbar"><button id="late-filter">筛选</button></div>' +
          '<div class="table-container"><div class="el-table__body-wrapper">' +
          '<table><tbody></tbody></table></div></div>';
        document.querySelector('#late-filter').addEventListener('click', () => {
          const panel = document.createElement('div');
          panel.className = 'filter-panel';
          panel.innerHTML = '<div class="el-form-item">交易号<input><button>应用</button></div>';
          document.body.appendChild(panel);
          panel.querySelector('button').addEventListener('click', () => {
            fetch('http://tms.test/api/logistics/tickets?tradeId=260811-000000000000001');
            document.querySelector('.el-table__body-wrapper tbody').innerHTML =
              '<tr><td>260811-000000000000001</td></tr>';
          });
        });
      }, 550);
    </script>
  `);
  const afterSlowRender = await filterTmsTicketsByOrder(
    page, '260811-000000000000001', { browserContext: {} },
  );
  assert.equal(afterSlowRender.count, 1,
    'TMS filtering must wait for an asynchronously rendered toolbar');
  assert.equal(filterRecovery.navigation, recoveriesBeforeSlowRender,
    'late toolbar rendering must not reload the registration page');
  await page.unroute('**/api/logistics/tickets*');

  await page.setContent(`
    <div class="el-dialog logistics-dialog">
      <div class="el-form-item">
        <input placeholder="请输入交易号，回车自动查询OMS" value="260811-000000000000001">
        <div class="query-tip">查询到 2 个订单，请选择对应订单</div>
        <div class="el-table__body-wrapper">
          <table><tbody>
            <tr class="el-table__row" onclick="selectCandidate('SO-FIRST', this)">
              <td>SO-FIRST</td><td>创建人甲</td><td>店铺甲</td>
            </tr>
            <tr class="el-table__row" onclick="selectCandidate('SO-SECOND', this)">
              <td>SO-SECOND</td><td>创建人乙</td><td>店铺乙</td>
            </tr>
          </tbody></table>
        </div>
      </div>
    </div>
    <script>
      window.selectedCandidates = [];
      window.selectCandidate = (orderNumber, row) => {
        window.selectedCandidates.push(orderNumber);
        row.closest('.el-form-item').querySelector('.query-tip').textContent =
          '查询成功，已自动填充订单信息';
      };
    </script>
  `);

  const dialog = page.locator('.logistics-dialog');
  const orderInput = dialog.getByPlaceholder('请输入交易号，回车自动查询OMS', { exact: true });
  const selected = await selectTmsAutofillCandidate(
    page,
    dialog,
    orderInput,
    '查询到 2 个订单，请选择对应订单',
    {
      preferredIndex: 1,
      selectionStrategy: 'business-fields-matched-row',
      candidateEvaluation: evaluations[1],
    },
  );
  assert.equal(selected.status, 'selected');
  assert.equal(selected.candidateCount, 2);
  assert.equal(selected.observedRowCount, 2);
  assert.equal(selected.selectedIndex, 1);
  assert.equal(selected.selectionStrategy, 'business-fields-matched-row');
  assert.equal(selected.selectedOrderNumber, 'SO-SECOND');
  assert.equal(selected.candidateEvaluation.matches, true);
  assert.deepEqual(await page.evaluate(() => window.selectedCandidates), ['SO-SECOND']);
  assert.deepEqual(actions, ['select-tms-autofill-candidate']);
  assert.equal(progressUpdates.at(-1).tmsAutofillCandidateSelection.status, 'selected');

  assert.equal(await selectTmsAutofillCandidate(
    page,
    dialog,
    orderInput,
    'OMS 未找到该交易号',
  ), null);
  assert.deepEqual(await page.evaluate(() => window.selectedCandidates), ['SO-SECOND']);

  await page.locator('.el-table__body-wrapper').evaluate((element) => element.remove());
  await assert.rejects(
    selectTmsAutofillCandidate(
      page,
      dialog,
      orderInput,
      '查询到 2 个订单，请选择对应订单',
      { preferredIndex: 1 },
    ),
    /无法定位第 2 条候选订单/u,
  );

  await page.setContent(`
    <div class="logistics-dialog">
      <div class="el-form-item"><label>责任快递</label>
        <div class="el-select"><div class="el-select__wrapper">
          <span class="el-select__selected-item el-select__placeholder is-transparent">优先自动带入，无匹配时请手动搜索选择</span>
        </div></div>
      </div>
    </div>
    <div class="el-select-dropdown" style="display:none">
      <div class="el-select-dropdown__item">中国邮政</div>
      <div class="el-select-dropdown__item">邮政快递包裹</div>
    </div>
    <script>
      const wrapper = document.querySelector('.el-select__wrapper');
      const dropdown = document.querySelector('.el-select-dropdown');
      wrapper.addEventListener('click', () => {
        dropdown.style.display = 'block';
        if (!wrapper.querySelector('input')) {
          const input = document.createElement('input');
          input.setAttribute('role', 'combobox');
          wrapper.appendChild(input);
        }
      });
      for (const option of dropdown.children) {
        option.addEventListener('click', () => {
          wrapper.querySelector('.el-select__placeholder').textContent = option.textContent;
          wrapper.querySelector('.el-select__placeholder').classList.remove('is-transparent');
          wrapper.querySelector('input').value = '';
          dropdown.style.display = 'none';
        });
      }
    </script>
  `);
  const carrierDialog = page.locator('.logistics-dialog');
  const autofilled = {
    orderNumber: 'SO-EXACT-SHIPMENT',
    trackingNumber: 'TRACKING-1',
    carrier: '优先自动带入，无匹配时请手动搜索选择',
  };
  const expectedLogistics = { trackingNumber: 'TRACKING-1', carrier: '邮政快递包裹' };
  assert.equal(await selectTmsExactCarrierWhenAutofillIsEmpty(
    page, carrierDialog, '260817-000000000000001', expectedLogistics,
    { ...autofilled, trackingNumber: 'OTHER' },
  ), null, 'a different tracking number must block carrier selection');
  assert.equal(await selectTmsExactCarrierWhenAutofillIsEmpty(
    page, carrierDialog, '260817-000000000000001', expectedLogistics,
    { ...autofilled, carrier: '中通快递' },
  ), null, 'a different existing carrier must remain a manual-review conflict');
  const carrierSelection = await selectTmsExactCarrierWhenAutofillIsEmpty(
    page, carrierDialog, '260817-000000000000001', expectedLogistics, autofilled,
  );
  assert.equal(carrierSelection.status, 'selected');
  assert.equal(carrierSelection.selectedCarrier, '邮政快递包裹');
  assert.deepEqual(actions.slice(-3), [
    'open-tms-exact-carrier-search', 'search-tms-exact-carrier', 'select-tms-exact-carrier',
  ]);

  await page.setContent(`
    <div class="logistics-dialog"><div class="el-form-item"><label>责任快递</label>
      <div class="el-select"><div class="el-select__wrapper">
        <span class="el-select__selected-item el-select__placeholder is-transparent">优先自动带入，无匹配时请手动搜索选择</span>
      </div></div>
    </div></div>
    <div class="el-select-dropdown" style="display:none">
      <div class="el-select-dropdown__item">邮政快递包裹</div>
    </div>
    <script>
      (() => {
      const wrapper = document.querySelector('.el-select__wrapper');
      const dropdown = document.querySelector('.el-select-dropdown');
      wrapper.addEventListener('click', () => { dropdown.style.display = 'block'; });
      dropdown.firstElementChild.addEventListener('click', () => {
        wrapper.querySelector('.el-select__placeholder').textContent = '邮政快递包裹';
        wrapper.querySelector('.el-select__placeholder').classList.remove('is-transparent');
        dropdown.style.display = 'none';
      });
      })();
    </script>
  `);
  const unsearchableSelection = await selectTmsExactCarrierWhenAutofillIsEmpty(
    page, page.locator('.logistics-dialog'), '260817-000000000000001',
    expectedLogistics, autofilled,
  );
  const dropdownState = await page.evaluate(() => ({
    display: document.querySelector('.el-select-dropdown')?.style.display,
    optionText: document.querySelector('.el-select-dropdown__item')?.textContent,
    optionVisible: Boolean(document.querySelector('.el-select-dropdown__item')?.getBoundingClientRect().height),
  }));
  assert.equal(unsearchableSelection.status, 'selected', JSON.stringify(dropdownState));
  assert.deepEqual(actions.slice(-2), [
    'open-tms-exact-carrier-search', 'select-tms-exact-carrier',
  ], 'an unsearchable dropdown may select only its unique exact option');

  const firstVisibleStart = workflowSource.indexOf('const firstVisible = async');
  const firstVisibleEnd = workflowSource.indexOf('\n\n// PDD', firstVisibleStart);
  const popupStart = workflowSource.indexOf('const closeUnexpectedTmsPopups = async');
  const popupEnd = workflowSource.indexOf('\n\nconst validatedSavedTmsToken = async', popupStart);
  assert(firstVisibleStart >= 0 && firstVisibleEnd > firstVisibleStart
    && popupStart >= 0 && popupEnd > popupStart,
  'TMS popup closer and visible-locator helper must be available for UI verification');
  vm.runInNewContext(
    `${workflowSource.slice(firstVisibleStart, firstVisibleEnd)}\n`
      + `${workflowSource.slice(popupStart, popupEnd)}\n`
      + 'globalThis.closeTmsPopups = closeUnexpectedTmsPopups;',
    sandbox,
    { filename: 'workflow-tms-popup-closer.mjs' },
  );
  await page.setContent(`
    <div role="dialog" aria-label="新建物流工单" class="el-overlay-dialog is-closing">
      <button type="button" class="el-dialog__headerbtn" aria-label="关闭此对话框"
        onclick="window.ticketCloseClicks++">关闭</button>
    </div>
    <div class="el-notification">
      <button type="button" class="el-notification__closeBtn"
        onclick="this.closest('.el-notification').remove()">提示关闭</button>
    </div>
    <script>window.ticketCloseClicks = 0;</script>
  `);
  assert.equal(await sandbox.closeTmsPopups(page), 1,
    'only the unrelated notification should be dismissed');
  assert.equal(await page.evaluate(() => window.ticketCloseClicks), 0,
    'popup cleanup must never close the logistics-ticket business dialog');
  assert.equal(await page.locator('[role="dialog"][aria-label="新建物流工单"]').count(), 1);
} finally {
  await browser.close();
}

console.log('TMS multi-order autofill UI self-test passed');
