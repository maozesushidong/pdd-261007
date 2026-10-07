import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const shopRoot = path.resolve(appRoot, '..', 'data', 'workflow', 'shops');
const snapshots = [];
for (const entry of await fs.readdir(shopRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(shopRoot, entry.name, 'state', 'workflow-progress.json');
  let progress;
  try { progress = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { continue; }
  const verification = progress.verificationLocation;
  if (!verification?.id || !['detected', 'waiting-human', 'verification-required']
    .includes(verification.status)) continue;
  snapshots.push({
    shopId: entry.name,
    verificationId: verification.id,
    progressStatus: verification.status,
    progressStep: progress.step || null,
    pddAuthStatus: progress.authHealth?.pdd?.status || null,
    pddIdentityStatus: progress.pddShopIdentity?.status || null,
    progressUpdatedAt: progress.updatedAt || null,
  });
}

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'stale-verification-gate-readonly-audit' });
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query('SET LOCAL statement_timeout = 15000');
  const { rows } = await client.query(`
    SELECT shop.id AS "shopId", shop.name AS "shopName",
      verification.id::text AS "verificationId",
      verification.status AS "databaseStatus",
      verification.resolved_at AS "resolvedAt",
      heartbeat.metadata->>'state' AS "workerState",
      heartbeat.metadata #>> '{authHealth,pdd,status}' AS "heartbeatPddAuthStatus",
      heartbeat.heartbeat_at AS "heartbeatAt"
    FROM verification_locations verification
    JOIN shops shop ON shop.id = verification.shop_id
    LEFT JOIN LATERAL (
      SELECT heartbeat_at, metadata FROM worker_heartbeats
      WHERE shop_id = shop.id ORDER BY heartbeat_at DESC LIMIT 1
    ) heartbeat ON true
    WHERE verification.id::text = ANY($1::text[])
  `, [snapshots.map((snapshot) => snapshot.verificationId)]);
  const byId = new Map(rows.map((row) => [row.verificationId, row]));
  const records = snapshots.map((snapshot) => {
    const row = byId.get(snapshot.verificationId);
    return {
      ...snapshot,
      shopName: row?.shopName || null,
      databaseStatus: row?.databaseStatus || 'missing',
      resolvedAt: row?.resolvedAt || null,
      workerState: row?.workerState || null,
      heartbeatPddAuthStatus: row?.heartbeatPddAuthStatus || null,
      heartbeatAt: row?.heartbeatAt || null,
      mismatch: !row || Boolean(row.resolvedAt)
        || !['detected', 'waiting-human', 'verification-required']
          .includes(row.databaseStatus),
    };
  });
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), records }, null, 2));
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
