import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = String(process.env.WORK_ORDER_UI_SELF_TEST_URL || 'http://web:4173').replace(/\/$/, '');
const passwordFile = process.env.OWNER_INITIAL_PASSWORD_FILE || '/run/workflow-secrets/OWNER_INITIAL_PASSWORD';
const outputDirectory = process.env.WORK_ORDER_UI_SELF_TEST_OUTPUT || '/tmp';
const password = (await fsp.readFile(passwordFile, 'utf8')).trim();
const browser = await chromium.launch({ headless: true });

try {
  await fsp.mkdir(outputDirectory, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await context.request.post(`${baseUrl}/api/v1/auth/login`, {
    data: { username: process.env.OWNER_USERNAME || 'owner', password },
  });
  assert.equal(login.status(), 200, 'owner login failed');
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('aside.sidebar').getByRole('button', { name: '工单中心' }).click();
  await page.getByRole('heading', { name: '工单中心' }).waitFor();
  const selectPage = page.getByRole('checkbox', { name: '选择本页' });
  await selectPage.check();
  const deleteButton = page.getByRole('button', { name: /删除 \(\d+\)/ });
  await deleteButton.click();
  const dialog = page.getByRole('dialog', { name: /删除 \d+ 张工单/ });
  await dialog.waitFor();
  await dialog.getByText('工单将从列表和统计中移除，并停止再次进入自动队列；所有者审计记录仍会保留。').waitFor();
  await page.screenshot({ path: `${outputDirectory}/work-order-delete-desktop.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = await dialog.boundingBox();
  assert(mobileBox && mobileBox.x >= 0 && mobileBox.width <= 390, 'delete dialog overflows the mobile viewport');
  await page.screenshot({ path: `${outputDirectory}/work-order-delete-mobile.png`, fullPage: true });
  await context.close();
  console.log('owner work-order deletion UI self-test passed');
} finally {
  await browser.close();
}
