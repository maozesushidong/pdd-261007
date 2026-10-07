import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
export const DEFAULT_DATA_ROOT = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(PROJECT_ROOT, '.codex'));
export const MIGRATION_VERSION = 1;

const SHOP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ORDER_NUMBER_PATTERN = /^\d{6}-\d{15}$/;
const UNSAFE_STEP_PATTERN = /(submitting|submit-pending|creating|uploading|executing)/i;
const SECRET_KEY_PATTERN = /^(password|passwd|pwd|secret|cookie|cookies|access[_-]?token|refresh[_-]?token|storage[_-]?state)$/i;
const IMPORTABLE_SHOP_PATHS = [
  'state/workflow-progress.json',
  'state/completed-work-orders',
  'tmp',
  'diagnostics',
];
const FORBIDDEN_SEGMENTS = new Set(['auth', 'browser-profile', 'locks']);

export function parseCliArgs(argv = process.argv.slice(2)) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      result[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[rawKey] = next;
      index += 1;
    } else {
      result[rawKey] = true;
    }
  }
  return result;
}

export function isoFileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function assertInside(root, candidate, label = 'path') {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes the allowed root`);
  }
  return resolvedCandidate;
}

export async function readJsonStrict(file) {
  const text = await fsp.readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${file}: ${error.message}`, { cause: error });
  }
}

export async function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${root}`);
  if (rootStat.isFile()) return [root];
  const result = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${file}`);
      if (entry.isDirectory()) queue.push(file);
      else if (entry.isFile()) result.push(file);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function deterministicUuid(namespace, value) {
  const bytes = crypto.createHash('sha256').update(`${namespace}\0${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    output[key] = scrubSecrets(child);
  }
  return output;
}

function isForbiddenRelativePath(relativePath) {
  return toPosix(relativePath).split('/').some((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

async function configuredShops(projectRoot = PROJECT_ROOT) {
  const configFile = path.join(projectRoot, 'shops.config.json');
  const config = await readJsonStrict(configFile);
  if (!Array.isArray(config.shops)) throw new Error('shops.config.json must contain a shops array');
  const ids = new Set();
  for (const shop of config.shops) {
    if (!SHOP_ID_PATTERN.test(String(shop.shopId || ''))) throw new Error(`Invalid shopId: ${shop.shopId}`);
    if (ids.has(shop.shopId)) throw new Error(`Duplicate shopId: ${shop.shopId}`);
    ids.add(shop.shopId);
  }
  return { file: configFile, config };
}

export async function collectImportableFiles({ dataRoot = DEFAULT_DATA_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  const resolvedDataRoot = path.resolve(dataRoot);
  const { file: shopConfigFile, config } = await configuredShops(projectRoot);
  const files = [shopConfigFile];
  const scenarioFile = path.join(projectRoot, 'config', 'scenarios.json');
  if (fs.existsSync(scenarioFile)) files.push(scenarioFile);

  for (const shop of config.shops) {
    const shopRoot = assertInside(path.join(resolvedDataRoot, 'shops'), path.join(resolvedDataRoot, 'shops', shop.shopId), 'shop root');
    for (const relative of IMPORTABLE_SHOP_PATHS) {
      const candidate = assertInside(shopRoot, path.join(shopRoot, ...relative.split('/')), 'importable path');
      for (const file of await walkFiles(candidate)) {
        const shopRelative = path.relative(shopRoot, file);
        if (isForbiddenRelativePath(shopRelative)) throw new Error(`Forbidden path selected for migration: ${file}`);
        files.push(file);
      }
    }
  }
  return [...new Set(files.map((file) => path.resolve(file)))].sort((left, right) => left.localeCompare(right));
}

function extractScreenshotReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) extractScreenshotReferences(item, references);
    return references;
  }
  if (!value || typeof value !== 'object') return references;
  if (typeof value.relativePath === 'string' && value.relativePath && String(value.mimeType || '').toLowerCase() === 'image/png') {
    references.push({ relativePath: value.relativePath, status: value.status || null, orderNumber: value.orderNumber || null });
  }
  for (const child of Object.values(value)) extractScreenshotReferences(child, references);
  return references;
}

async function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function validateLegacyData({ dataRoot = DEFAULT_DATA_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  const errors = [];
  const warnings = [];
  const shops = [];
  const resolvedDataRoot = path.resolve(dataRoot);
  let config;
  try {
    ({ config } = await configuredShops(projectRoot));
  } catch (error) {
    return { valid: false, safeToSnapshot: false, errors: [error.message], warnings, shops };
  }

  for (const configuredShop of config.shops) {
    const shopId = configuredShop.shopId;
    const shopRoot = path.join(resolvedDataRoot, 'shops', shopId);
    const progressFile = path.join(shopRoot, 'state', 'workflow-progress.json');
    const completedRoot = path.join(shopRoot, 'state', 'completed-work-orders');
    const summary = {
      shopId,
      progressStep: null,
      currentOrderNumber: null,
      completedOrders: 0,
      jsonFiles: 0,
      pngFiles: 0,
      screenshotReferences: 0,
      totalFiles: 0,
      totalBytes: 0,
      activeLockPids: [],
    };
    if (!fs.existsSync(shopRoot)) {
      errors.push(`[${shopId}] shop directory is missing`);
      shops.push(summary);
      continue;
    }

    let progress = null;
    if (!fs.existsSync(progressFile)) errors.push(`[${shopId}] workflow-progress.json is missing`);
    else {
      try {
        progress = await readJsonStrict(progressFile);
        summary.progressStep = progress.step || null;
        summary.currentOrderNumber = progress.orderNumber || progress.loopState?.currentOrderNumber || null;
        if (progress.shopId && progress.shopId !== shopId) errors.push(`[${shopId}] progress shopId does not match its directory`);
        if (UNSAFE_STEP_PATTERN.test(String(progress.step || ''))) {
          errors.push(`[${shopId}] current step may be mutating external state: ${progress.step}`);
        }
      } catch (error) {
        errors.push(`[${shopId}] ${error.message}`);
      }
    }

    for (const completedFile of await walkFiles(completedRoot)) {
      if (path.extname(completedFile).toLowerCase() !== '.json') continue;
      try {
        const completed = await readJsonStrict(completedFile);
        const expectedOrder = path.basename(completedFile, '.json');
        const actualOrder = completed.orderNumber || completed.completionArchive?.orderNumber;
        if (!ORDER_NUMBER_PATTERN.test(expectedOrder)) warnings.push(`[${shopId}] unusual completed-order filename: ${expectedOrder}`);
        if (actualOrder && actualOrder !== expectedOrder) errors.push(`[${shopId}] completed order number mismatch: ${expectedOrder}`);
        if (completed.shopId && completed.shopId !== shopId) errors.push(`[${shopId}] completed order has mismatched shopId: ${expectedOrder}`);
        summary.completedOrders += 1;
      } catch (error) {
        errors.push(`[${shopId}] ${error.message}`);
      }
    }

    const lockRoot = path.join(shopRoot, 'locks');
    for (const lockFile of await walkFiles(lockRoot)) {
      try {
        const text = (await fsp.readFile(lockFile, 'utf8')).trim();
        const parsed = text ? JSON.parse(text) : {};
        const pid = Number(parsed.pid || text);
        if (await isPidRunning(pid)) summary.activeLockPids.push(pid);
      } catch {
        warnings.push(`[${shopId}] unreadable lock file: ${path.basename(lockFile)}`);
      }
    }
    if (summary.activeLockPids.length) errors.push(`[${shopId}] workflow lock belongs to a running process`);

    const importableRoots = IMPORTABLE_SHOP_PATHS.map((relative) => path.join(shopRoot, ...relative.split('/')));
    const importableFiles = [];
    for (const root of importableRoots) importableFiles.push(...await walkFiles(root));
    for (const file of [...new Set(importableFiles)]) {
      const relative = path.relative(shopRoot, file);
      if (isForbiddenRelativePath(relative)) {
        errors.push(`[${shopId}] forbidden sensitive path selected: ${relative}`);
        continue;
      }
      const stat = await fsp.stat(file);
      summary.totalFiles += 1;
      summary.totalBytes += stat.size;
      const extension = path.extname(file).toLowerCase();
      if (extension === '.json') {
        summary.jsonFiles += 1;
        try {
          const value = await readJsonStrict(file);
          const references = extractScreenshotReferences(value);
          summary.screenshotReferences += references.length;
          for (const reference of references) {
            const referencedFile = assertInside(shopRoot, path.join(shopRoot, reference.relativePath), 'screenshot reference');
            const isDeleted = ['deleted', 'consumed'].includes(String(reference.status || '').toLowerCase());
            if (!isDeleted && !fs.existsSync(referencedFile)) {
              errors.push(`[${shopId}] live screenshot reference is missing: ${reference.relativePath}`);
            }
          }
        } catch (error) {
          errors.push(`[${shopId}] ${error.message}`);
        }
      } else if (extension === '.png') {
        summary.pngFiles += 1;
        const signature = Buffer.alloc(8);
        const handle = await fsp.open(file, 'r');
        try { await handle.read(signature, 0, 8, 0); } finally { await handle.close(); }
        if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) errors.push(`[${shopId}] invalid PNG signature: ${relative}`);
      }
    }
    if (!summary.currentOrderNumber && summary.progressStep !== 'flow-paused') {
      warnings.push(`[${shopId}] no current order number is present`);
    }
    shops.push(summary);
  }

  return {
    valid: errors.length === 0,
    safeToSnapshot: errors.length === 0,
    generatedAt: new Date().toISOString(),
    dataRoot: resolvedDataRoot,
    errors,
    warnings,
    totals: shops.reduce((totals, shop) => ({
      completedOrders: totals.completedOrders + shop.completedOrders,
      jsonFiles: totals.jsonFiles + shop.jsonFiles,
      pngFiles: totals.pngFiles + shop.pngFiles,
      files: totals.files + shop.totalFiles,
      bytes: totals.bytes + shop.totalBytes,
    }), { completedOrders: 0, jsonFiles: 0, pngFiles: 0, files: 0, bytes: 0 }),
    shops,
  };
}

export async function createMigrationManifest({ dataRoot = DEFAULT_DATA_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  const validation = await validateLegacyData({ dataRoot, projectRoot });
  if (!validation.valid) throw new Error(`Legacy data validation failed:\n${validation.errors.join('\n')}`);
  const resolvedDataRoot = path.resolve(dataRoot);
  const files = [];
  for (const file of await collectImportableFiles({ dataRoot, projectRoot })) {
    const stat = await fsp.stat(file);
    let logicalPath;
    if (file.startsWith(`${resolvedDataRoot}${path.sep}`)) logicalPath = toPosix(path.relative(resolvedDataRoot, file));
    else logicalPath = `project/${toPosix(path.relative(projectRoot, file))}`;
    files.push({
      logicalPath,
      sourcePath: file,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      sha256: await sha256File(file),
    });
  }
  return {
    schemaVersion: MIGRATION_VERSION,
    kind: 'legacy-migration-manifest',
    generatedAt: new Date().toISOString(),
    dataRoot: resolvedDataRoot,
    projectRoot: path.resolve(projectRoot),
    exclusions: ['shops/*/auth/**', 'shops/*/browser-profile/**', 'shops/*/locks/**'],
    validation,
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      completedOrders: validation.totals.completedOrders,
      pngFiles: validation.totals.pngFiles,
    },
  };
}

function normalizeStatus(progress, archived) {
  if (archived) return 'archived';
  const step = String(progress.step || 'not-started');
  if (/manual-review|flow-paused/i.test(step)) return 'paused';
  if (/succeeded|completed|next-order-ready/i.test(step)) return 'completed';
  if (/failed|error/i.test(step)) return 'failed';
  return 'processing';
}

function inferScenarioCode(progress) {
  return progress.scenarioCode || progress.pddResolutionFlow?.scenarioCode || 'in-transit-refund';
}

function inferTmsPayload(progress) {
  if (!progress.tmsWorkOrder && !progress.tmsFormDecision && !progress.tmsRoutingDecision) return null;
  return scrubSecrets({
    workOrder: progress.tmsWorkOrder || null,
    duplicateCheck: progress.tmsDuplicateCheck || null,
    routingDecision: progress.tmsRoutingDecision || null,
    formDecision: progress.tmsFormDecision || null,
    autofillVerification: progress.tmsAutofillVerification || null,
    attachmentTransfer: progress.tmsAttachmentTransfer || null,
  });
}

function findOrderNumber(progress, fallback = null) {
  return progress.orderNumber || progress.completionArchive?.orderNumber || progress.loopState?.currentOrderNumber || fallback;
}

export async function buildMigrationPlan({ dataRoot = DEFAULT_DATA_ROOT, projectRoot = PROJECT_ROOT, manifest = null } = {}) {
  const sourceManifest = manifest || await createMigrationManifest({ dataRoot, projectRoot });
  const { config: shopConfig } = await configuredShops(projectRoot);
  const scenarioConfig = fs.existsSync(path.join(projectRoot, 'config', 'scenarios.json'))
    ? await readJsonStrict(path.join(projectRoot, 'config', 'scenarios.json'))
    : { scenarios: [] };
  const resolvedDataRoot = path.resolve(dataRoot);
  const plan = {
    schemaVersion: MIGRATION_VERSION,
    migrationId: deterministicUuid('legacy-migration', sourceManifest.files.map((file) => file.sha256).join(':')),
    generatedAt: new Date().toISOString(),
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(sourceManifest.files.map(({ logicalPath, sha256 }) => ({ logicalPath, sha256 })))).digest('hex'),
    sourceManifest,
    shops: [],
    scenarioDefinitions: [],
    workOrders: [],
    workflowRuns: [],
    logisticsAnalyses: [],
    omsAnalyses: [],
    tmsWorkOrders: [],
    evidenceAssets: [],
    verificationLocations: [],
    auditEvents: [],
  };

  for (const scenario of scenarioConfig.scenarios || []) {
    plan.scenarioDefinitions.push({
      code: scenario.code,
      titlePatterns: scenario.titlePatterns || [],
      policyVersion: Number(scenario.policyVersion || 1),
      enabled: scenario.enabled !== false,
      config: scrubSecrets(scenario),
    });
  }

  const workOrderByShopAndOrder = new Map();
  const progressByShop = new Map();
  for (const shop of shopConfig.shops) {
    plan.shops.push({ id: shop.shopId, name: shop.expectedShopName || shop.shopId, enabled: shop.enabled !== false, ruleVersion: 1 });
    const shopRoot = path.join(resolvedDataRoot, 'shops', shop.shopId);
    const progressFile = path.join(shopRoot, 'state', 'workflow-progress.json');
    const progress = fs.existsSync(progressFile) ? await readJsonStrict(progressFile) : {};
    progressByShop.set(shop.shopId, progress);
    const records = [];
    const currentOrder = findOrderNumber(progress);
    if (currentOrder) records.push({ progress, orderNumber: currentOrder, archived: false, sourcePath: progressFile });
    for (const file of await walkFiles(path.join(shopRoot, 'state', 'completed-work-orders'))) {
      if (path.extname(file).toLowerCase() !== '.json') continue;
      const completed = await readJsonStrict(file);
      records.push({ progress: completed, orderNumber: findOrderNumber(completed, path.basename(file, '.json')), archived: true, sourcePath: file });
    }

    for (const record of records) {
      if (!record.orderNumber) continue;
      const workOrderType = record.progress.workOrderType || record.progress.targetWorkOrderTitle || 'unknown';
      const workOrderId = deterministicUuid('work-order', `${shop.shopId}:${record.orderNumber}:${workOrderType}`);
      const idempotencyKey = `legacy:${shop.shopId}:${record.orderNumber}:${crypto.createHash('sha256').update(workOrderType).digest('hex').slice(0, 16)}`;
      const status = normalizeStatus(record.progress, record.archived);
      const sourceRelativePath = toPosix(path.relative(resolvedDataRoot, record.sourcePath));
      plan.workOrders.push({
        id: workOrderId,
        shopId: shop.shopId,
        externalOrderNumber: record.orderNumber,
        workOrderType,
        scenarioCode: inferScenarioCode(record.progress),
        status,
        idempotencyKey,
        currentStep: record.progress.step || null,
        payload: scrubSecrets(record.progress),
        manualReviewReason: record.progress.manualReview?.reason || record.progress.error?.message || null,
        createdAt: record.progress.createdAt || record.progress.updatedAt || new Date(0).toISOString(),
        updatedAt: record.progress.updatedAt || record.progress.completionArchive?.archivedAt || new Date(0).toISOString(),
        sourceRelativePath,
      });
      workOrderByShopAndOrder.set(`${shop.shopId}:${record.orderNumber}`, workOrderId);
      plan.workflowRuns.push({
        id: deterministicUuid('workflow-run', `${workOrderId}:legacy`),
        workOrderId,
        workerId: 'legacy-windows-worker',
        status,
        startedAt: record.progress.createdAt || record.progress.updatedAt || new Date(0).toISOString(),
        finishedAt: record.archived ? (record.progress.completionArchive?.archivedAt || record.progress.updatedAt || null) : null,
        error: scrubSecrets(record.progress.error || null),
      });
      if (record.progress.logisticsAnalysis) plan.logisticsAnalyses.push({ workOrderId, payload: scrubSecrets(record.progress.logisticsAnalysis) });
      if (record.progress.omsAnalysis) plan.omsAnalyses.push({ workOrderId, payload: scrubSecrets(record.progress.omsAnalysis) });
      const tmsPayload = inferTmsPayload(record.progress);
      if (tmsPayload) {
        const requestHash = crypto.createHash('sha256').update(JSON.stringify(tmsPayload)).digest('hex');
        plan.tmsWorkOrders.push({
          id: deterministicUuid('tms-work-order', `${workOrderId}:${inferScenarioCode(record.progress)}:${requestHash}`),
          workOrderId,
          scenarioCode: inferScenarioCode(record.progress),
          externalTicketId: record.progress.tmsWorkOrder?.ticketId || record.progress.tmsWorkOrder?.ticketNo || null,
          status: record.progress.tmsWorkOrder?.status || record.progress.tmsFormDecision?.status || 'legacy-recorded',
          requestHash,
          payload: tmsPayload,
        });
      }
      if (record.progress.verificationLocation) {
        const location = scrubSecrets(record.progress.verificationLocation);
        plan.verificationLocations.push({
          id: location.id || deterministicUuid('verification-location', `${workOrderId}:${location.system}:${location.stage}:${location.detectedAt}`),
          shopId: shop.shopId,
          workOrderId,
          systemName: location.system || location.systemName || 'pdd',
          stage: location.stage || 'unknown',
          status: location.status || 'detected',
          url: location.url || '',
          frameUrl: location.frameUrl || null,
          selector: location.selector || null,
          boundingBox: location.boundingBox || { x: 0, y: 0, width: 0, height: 0 },
          confidence: location.confidence || 'low',
          detectedAt: location.detectedAt || record.progress.updatedAt || new Date(0).toISOString(),
          resolvedAt: location.resolvedAt || null,
        });
      }
      plan.auditEvents.push({
        shopId: shop.shopId,
        workOrderId,
        actorId: 'legacy-migrator',
        eventType: 'legacy-work-order-imported',
        payload: { sourceRelativePath, sourceStatus: record.progress.step || null, archived: record.archived },
        createdAt: record.progress.updatedAt || new Date(0).toISOString(),
      });
    }
  }

  const manifestBySourcePath = new Map(sourceManifest.files.map((entry) => [path.resolve(entry.sourcePath), entry]));
  for (const shop of shopConfig.shops) {
    const shopRoot = path.join(resolvedDataRoot, 'shops', shop.shopId);
    for (const area of ['tmp', 'diagnostics']) {
      for (const file of await walkFiles(path.join(shopRoot, area))) {
        if (path.extname(file).toLowerCase() !== '.png') continue;
        const manifestEntry = manifestBySourcePath.get(path.resolve(file));
        if (!manifestEntry) throw new Error(`Evidence file is absent from source manifest: ${file}`);
        const relativePath = toPosix(path.relative(shopRoot, file));
        const orderMatch = relativePath.match(/\d{6}-\d{15}/)?.[0] || null;
        const workOrderId = orderMatch ? workOrderByShopAndOrder.get(`${shop.shopId}:${orderMatch}`) || null : null;
        const kind = relativePath.startsWith('tmp/pdd-work-order-replies/') ? 'tms-work-order-screenshot'
          : relativePath.startsWith('tmp/tms-logistics-work-orders/') ? 'pdd-detail-screenshot'
            : 'diagnostic-screenshot';
        plan.evidenceAssets.push({
          id: deterministicUuid('evidence', `${shop.shopId}:${relativePath}:${manifestEntry.sha256}`),
          shopId: shop.shopId,
          workOrderId,
          kind,
          status: 'ready',
          objectKey: `legacy/${shop.shopId}/${relativePath}`,
          mimeType: 'image/png',
          sizeBytes: manifestEntry.sizeBytes,
          sha256: manifestEntry.sha256,
          sourcePath: file,
          sourceRelativePath: toPosix(path.relative(resolvedDataRoot, file)),
        });
      }
    }
    const progress = progressByShop.get(shop.shopId) || {};
    plan.auditEvents.push({
      shopId: shop.shopId,
      workOrderId: null,
      actorId: 'legacy-migrator',
      eventType: 'legacy-shop-snapshot-imported',
      payload: { step: progress.step || null, updatedAt: progress.updatedAt || null, manifestHash: plan.manifestHash },
      createdAt: progress.updatedAt || new Date().toISOString(),
    });
  }

  return plan;
}

export function migrationPlanSummary(plan) {
  return {
    migrationId: plan.migrationId,
    manifestHash: plan.manifestHash,
    shops: plan.shops.length,
    scenarioDefinitions: plan.scenarioDefinitions.length,
    workOrders: plan.workOrders.length,
    workflowRuns: plan.workflowRuns.length,
    logisticsAnalyses: plan.logisticsAnalyses.length,
    omsAnalyses: plan.omsAnalyses.length,
    tmsWorkOrders: plan.tmsWorkOrders.length,
    evidenceAssets: plan.evidenceAssets.length,
    verificationLocations: plan.verificationLocations.length,
    auditEvents: plan.auditEvents.length,
    evidenceBytes: plan.evidenceAssets.reduce((total, evidence) => total + evidence.sizeBytes, 0),
  };
}
