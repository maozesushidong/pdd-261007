import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectReturnRefundCandidates, matchesReturnRefundScanResumeProof,
  readReturnRefundScanResumeProof, returnRefundCountdownProofForRows,
} from '../packages/adapters/src/pdd/return-refund.mjs';

const orders = ['260929-111111111111111', '260929-222222222222222'];
const aftersales = ['23111111111111', '23222222222222'];
const remaining = [597207, 401122];
const duration = (seconds) => `${Math.floor(seconds / 86400)}天${Math.floor(seconds % 86400 / 3600)}时`
  + `${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
const row = (index, seconds, overrides = {}) => `订单号 ${overrides.order || orders[index]} `
  + `售后编号 ${aftersales[index]} 申请时间: ${overrides.date || '2026-09-28 07:58:03'} `
  + `（${duration(seconds)}${overrides.countdownCondition || '未处理'}，${overrides.timeoutText || '系统将自动退款'}） `
  + `${overrides.status || '退货退款，待商家确认收货'} 实付: ¥${overrides.amount || '38.00'} `
  + `最新物流时间: ${overrides.logisticsTime || '2026-09-29 08:03:01'} `
  + `${overrides.extra || ''} 查看详情`;
const proof = returnRefundCountdownProofForRows(remaining.map((seconds, i) => row(i, seconds)));
assert.equal(proof.version, 1);
assert.deepEqual(proof.seconds, remaining);
for (const privateValue of [...orders, ...aftersales, '2026-09-28', '38.00']) {
  assert(!JSON.stringify(proof).includes(privateValue), 'proof must retain no raw business row text');
}
assert.equal(returnRefundCountdownProofForRows([row(0, 0)]), null);
assert.equal(returnRefundCountdownProofForRows([row(0, 300) + ' ' + row(1, 400)]), null);
assert.equal(returnRefundCountdownProofForRows([row(0, 300) + ' ' + row(0, 400)]), null);
assert.equal(returnRefundCountdownProofForRows([row(0, 300).replace('0时', '24时')]), null);
// Adjacent countdown spans can contribute whitespace to innerText. Only
// those separators may vary; the labelled date and automatic action remain.
const spacedCountdownRow = (seconds) => row(0, seconds)
  .replace('（', '（ ').replace(/(\d+)(天|时|分|秒)/gu, '$1 $2 ');
const spacedBefore = returnRefundCountdownProofForRows([spacedCountdownRow(remaining[0])]);
const spacedAfter = returnRefundCountdownProofForRows([spacedCountdownRow(remaining[0] - 300)]);
assert.deepEqual(spacedBefore.seconds, [remaining[0]]);
assert.deepEqual(spacedAfter.seconds, [remaining[0] - 300]);
assert.equal(spacedBefore.rowsSha256, spacedAfter.rowsSha256);
for (const [before, after] of [
  ['2026-09-28 07:58:03', '2026-09-28 07:58:04'],
  ['38.00', '39.00'], ['系统将自动退款', '系统将自动撤销'],
  ['天', '天之后'], ['时', '小时'],
]) {
  const changed = returnRefundCountdownProofForRows([spacedCountdownRow(remaining[0] - 300).replace(before, after)]);
  assert.notEqual(changed?.rowsSha256, spacedBefore.rowsSha256, `${before} is not countdown whitespace`);
}

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
try {
  const page = await browser.newPage();
  let navigations = 0;
  await page.route('**/*', (route) => {
    navigations += 1;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body></body>' });
  });
  await page.goto('https://mms.pinduoduo.com/aftersales/aftersale_list');
  const render = async (values = remaining, overrides = {}) => {
    await page.setContent('<button>售后工作台</button><button>待商家处理</button><button>退货退款</button>'
      + '<button aria-current="page">2</button>'
      + values.map((seconds, i) => `<article>${row(i, seconds, i === 0 ? overrides : {})
        .replace(' 查看详情', '')}<button onclick="window.detailClicks=(window.detailClicks||0)+1">查看详情</button></article>`).join(''));
  };
  const cursor = { page: 2, itemOffset: 1 };
  await render();
  let original = await readReturnRefundScanResumeProof(page, cursor);
  original.capturedAt = new Date(Date.now() - 300_000).toISOString();
  const elapsed = remaining.map((seconds) => seconds - 300);
  await render(elapsed);
  const observed = await readReturnRefundScanResumeProof(page, cursor);
  assert.notEqual(original.rowsSha256, observed.rowsSha256);
  assert(matchesReturnRefundScanResumeProof(original, observed, cursor));

  // Both countdown notices occur together in the real PDD list. The notice
  // itself remains business text: only its ticking duration may change.
  const logisticsNotice = { countdownCondition: '物流无退回轨迹' };
  await render(remaining, logisticsNotice);
  original = await readReturnRefundScanResumeProof(page, cursor);
  original.capturedAt = new Date(Date.now() - 300_000).toISOString();
  await render(elapsed, logisticsNotice);
  const mixedObserved = await readReturnRefundScanResumeProof(page, cursor);
  assert.deepEqual(original.countdownProof.seconds, remaining);
  assert.deepEqual(mixedObserved.countdownProof.seconds, elapsed);
  assert.equal(mixedObserved.countdownDiagnostics.matchedRows, 2);
  assert(matchesReturnRefundScanResumeProof(original, mixedObserved, cursor));

  const cases = [
    ['order', { order: '260929-999999999999999' }],
    ['status', { status: '退款成功' }],
    ['amount', { amount: '39.00' }],
    ['application date', { date: '2026-09-28 07:58:04' }],
    ['logistics time', { logisticsTime: '2026-09-29 08:03:02' }],
    ['automatic action', { timeoutText: '系统将自动撤销' }],
    ['notice changed to unhandled', { countdownCondition: '未处理' }],
    ['logistics condition changed', { countdownCondition: '物流已退回' }],
    ['unlabelled duration', { extra: '商品保修剩余 1天2时3分4秒' }],
  ];
  for (const [name, overrides] of cases) {
    await render(elapsed, { ...logisticsNotice, ...overrides });
    assert.equal(matchesReturnRefundScanResumeProof(original,
      await readReturnRefundScanResumeProof(page, cursor), cursor), false, name);
  }
  for (const [name, values] of [
    ['deadline increased', remaining.map((seconds) => seconds + 1)],
    ['deadline moved', remaining.map((seconds) => seconds - 3000)],
    ['expired countdown', [0, elapsed[1]]],
    ['row removed', [elapsed[0]]],
  ]) {
    await render(values, logisticsNotice);
    assert.equal(matchesReturnRefundScanResumeProof(original,
      await readReturnRefundScanResumeProof(page, cursor), cursor), false, name);
  }
  await render(elapsed, logisticsNotice);
  const current = await readReturnRefundScanResumeProof(page, cursor);
  assert.equal(matchesReturnRefundScanResumeProof({ ...original, countdownProof: null }, current, cursor), false);
  assert.equal(matchesReturnRefundScanResumeProof(original, { ...current, page: 3 }, cursor), false);
  assert.equal(matchesReturnRefundScanResumeProof(original, { ...current, urlSha256: 'changed' }, cursor), false);
  assert.equal(matchesReturnRefundScanResumeProof(original, current, { page: 2, itemOffset: 0 }), false);
  assert.equal(matchesReturnRefundScanResumeProof({ ...original,
    capturedAt: new Date(Date.now() + 1000).toISOString() }, current, cursor), false);

  const steps = [];
  const scan = await collectReturnRefundCandidates(page, page.context(), {
    scanCursor: cursor, resumeProof: original, maxItems: 1, maxDurationMs: 5000,
    delayMs: 0, renderWaitMs: 100,
    completedRefunds: orders.map((orderNumber, i) => ({ orderNumber, aftersaleNumber: aftersales[i] })),
    onStep: (stage) => { steps.push(stage); },
  });
  assert.equal(scan.scan.resumeCheck.resumed, true);
  assert.equal(scan.scan.resumeCheck.sameRows, false);
  assert.equal(scan.scan.resumeCheck.sameRowsExceptCountdown, true);
  assert.deepEqual(scan.scan.startCursor, cursor);
  assert.equal(scan.scan.examined, 1);
  assert.equal(scan.scan.listResponseDiagnostics.rowsSkippedKnownCompleted, 1);
  assert(steps.includes('return-refund-resume-verified'));
  assert.equal(navigations, 1, 'a ticking countdown must not reopen the workbench or replay prior pages');
  assert.equal(await page.evaluate(() => window.detailClicks || 0), 0,
    'known completed refunds must not be clicked while checking list reuse');
  console.log('Refund countdown resume passed (mixed unhandled/no-return-logistics timers, business changes, deadlines, identity, privacy, actual collector)');
} finally {
  await browser.close();
}
