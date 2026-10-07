import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { classifyReturnRefundSubmission, submitReturnRefund }
  from '../packages/adapters/src/pdd/return-refund.mjs';

// Isolated timing experiment. Every browser request is intercepted; no live
// shop, account, database, or platform submission is used.
const orderNumber = '260930-111111111111111';
const aftersaleNumber = '23111111111111';
const paced = process.argv.includes('--paced');
const visibleStepDelayMs = paced ? 2_500 : 0;
const terminalDelayMs = paced ? 20_000 : 12_000;
const url = `https://mms.pinduoduo.com/aftersales-ssr/detail?id=${aftersaleNumber}&orderSn=${orderNumber}`;
const detail = (status, approve = false) => `
  <div>退款申请单</div><div>售后编号：</div><div>${aftersaleNumber}</div>
  <div>售后类型：</div><div>退货退款</div><div>退款金额：</div><div>¥65.00</div>
  <div>订单编号：</div><div>${orderNumber}</div>
  <div>售后状态：</div><div>${status}</div>
  ${approve ? '<button id="approve">同意退款</button>' : ''}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
const results = [];
try {
  for (const scenario of [
    { name: 'current-six-second-first-refresh', firstWaitMs: 6_000, terminalDelayMs, expectedReloads: 2 },
    { name: 'default-settled-first-refresh', firstWaitMs: undefined, terminalDelayMs, expectedReloads: 1 },
    { name: 'already-rendered-terminal-does-not-wait', firstWaitMs: undefined, terminalDelayMs: 0, expectedReloads: 0 },
  ]) {
    const page = await browser.newPage();
    let confirmedAt = null;
    const clicks = { approve: 0, confirm: 0 };
    const reads = [];
    let navigations = 0;
    await page.exposeFunction('recordFixtureClick', (kind) => {
      clicks[kind] += 1;
      if (kind === 'confirm') confirmedAt = Date.now();
    });
    const afterConfirm = detail(scenario.terminalDelayMs === 0
      ? '商家同意退款，本单退款成功' : '退款中');
    const initial = `${detail('待商家处理', true)}<script>
      document.querySelector('#approve').onclick = async () => {
        await window.recordFixtureClick('approve');
        document.body.innerHTML = '<div role="dialog"><div>同意退款</div><div>退款金额 ¥65.00</div><button id="confirm">确认退款</button><button>取消</button></div>';
        document.querySelector('#confirm').onclick = async () => {
          await window.recordFixtureClick('confirm');
          document.body.innerHTML = ${JSON.stringify(afterConfirm)};
        };
      };
    </script>`;
    await page.route('**/*', (route) => {
      if (route.request().url() !== url) return route.abort();
      const first = navigations++ === 0;
      const elapsed = confirmedAt === null ? null : Date.now() - confirmedAt;
      const terminal = elapsed !== null && elapsed >= scenario.terminalDelayMs;
      if (!first) reads.push({ elapsedMs: elapsed, terminal });
      return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: first ? initial : detail(terminal ? '商家同意退款，本单退款成功' : '退款中') });
    });
    await page.goto(url);
    const submission = await submitReturnRefund(page, {
      delayMs: visibleStepDelayMs, renderWaitMs: 1_000, expectedFacts: { orderNumber, aftersaleNumber },
      postconditionFirstRefreshWaitMs: scenario.firstWaitMs,
      postconditionLaterRefreshWaitMs: 8_000,
    });
    const classification = classifyReturnRefundSubmission(submission, {
      expectedOrderNumber: orderNumber, expectedAftersaleNumber: aftersaleNumber,
    });
    assert.equal(classification.effectStatus, 'succeeded', scenario.name);
    assert.deepEqual(clicks, { approve: 1, confirm: 1 }, scenario.name);
    assert.equal(navigations - 1, scenario.expectedReloads, scenario.name);
    const result = { scenario: scenario.name, visibleStepDelayMs,
      terminalDelayMs: scenario.terminalDelayMs, reloads: navigations - 1,
      clicks, resultReads: reads, elapsedAfterConfirmationMs: Date.now() - confirmedAt };
    results.push(result);
    console.log(JSON.stringify(result));
    await page.close();
  }
  console.log(JSON.stringify({ passed: results.length,
    limitation: 'Fixture models delayed platform state; live reduction must be verified separately.' }));
} finally {
  await browser.close();
}
