import assert from 'node:assert/strict';
import {
  clickFirstLivePddQrRefreshCandidate,
  clickVisiblePddQrRefreshControl,
} from '../packages/adapters/src/pdd/login-qr-refresh.mjs';

const group = (elements) => ({
  count: async () => elements.length,
  nth: (index) => elements[index],
});
const element = (result, onEvaluate = () => {}) => ({
  evaluate: async () => {
    onEvaluate();
    if (result instanceof Error) throw result;
    return result;
  },
});

let visibleClicks = 0;
assert.equal(await clickFirstLivePddQrRefreshCandidate([
  group([element(false), element(new Error('detached'))]),
  group([element(true, () => { visibleClicks++; })]),
]), true);
assert.equal(visibleClicks, 1, 'the visible duplicate must be clicked exactly once');

let retryWaits = 0;
assert.equal(await clickFirstLivePddQrRefreshCandidate([
  group([element(false)]),
], {
  maxAttempts: 3,
  waitForTimeout: async () => { retryWaits++; },
}), false);
assert.equal(retryWaits, 2, 'three attempts must wait only between attempts');

const visible = group([element(true)]);
const empty = group([]);
let pageWaits = 0;
assert.equal(await clickVisiblePddQrRefreshControl({
  getByRole: (_role, options) => (options.exact ? empty : visible),
  locator: () => ({ filter: () => empty }),
  waitForTimeout: async () => { pageWaits++; },
}), true);
assert.equal(pageWaits, 0, 'a live refresh control must not add retry latency');

if (process.env.PDD_QR_REFRESH_BROWSER_TEST === 'true') {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WORKFLOW_BROWSER_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button style="display:none" onclick="window.hiddenClicked=true">点击刷新</button>
      <button id="live" onclick="window.liveClicked=true">点击刷新</button>
    `);
    assert.equal(await clickVisiblePddQrRefreshControl(page), true);
    assert.equal(await page.evaluate(() => window.liveClicked === true), true);
    assert.equal(await page.evaluate(() => window.hiddenClicked === true), false);
  } finally {
    await browser.close();
  }
}

console.log('PDD login QR refresh self-test passed.');
