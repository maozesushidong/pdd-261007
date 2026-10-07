import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = (await fsp.readFile(path.join(root, 'workflow.mjs'), 'utf8'))
  .replace(/\r\n/g, '\n');
const uploaderStart = workflowSource.indexOf('const uploadTmsEvidenceToPdd = async');
const uploaderEnd = workflowSource.indexOf('\n\nconst hasConsumableTmsEvidence =', uploaderStart);
const ordinaryUploaderStart = workflowSource.indexOf('const uploadOrdinaryScenarioEvidence = async');
const ordinaryUploaderEnd = workflowSource.indexOf('\n\nconst applyOrdinaryPddFormDecisionOnce =', ordinaryUploaderStart);
assert(uploaderStart >= 0 && uploaderEnd > uploaderStart,
  'PDD evidence uploader source is missing');
assert(ordinaryUploaderStart >= 0 && ordinaryUploaderEnd > ordinaryUploaderStart,
  'ordinary evidence uploader source is missing');
const uploaderSource = workflowSource.slice(uploaderStart, uploaderEnd);
const ordinaryUploaderSource = workflowSource.slice(ordinaryUploaderStart, ordinaryUploaderEnd);
assert.match(uploaderSource, /finally \{\n\s+await bucketFallbackControl\?\.dispose\(\);\n\s+\}/u,
  'PDD evidence bucket fallback must be disposed by its owning uploader');
assert.doesNotMatch(ordinaryUploaderSource, /bucketFallbackControl/u,
  'ordinary uploader must not reference the inner uploader bucket fallback control');
assert.match(uploaderSource,
  /responseJson = JSON\.parse\(responseText\);[\s\S]*JSON\.stringify\(redactUploadDiagnostic\(responseJson\)\)/u,
  'PDD upload JSON response diagnostics must redact temporary credentials');
const helperStart = workflowSource.indexOf('const pddEvidenceFileChooserTimeoutMs =');
const helperEnd = workflowSource.indexOf('\n\nconst uploadTmsEvidenceToPdd = async', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart,
  'PDD evidence upload file-selection helper source is missing');
const helperSource = workflowSource.slice(helperStart, helperEnd);
const formProofStart = workflowSource.indexOf('const pddEvidenceImageRetainedInDom =');
const formProofEnd = workflowSource.indexOf('\n\nconst checkForHumanVerification =', formProofStart);
assert(formProofStart >= 0 && formProofEnd > formProofStart,
  'PDD evidence form-attachment proof is missing');
const formProofSandbox = {};
vm.runInNewContext(
  `${workflowSource.slice(formProofStart, formProofEnd)}\n`
    + 'globalThis.__formProof = { pddEvidenceImageRetainedInDom, pddEvidenceUploadedMarkerVisible };',
  formProofSandbox,
  { filename: 'workflow-pdd-evidence-form-proof.mjs' },
);
const { pddEvidenceImageRetainedInDom, pddEvidenceUploadedMarkerVisible } = formProofSandbox.__formProof;
assert.match(uploaderSource,
  /if \(!uploadPending && \(successMarkerVisible \|\| imageRetained\)\)/u,
  'upload completion must require the current form to retain the image or show a completed upload marker');
assert.match(ordinaryUploaderSource,
  /if \(prior\) \{\s*if \(!await pddEvidenceUploadedMarkerVisible\(targetPage\)\)/u,
  'a prior upload receipt must not authorize a fresh form without an attachment marker');

const firstVisible = async (candidates) => {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
};
const pacedAction = async (_page, _stage, action) => action();
const sandbox = {
  Error,
  Number,
  Object,
  Promise,
  String,
  URL,
  firstVisible,
  pacedAction,
  process: { env: { PDD_EVIDENCE_FILE_CHOOSER_TIMEOUT_MS: '200' } },
};
vm.runInNewContext(
  `${helperSource}\nglobalThis.__pddEvidenceUpload = {\n`
    + '  setPddEvidenceUploadFile,\n'
    + '  installPddEvidenceUploadBucketFallback,\n'
    + '  parsePddEvidenceImageUploadReceipt,\n'
    + '};',
  sandbox,
  { filename: 'workflow-pdd-evidence-upload-file-selection.mjs' },
);
const {
  setPddEvidenceUploadFile,
  installPddEvidenceUploadBucketFallback,
  parsePddEvidenceImageUploadReceipt,
} = sandbox.__pddEvidenceUpload;

assert.deepEqual(
  JSON.parse(JSON.stringify(parsePddEvidenceImageUploadReceipt({
    requestUrl: 'https://file.pinduoduo.com/v3/store_image',
    status: 200,
    body: {
      url: 'https://img.pddpic.com/evidence/example.png',
      etag: 'example-etag',
      size: 128,
      width: 640,
      height: 480,
    },
  }))),
  {
    remoteUrl: 'https://img.pddpic.com/evidence/example.png',
    host: 'img.pddpic.com',
    status: 200,
    etag: 'example-etag',
    size: 128,
    width: 640,
    height: 480,
  },
);
assert.equal(parsePddEvidenceImageUploadReceipt({
  requestUrl: 'https://file.pinduoduo.com/v3/store_image',
  status: 200,
  body: { url: 'https://example.com/not-pdd.png', size: 128, width: 640, height: 480 },
}), null);
assert.equal(parsePddEvidenceImageUploadReceipt({
  requestUrl: 'https://file.pinduoduo.com/v3/store_image',
  status: 500,
  body: { url: 'https://img.pddpic.com/evidence/example.png', size: 128, width: 640, height: 480 },
}), null);

const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'D:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe',
  'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const uploadFile = {
  name: '260825-000000000000001.png',
  mimeType: 'image/png',
  buffer: Buffer.from('pdd-evidence-upload-self-test'),
};
let signatureServer = null;

try {
  const page = await browser.newPage();
  await page.setContent('<main><p>上传成功</p><button type="button">提交</button></main>');
  assert.equal(await page.getByRole('button', { name: '提交' }).isEnabled(), true);
  assert.equal(await pddEvidenceUploadedMarkerVisible(page), false,
    'an enabled submit button and success text do not prove the form has a credential');
  assert.equal(await pddEvidenceImageRetainedInDom(
    page, 'https://img.pddpic.com/evidence/example.png'), false);
  await page.setContent('<main><div class="ant-upload-list-item-done">凭证已附加</div></main>');
  assert.equal(await pddEvidenceUploadedMarkerVisible(page), true);
  await page.setContent('<main><img src="https://img.pddpic.com/evidence/example.png"></main>');
  assert.equal(await pddEvidenceImageRetainedInDom(
    page, 'https://img.pddpic.com/evidence/example.png'), true);
  assert.equal(await pddEvidenceImageRetainedInDom(
    page, 'https://img.pddpic.com/evidence/another.png'), false);

  await page.setContent(`
    <label class="beast-core-upload-trigger" role="button">
      <span>示例</span>
      <input type="file" accept=".jpg,.jpeg,.png" hidden>
      <span>上传图片</span>
    </label>
  `);
  const visibleEntryResult = await setPddEvidenceUploadFile(
    page,
    uploadFile,
    'visible-entry-test',
  );
  assert.equal(visibleEntryResult.interaction.method, 'visible-trigger-filechooser');
  assert.equal(visibleEntryResult.interaction.fallbackReason, null);
  assert.equal(visibleEntryResult.interaction.trigger.role, 'button');
  assert.equal(visibleEntryResult.fileInputs.length, 1);
  assert.equal(
    await page.locator('input[type="file"]').evaluate((input) => input.files?.[0]?.name),
    uploadFile.name,
  );

  await page.setContent(`
    <input type="file" accept=".png" hidden>
    <div class="upload-copy">上传图片</div>
  `);
  const fallbackResult = await setPddEvidenceUploadFile(
    page,
    uploadFile,
    'fallback-test',
  );
  assert.equal(fallbackResult.interaction.method, 'direct-file-input-fallback');
  assert.match(fallbackResult.interaction.fallbackReason, /filechooser|文件选择器/i);
  assert.equal(
    await page.locator('input[type="file"]').evaluate((input) => input.files?.[0]?.name),
    uploadFile.name,
  );

  await page.setContent('<main>没有上传控件</main>');
  await assert.rejects(
    () => setPddEvidenceUploadFile(page, uploadFile, 'missing-control-test'),
    (error) => error.message.includes('未找到可用的凭证上传控件')
      && error.pddEvidenceUploadInteraction?.method === 'unavailable'
      && Array.isArray(error.pddEvidenceUploadFileInputs),
  );

  const signatureRequests = [];
  signatureServer = http.createServer((request, response) => {
    if (request.url === '/detail') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<main>工单详情</main>');
      return;
    }
    if (request.url !== '/galerie/business/get_signature' || request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      signatureRequests.push(payload.bucket_tag);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload.bucket_tag === 'work-flow-ticket'
        ? { success: false, error_code: 48143, error_msg: '非法请求' }
        : { success: true, error_code: 1000000, result: { signature: 'test-signature' } }));
    });
  });
  await new Promise((resolve) => signatureServer.listen(0, '127.0.0.1', resolve));
  const { port } = signatureServer.address();
  await page.goto(`http://127.0.0.1:${port}/detail`);
  const fallback = await installPddEvidenceUploadBucketFallback(page);
  const signatureResult = await page.evaluate(async () => {
    const response = await fetch('/galerie/business/get_signature', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket_tag: 'work-flow-ticket' }),
    });
    return response.json();
  });
  assert.equal(signatureResult.success, true);
  assert.equal(signatureResult.result?.signature, 'test-signature');
  assert.deepEqual(signatureRequests, ['work-flow-ticket', 'pdd_mms']);
  const fallbackSnapshot = JSON.parse(JSON.stringify(fallback.snapshot()));
  assert.deepEqual(fallbackSnapshot, {
    primaryBucketTag: 'work-flow-ticket',
    fallbackBucketTag: 'pdd_mms',
    attempted: true,
    used: true,
    primaryErrorCode: 48143,
    fallbackErrorCode: null,
    fallbackErrorMessage: null,
    usedAt: fallbackSnapshot.usedAt,
  });
  assert.match(fallbackSnapshot.usedAt, /^\d{4}-\d{2}-\d{2}T/u);
  await fallback.dispose();

  const responseAfterDispose = await page.evaluate(async () => {
    const response = await fetch('/galerie/business/get_signature', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket_tag: 'work-flow-ticket' }),
    });
    return response.json();
  });
  assert.equal(responseAfterDispose.error_code, 48143);
} finally {
  if (signatureServer) {
    await new Promise((resolve) => signatureServer.close(resolve));
  }
  await browser.close();
}

console.log('PDD evidence upload UI self-test passed');
