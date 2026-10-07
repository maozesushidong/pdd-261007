import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeValue = (name) => {
  const envPath = path.join(appRoot, '.env.native');
  if (!fs.existsSync(envPath)) return null;
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/u, '$2') || null;
};
const minutesIndex = process.argv.indexOf('--minutes');
const minutes = minutesIndex < 0 ? 60 : Number(process.argv[minutesIndex + 1]);
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
  throw new Error('--minutes must be between 1 and 1440');
}
const now = Date.now();
const since = now - minutes * 60_000;
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT
  || nativeValue('WORKFLOW_DATA_ROOT')
  || path.join(appRoot, '..', 'data', 'workflow'));
const shopRoot = path.join(dataRoot, 'shops');
if (!fs.existsSync(shopRoot)) throw new Error('Workflow shop data root is unavailable');

const dayKeys = new Set();
for (const instant of [since, now]) {
  dayKeys.add(new Date(instant).toISOString().slice(0, 10).replace(/-/gu, ''));
}
const shops = fs.readdirSync(shopRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const byShop = new Map();
for (const shopId of shops) {
  const item = { shopId, attempts: 0, closedFailureEvents: 0, firstAt: null, lastAt: null };
  for (const dayKey of dayKeys) {
    const filename = path.join(shopRoot, shopId, 'state', 'sync-outbox', `events-${dayKey}.ndjson`);
    if (!fs.existsSync(filename)) continue;
    const lines = readline.createInterface({ input: fs.createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('verification-recovery-starting')
        && !line.includes('verification-recovery-retryable')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const occurredAt = Date.parse(event.occurredAt || '');
      if (!Number.isFinite(occurredAt) || occurredAt < since || occurredAt > now + 5_000) continue;
      if (event.stage === 'verification-recovery-starting') {
        item.attempts += 1;
        if (!item.firstAt || occurredAt < Date.parse(item.firstAt)) item.firstAt = event.occurredAt;
        if (!item.lastAt || occurredAt > Date.parse(item.lastAt)) item.lastAt = event.occurredAt;
      } else if (event.stage === 'verification-recovery-retryable'
        && /验证码恢复页面在确认解除前已关闭|target page, context or browser has been closed/iu
          .test(String(event.message || ''))) {
        item.closedFailureEvents += 1;
      }
    }
  }
  if (item.attempts || item.closedFailureEvents) byShop.set(shopId, item);
}

let shopNames = new Map();
try {
  const response = await fetch('http://127.0.0.1:3000/api/v1/shops', {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.ok) {
    const payload = await response.json();
    shopNames = new Map((payload.data || []).map((shop) => [shop.shopId, shop.name]));
  }
} catch { /* Local shop ids remain usable when the API is unavailable. */ }
const shopsWithAttempts = [...byShop.values()]
  .map((item) => ({ ...item, shopName: shopNames.get(item.shopId) || item.shopId }))
  .sort((left, right) => right.attempts - left.attempts);
console.log(JSON.stringify({
  checkedAt: new Date(now).toISOString(),
  since: new Date(since).toISOString(),
  hotLoopThreshold: 20,
  hotLoops: shopsWithAttempts.filter((item) => item.attempts >= 20),
  shopsWithAttempts,
}, null, 2));
