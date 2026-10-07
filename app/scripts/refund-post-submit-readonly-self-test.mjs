import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  classifyReturnRefundSubmission,
  readReturnRefundDetail,
  submitReturnRefund,
} from '../packages/adapters/src/pdd/return-refund.mjs';

const orderNumber = '260929-111111111111111';
const aftersaleNumber = '23111111111111';
const detailUrl = `https://mms.pinduoduo.com/aftersales-ssr/detail?id=${aftersaleNumber}&orderSn=${orderNumber}`;
const expectedFacts = { orderNumber, aftersaleNumber };
const detail = ({ status = '退款中', order = orderNumber, approve = false, extra = '' } = {}) => `
  <div>退款申请单</div>
  <div>售后编号：</div><div>${aftersaleNumber}</div>
  <div>售后类型：</div><div>退货退款</div>
  <div>退款金额：</div><div>¥65.00</div>
  <div>订单编号：</div><div>${order}</div>
  <div>售后状态：</div><div>${status}</div>
  ${approve ? '<button id="approve">同意退款</button>' : ''}
  <button onclick="window.fixtureClick('logistics')">退货物流</button>
  <button onclick="window.fixtureClick('expand')">查看全部</button>
  ${extra}`;
const initialBody = `${detail({ status: '待商家处理', approve: true })}
  <script>
    document.querySelector('#approve').onclick = () => {
      window.fixtureClick('approve');
      document.body.innerHTML = '<div role="dialog"><div>同意退款</div><div>退款金额 ¥65.00</div><button id="confirm">确认退款</button><button>取消</button></div>';
      document.querySelector('#confirm').onclick = () => {
        window.fixtureClick('confirm');
        document.body.innerHTML = ${JSON.stringify(detail())};
      };
    };
  </script>`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
try {
  for (const scenario of [
    { name: 'terminal-after-refresh', status: '商家同意退款，本单退款成功', expected: 'succeeded', refreshes: 1 },
    { name: 'pending-is-not-completed', status: '退款中', expected: 'unknown', refreshes: 3 },
    { name: 'wrong-order-is-not-completed', status: '退款成功', order: '260929-222222222222222', expected: 'unknown', refreshes: 1 },
    { name: 'approve-action-still-visible', status: '退款成功', approve: true, expected: 'unknown', refreshes: 3 },
    { name: 'unrelated-success-text', status: '待商家处理', extra: '<aside>说明：退款成功后请等待到账</aside>', expected: 'unknown', refreshes: 3 },
  ]) {
    const page = await browser.newPage();
    const clicks = { approve: 0, confirm: 0, logistics: 0, expand: 0 };
    const steps = [];
    let requests = 0;
    await page.exposeFunction('fixtureClick', (name) => { clicks[name] += 1; });
    await page.route('**/*', (route) => route.request().url() === detailUrl
      ? route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: requests++ === 0 ? initialBody : detail(scenario) }) : route.abort());
    await page.goto(detailUrl);
    const submission = await submitReturnRefund(page, {
      delayMs: 0, renderWaitMs: 1_000, expectedFacts,
      postconditionFirstRefreshWaitMs: 0, postconditionLaterRefreshWaitMs: 0,
      onStep: async (step) => { steps.push(step); },
    });
    const classification = classifyReturnRefundSubmission(submission, {
      expectedOrderNumber: orderNumber, expectedAftersaleNumber: aftersaleNumber,
    });
    assert.equal(classification.effectStatus, scenario.expected, scenario.name);
    assert.equal(submission.postconditionRefreshCount, scenario.refreshes, scenario.name);
    assert.equal(requests, scenario.refreshes + 1, scenario.name);
    assert.deepEqual(clicks, { approve: 1, confirm: 1, logistics: 0, expand: 0 },
      `${scenario.name}: post-submit proof must not click logistics or repeat approval`);
    assert(!steps.includes('return-refund-select-return-logistics'), scenario.name);
    await page.close();
    console.log(`passed: ${scenario.name}`);
  }

  // Ordinary detail reads must still inspect return logistics before a decision.
  const page = await browser.newPage();
  const clicks = { logistics: 0, expand: 0 };
  await page.exposeFunction('fixtureClick', (name) => { clicks[name] += 1; });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: detail({ status: '待商家处理', approve: true }) }));
  await page.goto(detailUrl);
  const facts = await readReturnRefundDetail(page, { delayMs: 0, renderWaitMs: 1_000 });
  assert.equal(facts.actionButtonVisible, true);
  assert.equal(facts.aftersaleStatus, '待商家处理');
  assert.deepEqual(clicks, { logistics: 1, expand: 1 });
  console.log('passed: pre-submit logistics read unchanged');
} finally {
  await browser.close();
}
