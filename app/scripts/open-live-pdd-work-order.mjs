import process from 'node:process';

import { chromium } from 'playwright';

const [, , endpoint = 'http://127.0.0.1:9333', orderNumber = ''] = process.argv;
if (!/^\d{6}-\d{15}$/u.test(orderNumber)) {
  throw new Error('Usage: node scripts/open-live-pdd-work-order.mjs <cdp-endpoint> <order-number>');
}

const browser = await chromium.connectOverCDP(endpoint);
const pages = browser.contexts().flatMap((context) => context.pages());
const listPage = pages.find((page) => /mms\.pinduoduo\.com\/aftersales\/work_order\/list/u.test(page.url()));
if (!listPage) throw new Error(`No PDD work-order list is attached at ${endpoint}`);

const orderText = listPage.getByText(orderNumber, { exact: true }).first();
if (!await orderText.count()) throw new Error(`Order ${orderNumber} is not visible in the pending list`);
const card = orderText.locator(
  'xpath=ancestor::div[contains(@class,"listItem_workOrderItem")][1]',
);
if (!await card.count()) throw new Error(`Order card ${orderNumber} was not found`);
const action = card.getByText('立即处理', { exact: true });
if (!await action.count()) throw new Error(`Order ${orderNumber} does not expose an immediate action`);

const pageBeforeClick = new Set(browser.contexts().flatMap((context) => context.pages()));
const popupPromise = listPage.waitForEvent('popup', { timeout: 15_000 }).catch(() => null);
await action.click();
const popup = await popupPromise;
await listPage.waitForTimeout(1_500);
const pagesAfterClick = browser.contexts().flatMap((context) => context.pages());
const detailPage = popup
  || pagesAfterClick.find((page) => !pageBeforeClick.has(page))
  || pagesAfterClick.find((page) => /\/aftersales\/work_order\/tododetail/u.test(page.url()));
if (!detailPage) throw new Error(`Order ${orderNumber} detail page did not open`);

await detailPage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
await detailPage.waitForTimeout(2_500);
const bodyText = await detailPage.locator('body').innerText();
if (!bodyText.includes(orderNumber)) {
  throw new Error(`Opened detail does not contain expected order ${orderNumber}`);
}

console.log(JSON.stringify({
  orderNumber,
  title: await detailPage.title(),
  url: detailPage.url(),
  bodyText,
}, null, 2));

// Keep the visible shop browser and detail tab open for follow-up inspection.
process.exit(0);
