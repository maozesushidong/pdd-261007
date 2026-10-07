import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectReturnRefundCandidates, readReturnRefundScanResumeProof,
  matchesReturnRefundScanResumeProof, returnRefundListDetailActions,
  findMatchingReturnRefundDetailAction } from '../packages/adapters/src/pdd/return-refund.mjs';

const orders = ['260929-111111111111111', '260929-222222222222222'];
const aftersales = ['23111111111111', '23222222222222'];
const toolbar = '<button>售后工作台</button><button>待商家处理</button><button>退货退款</button>';
const business = '<button aria-current="page">1</button>' + orders.map((order, i) =>
  `<article>订单号 ${order} 售后编号 ${aftersales[i]} 待处理
    <button id="refund-${i}" onclick="window.businessClicks=(window.businessClicks||0)+1">查看详情</button></article>`).join('');
const message = `<section class="ImportantList_msgbox-content__example"><div>
  <div class="MsgItem_item-msg-title__admWw">退货签收提醒 17:42</div>
  <div class="MsgItem_item-content__RvQqp">订单${orders[0]}消费者的退货物流显示已被签收</div>
  <button id="message-detail" onclick="window.messageClicks=(window.messageClicks||0)+1">查看详情</button>
</div></section>`;
const completedRefunds = orders.map((orderNumber, i) => ({ orderNumber, aftersaleNumber: aftersales[i] }));
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
try {
  const page = await browser.newPage();
  let navigations = 0;
  await page.route('https://mms.pinduoduo.com/**', (route) => {
    navigations += 1;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: toolbar + business });
  });
  await page.goto('https://mms.pinduoduo.com/aftersales/aftersale_list');
  const cursor = { page: 1, itemOffset: 0 };
  const proof = await readReturnRefundScanResumeProof(page, cursor);
  assert.equal(proof.rowCount, 2);
  await page.locator('body').evaluate((body, html) => body.insertAdjacentHTML('afterbegin', html), message);
  assert.equal(await page.getByText('查看详情', { exact: true }).count(), 3);
  assert.equal(await returnRefundListDetailActions(page).count(), 2);
  const withMessage = await readReturnRefundScanResumeProof(page, cursor);
  assert.equal(withMessage.excludedMessageActionCount, 1);
  assert(matchesReturnRefundScanResumeProof(proof, withMessage, cursor),
    'a new platform message must not invalidate the unchanged actual refund rows');
  const matched = await findMatchingReturnRefundDetailAction(page, { orderNumber: orders[0] });
  assert.equal(await matched.getAttribute('id'), 'refund-0',
    'recovery must select the actual refund row even when a notification names the same order');
  const steps = [];
  const scan = await collectReturnRefundCandidates(page, page.context(), {
    scanCursor: cursor, resumeProof: proof, maxItems: 2, maxDurationMs: 5_000,
    delayMs: 0, renderWaitMs: 100, completedRefunds,
    onStep: (stage) => { steps.push(stage); },
  });
  assert.equal(scan.scan.examined, 2);
  assert.equal(scan.scan.listResponseDiagnostics.rowsSkippedKnownCompleted, 2);
  assert.equal(await page.evaluate(() => window.messageClicks || 0), 0);
  assert.equal(await page.evaluate(() => window.businessClicks || 0), 0);
  assert.equal(navigations, 1, 'notification changes must not cause a workbench reload');
  assert(steps.includes('return-refund-resume-verified'));

  await page.locator('[class*="MsgItem_item-content"]').evaluate((node) => {
    node.textContent = '订单260929-999999999999999 运费申诉审核通过 17:48';
  });
  assert(matchesReturnRefundScanResumeProof(proof,
    await readReturnRefundScanResumeProof(page, cursor), cursor));
  await page.locator('article').first().evaluate((node) => {
    node.firstChild.textContent += ' 退款成功';
  });
  assert.equal(matchesReturnRefundScanResumeProof(proof,
    await readReturnRefundScanResumeProof(page, cursor), cursor), false,
  'a real refund row change must still reject the proof');

  await page.setContent(toolbar + message + business);
  const oldProof = { ...await readReturnRefundScanResumeProof(page, { page: 1, itemOffset: 1 }) };
  delete oldProof.actionScope;
  assert.equal(matchesReturnRefundScanResumeProof(oldProof,
    await readReturnRefundScanResumeProof(page, { page: 1, itemOffset: 1 }), { page: 1, itemOffset: 1 }), false);
  const upgraded = await collectReturnRefundCandidates(page, page.context(), {
    scanCursor: { page: 1, itemOffset: 1 }, resumeProof: oldProof,
    maxItems: 2, maxDurationMs: 5_000, delayMs: 0, renderWaitMs: 100, completedRefunds,
  });
  assert.equal(upgraded.scan.resumeCheck.cursorScopeReset, true);
  assert.deepEqual(upgraded.scan.startCursor, cursor);
  assert.equal(upgraded.scan.listResponseDiagnostics.rowsSkippedKnownCompleted, 2,
    'a legacy offset including a message must not skip the first real refund');

  await page.setContent(toolbar + message + '<div>暂无待处理</div>');
  const empty = await collectReturnRefundCandidates(page, page.context(), {
    maxItems: 1, maxDurationMs: 5_000, delayMs: 0, renderWaitMs: 100,
  });
  assert.equal(empty.scan.examined, 0);
  assert.equal(await page.evaluate(() => window.messageClicks || 0), 0,
    'an empty refund list must not scan a message notification');
  console.log('Refund list message scope self-test passed (notification changes, recovery, empty list, cursor upgrade)');
} finally {
  await browser.close();
}
