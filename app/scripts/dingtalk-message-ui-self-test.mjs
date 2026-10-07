import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = String(process.env.DINGTALK_UI_SELF_TEST_URL || 'http://web:4173').replace(/\/$/, '');
const passwordFile = process.env.OWNER_INITIAL_PASSWORD_FILE || '/run/workflow-secrets/OWNER_INITIAL_PASSWORD';
const password = (await fsp.readFile(passwordFile, 'utf8')).trim();
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  const login = await context.request.post(`${baseUrl}/api/v1/auth/login`, {
    data: { username: process.env.OWNER_USERNAME || 'owner', password },
  });
  assert.equal(login.status(), 200, 'owner login failed');
  const csrfToken = (await login.json()).data?.csrfToken;
  const workOrdersResponse = await context.request.get(`${baseUrl}/api/v1/work-orders?pageSize=100`);
  assert.equal(workOrdersResponse.status(), 200, 'work-order list failed');
  const workOrders = (await workOrdersResponse.json()).data || [];
  const workOrder = workOrders.find((item) => item.scenarioCode !== 'return-refund'
    && !['pending', 'sending'].includes(item.dingtalkNotification?.status));
  assert(workOrder?.id, 'no pushable work order is available for the DingTalk UI self-test');
  const rejected = await context.request.post(`${baseUrl}/api/v1/work-orders/${workOrder.id}/dingtalk`, {
    headers: { 'x-csrf-token': csrfToken },
    data: {
      message: {
        problemZh: '页面异常',
        descriptionZh: 'page.goto: Target page, context or browser has been closed',
        descriptionEn: 'Manual review required.',
      },
    },
  });
  assert.equal(rejected.status(), 400, 'log-like message content was not rejected');

  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('aside.sidebar').getByRole('button', { name: '工单中心' }).click();
  await page.getByRole('heading', { name: '工单中心' }).waitFor();
  const pushButton = page.locator('tbody tr:not(.return-refund-row) button.row-dingtalk-action:not(:disabled)').first();
  await pushButton.waitFor();
  const selectedOrderNumber = (await pushButton.locator('xpath=ancestor::tr').locator('.order-number').textContent()).trim();
  await pushButton.click();
  const dialog = page.getByRole('dialog', { name: /推送钉钉/ });
  await dialog.waitFor();
  const problem = dialog.getByLabel('问题（中文）');
  const descriptionZh = dialog.getByLabel('未完成流程分析（中文）');
  const descriptionEn = dialog.getByLabel('Incomplete workflow analysis (English)');
  const manualCopy = dialog.getByRole('region', { name: '人工处理信息' });
  await manualCopy.waitFor();
  assert.equal(await manualCopy.getByRole('button', { name: '全部复制' }).count(), 1, 'manual processing fields do not expose copy-all');
  assert.equal(await manualCopy.getByRole('button', { name: '复制订单号' }).count(), 1, 'order number does not expose an individual copy action');
  assert.match(await manualCopy.textContent(), /OMS发货仓库/u, 'OMS warehouse is missing from the manual copy section');
  assert.match(await manualCopy.textContent(), /TMS凭证图片/u, 'TMS evidence is missing from the manual copy section');
  await manualCopy.getByRole('button', { name: '复制订单号' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selectedOrderNumber, 'copy order number wrote the wrong clipboard value');
  await manualCopy.getByRole('button', { name: '全部复制' }).click();
  const copiedManualBlock = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copiedManualBlock, new RegExp(`订单号：${selectedOrderNumber}`, 'u'), 'copy-all omitted the order number');
  assert.match(copiedManualBlock, /OMS发货仓库：/u, 'copy-all omitted the OMS warehouse');
  assert.match(copiedManualBlock, /TMS凭证图片：/u, 'copy-all omitted the TMS evidence reference');
  assert((await problem.inputValue()).trim(), 'Chinese problem was not prefilled');
  assert((await descriptionZh.inputValue()).trim(), 'Chinese analysis was not prefilled');
  assert((await descriptionEn.inputValue()).trim(), 'English analysis was not prefilled');
  const defaults = `${await problem.inputValue()} ${await descriptionZh.inputValue()} ${await descriptionEn.inputValue()}`;
  assert(!/page\.goto|workflow\.mjs|\n\s*at\s+/i.test(defaults), 'dialog was prefilled with log content');
  await problem.fill('页面需要人工验证。');
  await descriptionZh.fill('页面需要人工验证，程序停在人工验证阶段。');
  await descriptionEn.fill('The page requires verification. The automation stopped at human verification.');
  assert(await dialog.getByRole('button', { name: '确认推送' }).isEnabled(), 'custom message cannot be submitted');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = await dialog.boundingBox();
  assert(mobileBox && mobileBox.x >= 0 && mobileBox.width <= 390, 'DingTalk dialog overflows the mobile viewport');
  await context.close();
  console.log('owner DingTalk message UI and API rejection self-test passed');
} finally {
  await browser.close();
}
