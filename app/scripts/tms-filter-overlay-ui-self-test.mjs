import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { chromium } from 'playwright';

const workflowSource = fs.readFileSync(
  process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs', import.meta.url), 'utf8',
).replace(/\r\n/gu, '\n');
const start = workflowSource.indexOf('const findTmsFilterPanel = async');
const end = workflowSource.indexOf('\nconst readTmsRowIdentity = async', start);
assert(start >= 0 && end > start);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_CHROME_PATH ? { executablePath: process.env.TEST_CHROME_PATH } : {}),
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(1500);
  const orderNumber = '260913-402160423253909';
  await page.route('https://tms.aipro123.top/**', (route) => {
    if (route.request().url().includes('/api/logistics/tickets')) {
      return route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><meta charset="utf-8"><style>
        .el-overlay { position: fixed; inset: 0; z-index: 20; background: #ddd; }
        .el-drawer { height: 100%; }
        .filter-panel { position: relative; width: 400px; }
      </style>
      <div class="filter-panel"><label>交易号<input oninput="clearTimeout(window.filterTimer); window.filterTimer=setTimeout(() => { window.filterModel=this.value; }, 650)"></label>
        <button onclick="fetch('/api/logistics/tickets?' + (window.badQuery ? 'order=' : 'tradeId=') + window.filterModel)">应用</button>
      </div>
      <div class="el-overlay is-drawer"><div class="el-drawer">
        <button class="el-drawer__close-btn" onclick="this.closest('.el-overlay').remove()">关闭</button>
      </div></div>
      <div class="table-container"><div class="el-table__body-wrapper"><table><tbody>
        <tr><td>${orderNumber}</td></tr>
      </tbody></table></div></div>`,
    });
  });
  await page.goto('https://tms.aipro123.top/logistics');
  const firstVisible = async (candidates) => {
    for (const candidate of candidates) {
      if (await candidate.count().catch(() => 0)
        && await candidate.first().isVisible().catch(() => false)) return candidate.first();
    }
    return null;
  };
  const sandbox = {
    console,
    URL,
    context: null,
    tmsLogisticsUrl: 'https://tms.aipro123.top/logistics',
    firstVisible,
    tmsFormItem: (panel) => panel,
    pacedAction: async (_page, _stage, action) => action(),
    writeProgress: () => {},
    pauseForTransientRetry: async (_page, stage, code, reason, _patch, retryAfterMs) => {
      const error = new Error(`${code}: ${reason}`);
      Object.assign(error, { stage, code, retryAfterMs });
      throw error;
    },
    navigateSystemPage: async () => {},
    openTmsCustomerRegistration: async () => {},
    closeUnexpectedTmsPopups: async () => {},
    HumanVerificationRequiredError: class extends Error {},
    PddLoginRequiredError: class extends Error {},
    RateLimitPauseError: class extends Error {},
    ManualReviewRequiredError: class extends Error {},
    LogisticsRetryRequiredError: class extends Error {},
  };
  vm.runInNewContext(`${workflowSource.slice(start, end)}\n`
    + 'globalThis.filterTmsTicketsByOrderForTest = filterTmsTicketsByOrder;', sandbox);
  const result = await sandbox.filterTmsTicketsByOrderForTest(page, orderNumber);
  assert.equal(result.count, 1);
  assert.equal(await page.locator('.el-overlay.is-drawer').count(), 0);
  assert.equal(await page.locator('.filter-panel input').inputValue(), orderNumber);
  await page.evaluate(() => { window.badQuery = true; });
  await assert.rejects(
    sandbox.filterTmsTicketsByOrderForTest(page, orderNumber),
    /TMS 交易号筛选请求未携带目标交易号/u,
    'an unfiltered response must not be treated as proof that the created ticket is missing',
  );
  await page.evaluate(() => { window.badQuery = false; });
  page.waitForResponse = async () => null;
  await assert.rejects(
    sandbox.filterTmsTicketsByOrderForTest(page, orderNumber),
    (error) => error.code === 'TMS_TICKET_FILTER_TEMPORARILY_UNAVAILABLE'
      && error.stage === 'tms-ticket-filter-response'
      && error.retryAfterMs === 5 * 60_000,
    'a missing read-only filter response must enter the bounded delayed retry path',
  );
  console.log('TMS filter overlay regression passed (visible panel behind unrelated drawer, safe close, exact read-only filter)');
} finally {
  await browser.close();
}
