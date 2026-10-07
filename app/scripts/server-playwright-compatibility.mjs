import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const display = process.env.DISPLAY || ':99';
const durationMs = Number(process.env.COMPAT_DURATION_MS || 1_800_000);
const heartbeatMs = Number(process.env.COMPAT_HEARTBEAT_MS || 30_000);
const profileDir = process.env.COMPAT_PROFILE_DIR || '/compat/profile';
const artifactDir = process.env.COMPAT_ARTIFACT_DIR || '/compat/artifacts';
const runnerId = process.env.COMPAT_RUNNER_ID || display.replace(':', 'display-');
const startedAt = new Date().toISOString();

await fs.mkdir(profileDir, { recursive: true });
await fs.mkdir(artifactDir, { recursive: true });

const artifactPath = (name) => path.join(artifactDir, `${runnerId}-${name}`);
const writeJson = (name, value) => fs.writeFile(
  artifactPath(name),
  `${JSON.stringify(value, null, 2)}\n`,
  'utf8',
);

const captureScreenshot = async (page, name) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.screenshot({ path: artifactPath(name) });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(1_000);
    }
  }

  throw new Error(`Unable to capture ${name} after three attempts`, { cause: lastError });
};

const mainPage = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>Playwright compatibility</title></head>
  <body data-state="ready">
    <label>Test value <input id="value" /></label>
    <button id="save">Save</button>
    <button id="open">Open new tab</button>
    <button id="alert">Open dialog</button>
    <output id="status">ready</output>
    <script>
      document.querySelector('#save').addEventListener('click', () => {
        localStorage.setItem('compat-marker', document.querySelector('#value').value);
        document.querySelector('#status').textContent = 'saved';
      });
      document.querySelector('#open').addEventListener('click', () => window.open('/popup', '_blank'));
      document.querySelector('#alert').addEventListener('click', () => alert('compat-dialog'));
    </script>
  </body>
</html>`;

const popupPage = '<!doctype html><html><head><title>Compatibility popup</title></head><body>popup-ready</body></html>';
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(request.url === '/popup' ? popupPage : mainPage);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const testUrl = `http://127.0.0.1:${address.port}/`;
const marker = `${runnerId}-${Date.now()}`;
let context;

const launch = async () => chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-session-crashed-bubble',
    '--disable-restore-session-state',
    '--noerrdialogs',
    '--start-maximized',
  ],
});

try {
  await writeJson('result.json', {
    status: 'starting',
    runnerId,
    display,
    startedAt,
    durationMs,
  });

  context = await launch();
  let page = context.pages()[0] || await context.newPage();
  await page.goto(testUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#value').fill(marker);
  await page.locator('#save').click();
  await page.locator('#status').waitFor({ state: 'visible' });

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#open').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  if (!await popup.getByText('popup-ready', { exact: true }).isVisible()) {
    throw new Error('The popup did not render its expected content');
  }
  await popup.close();

  const dialogPromise = new Promise((resolve, reject) => {
    page.once('dialog', async (dialog) => {
      try {
        if (dialog.message() !== 'compat-dialog') throw new Error('Unexpected dialog text');
        await dialog.accept();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  await page.locator('#alert').click();
  await dialogPromise;
  await captureScreenshot(page, 'phase-one.png');
  await context.close();
  context = null;

  context = await launch();
  page = context.pages()[0] || await context.newPage();
  await page.goto(testUrl, { waitUntil: 'domcontentloaded' });
  const restoredMarker = await page.evaluate(() => localStorage.getItem('compat-marker'));
  if (restoredMarker !== marker) throw new Error('Persistent profile state was not restored');
  await captureScreenshot(page, 'phase-two.png');

  const iterations = Math.max(1, Math.ceil(durationMs / heartbeatMs));
  for (let index = 1; index <= iterations; index += 1) {
    await page.waitForTimeout(Math.min(heartbeatMs, Math.max(0, durationMs - ((index - 1) * heartbeatMs))));
    const title = await page.title();
    if (title !== 'Playwright compatibility') throw new Error(`Unexpected page title: ${title}`);
    await writeJson('heartbeat.json', {
      status: 'running',
      runnerId,
      display,
      iteration: index,
      iterations,
      checkedAt: new Date().toISOString(),
    });
  }

  await captureScreenshot(page, 'completed.png');
  await writeJson('result.json', {
    status: 'passed',
    runnerId,
    display,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs,
    persistentProfileRestored: true,
    popupPassed: true,
    dialogPassed: true,
    screenshotPassed: true,
  });
} catch (error) {
  await writeJson('result.json', {
    status: 'failed',
    runnerId,
    display,
    startedAt,
    failedAt: new Date().toISOString(),
    error: error instanceof Error ? error.stack || error.message : String(error),
  }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
