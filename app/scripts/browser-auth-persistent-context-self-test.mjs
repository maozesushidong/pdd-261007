import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  mergeBrowserStorageStates,
  restoreBrowserAuthFromSnapshots,
} from '../packages/adapters/src/browser-auth-state.mjs';
import { installManagedPageTitle } from '../packages/adapters/src/browser-runtime-state.mjs';

const executablePath = String(process.env.WORKFLOW_BROWSER_EXECUTABLE_PATH || '').trim()
  || chromium.executablePath();
assert(fs.existsSync(executablePath), `Chrome executable is missing: ${executablePath}`);

const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-auth-profile-'));
const expires = Math.floor(Date.now() / 1000) + 3600;
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  await context.addCookies([
    { name: 'PASS_ID', value: 'current-pass', domain: 'mms.pinduoduo.com', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'oms-token', value: 'current-oms', domain: 'www.jeoms.com', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'unrelated', value: 'current-unrelated', domain: 'example.com', path: '/', expires, httpOnly: false, secure: true, sameSite: 'Lax' },
  ]);
  const saved = mergeBrowserStorageStates([{
    cookies: [{
      name: 'windows_app_shop_token_23',
      value: 'saved-pdd-token',
      domain: '.pinduoduo.com',
      path: '/',
      expires,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }],
    origins: [{
      origin: 'https://mms.pinduoduo.com',
      localStorage: [{ name: 'ISLOGIN', value: 'true' }],
    }],
  }]);
  const result = await restoreBrowserAuthFromSnapshots(context, saved);
  assert.deepEqual(result.restoredSystems, ['pdd']);
  const restored = await context.storageState({ indexedDB: true });
  assert.equal(restored.cookies.find((cookie) => cookie.name === 'windows_app_shop_token_23')?.value,
    'saved-pdd-token');
  assert.equal(restored.cookies.find((cookie) => cookie.name === 'oms-token')?.value, 'current-oms');
  assert.equal(restored.cookies.find((cookie) => cookie.name === 'unrelated')?.value,
    'current-unrelated');
  assert.equal(restored.origins.find((origin) => origin.origin === 'https://mms.pinduoduo.com')
    ?.localStorage.find((entry) => entry.name === 'ISLOGIN')?.value, 'true');
  const titlePage = context.pages()[0] || await context.newPage();
  await titlePage.goto('data:text/html,<title>Initial</title><main>ready</main>');
  await titlePage.evaluate(installManagedPageTitle, { prefix: '[shop-a]', fallbackTitle: 'Loading' });
  assert.equal(await titlePage.title(), '[shop-a] Initial');
  await titlePage.evaluate(() => {
    const replacement = document.createElement('title');
    replacement.textContent = 'Replaced';
    document.querySelector('title')?.replaceWith(replacement);
  });
  await titlePage.waitForFunction(() => document.title === '[shop-a] Replaced');
  await titlePage.evaluate(installManagedPageTitle, { prefix: '[shop-b]', fallbackTitle: 'Loading' });
  await titlePage.evaluate(() => { document.title = 'Updated'; });
  await titlePage.waitForFunction(() => document.title === '[shop-b] Updated');
  console.log('persistent browser auth restoration self-test passed');
} finally {
  await context?.close().catch(() => {});
  await fsp.rm(profileDir, { recursive: true, force: true });
}
