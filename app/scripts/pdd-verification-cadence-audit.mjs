import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clusterCount = (timestamps, gapMs = 10 * 60_000) => {
  let count = 0;
  let previous = null;
  for (const timestamp of [...timestamps].sort((left, right) => left - right)) {
    if (previous === null || timestamp - previous > gapMs) count += 1;
    previous = timestamp;
  }
  return count;
};

if (process.argv.includes('--self-test')) {
  assert.equal(clusterCount([]), 0);
  assert.equal(clusterCount([0, 9 * 60_000, 19 * 60_000]), 1);
  assert.equal(clusterCount([0, 11 * 60_000, 12 * 60_000]), 2);
  console.log('PDD verification cadence audit self-test passed');
  process.exit(0);
}

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const untilInput = argument('--until') || new Date().toISOString();
const sinceInput = argument('--since')
  || new Date(Date.parse(untilInput) - 4 * 60 * 60_000).toISOString();
const sinceMs = Date.parse(sinceInput);
const untilMs = Date.parse(untilInput);
if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) {
  throw new Error('--since and --until must define an increasing ISO time range');
}
const shopIds = String(argument('--shops') || '').split(',').map((value) => value.trim())
  .filter(Boolean);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envText = await fs.readFile(path.join(root, '.env.native'), 'utf8').catch(() => '');
const databaseUrl = process.env.DATABASE_URL || envText.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='))
  ?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
  application_name: 'pdd-verification-cadence-readonly-audit' });
try {
  const [events, shopRows] = await Promise.all([
    pool.query(`
      SELECT verification.shop_id AS "shopId", shop.name AS "shopName",
        verification.work_order_id AS "workOrderId", verification.stage,
        verification.status, verification.detected_at AS "detectedAt",
        verification.resolved_at AS "resolvedAt"
      FROM verification_locations verification
      JOIN shops shop ON shop.id = verification.shop_id
      WHERE verification.detected_at >= $1::timestamptz
        AND verification.detected_at < $2::timestamptz
        AND verification.system_name ~* '^(pdd|pinduoduo)$'
        AND (cardinality($3::text[]) = 0 OR verification.shop_id = ANY($3::text[]))
      ORDER BY verification.shop_id, verification.detected_at
    `, [new Date(sinceMs), new Date(untilMs), shopIds]),
    shopIds.length ? pool.query('SELECT id, name FROM shops WHERE id = ANY($1::text[])',
      [shopIds]) : Promise.resolve({ rows: [] }),
  ]);
  const grouped = new Map(shopRows.rows.map((shop) => [shop.id, {
    shopId: shop.id, shopName: shop.name, events: [],
  }]));
  for (const event of events.rows) {
    if (!grouped.has(event.shopId)) grouped.set(event.shopId, {
      shopId: event.shopId, shopName: event.shopName, events: [],
    });
    grouped.get(event.shopId).events.push(event);
  }
  const hours = (untilMs - sinceMs) / 60 / 60_000;
  const shops = [...grouped.values()].map((group) => {
    const stages = new Map();
    const orderIds = new Set();
    const times = [];
    let resolved = 0;
    let expired = 0;
    let unresolved = 0;
    for (const event of group.events) {
      times.push(Date.parse(event.detectedAt));
      if (event.workOrderId) orderIds.add(event.workOrderId);
      stages.set(event.stage, (stages.get(event.stage) || 0) + 1);
      if (event.status === 'resolved') resolved += 1;
      else if (event.status === 'expired') expired += 1;
      else if (!event.resolvedAt) unresolved += 1;
    }
    const clusters = clusterCount(times);
    return {
      shopId: group.shopId,
      shopName: group.shopName,
      detections: times.length,
      detectionClusters: clusters,
      clustersPerHour: Number((clusters / hours).toFixed(2)),
      distinctOrders: orderIds.size,
      resolved,
      expired,
      unresolved,
      topStages: [...stages.entries()].sort((left, right) => right[1] - left[1])
        .slice(0, 3).map(([stage, count]) => ({ stage, count })),
    };
  }).sort((left, right) => right.detectionClusters - left.detectionClusters
    || left.shopName.localeCompare(right.shopName, 'zh-CN'));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(),
    since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(),
    hours: Number(hours.toFixed(2)),
    note: 'Detection clusters merge same-shop records within 10 minutes; they are not proven unique CAPTCHA challenges.',
    shops,
  }, null, 2));
} finally {
  await pool.end();
}
