import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
const omsRowLookupSource = sourceBetween(
  'const normalizeOmsOrderStatus = (value) => {',
  '\n\nconst waitForFirstVisible = async',
);
const omsRowReadersSource = sourceBetween(
  'const readOmsOrderStatus = async (targetPage, rowScope) => {',
  '\n\nconst analyzeOmsOrderUnlocked = async',
);

const sandbox = { console, Date, Error, JSON, RegExp, setTimeout, clearTimeout };
vm.runInNewContext(
  `${firstVisibleSource}\n`
  + `const lowValuePattern = /低值(?:品|商品|货品)?|低价(?:品|商品|货品)?/;\n`
  + `const reissuePattern = /补发(?:单|订单|货)?|补单|补寄|重发|(?:^|\\s)补(?:\\s|$)/;\n`
  + `${omsRowLookupSource}\n${omsRowReadersSource}\n`
  + 'globalThis.__functions = { findVisibleOmsOrderRow, readOmsOrderStatus, readOmsOrderMark, findOmsSalesOrderCodeCell };',
  sandbox,
  { filename: 'workflow-oms-order-mark-functions.mjs' },
);

const { findVisibleOmsOrderRow, readOmsOrderStatus, readOmsOrderMark,
  findOmsSalesOrderCodeCell } = sandbox.__functions;
const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  process.env.WORKFLOW_BROWSER_EXECUTABLE_PATH,
  'D:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage();

const loadVirtualGrid = async ({ markText = '', hideInitialMark = false } = {}) => {
  await page.setContent(`
    <style>
      .ag-center-cols-viewport { width: 280px; overflow-x: auto; }
      .scroll-spacer { width: 1200px; height: 2px; }
      .ag-header-cell, .ag-cell { display: inline-block; min-width: 160px; padding: 4px; }
      .ag-row { display: block; }
    </style>
    <div class="ag-center-cols-viewport" id="viewport"><div class="scroll-spacer"></div></div>
    <div id="headers"></div>
    <div id="rows"></div>
    <script>
      (() => {
      window.__markText = ${JSON.stringify(markText)};
      window.__hideInitialMark = ${JSON.stringify(hideInitialMark)};
      window.__dropMarkAfterStatus = false;
      window.__visitedStatus = false;
      const viewport = document.getElementById('viewport');
      const headers = document.getElementById('headers');
      const rows = document.getElementById('rows');
      const render = () => {
        const statusSide = viewport.scrollLeft > 100;
        if (statusSide) window.__visitedStatus = true;
        if (statusSide) {
          headers.innerHTML = '<div class="ag-header-cell" col-id="orderStatus">订单状态</div>';
          rows.innerHTML = '<div class="ag-row" role="row" row-id="0" row-index="0">'
            + '<div class="ag-cell" role="gridcell" col-id="orderStatus">已配货</div></div>';
          return;
        }
        const hideMark = window.__hideInitialMark
          || (window.__dropMarkAfterStatus && window.__visitedStatus);
        headers.innerHTML = '<div class="ag-header-cell" col-id="salesOrderCode">订单号</div>'
          + (hideMark ? '' : '<div class="ag-header-cell" col-id="tags">标记</div>');
        rows.innerHTML = '<div class="ag-row" role="row" row-id="0" row-index="0">'
          + '<div class="ag-cell" role="gridcell" col-id="salesOrderCode">260825-153343782483244</div>'
          + (hideMark ? '' : '<div class="ag-cell" role="gridcell" col-id="tags">'
            + window.__markText + '</div>')
          + '</div>';
      };
      viewport.addEventListener('scroll', render);
      render();
      })();
    </script>
  `);
};

const readGridCells = async (rowScope) => rowScope.locator('.ag-cell').evaluateAll((cells) => (
  cells.map((cell) => ({ colId: cell.getAttribute('col-id'), text: (cell.innerText || '').trim() }))
));

const analyzeCase = async (markText) => {
  await loadVirtualGrid({ markText });
  const original = await findVisibleOmsOrderRow(page, '260825-153343782483244', {
    timeoutMs: 1000,
    pollIntervalMs: 25,
  });
  assert.ok(original, 'initial OMS order row should be visible');
  const renderedCells = await readGridCells(original.rowScope);
  const orderStatus = await readOmsOrderStatus(page, original.rowScope);
  assert.equal(orderStatus, '已配货');
  assert.equal(await page.locator('#viewport').evaluate((element) => element.scrollLeft), 0,
    'order-status lookup must restore the original horizontal scroll position');
  return readOmsOrderMark(
    page,
    '260825-153343782483244',
    original.orderCell,
    original.rowScope,
    renderedCells,
  );
};

let analysis = await analyzeCase('新\n拆单可发');
assert.equal(analysis.markText.replace(/\s+/g, ' '), '新 拆单可发');
assert.equal(analysis.isLowValue, false);
assert.equal(analysis.isReissueOrder, false);

analysis = await analyzeCase('低值品');
assert.equal(analysis.isLowValue, true);
assert.equal(analysis.isReissueOrder, false);

analysis = await analyzeCase('补发单');
assert.equal(analysis.isLowValue, false);
assert.equal(analysis.isReissueOrder, true);

await loadVirtualGrid({ markText: '新\n拆单可发' });
let original = await findVisibleOmsOrderRow(page, '260825-153343782483244', {
  timeoutMs: 1000,
  pollIntervalMs: 25,
});
const capturedCells = await readGridCells(original.rowScope);
await page.evaluate(() => { window.__dropMarkAfterStatus = true; });
assert.equal(await readOmsOrderStatus(page, original.rowScope), '已配货');
analysis = await readOmsOrderMark(
  page,
  '260825-153343782483244',
  original.orderCell,
  original.rowScope,
  capturedCells,
);
assert.equal(analysis.source, 'captured-row-dom');
assert.equal(analysis.isLowValue, false);
assert.equal(analysis.isReissueOrder, false);

await loadVirtualGrid({ markText: '低值品' });
original = await findVisibleOmsOrderRow(page, '260825-153343782483244', {
  timeoutMs: 1000,
  pollIntervalMs: 25,
});
const capturedBeforeEmptyMark = await readGridCells(original.rowScope);
await page.evaluate(() => {
  window.__markText = '';
  document.getElementById('viewport').dispatchEvent(new Event('scroll'));
});
analysis = await readOmsOrderMark(page, '260825-153343782483244',
  original.orderCell, original.rowScope, capturedBeforeEmptyMark);
assert.equal(analysis.source, 'captured-row-dom');
assert.equal(analysis.isLowValue, true,
  'a temporarily empty mark cell must retain the exact order row capture');

await page.setContent('<div class="ag-row" role="row"><div class="ag-cell" col-id="tradeId">'
  + '260825-153343782483244</div></div><button>SO282286058392577</button>');
const capturedSalesCodeCells = [
  { colId: 'tradeId', text: '260825-153343782483244' },
  { colId: 'salesOrderCode', text: 'SO282286058392577' },
];
const salesCodeCell = await findOmsSalesOrderCodeCell(page, page.locator('.ag-row'),
  capturedSalesCodeCells, '260825-153343782483244');
assert.equal(await salesCodeCell?.innerText(), 'SO282286058392577',
  'the captured exact-row sales code should locate its redrawn pinned cell');
assert.equal(await findOmsSalesOrderCodeCell(page, page.locator('.ag-row'),
  capturedSalesCodeCells, '260825-000000000000000'), null,
  'a sales code captured for another order must not be reused');

await loadVirtualGrid({ hideInitialMark: true });
original = await findVisibleOmsOrderRow(page, '260825-153343782483244', {
  timeoutMs: 1000,
  pollIntervalMs: 25,
});
assert.equal(await readOmsOrderStatus(page, original.rowScope), '已配货');
await assert.rejects(
  readOmsOrderMark(
    page,
    '260825-153343782483244',
    original.orderCell,
    original.rowScope,
    [],
  ),
  /OMS 当前订单行未找到“标记”单元格/u,
);

await browser.close();
console.log('OMS order mark UI self-test passed');
