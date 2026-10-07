import { chromium } from 'playwright';

const targetUrl = 'https://mms.pinduoduo.com/aftersales/work_order/list';
const statePath = process.env.PDD_STATE || 'pdd-auth.json';

// This entry point is always headed and intentionally keeps the browser alive.
const browser = await chromium.launch({ headless: false });
const context = await contextWithState(browser, statePath);
const page = await context.newPage();

try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  if (!page.url().includes('/aftersales/work_order/list')) {
    throw new Error(`登录状态无效或页面被重定向: ${page.url()}`);
  }
  console.log(`页面已打开: ${await page.title()} | ${page.url()}`);
  console.log('可视化浏览器保持运行中；设置 PDD_CLOSE_ON_EXIT=true 才会退出。');
  if (process.env.PDD_CLOSE_ON_EXIT !== 'true') await new Promise(() => {});
} finally {
  if (process.env.PDD_CLOSE_ON_EXIT === 'true') await browser.close();
}

async function contextWithState(browserInstance, path) {
  try {
    return await browserInstance.newContext({ storageState: path });
  } catch (error) {
    await browserInstance.close();
    throw new Error(`无法加载登录状态文件 ${path}: ${error.message}`, { cause: error });
  }
}
