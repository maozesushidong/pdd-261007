import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = (await fsp.readFile(path.join(root, 'workflow.mjs'), 'utf8'))
  .replace(/\r\n/g, '\n');
const helperStart = workflowSource.indexOf('const tmsAttachmentSuccessSelector =');
const helperEnd = workflowSource.indexOf('\n\nconst createTmsTicket = async', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'TMS attachment upload helper source is missing');
const helperSource = workflowSource.slice(helperStart, helperEnd);
const testOrderNumber = '260819-514452427111858';
const testEvidencePath = path.join(os.tmpdir(), `${testOrderNumber}.png`);
await fsp.writeFile(testEvidencePath, Buffer.from('tms-attachment-upload-self-test'));

const progressUpdates = [];
const progress = {};
const sandbox = {
  Date,
  Error,
  URL,
  console,
  path,
  readProgress: () => progress,
  writeProgress: (patch) => {
    Object.assign(progress, patch);
    progressUpdates.push(patch);
  },
  pacedAction: async (_page, _action, operation) => operation(),
  resolveReadyEvidenceScreenshot: (orderNumber) => ({
    absolutePath: testEvidencePath,
    metadata: { relativePath: `tmp/tms-logistics-work-orders/${orderNumber}.png` },
  }),
  findDeepValue: (value, keys) => {
    if (!value || typeof value !== 'object') return null;
    for (const key of keys) if (value[key]) return value[key];
    for (const child of Object.values(value)) {
      const found = sandbox.findDeepValue(child, keys);
      if (found !== null) return found;
    }
    return null;
  },
  readSuccessfulApiResponse: async (response) => response.json(),
};
vm.runInNewContext(
  `${helperSource}\nglobalThis.tmsAttachmentFunctions = { uploadPddEvidenceToTms, recoverTmsAttachmentFromVisibleThumbnail, isTmsAttachmentResponseTimeout };`,
  sandbox,
  { filename: 'workflow-tms-attachment-functions.mjs' },
);
const {
  uploadPddEvidenceToTms,
  recoverTmsAttachmentFromVisibleThumbnail,
  isTmsAttachmentResponseTimeout,
} = sandbox.tmsAttachmentFunctions;

const bundledChromeRoot = path.resolve(root, '..', 'runtime', 'chrome-for-testing');
const bundledChromeCandidates = fs.existsSync(bundledChromeRoot)
  ? fs.readdirSync(bundledChromeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(bundledChromeRoot, entry.name, 'chrome.exe'))
    .sort()
    .reverse()
  : [];
const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  ...bundledChromeCandidates,
  'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

try {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="el-dialog logistics-dialog">
      <div class="el-upload"><input type="file"></div>
      <ul class="el-upload-list"></ul>
    </div>
    <script>
      document.querySelector('input[type="file"]').addEventListener('change', (event) => {
        setTimeout(() => {
          const item = document.createElement('li');
          item.className = 'el-upload-list__item is-success';
          item.dataset.uid = 'dom-upload-1';
          item.innerHTML = '<span class="el-upload-list__item-name" title="260819-514452427111858.png">260819-514452427111858.png</span>';
          document.querySelector('.el-upload-list').appendChild(item);
        }, 25);
      });
    </script>
  `);
  const dialog = page.locator('.logistics-dialog');
  const transfer = await uploadPddEvidenceToTms(
    page,
    dialog,
    testOrderNumber,
  );
  assert.equal(transfer.status, 'uploaded');
  assert.equal(transfer.confirmationMethod, 'dom-success-without-captured-response');
  assert.equal(transfer.attachmentId, 'dom-upload-1');
  assert.equal(transfer.domReceipt.fileNameMatched, true);
  assert.equal(progressUpdates.at(-1).step, 'tms-attachment-uploaded');

  await page.locator('.el-upload-list').evaluate((list) => {
    const item = document.createElement('li');
    item.className = 'el-upload-list__item is-ready';
    item.innerHTML = '<span class="el-upload-list__item-delete">remove</span>';
    item.querySelector('.el-upload-list__item-delete').addEventListener('click', () => item.remove());
    list.appendChild(item);
  });
  const retriedTransfer = await uploadPddEvidenceToTms(page, dialog, testOrderNumber);
  assert.equal(retriedTransfer.status, 'uploaded');
  assert.equal(retriedTransfer.diagnostics.cleanup.observedCount, 1);
  assert.equal(retriedTransfer.diagnostics.cleanup.removedCount, 1);
  assert.equal(retriedTransfer.diagnostics.cleanup.remainingCount, 0);
  assert.equal(await dialog.locator('.el-upload-list__item.is-ready').count(), 0);

  progressUpdates.length = 0;
  const recovered = await recoverTmsAttachmentFromVisibleThumbnail(
    dialog,
    testOrderNumber,
    {
      orderNumber: testOrderNumber,
      status: 'failed',
      error: 'page.waitForResponse: Timeout 60000ms exceeded while waiting for event "response"',
    },
  );
  assert.equal(isTmsAttachmentResponseTimeout(recovered?.error), false);
  assert.equal(recovered.status, 'uploaded');
  assert.equal(recovered.confirmationMethod, 'recovered-existing-dom-success');
  assert.equal(progressUpdates.at(-1).step, 'tms-attachment-uploaded');

  assert.equal(await recoverTmsAttachmentFromVisibleThumbnail(
    dialog,
    testOrderNumber,
    {
      orderNumber: testOrderNumber,
      status: 'failed',
      error: 'TMS 客服附件接口返回 HTTP 500',
    },
  ), null, 'a definitive upload failure must not be recovered from a stale thumbnail');

  await page.setContent(`
    <div class="el-dialog logistics-dialog">
      <div class="el-upload"><input type="file"></div>
      <ul class="el-upload-list"></ul>
      <button type="button" id="cancel">取消</button>
    </div>
    <script>
      document.querySelector('input[type="file"]').addEventListener('change', (event) => {
        const body = new FormData();
        body.append('files', event.target.files[0]);
        fetch('https://tms.test/api/logistics/files', { method: 'POST', body }).catch(() => {});
      });
      document.querySelector('#cancel').addEventListener('click', () => {
        document.querySelector('.logistics-dialog').style.display = 'none';
      });
    </script>
  `);
  await page.route('https://tms.test/api/logistics/files', (route) => route.abort('connectionfailed'));
  const failedDialog = page.locator('.logistics-dialog');
  const failureStartedAt = Date.now();
  await assert.rejects(
    () => uploadPddEvidenceToTms(page, failedDialog, testOrderNumber),
    /TMS_ATTACHMENT_UPLOAD_TEMPORARILY_UNAVAILABLE: TMS 客服附件上传请求失败/u,
  );
  assert.ok(Date.now() - failureStartedAt < 10_000, 'request failure must not wait for the 60-second response timeout');
  assert.equal(progress.tmsAttachmentTransfer.status, 'failed');
  assert.equal(progress.tmsAttachmentTransfer.diagnostics.requestObserved, true);
  assert.equal(progress.tmsAttachmentTransfer.diagnostics.requestFailed, true);
  assert.equal(progress.tmsAttachmentTransfer.diagnostics.dismissedDirtyDialog, true);
  assert.equal(await failedDialog.isVisible(), false);
} finally {
  await browser.close();
  await fsp.rm(testEvidencePath, { force: true });
}

console.log('TMS attachment upload UI self-test passed');
