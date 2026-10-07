import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { clickVisiblePddStalePageRefresh } from '../packages/adapters/src/pdd/stale-page-refresh.mjs';
import { waitForPddRenderedResult } from '../packages/adapters/src/pdd/render-wait.mjs';

const browserExecutablePath = process.env.PDD_BROWSER_EXECUTABLE_PATH || process.env.TEST_CHROME_PATH;
const browser = await chromium.launch({ headless: true,
  ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent(`
    <button id="outside">刷新</button>
    <div role="dialog" aria-modal="true" id="stale-modal">
      <p>当前页面停留时间过长，为了避免数据延迟，建议刷新一次页面</p>
      <button id="stale-refresh">刷新</button>
    </div>
    <script>
      document.querySelector('#stale-refresh').addEventListener('click', () => {
        document.querySelector('#stale-modal').remove();
        document.body.dataset.refreshed = 'true';
      });
      document.querySelector('#outside').addEventListener('click', () => {
        document.body.dataset.outsideClicked = 'true';
      });
    </script>
  `);
  const result = await clickVisiblePddStalePageRefresh(page, { settleMs: 0 });
  assert.equal(result.handled, true);
  assert.equal(await page.locator('body').getAttribute('data-refreshed'), 'true');
  assert.equal(await page.locator('body').getAttribute('data-outside-clicked'), null);
  assert.equal(await page.locator('#outside').isVisible(), true);

  const noModal = await clickVisiblePddStalePageRefresh(page, { cooldownMs: 0, settleMs: 0 });
  assert.equal(noModal.handled, false);

  await page.setContent(`
    <button id="outside">刷新</button>
    <div role="dialog" aria-modal="true">
      <p>当前页面停留时间过长，建议刷新一次页面</p>
      <button id="stale-refresh">刷新</button>
    </div>
  `);
  const second = await clickVisiblePddStalePageRefresh(page, { cooldownMs: 0, settleMs: 0 });
  assert.equal(second.handled, true);
  assert.equal(await page.locator('#outside').isVisible(), true);

  await page.setContent(`
    <button id="outside">刷新</button>
    <div data-overlay="pdd-warning">
      <section>
        <p>当前页面停留时间过长，为了避免数据延迟，建议刷新一次页面</p>
        <div role="button" id="plain-refresh">刷新</div>
      </section>
    </div>
    <script>
      document.querySelector('#plain-refresh').addEventListener('click', () => {
        document.body.dataset.plainRefreshed = 'true';
      });
      document.querySelector('#outside').addEventListener('click', () => {
        document.body.dataset.outsideClicked = 'true';
      });
    </script>
  `);
  const plain = await clickVisiblePddStalePageRefresh(page, { cooldownMs: 0, settleMs: 0 });
  assert.equal(plain.handled, true);
  assert.equal(await page.locator('body').getAttribute('data-plain-refreshed'), 'true');
  assert.equal(await page.locator('body').getAttribute('data-outside-clicked'), null);

  const nested = Array.from({ length: 10 }, (_, index) => `<div data-nested="${index}">`).join('');
  const closing = Array.from({ length: 10 }, () => '</div>').join('');
  await page.setContent(`
    <button id="outside">刷新</button>
    ${nested}
      <p>当前页面停留时间过长，为了避免数据延迟，建议刷新一次页面</p>
      <div role="button" id="nested-refresh">刷新</div>
    ${closing}
    <script>
      document.querySelector('#nested-refresh').addEventListener('click', () => {
        document.body.dataset.nestedRefreshed = 'true';
      });
      document.querySelector('#outside').addEventListener('click', () => {
        document.body.dataset.outsideClicked = 'true';
      });
    </script>
  `);
  const deeplyNested = await clickVisiblePddStalePageRefresh(page, { cooldownMs: 0, settleMs: 0 });
  assert.equal(deeplyNested.handled, true);
  assert.equal(await page.locator('body').getAttribute('data-nested-refreshed'), 'true');
  assert.equal(await page.locator('body').getAttribute('data-outside-clicked'), null);

  let reloadCount = 0;
  await page.setContent(`
    <div role="dialog" aria-modal="true" id="stale-modal">
      <p>当前页面停留时间过长，为了避免数据延迟，建议刷新一次页面</p>
      <button id="stale-refresh">刷新</button>
    </div>
    <script>
      document.querySelector('#stale-refresh').addEventListener('click', () => {
        document.querySelector('#stale-modal').remove();
        document.body.dataset.refreshed = 'true';
      });
    </script>
  `);
  const originalReload = page.reload.bind(page);
  page.reload = async (...args) => {
    reloadCount += 1;
    return originalReload(...args);
  };
  const recovered = await waitForPddRenderedResult(page, {
    stage: 'self-test',
    timeoutMs: 80,
    totalTimeoutMs: 400,
    initialWaitMs: 20,
    pollIntervalMs: 5,
    beforeReload: (targetPage) => clickVisiblePddStalePageRefresh(targetPage, {
      cooldownMs: 0,
      settleMs: 0,
    }),
    inspect: async (targetPage) => (
      await targetPage.locator('body').getAttribute('data-refreshed') === 'true'
        ? { recovered: true }
        : null
    ),
  });
  assert.equal(recovered.refreshed, true);
  assert.equal(reloadCount, 0);
} finally {
  await browser.close();
}

console.log('stale-page-refresh-self-test: ok');
