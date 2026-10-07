import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';

const url = 'https://www.jeoms.com/xianma/login';
const statePath = process.env.JEOMS_STATE || 'jeoms-auth.json';
const ask = async (text) => {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(text)).trim(); } finally { rl.close(); }
};
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext(fs.existsSync(statePath) ? { storageState: statePath } : {});
const page = await context.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (page.url().endsWith('/xianma/login')) {
    await page.getByRole('textbox', { name: '登录账号' }).fill(process.env.JEOMS_ACCOUNT || '');
    await page.getByRole('textbox', { name: '登录密码' }).fill(process.env.JEOMS_PASSWORD || '');
    const captcha = page.getByRole('textbox', { name: '请输入验证码' });
    if (await captcha.isVisible().catch(() => false)) await captcha.fill(process.env.JEOMS_CAPTCHA || await ask('请输入 JEOMS 图形验证码: '));
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((current) => !current.toString().endsWith('/xianma/login'), { timeout: 300000 });
    await context.storageState({ path: statePath });
  }
  console.log(`JEOMS 登录成功: ${page.url()}`);
  await new Promise(() => {});
} catch (error) {
  console.error(`JEOMS 流程暂停，浏览器保持打开: ${error.message}`);
  await new Promise(() => {});
}
