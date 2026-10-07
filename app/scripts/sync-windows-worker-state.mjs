import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalScenarioCode } from '../packages/domain/src/scenario-code.mjs';
import {
  workflowEventSemanticJson,
  workflowEventSeverity,
} from '../packages/domain/src/workflow-event-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex'));
const apiUrl = String(process.env.WORKER_SYNC_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const sourceId = process.env.WORKER_SYNC_SOURCE_ID || 'windows-native';
const pollIntervalMs = Math.max(1000, Number(process.env.WORKER_SYNC_INTERVAL_MS || 5000));
const configuredMaxEventsPerRun = Number(process.env.WORKER_SYNC_MAX_EVENTS_PER_RUN || 1000);
const maxEventsPerRun = Number.isFinite(configuredMaxEventsPerRun)
  ? Math.max(200, configuredMaxEventsPerRun)
  : 1000;
const cursorFile = path.join(dataRoot, 'sync', 'windows-worker-state.json');
const lockFile = path.join(dataRoot, 'sync', 'windows-worker-state.lock');
const tokenFile = path.resolve(process.env.WORKER_INGEST_TOKEN_FILE || path.join(root, 'secrets', 'staging', 'WORKER_INGEST_TOKEN'));
const initializeCursor = process.argv.includes('--initialize-cursor');
const once = process.argv.includes('--once') || initializeCursor;
const selfTestMode = process.argv.includes('--self-test');

const readJson = async (file, fallback = null) => {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
};

let ownsLock = false;
if (!once && !selfTestMode) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const acquire = () => {
    try {
      fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      ownsLock = true;
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  };
  if (!acquire()) {
    const existing = await readJson(lockFile, {});
    let alive = false;
    const existingPid = Number(existing.pid);
    if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
      try { process.kill(existingPid, 0); alive = true; } catch { /* stale lock */ }
    }
    if (alive) {
      console.log(`[Windows同步] 已有同步进程 ${existing.pid}，当前进程退出`);
      process.exit(0);
    }
    await fsp.unlink(lockFile).catch(() => {});
    if (!acquire()) throw new Error('Unable to acquire Windows sync lock');
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stableEventKey = (...parts) => parts.map((part) => String(part || 'none').replace(/[^a-zA-Z0-9:._-]/g, '_')).join(':');

// The progress file doubles as a live browser heartbeat. Hash only durable
// business meaning so repeated scans and observations do not become events.
const snapshotEventHash = (snapshot = {}) => sha256(workflowEventSemanticJson(snapshot));

const outboxCoversSnapshot = (snapshotHash, events = []) => events.some((event) => (
  event?.payload?.snapshot
  && snapshotEventHash(event.payload.snapshot) === snapshotHash
));

const enabledShopsFromApiPayload = (payload = {}) => {
  const shops = Array.isArray(payload.data) ? payload.data : [];
  const seen = new Set();
  return shops.filter((shop) => {
    const shopId = String(shop?.shopId || '').trim();
    if (!shopId || shop?.enabled !== true || seen.has(shopId)) return false;
    seen.add(shopId);
    return true;
  }).map((shop) => ({ ...shop, shopId: String(shop.shopId).trim() }));
};

const loadEnabledShops = async (token) => {
  const response = await fetch(`${apiUrl}/api/v1/shops`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Shop API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return enabledShopsFromApiPayload(await response.json());
};

const runtimeStatus = (snapshot = {}) => {
  const step = String(snapshot.step || 'not-started');
  if (/complete|succeeded|archived|next-order-ready|requested-order-complete/.test(step)) return 'completed';
  if (/verification|login-required/.test(step)) return 'verification';
  if (/manual-review/.test(step)) return 'manual-review';
  if (/waiting|retry|rate-limit|queue-empty/.test(step)) return 'waiting';
  if (/paused|failed|error/.test(step) || snapshot.error) return 'failed';
  if (/not-started/.test(step)) return 'queued';
  return 'processing';
};

const reasonCode = (snapshot = {}) => {
  const step = String(snapshot.step || '');
  const reason = String(snapshot.error
    || (/manual-review/.test(step) ? snapshot.manualReview?.reason : '')
    || (/(?:consumer-response|logistics)-wait/.test(step) ? snapshot.logisticsWait?.reason : '')
    || '');
  if (snapshot.omsWarehouseParse?.status === 'out-of-scope'
    || /oms-warehouse-out-of-scope|warehouse-out-of-scope/.test(step)
    || /(?:发货)?仓库.*不在.*(?:业务处理)?范围|不在业务处理范围/.test(reason)) return 'warehouse-out-of-scope';
  if (/verification-(?:completed|cleared)/.test(step)) return null;
  if (/verification/.test(step)
    || /检测到人工验证|需要人工验证|验证码|滑块|安全验证/iu.test(reason)) return 'verification-required';
  if (/login-required/.test(step) || /登录/.test(reason)) return 'login-required';
  if (/rate-limit/.test(step) || /限流|频率/.test(reason)) return 'rate-limited';
  if (/consumer-response-wait/.test(step)) return 'waiting-consumer-response';
  if (/logistics-wait/.test(step)) return 'waiting-logistics';
  if (/manual-review/.test(step)) return 'manual-review-required';
  if (/unknown-scenario|unsupported-scenario/.test(step) || /未识别.*(?:场景|工单)/.test(reason)) return 'unknown-scenario';
  if (/缺少必选|未知选项|未见过.*选项|控件数量|无法唯一.*选项/.test(reason)) return 'unknown-page-option';
  if (/Failed to open a new tab|Target\.createTarget|page.*crash/i.test(reason)) return 'page-crashed';
  if (/OMS 未找到|OMS.*目标订单/.test(reason)) return 'oms-query-miss';
  if (/TMS 未找到|TMS.*目标工单/.test(reason)) return 'tms-query-miss';
  if (/selector|定位器|控件/.test(reason)) return 'selector-mismatch';
  const evidenceUploadFailed = [
    snapshot.ordinaryEvidenceUpload,
    snapshot.pddEvidenceUpload,
    snapshot.tmsAttachmentTransfer,
  ].some((upload) => ['failed', 'unknown'].includes(String(upload?.status || '')))
    || /(?:凭证|图片|附件).*上传.*(?:失败|48143|非法请求)|48143.*非法请求/u.test(reason);
  if (evidenceUploadFailed) return 'image-upload-failed';
  return reason ? 'external-system-error' : null;
};

const eventMessage = (snapshot = {}, reason = reasonCode(snapshot)) => {
  if (reason === 'warehouse-out-of-scope') {
    const warehouse = snapshot.omsWarehouseParse?.parsedValue
      || snapshot.omsAnalysis?.shippingWarehouse
      || snapshot.omsAnalysis?.warehouse
      || null;
    return `OMS 发货仓库${warehouse ? `“${warehouse}”` : ''}不在业务处理范围，已禁止进入 TMS 和拼多多提交`;
  }
  const step = String(snapshot.step || '');
  if (snapshot.error) return snapshot.error;
  if (/manual-review/.test(step)) return snapshot.manualReview?.reason || null;
  if (/(?:consumer-response|logistics)-wait/.test(step)) {
    return snapshot.logisticsWait?.reason || null;
  }
  return null;
};

const systemName = (snapshot = {}) => {
  const stage = String(snapshot.step || snapshot.manualReview?.stage || '').toLowerCase();
  if (stage.includes('oms')) return 'oms';
  if (stage.includes('tms')) return 'tms';
  return 'pdd';
};

const eventFromSnapshot = ({ shopId, snapshot, source, relativePath }) => {
  const serialized = JSON.stringify(snapshot);
  const sourceHash = source === 'snapshot' ? snapshotEventHash(snapshot) : sha256(serialized);
  const status = source === 'archive' ? 'completed' : runtimeStatus(snapshot);
  const reason = reasonCode(snapshot);
  return {
    eventKey: stableEventKey('windows', source, shopId, sourceHash),
    sessionId: `windows-${source}`,
    sequence: 0,
    shopId,
    orderNumber: snapshot.orderNumber || snapshot.loopState?.currentOrderNumber || null,
    scenarioCode: canonicalScenarioCode(snapshot.scenarioCode || snapshot.pddResolutionFlow?.code || null) || null,
    workOrderType: snapshot.workOrderType || snapshot.targetWorkOrderTitle || null,
    system: systemName(snapshot),
    stage: source === 'archive' ? (snapshot.step || 'legacy-archive-imported') : (snapshot.step || 'not-started'),
    eventType: source === 'archive' ? 'workflow.archive-imported' : 'workflow.snapshot-synchronized',
    severity: workflowEventSeverity({
      runtimeStatus: status,
      reasonCode: reason,
      eventType: source === 'archive' ? 'workflow.archive-imported' : 'workflow.snapshot-synchronized',
      current: snapshot,
      patch: snapshot,
    }),
    runtimeStatus: status,
    reasonCode: reason,
    message: eventMessage(snapshot, reason),
    occurredAt: snapshot.updatedAt || snapshot.completedAt || snapshot.archivedAt || new Date().toISOString(),
    sourceHash,
    payload: { source, relativePath, snapshot },
  };
};

const walkJsonFiles = async (directory) => {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(fullPath);
  }
  return files.sort();
};

const readOutboxEvents = async (shopRoot, cursor, limit = maxEventsPerRun) => {
  const outboxRoot = path.join(shopRoot, 'state', 'sync-outbox');
  if (!fs.existsSync(outboxRoot)) return { events: [], offsets: {} };
  const files = (await fsp.readdir(outboxRoot)).filter((name) => name.endsWith('.ndjson')).sort();
  const events = [];
  const offsets = {};
  for (const name of files) {
    if (events.length >= limit) break;
    const file = path.join(outboxRoot, name);
    const start = Number(cursor.outboxOffsets?.[name] || 0);
    const stat = await fsp.stat(file);
    if (start >= stat.size) continue;
    const handle = await fsp.open(file, 'r');
    let readOffset = start;
    let committedOffset = start;
    let pending = Buffer.alloc(0);
    try {
      while (readOffset < stat.size && events.length < limit) {
        const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, stat.size - readOffset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, readOffset);
        if (!bytesRead) break;
        readOffset += bytesRead;
        pending = pending.length
          ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        let newline = pending.indexOf(0x0a);
        while (newline >= 0 && events.length < limit) {
          const line = pending.subarray(0, newline).toString('utf8').trim();
          pending = pending.subarray(newline + 1);
          committedOffset += newline + 1;
          if (line) {
            try { events.push(JSON.parse(line)); } catch { /* skip a complete malformed record */ }
          }
          newline = pending.indexOf(0x0a);
        }
      }
    } finally {
      await handle.close();
    }
    if (committedOffset > start) offsets[name] = committedOffset;
  }
  return { events, offsets };
};

const postEvents = async (token, events) => {
  let accepted = 0;
  let duplicates = 0;
  for (let offset = 0; offset < events.length; offset += 200) {
    const response = await fetch(`${apiUrl}/api/v1/worker-events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId, events: events.slice(offset, offset + 200) }),
    });
    if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    accepted += body.data?.accepted?.length || 0;
    duplicates += body.data?.duplicates?.length || 0;
  }
  return { accepted, duplicates };
};

const collectSnapshotAssets = async ({ shopId, shopRoot, snapshot, cursor }) => {
  const candidates = [
    { kind: 'verification-screenshot', relativePath: snapshot.verificationLocation?.screenshotFileId,
      verificationId: snapshot.verificationLocation?.id },
    { kind: 'pdd-evidence', relativePath: snapshot.pddEvidenceScreenshot?.relativePath },
    { kind: 'tms-evidence', relativePath: snapshot.tmsEvidenceScreenshot?.relativePath },
    { kind: 'tms-evidence', relativePath: snapshot.tmsEvidenceDisposition?.screenshotRelativePath },
  ];
  const assets = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const relativePath = String(candidate.relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
    if (!relativePath || seen.has(relativePath) || !/^(diagnostics|tmp)\//.test(relativePath)) continue;
    seen.add(relativePath);
    const file = path.resolve(shopRoot, ...relativePath.split('/'));
    if (!file.startsWith(`${path.resolve(shopRoot)}${path.sep}`) || !fs.existsSync(file)) continue;
    const bytes = await fsp.readFile(file);
    const hash = sha256(bytes);
    if (cursor.assets?.[relativePath] === hash) continue;
    assets.push({
      shopId,
      orderNumber: snapshot.orderNumber || snapshot.loopState?.currentOrderNumber || null,
      workOrderType: snapshot.workOrderType || snapshot.targetWorkOrderTitle || null,
      ordinaryInstanceId: snapshot.ordinaryInstanceId || null,
      platformCaseKey: snapshot.platformCaseKey || snapshot.latestDiscovery?.platformCaseKey || null,
      kind: candidate.kind,
      sourcePath: relativePath,
      verificationId: candidate.verificationId || null,
      mimeType: relativePath.toLowerCase().endsWith('.jpg') || relativePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
      sha256: hash,
      contentBase64: bytes.toString('base64'),
    });
  }
  return assets;
};

const postAssets = async (token, assets) => {
  const uploaded = [];
  for (const asset of assets) {
    const response = await fetch(`${apiUrl}/api/v1/worker-assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(asset),
    });
    if (!response.ok) {
      const responseText = (await response.text()).slice(0, 300);
      if (response.status === 400 && responseText.includes('worker-asset-ordinary-instance-mismatch')) {
        uploaded.push({ sourcePath: asset.sourcePath, sha256: asset.sha256, skipped: 'ordinary-instance-mismatch' });
        continue;
      }
      throw new Error(`Asset API ${response.status}: ${responseText}`);
    }
    uploaded.push({ sourcePath: asset.sourcePath, sha256: asset.sha256 });
  }
  return uploaded;
};

const postHeartbeat = async (token, shopIds, backlogCount = 0) => {
  const response = await fetch(`${apiUrl}/api/v1/worker-sync-heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId, shopIds, backlogCount }),
  });
  if (!response.ok) throw new Error(`Heartbeat API ${response.status}: ${(await response.text()).slice(0, 300)}`);
};

const writeCursor = async (cursor) => {
  await fsp.mkdir(path.dirname(cursorFile), { recursive: true, mode: 0o700 });
  const temp = `${cursorFile}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(cursor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temp, cursorFile);
};

const initializeCursorAtCurrentState = async () => {
  const token = (await fsp.readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error(`Worker ingest token is empty: ${tokenFile}`);
  const enabledShops = await loadEnabledShops(token);
  const cursor = { version: 1, shops: {} };
  let archiveCount = 0;
  let outboxFileCount = 0;

  for (const shop of enabledShops) {
    const shopId = String(shop.shopId || '');
    if (!shopId) continue;
    const shopRoot = path.join(dataRoot, 'shops', shopId);
    const shopCursor = { snapshotHash: null, archives: {}, outboxOffsets: {}, assets: {} };
    const snapshot = await readJson(path.join(shopRoot, 'state', 'workflow-progress.json'));
    if (snapshot) {
      shopCursor.snapshotHash = snapshotEventHash(snapshot);
      const snapshotAssets = await collectSnapshotAssets({ shopId, shopRoot, snapshot, cursor: shopCursor });
      for (const asset of snapshotAssets) shopCursor.assets[asset.sourcePath] = asset.sha256;
    }

    const archiveRoot = path.join(shopRoot, 'state', 'completed-work-orders');
    for (const archiveFile of await walkJsonFiles(archiveRoot)) {
      const archive = await readJson(archiveFile);
      if (!archive) continue;
      const relativePath = path.relative(shopRoot, archiveFile).replaceAll('\\', '/');
      shopCursor.archives[relativePath] = sha256(JSON.stringify(archive));
      archiveCount += 1;
    }

    const outboxRoot = path.join(shopRoot, 'state', 'sync-outbox');
    if (fs.existsSync(outboxRoot)) {
      const files = (await fsp.readdir(outboxRoot)).filter((name) => name.endsWith('.ndjson')).sort();
      for (const name of files) {
        const buffer = await fsp.readFile(path.join(outboxRoot, name));
        const lastNewline = buffer.lastIndexOf(0x0a);
        shopCursor.outboxOffsets[name] = lastNewline < 0 ? 0 : lastNewline + 1;
        outboxFileCount += 1;
      }
    }
    cursor.shops[shopId] = shopCursor;
  }

  cursor.initializedAt = new Date().toISOString();
  cursor.initialization = { mode: 'current-state', archiveCount, outboxFileCount };
  await writeCursor(cursor);
  console.log(`[Windows sync] Cursor initialized for ${Object.keys(cursor.shops).length} shops, ${archiveCount} archives and ${outboxFileCount} outbox files`);
};

const runOnce = async () => {
  const token = (await fsp.readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error(`Worker ingest token is empty: ${tokenFile}`);
  const enabledShops = await loadEnabledShops(token);
  const shopIds = enabledShops.map((shop) => String(shop.shopId || '')).filter(Boolean);
  const cursor = await readJson(cursorFile, { version: 1, shops: {} });
  const events = [];
  const assets = [];
  const pendingCursor = structuredClone(cursor);
  const maxEventsPerShop = Math.max(1, Math.floor(maxEventsPerRun / Math.max(1, enabledShops.length)));

  for (const shop of enabledShops) {
    const shopId = String(shop.shopId || '');
    if (!shopId) continue;
    const shopRoot = path.join(dataRoot, 'shops', shopId);
    const shopCursor = cursor.shops?.[shopId] || { snapshotHash: null, archives: {}, outboxOffsets: {} };
    const nextShopCursor = structuredClone(shopCursor);
    const shopEventStart = events.length;
    const shopHasEventCapacity = () => events.length < maxEventsPerRun
      && events.length - shopEventStart < maxEventsPerShop;
    const progressFile = path.join(shopRoot, 'state', 'workflow-progress.json');
    const snapshot = await readJson(progressFile);
    let pendingSnapshotEvent = null;
    let pendingSnapshotHash = null;
    if (snapshot && shopHasEventCapacity()) {
      const snapshotHash = snapshotEventHash(snapshot);
      if (snapshotHash !== shopCursor.snapshotHash) {
        pendingSnapshotHash = snapshotHash;
        pendingSnapshotEvent = eventFromSnapshot({
          shopId,
          snapshot,
          source: 'snapshot',
          relativePath: path.relative(root, progressFile).replaceAll('\\', '/'),
        });
      }
      const pendingAssets = await collectSnapshotAssets({ shopId, shopRoot, snapshot, cursor: shopCursor });
      assets.push(...pendingAssets);
      nextShopCursor.pendingAssets = pendingAssets;
    }

    const archiveRoot = path.join(shopRoot, 'state', 'completed-work-orders');
    for (const archiveFile of await walkJsonFiles(archiveRoot)) {
      if (!shopHasEventCapacity()) break;
      const archive = await readJson(archiveFile);
      if (!archive) continue;
      const relativePath = path.relative(shopRoot, archiveFile).replaceAll('\\', '/');
      const archiveHash = sha256(JSON.stringify(archive));
      if (shopCursor.archives?.[relativePath] === archiveHash) continue;
      events.push(eventFromSnapshot({ shopId, snapshot: archive, source: 'archive', relativePath }));
      nextShopCursor.archives = { ...(nextShopCursor.archives || {}), [relativePath]: archiveHash };
    }

    const snapshotReserve = pendingSnapshotEvent && shopHasEventCapacity() ? 1 : 0;
    const outboxLimit = Math.max(0, Math.min(
      maxEventsPerRun - events.length,
      maxEventsPerShop - (events.length - shopEventStart),
    ) - snapshotReserve);
    const outbox = await readOutboxEvents(shopRoot, shopCursor, outboxLimit);
    if (pendingSnapshotEvent) {
      if (outboxCoversSnapshot(pendingSnapshotHash, outbox.events)) {
        nextShopCursor.snapshotHash = pendingSnapshotHash;
      } else if (shopHasEventCapacity()) {
        events.push(pendingSnapshotEvent);
        nextShopCursor.snapshotHash = pendingSnapshotHash;
      }
    }
    events.push(...outbox.events);
    nextShopCursor.outboxOffsets = { ...(nextShopCursor.outboxOffsets || {}), ...outbox.offsets };
    pendingCursor.shops = { ...(pendingCursor.shops || {}), [shopId]: nextShopCursor };
  }

  if (events.length) {
    const result = await postEvents(token, events);
    const uploadedAssets = await postAssets(token, assets);
    await postHeartbeat(token, shopIds, 0);
    for (const [shopId, shopCursor] of Object.entries(pendingCursor.shops || {})) {
      for (const asset of shopCursor.pendingAssets || []) {
        shopCursor.assets = { ...(shopCursor.assets || {}), [asset.sourcePath]: asset.sha256 };
      }
      delete shopCursor.pendingAssets;
      pendingCursor.shops[shopId] = shopCursor;
    }
    pendingCursor.lastSuccessAt = new Date().toISOString();
    pendingCursor.lastBatch = { events: events.length, assets: uploadedAssets.length, ...result };
    await writeCursor(pendingCursor);
    console.log(`[Windows同步] 事件 ${events.length}，新增 ${result.accepted}，重复 ${result.duplicates}，图片 ${uploadedAssets.length}`);
    return result;
  }
  if (assets.length) {
    const uploadedAssets = await postAssets(token, assets);
    await postHeartbeat(token, shopIds, 0);
    for (const [shopId, shopCursor] of Object.entries(pendingCursor.shops || {})) {
      for (const asset of shopCursor.pendingAssets || []) {
        shopCursor.assets = { ...(shopCursor.assets || {}), [asset.sourcePath]: asset.sha256 };
      }
      delete shopCursor.pendingAssets;
      pendingCursor.shops[shopId] = shopCursor;
    }
    pendingCursor.lastSuccessAt = new Date().toISOString();
    pendingCursor.lastBatch = { events: 0, assets: uploadedAssets.length, accepted: 0, duplicates: 0 };
    await writeCursor(pendingCursor);
    console.log(`[Windows同步] 事件 0，图片 ${uploadedAssets.length}`);
    return pendingCursor.lastBatch;
  }
  await postHeartbeat(token, shopIds, 0);
  pendingCursor.lastSuccessAt = new Date().toISOString();
  pendingCursor.lastBatch = { events: 0, accepted: 0, duplicates: 0 };
  await writeCursor(pendingCursor);
  if (once) console.log('[Windows同步] 当前无新增事件');
  return pendingCursor.lastBatch;
};

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
process.on('exit', () => { if (ownsLock) { try { fs.unlinkSync(lockFile); } catch { /* already removed */ } } });

if (selfTestMode) {
  const shops = enabledShopsFromApiPayload({ data: [
    { shopId: 'database-enabled', enabled: true },
    { shopId: 'database-disabled', enabled: false },
    { shopId: 'database-enabled', enabled: true },
    { shopId: 'dynamic-shop', enabled: true },
  ] });
  if (shops.map((shop) => shop.shopId).join(',') !== 'database-enabled,dynamic-shop') {
    throw new Error('dynamic enabled-shop selection self-test failed');
  }
  const durableWarehouseFailure = {
    step: 'flow-paused',
    error: 'OMS 查询结果未找到订单所在行',
    omsWarehouseParse: { status: 'out-of-scope', parsedValue: '代发聚水潭-迅发' },
  };
  if (reasonCode(durableWarehouseFailure) !== 'warehouse-out-of-scope') {
    throw new Error('durable warehouse reason self-test failed');
  }
  if (!eventMessage(durableWarehouseFailure).includes('代发聚水潭-迅发')) {
    throw new Error('warehouse notification message self-test failed');
  }
  const staleLogisticsReason = {
    step: 'human-verification-required',
    logisticsWait: { reason: 'OMS 已按建议快递完成配货，等待拼多多订单实际发货后再提交处理结果' },
  };
  if (reasonCode(staleLogisticsReason) !== 'verification-required'
    || eventMessage(staleLogisticsReason) !== null) {
    throw new Error('stale logistics reason isolation self-test failed');
  }
  const consumerResponseWait = {
    step: 'consumer-response-waiting-released',
    logisticsWait: {
      waitKind: 'consumer-response',
      reason: '拼多多正在等待消费者确认拦截后退款方案，满 12 小时仍无回复后再自动处理',
    },
  };
  if (reasonCode(consumerResponseWait) !== 'waiting-consumer-response'
    || !eventMessage(consumerResponseWait)?.includes('等待消费者')) {
    throw new Error('consumer response wait classification self-test failed');
  }
  const verificationBusinessState = {
    shopId: 'verification-shop',
    orderNumber: '260800-000000000000001',
    step: 'human-verification-required',
    businessUpdatedAt: '2026-08-22T00:00:00.000Z',
    verificationLocation: {
      id: 'verification-1',
      system: 'pdd',
      stage: 'pdd-manual-login',
      status: 'waiting-human',
      url: 'https://mms.pinduoduo.com/login/',
      detectedAt: '2026-08-22T00:00:00.000Z',
    },
    updatedAt: '2026-08-22T00:00:05.000Z',
    runtimeObservation: { observedAt: '2026-08-22T00:00:05.000Z' },
    systemTabs: { pdd: { url: 'https://mms.pinduoduo.com/login/' } },
    authHealth: { pdd: { status: 'verification-required', checkedAt: '2026-08-22T00:00:05.000Z' } },
  };
  const heartbeatOnlyRefresh = {
    ...verificationBusinessState,
    updatedAt: '2026-08-22T00:00:20.000Z',
    runtimeObservation: { observedAt: '2026-08-22T00:00:20.000Z' },
    systemTabs: { pdd: { url: 'https://mms.pinduoduo.com/login/?heartbeat=2' } },
    authHealth: { pdd: { status: 'verification-required', checkedAt: '2026-08-22T00:00:20.000Z' } },
  };
  if (snapshotEventHash(verificationBusinessState) !== snapshotEventHash(heartbeatOnlyRefresh)) {
    throw new Error('runtime-only snapshot changes must not create duplicate workflow events');
  }
  const clearedVerification = {
    ...heartbeatOnlyRefresh,
    step: 'challenge-cleared',
    businessUpdatedAt: '2026-08-22T00:00:21.000Z',
    verificationLocation: null,
  };
  if (snapshotEventHash(verificationBusinessState) === snapshotEventHash(clearedVerification)) {
    throw new Error('business state changes must create a new snapshot workflow event');
  }
  const firstVerificationEvent = eventFromSnapshot({
    shopId: 'verification-shop',
    snapshot: verificationBusinessState,
    source: 'snapshot',
    relativePath: 'state/workflow-progress.json',
  });
  const heartbeatVerificationEvent = eventFromSnapshot({
    shopId: 'verification-shop',
    snapshot: heartbeatOnlyRefresh,
    source: 'snapshot',
    relativePath: 'state/workflow-progress.json',
  });
  if (firstVerificationEvent.eventKey !== heartbeatVerificationEvent.eventKey) {
    throw new Error('runtime-only snapshot refresh must retain the same event key');
  }
  if (!outboxCoversSnapshot(snapshotEventHash(heartbeatOnlyRefresh), [{
    eventKey: 'matching-source-event',
    payload: { snapshot: verificationBusinessState },
  }])) {
    throw new Error('matching outbox event must suppress a duplicate snapshot event');
  }
  if (outboxCoversSnapshot(snapshotEventHash(clearedVerification), [{
    eventKey: 'different-source-event',
    payload: { snapshot: verificationBusinessState },
  }])) {
    throw new Error('a real business transition must retain its fallback snapshot event');
  }
  const manualBusinessGuard = {
    step: 'manual-review-blocked',
    manualReview: { reason: '发货仓库不一致' },
  };
  if (reasonCode(manualBusinessGuard) !== 'manual-review-required') {
    throw new Error('manual review classification self-test failed');
  }
  const exhaustedEvidenceUpload = {
    step: 'flow-paused',
    error: '拼多多凭证上传授权失败（48143）：非法请求',
    ordinaryEvidenceUpload: {
      status: 'failed',
      diagnostics: { authorizationFailure: { errorCode: 48143 } },
    },
  };
  if (reasonCode(exhaustedEvidenceUpload) !== 'image-upload-failed') {
    throw new Error('image upload failure classification self-test failed');
  }
  const batchRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-sync-batch-'));
  try {
    const outboxRoot = path.join(batchRoot, 'state', 'sync-outbox');
    await fsp.mkdir(outboxRoot, { recursive: true });
    const outboxFile = path.join(outboxRoot, 'events.ndjson');
    await fsp.writeFile(outboxFile, [1, 2, 3].map((sequence) => JSON.stringify({ eventKey: `event-${sequence}` })).join('\n') + '\n');
    const firstBatch = await readOutboxEvents(batchRoot, { outboxOffsets: {} }, 2);
    if (firstBatch.events.length !== 2 || !(firstBatch.offsets['events.ndjson'] > 0)) {
      throw new Error('bounded outbox first batch self-test failed');
    }
    const secondBatch = await readOutboxEvents(batchRoot, { outboxOffsets: firstBatch.offsets }, 2);
    if (secondBatch.events.length !== 1 || secondBatch.events[0]?.eventKey !== 'event-3') {
      throw new Error('bounded outbox cursor continuation self-test failed');
    }
  } finally {
    await fsp.rm(batchRoot, { recursive: true, force: true });
  }
  console.log('Windows worker state sync self-test passed');
  process.exit(0);
}

if (initializeCursor) {
  await initializeCursorAtCurrentState();
  process.exit(0);
}

do {
  try { await runOnce(); } catch (error) { console.error(`[Windows同步] ${error.message}`); }
  if (once || stopping) break;
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
} while (!stopping);
