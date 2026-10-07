import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { selectVerificationTab, verificationTabLockPath } from '../packages/adapters/src/verification-detector/tab-selection.mjs';
import { createVerificationFocusCoordinator } from '../packages/adapters/src/verification-detector/focus-lock.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pdd-tab-selection-test-'));
const extension = fileURLToPath(new URL('./fixtures/tab-selection-extension/', import.meta.url));
let context;
try {
  const lockA = verificationTabLockPath({ root: temporary, shopId: 'shop-A' });
  const lockB = verificationTabLockPath({ root: temporary, shopId: 'shop-B' });
  assert.notEqual(lockA, lockB);
  assert.equal(verificationTabLockPath({ root: temporary, shopId: '../shop/A' }).startsWith(temporary), true);
  const first = createVerificationFocusCoordinator({ lockPath: lockA, shopId: 'shop-A' });
  const second = createVerificationFocusCoordinator({ lockPath: lockB, shopId: 'shop-B' });
  const sameShop = createVerificationFocusCoordinator({ lockPath: lockA, shopId: 'shop-A', pollMs: 5 });
  try {
    assert.equal((await first.acquire({ timeoutMs: 1000 })).acquired, true);
    assert.equal((await second.acquire({ timeoutMs: 1000 })).acquired, true,
      'another shop must select its verification tab while the first shop remains locked');
    assert.equal((await sameShop.acquire({ timeoutMs: 25 })).status, 'timeout',
      'overlapping operations within one shop must still serialize');
  } finally { first.release(); second.release(); sameShop.release(); }
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    headless: true,
    ...(process.env.PDD_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.PDD_BROWSER_EXECUTABLE_PATH } : { channel: 'chromium' }),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const firstPage = context.pages()[0];
  await firstPage.goto('data:text/html,<title>same-url</title><p>First tab</p>');
  const secondPage = await context.newPage();
  await secondPage.goto(firstPage.url());
  const thirdPage = await context.newPage();
  await thirdPage.goto('data:text/html,<title>selected</title>');
  // Select a known other tab before exercising the helper. Both candidates
  // deliberately share one URL, so URL matching would pick the wrong tab.
  const initialTabs = await worker.evaluate(() => chrome.tabs.query({}));
  const selected = initialTabs.find(tab => tab.url?.includes('title>selected'));
  assert.ok(selected?.id);
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), selected.id);
  const foregroundWindow = await worker.evaluate(() => chrome.windows.create({
    url: 'data:text/html,<title>Other foreground window</title>', focused: true,
  }));
  const windowBefore = await worker.evaluate(id => chrome.windows.get(id), selected.windowId);
  const foregroundBefore = await worker.evaluate(id => chrome.windows.get(id), foregroundWindow.id);
  const selectionStarted = Date.now();
  const result = await selectVerificationTab({ page: secondPage, extensionIds: [extensionId] });
  assert.equal(result.selected, true, JSON.stringify(result));
  assert.equal(result.activated, true);
  assert.ok(Date.now() - selectionStarted >= 1980, 'actual selection must wait one second before and after');
  assert.ok(result.waitedBeforeMs >= 1000);
  assert.equal(result.settleMs, 1000);
  const targetSession = await context.newCDPSession(secondPage);
  const targetId = (await targetSession.send('Target.getTargetInfo')).targetInfo.targetId;
  await targetSession.detach();
  const exact = await worker.evaluate(async targetId => {
    const target = (await chrome.debugger.getTargets()).find(item => item.id === targetId);
    return chrome.tabs.get(target.tabId);
  }, targetId);
  assert.equal(exact.id, result.tabId);
  assert.equal(exact.active, true);
  const windowAfter = await worker.evaluate(id => chrome.windows.get(id), selected.windowId);
  for (const key of ['left','top','width','height','state','focused']) {
    assert.equal(windowAfter[key], windowBefore[key], `tab selection must preserve window ${key}`);
  }
  const foregroundAfter = await worker.evaluate(id => chrome.windows.get(id), foregroundWindow.id);
  for (const key of ['left','top','width','height','state','focused']) {
    assert.equal(foregroundAfter[key], foregroundBefore[key], `other window ${key} must stay unchanged`);
  }
  const again = await selectVerificationTab({ page: secondPage, extensionIds: [extensionId] });
  assert.equal(again.selected, true);
  assert.equal(again.activated, false, 'the selected tab must not be reactivated during a drag/redraw');
  assert.equal(again.skipped, true);
  const back = await selectVerificationTab({ page: firstPage, extensionIds: [extensionId] });
  assert.equal(back.activated, true);
  assert.ok(Date.parse(back.selectedAt) - Date.parse(result.selectedAt) >= 2480,
    'actual tab changes must not happen in a burst');
  let selectionChecks = 0;
  const clearedDuringPause = await selectVerificationTab({
    page: secondPage, extensionIds: [extensionId], canSelect: async () => ++selectionChecks === 1,
  });
  assert.equal(clearedDuringPause.reason, 'tab-selection-no-longer-required');
  assert.equal(clearedDuringPause.activated, false, 'a challenge cleared during the pause must not cause a stale tab jump');
  const coalesced = await Promise.all([
    selectVerificationTab({ page: secondPage, extensionIds: [extensionId] }),
    selectVerificationTab({ page: secondPage, extensionIds: [extensionId] }),
  ]);
  assert.equal(coalesced.filter(item => item.activated).length, 1,
    'overlapping observers must select the same challenge only once');
  assert.ok(coalesced.every(item => item.selected));
  const unavailable = await selectVerificationTab({ page: firstPage, extensionIds: [] });
  assert.equal(unavailable.selected, false);
  const retained = await worker.evaluate(id => chrome.tabs.get(id), result.tabId);
  assert.equal(retained.active, true, 'missing extension must not trigger a foreground activation fallback');
  await worker.evaluate(id => chrome.windows.update(id, { state: 'minimized' }), selected.windowId);
  const minimized = await selectVerificationTab({ page: firstPage, extensionIds: [extensionId] });
  assert.equal(minimized.selected, true);
  const minimizedWindow = await worker.evaluate(id => chrome.windows.get(id), selected.windowId);
  assert.equal(minimizedWindow.state, 'minimized', 'selecting a tab must not restore a minimized window');
  console.log('verification tab selection and per-shop locking self-test passed');
} finally {
  await context?.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('pdd-tab-selection-test-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
