import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { extractOrdinaryListCreatedAt } from '../packages/adapters/src/pdd/ordinary-work-orders.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'workflow.mjs'), 'utf8');
const start = source.indexOf('const locateWorkOrderAction = async (title) => {');
const end = source.indexOf('\n\nconst expandEvidencePanelForScreenshot =', start);
assert(start >= 0 && end > start);
const sandbox = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}\nthis.locateWorkOrderAction = locateWorkOrderAction;`, sandbox);

const candidates = [
  process.env.PDD_BROWSER_EXECUTABLE_PATH,
  'D:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
].filter(Boolean);
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setContent(`
    <div id="dated-row">
      <div id="compact-row">
        <span id="dated-title">商品少发</span>
        <span>订单编号 260926-217862673963683</span>
        <button>立即处理</button>
      </div>
      <div>工单创建时间：2026-09-28 23:06:14</div>
    </div>
    <div id="undated-row">
      <div id="undated-compact">
        <span id="undated-title">物流问题</span>
        <span>订单编号 260929-595339559243705</span>
        <button>立即处理</button>
      </div>
    </div>
  `);
  const datedTitle = page.locator('#dated-title');
  const datedAction = await sandbox.locateWorkOrderAction(datedTitle);
  assert.equal(await datedAction.count(), 1);
  const datedRow = datedTitle.locator('xpath=ancestor::*[@data-codex-pdd-work-order-row="true"][1]');
  assert.equal(await datedRow.getAttribute('id'), 'dated-row');
  assert(extractOrdinaryListCreatedAt(await datedRow.innerText()));

  const undatedTitle = page.locator('#undated-title');
  const undatedAction = await sandbox.locateWorkOrderAction(undatedTitle);
  assert.equal(await undatedAction.count(), 1);
  const undatedRow = undatedTitle.locator('xpath=ancestor::*[@data-codex-pdd-work-order-row="true"][1]');
  assert.equal(await undatedRow.getAttribute('id'), 'undated-compact');
  assert.equal(extractOrdinaryListCreatedAt(await undatedRow.innerText()), null);
} finally {
  await browser.close();
}
console.log('PDD discovery row UI self-test passed');
