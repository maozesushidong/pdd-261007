import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sinceInput = process.argv[process.argv.indexOf('--since') + 1];
if (!sinceInput || Number.isNaN(Date.parse(sinceInput))) {
  throw new Error('--since requires an ISO-8601 timestamp');
}
const since = new Date(sinceInput).toISOString();
const databaseLine = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8')
  .split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'verification-incidence-readonly-audit' });
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query('SET LOCAL statement_timeout = 15000');
  const { rows } = await client.query(`
    SELECT shop.name AS "shopName", verification.system_name AS system,
      verification.stage, verification.status,
      verification.detected_at AS "detectedAt",
      verification.resolved_at AS "resolvedAt",
      verification.work_order_id AS "workOrderId",
      work_order.scenario_code AS "scenarioCode"
    FROM verification_locations verification
    JOIN shops shop ON shop.id = verification.shop_id
    LEFT JOIN work_orders work_order ON work_order.id = verification.work_order_id
    WHERE verification.detected_at >= $1::timestamptz
    ORDER BY verification.detected_at`, [since]);
  // Resident browsers can show a shop-level challenge before an order is
  // claimed. Those live states have no verification_locations row, so the
  // historical event count below is a lower bound rather than a full count.
  const { rows: liveHeartbeatChallenges } = await client.query(`
    SELECT shop.name AS "shopName", heartbeat.heartbeat_at AS "heartbeatAt",
      heartbeat.metadata->>'state' AS "workerState",
      heartbeat.metadata->>'workflowStep' AS "workflowStep",
      EXISTS (
        SELECT 1 FROM verification_locations verification
        WHERE verification.shop_id = shop.id
          AND lower(verification.system_name) = 'pdd'
          AND verification.status IN ('detected','waiting-human','verification-required')
          AND verification.resolved_at IS NULL
      ) AS "hasPersistedActiveChallenge"
    FROM shops shop
    JOIN LATERAL (
      SELECT heartbeat_at, metadata FROM worker_heartbeats
      WHERE shop_id = shop.id ORDER BY heartbeat_at DESC LIMIT 1
    ) heartbeat ON true
    WHERE shop.enabled = true
      AND heartbeat.heartbeat_at >= now() - interval '20 seconds'
      AND heartbeat.metadata->'authHealth'->'pdd'->>'status' = 'verification-required'
    ORDER BY shop.name`);
  const counts = {};
  const byShop = new Map();
  for (const row of rows) {
    const hour = new Date(row.detectedAt).toISOString().slice(0, 13) + ':00Z';
    counts[hour] = (counts[hour] || 0) + 1;
    const shopRows = byShop.get(row.shopName) || [];
    shopRows.push(row);
    byShop.set(row.shopName, shopRows);
  }
  const clusterGapMs = 2 * 60_000;
  const timeClustersByShop = [...byShop].map(([shopName, shopRows]) => {
    const clusters = [];
    const workOrderClusters = new Map();
    for (const row of shopRows) {
      const detectedMs = Date.parse(row.detectedAt);
      const last = clusters.at(-1);
      if (!last || detectedMs - last.lastMs > clusterGapMs) {
        clusters.push({ firstMs: detectedMs, lastMs: detectedMs, records: 1 });
      } else {
        last.lastMs = detectedMs;
        last.records += 1;
      }
      if (row.workOrderId) {
        const indices = workOrderClusters.get(row.workOrderId) || new Set();
        indices.add(clusters.length - 1);
        workOrderClusters.set(row.workOrderId, indices);
      }
    }
    return {
      shopName,
      records: shopRows.length,
      distinctWorkOrders: workOrderClusters.size,
      timeClusters: clusters.length,
      workOrdersWithRepeatedClusters: [...workOrderClusters.values()]
        .filter((indices) => indices.size > 1).length,
      largestClusterRecords: Math.max(...clusters.map((cluster) => cluster.records)),
    };
  }).sort((a, b) => b.records - a.records);
  const records = rows.map(({ workOrderId, ...record }) => record);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), since,
    checked: rows.length, hourlyCounts: counts,
    distinctWorkOrders: new Set(rows.map((row) => row.workOrderId).filter(Boolean)).size,
    timeClusterGapMs: clusterGapMs,
    timeClusters: timeClustersByShop.reduce((total, shop) => total + shop.timeClusters, 0),
    timeClustersByShop, records,
    historicalCountLimitation: 'Shop-level challenges visible only in fresh Worker heartbeats are not retained in verification_locations and are excluded from historical counts.',
    liveHeartbeatChallenges,
    liveHeartbeatOnlyChallenges: liveHeartbeatChallenges
      .filter((entry) => !entry.hasPersistedActiveChallenge) }, null, 2));
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
