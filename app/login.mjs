import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const loginUrl = 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmms.pinduoduo.com%2F';
const ask = async (text) => { const rl = readline.createInterface({ input, output }); try { return (await rl.question(text)).trim(); } finally { rl.close(); } };
const required = (name) => process.env[name] || (() => { throw new Error(`Missing ${name}`); })();
// All project runs are visual by policy; do not allow headless mode here.
const visible = true;
const keepOpen = process.env.PDD_KEEP_OPEN !== 'false';
const browser = await chromium.launch({ headless: !visible });
const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  const close = page.getByTestId('beast-core-modal-close-button');
  for (let i = 0; i < await close.count(); i++) if (await close.nth(i).isVisible().catch(() => false)) await close.nth(i).click({ force: true });
  const tab = page.getByText('账号登录', { exact: true });
  if (await tab.isVisible().catch(() => false)) await tab.click({ force: true });
  await page.getByRole('textbox', { name: '请输入账号名/手机号' }).fill(required('PDD_ACCOUNT'));
  await page.getByRole('textbox', { name: '请输入密码' }).fill(required('PDD_PASSWORD'));
  await page.getByRole('button', { name: '登录' }).click();
  const otp = page.getByRole('textbox', { name: '请输入短信验证码' });
  if (await otp.isVisible().catch(() => false)) {
    const code = process.env.PDD_OTP || await ask('OTP: ');
    await otp.fill(code);
    await page.getByRole('button', { name: '确认' }).click();
  }
  await page.waitForURL('**/home/**', { timeout: 300000 });
  await context.storageState({ path: process.env.PDD_STATE || 'pdd-auth.json' });
  console.log(`Login OK: ${page.url()}`);
  if (visible && keepOpen) await new Promise(() => {});
} catch (error) {
  console.error(`Login incomplete: ${error.message}`);
  if (visible && keepOpen) await new Promise(() => {});
} finally {
  if (!visible || process.env.PDD_CLOSE_ON_EXIT === 'true') await browser.close();
}
