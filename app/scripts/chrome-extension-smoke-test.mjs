import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const [extensionArgument, expectedExtensionId = '', executableArgument = ''] = process.argv.slice(2);
if (!extensionArgument) {
  throw new Error('Usage: node scripts/chrome-extension-smoke-test.mjs <extension-root> [extension-id] [chrome-executable]');
}

const extensionRoot = path.resolve(extensionArgument);
const manifest = JSON.parse(await fsp.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
if (!manifest.key) throw new Error('Extension manifest has no signing key');

const digest = crypto.createHash('sha256')
  .update(Buffer.from(manifest.key, 'base64'))
  .digest()
  .subarray(0, 16);
const extensionId = [...digest]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((value) => String.fromCharCode('a'.charCodeAt(0) + value))
  .join('');
if (expectedExtensionId) assert.equal(extensionId, expectedExtensionId);

const executablePath = executableArgument || process.env.WORKFLOW_BROWSER_EXECUTABLE_PATH || undefined;
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-extension-smoke-'));
const profileRoot = path.join(temporaryRoot, 'profile');
const loadedExtensionRoot = path.join(temporaryRoot, 'extension');
await fsp.cp(extensionRoot, loadedExtensionRoot, { recursive: true, errorOnExist: true });
const testServer = http.createServer((_request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end('<!doctype html><html><head><title>PDD extension content test</title></head><body>ready</body></html>');
});
await new Promise((resolve, reject) => {
  testServer.once('error', reject);
  testServer.listen(0, '127.0.0.1', resolve);
});
const testServerAddress = testServer.address();
if (!testServerAddress || typeof testServerAddress === 'string') {
  throw new Error('Could not resolve the local extension smoke-test server address');
}
const contentTestUrl = `http://127.0.0.1:${testServerAddress.port}/extension-content-test`;
let context;
try {
  context = await chromium.launchPersistentContext(profileRoot, {
    headless: process.env.EXTENSION_SMOKE_HEADLESS === 'true',
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
    ],
    args: [
      `--disable-extensions-except=${loadedExtensionRoot}`,
      `--load-extension=${loadedExtensionRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--noerrdialogs',
    ],
  });
  const popupPath = manifest.action?.default_popup;
  if (!popupPath) throw new Error('Extension manifest has no action.default_popup');
  const page = context.pages()[0] || await context.newPage();
  const popupUrl = `chrome-extension://${extensionId}/${popupPath}`;
  const deadline = Date.now() + 60_000;
  let response;
  let navigationError;
  do {
    try {
      response = await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      navigationError = null;
      break;
    } catch (error) {
      navigationError = error;
      await page.waitForTimeout(2_000);
    }
  } while (Date.now() < deadline);
  if (navigationError) throw navigationError;
  assert.equal(page.url(), popupUrl);
  assert.ok(!response || response.ok(), `Extension popup returned HTTP ${response.status()}`);

  const serviceWorkerUrl = `chrome-extension://${extensionId}/${manifest.background?.service_worker || ''}`;
  let serviceWorker = context.serviceWorkers().find((worker) => worker.url() === serviceWorkerUrl);
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url() === serviceWorkerUrl,
      timeout: 60_000,
    });
  }
  const serviceWorkerIdentity = await serviceWorker.evaluate(() => ({
    extensionId: chrome.runtime.id,
    manifestVersion: chrome.runtime.getManifest().manifest_version,
    version: chrome.runtime.getManifest().version,
  }));
  assert.equal(serviceWorkerIdentity.extensionId, extensionId);
  assert.equal(serviceWorkerIdentity.manifestVersion, 3);
  assert.equal(serviceWorkerIdentity.version, manifest.version);

  const contentPage = await context.newPage();
  await contentPage.goto(contentTestUrl, { waitUntil: 'load', timeout: 30_000 });
  const contentScriptDeadline = Date.now() + 30_000;
  let contentScriptResult;
  do {
    contentScriptResult = await serviceWorker.evaluate(async ({ targetUrl }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === targetUrl);
      if (!tab?.id) return { ok: false, error: 'content-test-tab-not-found' };
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'PERF_REQUEST' }, (messageResponse) => {
          const error = chrome.runtime.lastError?.message;
          resolve(error
            ? { ok: false, error }
            : { ok: true, response: messageResponse });
        });
      });
    }, { targetUrl: contentTestUrl });
    if (contentScriptResult?.ok) break;
    await contentPage.waitForTimeout(500);
  } while (Date.now() < contentScriptDeadline);
  assert.ok(contentScriptResult?.ok,
    `Extension content script did not respond: ${contentScriptResult?.error || 'unknown error'}`);
  assert.equal(contentScriptResult.response?.ok, true);
  assert.equal(contentScriptResult.response?.data?.url, contentTestUrl);
  assert.equal(contentScriptResult.response?.data?.title, 'PDD extension content test');

  console.log(JSON.stringify({
    status: 'passed',
    extensionId,
    version: manifest.version,
    popupUrl,
    serviceWorkerUrl,
    contentScriptInjected: true,
  }));
} finally {
  await context?.close().catch(() => {});
  await new Promise((resolve) => testServer.close(resolve));
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
