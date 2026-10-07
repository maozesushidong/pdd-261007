import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectReturnRefundCandidates, readReturnRefundScanResumeProof } from '../packages/adapters/src/pdd/return-refund.mjs';

const orders = ['260929-111111111111111', '260929-222222222222222', '260929-333333333333333'];
const ids = ['23111111111111', '23222222222222', '23333333333333'];
const url = 'https://mms.pinduoduo.com/aftersales/aftersale_list';
const rows = orders.map((orderSn, i) => ({ orderSn, id: ids[i] }));
const future = orders.map((orderNumber, i) => ({ orderNumber, aftersaleNumber: ids[i],
  nextCheckAt: new Date(Date.now() + 86400000).toISOString() }));
const html = '<button>售后工作台</button><button>待商家处理</button><button>退货退款</button>'
  + '<button aria-current="page">1</button>' + orders.map((order, index) => `<article>订单号 ${order} 待处理
    申请时间: 2026-09-29 07:00:00 （<span class="timer">6天2时3分30秒</span>${index === 1 ? '物流无退回轨迹' : '未处理'}，系统将自动退款）
    <button onclick="window.detailClicks=(window.detailClicks||0)+1">查看详情</button></article>`).join('');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
let fixtureCount = 0;
try {
  const fixture = async () => {
    const context = await browser.newContext();
    const page = await context.newPage(); let requests = 0; let responseRows = rows;
    await page.route('**/*', (route) => {
      if (route.request().url().includes('/queryList')) {
        requests += 1; return route.fulfill({ contentType: 'application/json',
          body: JSON.stringify({ data: { list: responseRows } }) });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    await page.goto(url);
    const fetchList = () => page.evaluate(async () => {
      await (await fetch('/mercury/mms/afterSales/queryList', { method: 'POST', body: '{}' })).text();
    });
    const options = { maxItems: 1, maxDurationMs: 5000, delayMs: 0, renderWaitMs: 100, deferredRefunds: future };
    const first = await collectReturnRefundCandidates(page, page.context(), {
      ...options, scanCursor: { page: 1, itemOffset: 0 },
      resumeProof: await readReturnRefundScanResumeProof(page, { page: 1, itemOffset: 0 }),
      onStep: async (stage) => { if (stage === 'return-refund-list-page-ready') await fetchList(); },
    });
    assert.equal(first.scan.listResponseDiagnostics.rowsSkippedKnownWait, 1);
    fixtureCount += 1;
    return { page, first, options, fetchList, requests: () => requests,
      setRows: (value) => { responseRows = value; } };
  };
  const next = (f, extra = {}, page = f.page) => collectReturnRefundCandidates(page, page.context(), {
    ...f.options, scanCursor: f.first.scan.nextCursor, resumeProof: f.first.scan.resumeProof,
    onVerification: (_page, stage) => {
      if (stage === 'return-refund-open-detail-before') throw new Error('DETAIL_INSPECTION_REQUIRED');
    },
    ...extra,
  });
  const valid = await fixture();
  valid.first.scan.resumeProof.capturedAt = new Date(Date.now() - 3000).toISOString();
  await valid.page.locator('.timer').evaluateAll((elements) => elements.forEach((node) => { node.textContent = '6天2时3分27秒'; }));
  const resumed = await next(valid);
  assert.equal(resumed.scan.resumeCheck.sameRowsExceptCountdown, true);
  assert.equal(resumed.scan.listResponseDiagnostics.pagesWithReusedListResponse, 1);
  assert.equal(resumed.scan.listResponseDiagnostics.pathResponses, 0);
  assert.equal(resumed.scan.listResponseDiagnostics.rowsSkippedKnownWait, 1);
  assert.equal(valid.requests(), 1, 'reuse must not issue another list request');
  assert.equal(await valid.page.evaluate(() => window.detailClicks || 0), 0);
  for (const privateValue of [...orders, ...ids]) assert(!JSON.stringify(resumed).includes(privateValue));

  const reloaded = await fixture();
  await reloaded.page.reload();
  await assert.rejects(next(reloaded), /DETAIL_INSPECTION_REQUIRED/u);
  const other = await fixture();
  const otherPage = await other.page.context().newPage();
  await otherPage.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await otherPage.goto(url);
  await assert.rejects(next(other, {}, otherPage), /DETAIL_INSPECTION_REQUIRED/u);
  const changed = await fixture();
  await changed.page.locator('article').nth(1).evaluate((node) => { node.firstChild.textContent += ' 状态改变'; });
  await assert.rejects(next(changed), /DETAIL_INSPECTION_REQUIRED/u);
  const conflict = await fixture();
  conflict.setRows(rows.map((row) => ({ ...row, id: '23999999999999' })));
  await assert.rejects(next(conflict, { onStep: async (stage) => {
    if (stage === 'return-refund-list-page-ready') await conflict.fetchList();
    if (stage === 'return-refund-open-detail') throw new Error('DETAIL_INSPECTION_REQUIRED');
  } }), /DETAIL_INSPECTION_REQUIRED/u);
  const invalidResponse = await fixture();
  invalidResponse.setRows([]);
  await assert.rejects(next(invalidResponse, { onStep: async (stage) => {
    if (stage === 'return-refund-list-page-ready') await invalidResponse.fetchList();
  } }), /DETAIL_INSPECTION_REQUIRED/u);
  const cloned = await fixture();
  await assert.rejects(next(cloned, { resumeProof: structuredClone(cloned.first.scan.resumeProof) }), /DETAIL_INSPECTION_REQUIRED/u);
  const expired = await fixture();
  const now = Date.now;
  try {
    Date.now = () => now() + 76 * 60000;
    expired.first.scan.resumeProof.capturedAt = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(next(expired), /DETAIL_INSPECTION_REQUIRED/u);
  } finally { Date.now = now; }
  console.log(`Refund response reuse passed (${fixtureCount} isolated browser fixtures: no repeated detail/request, countdown, navigation, other page, changed rows, fresh conflict, proof identity, expiry, privacy)`);
} finally { await browser.close(); }
