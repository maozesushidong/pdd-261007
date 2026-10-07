import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shopId = 'shop-mt9va8ol-47962e';
const orderNumber = '260926-334244135232125';
const reviewStage = 'in-transit-address-change-completion-unverified';
const apply = process.argv.includes('--apply');
const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'park-exact-unverified-address-change-review',
});
await client.connect();
let transactionOpen = false;
try {
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query("SET LOCAL lock_timeout = '5s'");
  const { rows: [order] } = await client.query(`
    SELECT work_order.id, work_order.shop_id, work_order.status,
      work_order.runtime_status AS work_runtime_status, work_order.current_step,
      work_order.recovery_state, work_order.completion_state,
      work_order.current_ordinary_instance_id, work_order.payload->'manualReview' AS review,
      runtime.status AS shop_runtime_status, runtime.worker_id, runtime.lease_token,
      runtime.lease_expires_at, runtime.current_work_order_id,
      instance.shop_id AS instance_shop_id,
      instance.work_order_id AS instance_work_order_id,
      instance.identity_status AS instance_identity_status,
      instance.status AS instance_status,
      instance.runtime_status AS instance_runtime_status,
      (SELECT count(*)::int FROM external_effects effect
        WHERE effect.work_order_id = work_order.id) AS effect_count,
      (SELECT count(*)::int FROM verification_locations verification
        WHERE verification.work_order_id = work_order.id
          AND verification.resolved_at IS NULL
          AND verification.status IN ('detected','waiting-human','verification-required'))
        AS active_verifications,
      (SELECT count(*)::int FROM operator_commands command
        WHERE command.work_order_id = work_order.id
          AND command.status IN ('pending','delivered')) AS active_commands
    FROM work_orders work_order
    JOIN shop_runtime_state runtime ON runtime.shop_id = work_order.shop_id
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.shop_id = $1 AND work_order.external_order_number = $2
    FOR UPDATE OF work_order, runtime, instance
  `, [shopId, orderNumber]);
  const { rows: [heartbeat] } = await client.query(`
    SELECT heartbeat_at, metadata->>'state' AS state,
      metadata->>'currentOrderNumber' AS order_number
    FROM worker_heartbeats WHERE shop_id = $1
    ORDER BY heartbeat_at DESC LIMIT 1
  `, [shopId]);
  const failures = [];
  if (!order) failures.push('exact-order-missing');
  else {
    if (order.status !== 'processing' || order.work_runtime_status !== 'processing'
      || order.current_step !== 'manual-review-waiting'
      || order.recovery_state !== 'ready' || order.completion_state !== 'pending') {
      failures.push('order-state-changed');
    }
    if (order.review?.stage !== reviewStage || order.review?.status !== 'waiting'
      || !/两个阶段.*完整记录/u.test(String(order.review?.reason || ''))) {
      failures.push('review-proof-gate-changed');
    }
    if (!order.current_ordinary_instance_id
      || order.instance_shop_id !== shopId
      || order.instance_work_order_id !== order.id
      || order.instance_status !== 'processing'
      || order.instance_runtime_status !== 'processing'
      || order.instance_identity_status !== 'verified') {
      failures.push('ordinary-instance-identity');
    }
    if (order.shop_runtime_status !== 'processing'
      || order.current_work_order_id !== order.id
      || !order.lease_token
      || Date.parse(order.lease_expires_at || '') <= Date.now() + 30_000) {
      failures.push('active-lease-changed');
    }
    if (order.effect_count !== 0 || order.active_verifications !== 0
      || order.active_commands !== 0) failures.push('external-or-operator-action-active');
  }
  if (!heartbeat || Date.now() - Date.parse(heartbeat.heartbeat_at || '') > 20_000
    || heartbeat.state !== 'processing' || heartbeat.order_number !== orderNumber) {
    failures.push('worker-heartbeat-changed');
  }
  const check = {
    shopId, orderNumber, workOrderId: order?.id || null,
    ordinaryInstanceId: order?.current_ordinary_instance_id || null,
    reviewStage: order?.review?.stage || null,
    effectCount: order?.effect_count ?? null,
    activeVerifications: order?.active_verifications ?? null,
    failures,
  };
  if (!apply || failures.length) {
    await client.query('ROLLBACK');
    transactionOpen = false;
    console.log(JSON.stringify({ applied: false, safe: failures.length === 0, ...check }));
    if (apply && failures.length) process.exitCode = 2;
  } else {
    const backupDirectory = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory,
      `park-unverified-address-change-${orderNumber}-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, `${JSON.stringify({
      checkedAt: new Date().toISOString(), check,
      priorStatus: order.status, priorStep: order.current_step,
      review: order.review,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const commandId = crypto.randomUUID();
    await client.query(`
      INSERT INTO operator_commands
        (id, shop_id, work_order_id, ordinary_instance_id,
          command_type, payload, requested_by)
      VALUES ($1,$2,$3,$4,'refresh-next-order',$5::jsonb,$6)
    `, [commandId, shopId, order.id, order.current_ordinary_instance_id,
      JSON.stringify({
        reason: '同单完成页缺少在途改地址两阶段完整证明；保留人工复核并释放店铺处理其他单据，禁止归档或重新提交',
        reviewStage, ordinaryInstanceId: order.current_ordinary_instance_id,
        source: 'park-unverified-address-change-review',
      }), 'codex-exact-manual-review-park']);
    await client.query('COMMIT');
    transactionOpen = false;
    console.log(JSON.stringify({ applied: true, safe: true, ...check, commandId, backupPath }));
  }
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
