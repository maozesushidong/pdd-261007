import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';

const source = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const findTmsFilterPanel = async');
const end = source.indexOf('const readTmsRowIdentity = async', start);
assert(start >= 0 && end > start);
const filterSource = source.slice(start, end);
const order = '260929-111111111111111';
const base = 'http://tms.test';
const html = `<div class="filter-panel"><div class="el-form-item">交易号<input>
  <button onclick="fetch('/api/logistics/tickets?tradeId='+document.querySelector('input').value)">应用</button>
  </div></div><div class="table-container"><div class="el-table__body-wrapper">
  <table><tbody><tr><td>${order}</td></tr></tbody></table></div></div>`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
let fixtureCount = 0;
try {
  const run = async (statuses, { recoveryFailure = false, ignoredOpenClicks = null,
    panelDelayMs = 0, panelAppearsBeforeClick = false, recoveryPasses = 2 } = {}) => {
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    const metrics = { queries: 0, navigations: 0, registrations: 0, pauses: [], progress: [], actions: [] };
    await page.route('**/*', async (route) => {
      assert.equal(route.request().method(), 'GET', 'filter recovery must never submit a business action');
      if (route.request().url().includes('/api/logistics/tickets')) {
        assert.equal(new URL(route.request().url()).searchParams.get('tradeId'), order);
        const status = statuses[Math.min(metrics.queries++, statuses.length - 1)];
        return route.fulfill({ status, contentType: 'application/json', body: '{}' });
      }
      assert.equal(route.request().url(), `${base}/logistics`);
      const body = ignoredOpenClicks === null ? html
        : `<div class="toolbar"><button onclick="window.openClicks=(window.openClicks||0)+1;
          if(window.openClicks>${ignoredOpenClicks})setTimeout(()=>{
            const p=document.querySelector('.filter-panel');
            p.style.display=p.style.display==='none'?'block':'none';
          },${panelDelayMs})">筛选</button></div>`
          + html.replace('class="filter-panel"', 'class="filter-panel" style="display:none"');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    await page.goto(`${base}/logistics`);
    const sandbox = { Date, Error, URL, context: browserContext,
      tmsLogisticsUrl: `${base}/logistics`,
      firstVisible: async (locators) => {
        for (const locator of locators) {
          if (await locator.first().isVisible().catch(() => false)) return locator.first();
        }
        return null;
      },
      tmsFormItem: (scope, label) => scope.locator('.el-form-item').filter({ hasText: label }).first(),
      pacedAction: async (_page, action, operation) => {
        metrics.actions.push(action);
        if (panelAppearsBeforeClick && action === 'expand-tms-filter') {
          await page.locator('.filter-panel').evaluate((element) => { element.style.display = 'block'; });
        }
        return operation();
      },
      writeProgress: (patch) => metrics.progress.push(patch),
      navigateSystemPage: async (target, url) => { metrics.navigations++; await target.goto(url); },
      openTmsCustomerRegistration: async (target, context) => {
        assert.equal(target, page); assert.equal(context, browserContext);
        metrics.registrations++;
        if (recoveryFailure) throw Object.assign(new Error('manual verification required'), { code: 'HUMAN_VERIFICATION' });
      },
      closeUnexpectedTmsPopups: async () => {},
      pauseForTransientRetry: async (...args) => {
        metrics.pauses.push({ code: args[2], retryAfterMs: args[5], patch: args[4] });
        throw Object.assign(new Error(args[3]), { code: args[2] });
      },
    };
    vm.runInNewContext(`${filterSource}\nglobalThis.run = filterTmsTicketsByOrder;`, sandbox);
    let result, error;
    try { result = await sandbox.run(page, order, { browserContext, recoveryPasses }); } catch (caught) { error = caught; }
    metrics.openClicks = await page.evaluate(() => window.openClicks || 0);
    await browserContext.close();
    fixtureCount++;
    return { ...metrics, count: result?.count, error };
  };

  const normal = await run([200]);
  assert.equal(normal.count, 1); assert.equal(normal.queries, 1); assert.equal(normal.navigations, 0);
  const recovered = await run([401, 200]);
  assert.equal(recovered.count, 1); assert.equal(recovered.queries, 2);
  assert.equal(recovered.navigations, 1); assert.equal(recovered.registrations, 1);
  assert.equal(recovered.progress.at(-1).tmsTicketFilterRecovery.status, 'succeeded');
  assert(recovered.actions.every(action => ['fill-tms-ticket-filter', 'apply-tms-ticket-filter'].includes(action)));
  const repeated = await run([401, 401]);
  assert.equal(repeated.count, undefined, 'stale visible rows must not become a successful query');
  assert.equal(repeated.queries, 2); assert.equal(repeated.navigations, 1);
  assert.equal(repeated.error.code, 'TMS_TICKET_FILTER_TEMPORARILY_UNAVAILABLE');
  assert.equal(repeated.pauses[0].retryAfterMs, 300000);
  assert.equal(repeated.pauses[0].patch.tmsTicketFilterRecovery.readOnly, true);
  for (const status of [403, 422, 503]) {
    const terminal = await run([status]);
    assert.match(terminal.error.message, new RegExp(`HTTP ${status}$`));
    assert.equal(terminal.queries, 1); assert.equal(terminal.navigations, 0);
    assert.equal(terminal.pauses.length, 0);
  }
  const human = await run([401, 200], { recoveryFailure: true });
  assert.equal(human.error.code, 'HUMAN_VERIFICATION'); assert.equal(human.queries, 1);
  assert.equal(human.pauses.length, 0);
  const changedFailure = await run([401, 403]);
  assert.match(changedFailure.error.message, /HTTP 403$/u);
  assert.equal(changedFailure.queries, 2); assert.equal(changedFailure.navigations, 1);
  assert.equal(changedFailure.pauses.length, 0);

  const ignored = await run([200], { ignoredOpenClicks: 1 });
  assert.equal(ignored.count, 1); assert.equal(ignored.openClicks, 2);
  assert.equal(ignored.queries, 1); assert.equal(ignored.navigations, 0,
    'one ignored read-only toggle should recover without reloading the route');
  const delayed = await run([200], { ignoredOpenClicks: 0, panelDelayMs: 1500 });
  assert.equal(delayed.count, 1); assert.equal(delayed.openClicks, 1,
    'a slowly rendered filter must not be toggled shut by another click');
  const appeared = await run([200], { ignoredOpenClicks: 0, panelAppearsBeforeClick: true });
  assert.equal(appeared.count, 1); assert.equal(appeared.openClicks, 0,
    'a panel that appears during pacing must be rechecked before the actual click');
  const unavailable = await run([200], { ignoredOpenClicks: Infinity, recoveryPasses: 0 });
  assert.match(unavailable.error.message, /筛选面板在有界恢复后仍未渲染/u);
  assert.equal(unavailable.openClicks, 2); assert.equal(unavailable.queries, 0);
  assert.equal(unavailable.count, undefined); assert.equal(unavailable.navigations, 0);
} finally { await browser.close(); }
console.log(`TMS filter authorization UI self-test passed (${fixtureCount} fixtures)`);
