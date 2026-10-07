import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { summarizeReturnRefundScanRows, readReturnRefundScanResumeProof,
  matchesReturnRefundScanResumeProof } from '../packages/adapters/src/pdd/return-refund.mjs';

const original = ['订单号 260929-111111111111111 待商家处理 剩余 1天2小时3分4秒 查看详情',
  '订单号 260929-222222222222222 买家已发货 12:34:56 查看详情'];
const timerChanged = [original[0].replace('1天2小时3分4秒', '1天2小时2分4秒'),
  original[1].replace('12:34:56', '12:35:56')];
const before = summarizeReturnRefundScanRows(original);
const timer = summarizeReturnRefundScanRows(timerChanged);
assert.deepEqual(before.rowOrderCounts, [1, 1]);
assert.deepEqual(before.timeTokenCounts, { clock: 1, duration: 1 });
assert.equal(before.rowsWithoutTimeTokensSha256, timer.rowsWithoutTimeTokensSha256);
assert.equal(before.orderSequenceSha256, timer.orderSequenceSha256);
const changedStatus = summarizeReturnRefundScanRows([
  timerChanged[0].replace('待商家处理', '退款成功'), timerChanged[1],
]);
assert.notEqual(before.rowsWithoutTimeTokensSha256, changedStatus.rowsWithoutTimeTokensSha256);
const reordered = summarizeReturnRefundScanRows([...original].reverse());
assert.notEqual(before.orderSequenceSha256, reordered.orderSequenceSha256);
const broadAncestor = summarizeReturnRefundScanRows([original.join(' ')]);
assert.deepEqual(broadAncestor.rowOrderCounts, [2]);
assert(!JSON.stringify(before).includes('260929-111111111111111'),
  'diagnostics must not persist raw order IDs or row contents');

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
try {
  const page = await browser.newPage();
  await page.route('https://mms.pinduoduo.com/**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<html><body></body></html>',
  }));
  await page.goto('https://mms.pinduoduo.com/aftersales/aftersale_list');
  const render = (rows) => page.setContent('<button aria-current="page">12</button>'
    + rows.map((row) => `<article>${row.replace('查看详情', '<button>查看详情</button>')}</article>`).join(''));
  const cursor = { page: 12, itemOffset: 1 };
  await render(original);
  const proof = await readReturnRefundScanResumeProof(page, cursor);
  assert(matchesReturnRefundScanResumeProof(proof,
    await readReturnRefundScanResumeProof(page, cursor), cursor));
  await render(timerChanged);
  const changed = await readReturnRefundScanResumeProof(page, cursor);
  assert.equal(proof.rowTextDiagnostics.rowsWithoutTimeTokensSha256,
    changed.rowTextDiagnostics.rowsWithoutTimeTokensSha256);
  assert.notEqual(proof.rowsSha256, changed.rowsSha256);
  assert.equal(matchesReturnRefundScanResumeProof(proof, changed, cursor), false,
    'even a timer-only diagnostic match must not relax the actual resume check');
  await render([original[0].replace('待商家处理', '退款成功'), original[1]]);
  const statusProof = await readReturnRefundScanResumeProof(page, cursor);
  assert.notEqual(proof.rowTextDiagnostics.rowsWithoutTimeTokensSha256,
    statusProof.rowTextDiagnostics.rowsWithoutTimeTokensSha256);
  assert.equal(matchesReturnRefundScanResumeProof(proof, statusProof, cursor), false);
  await render([...original].reverse());
  const reorderedProof = await readReturnRefundScanResumeProof(page, cursor);
  assert.notEqual(proof.rowTextDiagnostics.orderSequenceSha256,
    reorderedProof.rowTextDiagnostics.orderSequenceSha256);
  assert.equal(matchesReturnRefundScanResumeProof(proof, reorderedProof, cursor), false);
  await render(original);
  const legacy = { ...proof };
  delete legacy.rowTextDiagnostics;
  assert(matchesReturnRefundScanResumeProof(legacy,
    await readReturnRefundScanResumeProof(page, cursor), cursor),
  'old proofs continue to use the unchanged full-text check');
  console.log('Refund resume diagnostics self-test passed (hash privacy and 5 browser cases)');
} finally {
  await browser.close();
}
