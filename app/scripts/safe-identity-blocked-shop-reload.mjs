import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = argument('--shop');
const expectedVersion = Number(argument('--expected-version'));
const apply = process.argv.includes('--apply');
if (!shopId || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
  throw new Error('Usage: safe-identity-blocked-shop-reload.mjs --shop ID --expected-version N [--apply]');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'safe-identity-blocked-shop-code-reload',
});
await client.connect();
let inTransaction = false;
try {
  await client.query('BEGIN');
  inTransaction = true;
  const one = async (sql) => (await client.query(sql, [shopId])).rows[0] || null;
  const shop = await one(`
    SELECT id, name, expected_shop_name, enabled, onboarding_status, config_version
    FROM shops WHERE id = $1 FOR UPDATE`);
  const identity = await one(`
    SELECT status FROM shop_identity_bindings WHERE shop_id = $1`);
  const binding = await one(`
    SELECT shop_id FROM pdd_shop_runtime_bindings WHERE shop_id = $1`);
  const runtime = await one(`
    SELECT status, lease_token, current_work_order_id
    FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`);
  const heartbeat = await one(`
    SELECT heartbeat_at, metadata FROM worker_heartbeats
    WHERE shop_id = $1 ORDER BY heartbeat_at DESC LIMIT 1`);
  const active = await one(`
    SELECT
      (SELECT count(*)::int FROM work_orders
       WHERE shop_id = $1 AND runtime_status = 'processing') AS work_orders,
      (SELECT count(*)::int FROM ordinary_work_order_instances
       WHERE shop_id = $1 AND runtime_status = 'processing') AS ordinary_instances,
      (SELECT count(*)::int FROM return_refunds
       WHERE shop_id = $1 AND action_state = 'submitting') AS refunds,
      (SELECT count(*)::int FROM external_effects
       WHERE shop_id = $1 AND status = 'reserved') AS reserved_effects,
      (SELECT count(*)::int FROM verification_locations
       WHERE shop_id = $1 AND status IN ('detected', 'waiting-human', 'verification-required')
         AND resolved_at IS NULL) AS verifications`);

  const metadata = heartbeat?.metadata || {};
  const failures = [];
  if (!shop?.enabled || shop.config_version !== expectedVersion
    || shop.onboarding_status !== 'initializing'
    || !shop.expected_shop_name || shop.name === shop.expected_shop_name) {
    failures.push('shop-version-or-identity-configuration');
  }
  if (identity?.status !== 'revoked' || binding) failures.push('shop-binding-not-blocked');
  if (!heartbeat || Date.now() - Date.parse(heartbeat.heartbeat_at) > 20_000
    || metadata.state !== 'pdd-identity-binding-waiting'
    || metadata.currentOrderNumber
    || !metadata.actualShopName
    || metadata.actualShopName === shop?.expected_shop_name
    || ['pdd', 'oms', 'tms'].some((system) => metadata.authHealth?.[system]?.status !== 'authenticated')) {
    failures.push('worker-not-idle-at-identity-mismatch');
  }
  if (!runtime || runtime.status !== 'idle' || runtime.lease_token
    || runtime.current_work_order_id) failures.push('runtime-active');
  if (Object.values(active || {}).some((count) => Number(count) !== 0)) {
    failures.push('work-or-verification-active');
  }

  const check = {
    shopId,
    expectedVersion,
    observedVersion: shop?.config_version ?? null,
    workerState: metadata.state || null,
    heartbeatAt: heartbeat?.heartbeat_at || null,
    active,
    safe: failures.length === 0,
    failures,
  };
  if (!apply || failures.length) {
    await client.query('ROLLBACK');
    inTransaction = false;
    console.log(JSON.stringify({ applied: false, ...check }));
    if (apply && failures.length) process.exitCode = 2;
  } else {
    const backupDir = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir,
      `safe-identity-blocked-shop-reload-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({ checkedAt: new Date().toISOString(),
      shop, identity, runtime: { status: runtime.status },
      heartbeat: { heartbeatAt: heartbeat.heartbeat_at, state: metadata.state,
        actualShopName: metadata.actualShopName }, active }, null, 2), { flag: 'wx' });
    const updated = await client.query(`
      UPDATE shops SET config_version = config_version + 1, updated_at = now()
      WHERE id = $1 AND config_version = $2 RETURNING config_version`,
    [shopId, expectedVersion]);
    if (updated.rowCount !== 1) throw new Error('Shop version changed during reload');
    await client.query('COMMIT');
    inTransaction = false;
    console.log(JSON.stringify({ applied: true, ...check,
      newVersion: updated.rows[0].config_version, backupPath }));
  }
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
