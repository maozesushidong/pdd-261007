import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceDir = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(workspaceDir, '.codex'));
const args = new Map(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const separator = value.indexOf('=');
  return separator < 0 ? [value.slice(2), 'true'] : [value.slice(2, separator), value.slice(separator + 1)];
}));
const shopId = args.get('shop')?.trim();
const orderNumber = args.get('order')?.trim();
const dryRun = args.get('dry-run') === 'true';

const fail = (message) => { throw new Error(message); };
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(shopId || '')) fail('必须提供有效的 --shop=<shopId>');
if (!/^\d+(?:-\d+)+$/.test(orderNumber || '')) fail('必须提供有效的 --order=<订单编号>');

const shopDir = path.join(dataRoot, 'shops', shopId);
const progressPath = path.join(shopDir, 'state', 'workflow-progress.json');
const archiveDir = path.join(shopDir, 'state', 'completed-work-orders');
const archivePath = path.join(archiveDir, `${orderNumber}.json`);
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
};
const isInside = (parent, candidate) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const now = new Date().toISOString();
if (!fs.existsSync(progressPath)) fail(`进度文件不存在: ${progressPath}`);
const progress = readJson(progressPath);
if (progress.shopId && progress.shopId !== shopId) fail(`进度文件店铺不一致: ${progress.shopId}`);
if (progress.orderNumber && progress.orderNumber !== orderNumber) {
  fail(`当前进度订单不一致: ${progress.orderNumber}`);
}

let existing = null;
if (fs.existsSync(archivePath)) {
  existing = readJson(archivePath);
  if (existing.shopId !== shopId || existing.completionArchive?.orderNumber !== orderNumber
    || existing.completionArchive?.confirmationMethod !== 'user-confirmed-complete') {
    fail(`已存在冲突的归档: ${archivePath}`);
  }
}

const screenshot = progress.pddEvidenceScreenshot;
let screenshotPath = null;
if (screenshot?.status === 'ready') {
  if (screenshot.orderNumber !== orderNumber || screenshot.mimeType !== 'image/png') {
    fail('PDD 临时截图元数据与外部完成订单不一致');
  }
  screenshotPath = path.resolve(shopDir, screenshot.relativePath || '');
  const allowedDir = path.join(shopDir, 'tmp', 'tms-logistics-work-orders');
  if (!isInside(allowedDir, screenshotPath) || path.basename(screenshotPath) !== `${orderNumber}.png`) {
    fail('PDD 临时截图路径不在受控订单目录内');
  }
  if (!fs.existsSync(screenshotPath)) fail(`PDD 临时截图缺失: ${screenshotPath}`);
}

const deletedScreenshot = screenshot?.status === 'ready'
  ? { ...screenshot, status: 'deleted', deletedAt: now, relativePath: null }
  : screenshot;
const archive = existing || {
  ...progress,
  pddEvidenceScreenshot: deletedScreenshot,
  completionArchive: {
    shopId,
    orderNumber,
    status: 'externally-confirmed',
    confirmationMethod: 'user-confirmed-complete',
    outcome: null,
    confirmedAt: now,
    archivedAt: now,
  },
};

const nextProgress = {
  run: 'continuous-work-order-loop',
  step: 'next-order-ready',
  shopId,
  targetWorkOrderTitle: progress.targetWorkOrderTitle || '订单问题：在途无理由退款处理',
  browserMode: progress.browserMode || process.env.WORKFLOW_BROWSER_MODE || 'headed',
  workflowDataDir: shopDir,
  systemTabs: progress.systemTabs || {},
  authHealth: progress.authHealth || {},
  authCheckpoint: progress.authCheckpoint || null,
  loopState: {
    ...(progress.loopState || {}),
    status: 'processing',
    currentOrderNumber: null,
    nextPollAt: null,
    skippedOrderNumbers: [...new Set([...(progress.loopState?.skippedOrderNumbers || []), orderNumber])],
  },
  lastCompletedOrder: {
    orderNumber,
    outcome: null,
    confirmationMethod: 'user-confirmed-complete',
    status: 'externally-confirmed',
    confirmedAt: now,
    archivedAt: now,
  },
  error: null,
};

if (dryRun) {
  console.log(JSON.stringify({ shopId, orderNumber, archivePath, screenshotPath, wouldDeleteScreenshot: Boolean(screenshotPath) }, null, 2));
  process.exit(0);
}
if (!existing) writeJson(archivePath, archive);
if (screenshotPath) fs.rmSync(screenshotPath, { force: false });
writeJson(progressPath, nextProgress);
console.log(JSON.stringify({ shopId, orderNumber, status: 'externally-confirmed', archivePath, screenshotDeleted: Boolean(screenshotPath) }, null, 2));
