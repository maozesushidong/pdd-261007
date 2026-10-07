import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = arg('--shop');
const orderNumber = arg('--order');
const expectedVersion = Number(arg('--expected-version'));
const apply = process.argv.includes('--apply');
if (!/^[a-z0-9-]{5,100}$/u.test(shopId || '')
  || !/^\d{6}-\d{15}$/u.test(orderNumber || '')
  || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
  throw new Error('Usage: retry-verified-tms-filter-overlay-pause.mjs --shop ID --order N --expected-version N [--apply]');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
const fixedCodeWrittenAt = (await fs.stat(path.join(appRoot, 'workflow.mjs'))).mtimeMs;

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'retry-verified-tms-filter-overlay-pause' });
await client.connect();
let transactionOpen = false;
try {
  await client.query('BEGIN');
  transactionOpen = true;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0] || null;
  const shop = await one(`SELECT id, enabled, onboarding_status, expected_shop_name,
    config_version FROM shops WHERE id=$1 FOR UPDATE`, [shopId]);
  const binding = await one(`SELECT binding_token::text AS token, actual_shop_name,
    mall_id, profile_fingerprint FROM pdd_shop_runtime_bindings WHERE shop_id=$1`, [shopId]);
  const identity = await one(`SELECT status, expected_shop_name, mall_id,
    profile_fingerprint FROM shop_identity_bindings WHERE shop_id=$1`, [shopId]);
  const runtime = await one(`SELECT status, lease_token, current_work_order_id
    FROM shop_runtime_state WHERE shop_id=$1 FOR UPDATE`, [shopId]);
  const heartbeat = await one(`SELECT heartbeat_at, metadata FROM worker_heartbeats
    WHERE shop_id=$1 ORDER BY heartbeat_at DESC LIMIT 1`, [shopId]);
  const order = await one(`SELECT w.id, w.status, w.runtime_status, w.current_step,
      w.recovery_state, w.completion_state, w.manual_review_reason,
      w.current_ordinary_instance_id, w.payload,
      i.status AS instance_status, i.runtime_status AS instance_runtime_status,
      i.identity_status, i.platform_case_id, i.platform_case_key, i.detail_url
    FROM work_orders w JOIN ordinary_work_order_instances i
      ON i.id=w.current_ordinary_instance_id AND i.work_order_id=w.id
      AND i.shop_id=w.shop_id
    WHERE w.shop_id=$1 AND w.external_order_number=$2
      AND w.scenario_code='shipped-no-tracking-refund'
    FOR UPDATE OF w,i`, [shopId, orderNumber]);
  const effectCount = order ? await one(`SELECT count(*)::int AS count FROM external_effects
    WHERE work_order_id=$1`, [order.id]) : null;
  const pendingCommand = order ? await one(`SELECT id FROM operator_commands
    WHERE work_order_id=$1 AND status IN ('pending','delivered') LIMIT 1`, [order.id]) : null;
  const activeVerification = await one(`SELECT id FROM verification_locations
    WHERE shop_id=$1 AND resolved_at IS NULL
      AND status IN ('detected','waiting-human','verification-required') LIMIT 1`, [shopId]);
  const conflictingOrder = await one(`SELECT id FROM work_orders
    WHERE external_order_number=$1 AND shop_id<>$2
      AND status NOT IN ('archived','completed') LIMIT 1`, [orderNumber, shopId]);

  const metadata = heartbeat?.metadata || {};
  const auth = metadata.authHealth || {};
  const reason = String(order?.manual_review_reason || '');
  const failures = [];
  if (!shop?.enabled || shop.onboarding_status !== 'ready'
    || shop.config_version !== expectedVersion) failures.push('shop-version-or-readiness');
  if (!binding || !identity || identity.status !== 'confirmed'
    || binding.actual_shop_name !== shop?.expected_shop_name
    || identity.expected_shop_name !== shop?.expected_shop_name
    || String(binding.mall_id || '') !== String(identity.mall_id || '')
    || binding.profile_fingerprint !== identity.profile_fingerprint) {
    failures.push('shop-identity-binding');
  }
  if (!heartbeat || Date.now() - Date.parse(heartbeat.heartbeat_at) > 20_000
    || metadata.state !== 'queue-waiting' || metadata.currentOrderNumber
    || metadata.actualShopName !== shop?.expected_shop_name
    || metadata.identityBindingToken !== binding?.token
    || String(metadata.mallId || '') !== String(binding?.mall_id || '')
    || !(Date.parse(metadata.runnerStartedAt || '') >= fixedCodeWrittenAt)) {
    failures.push('new-worker-heartbeat-or-queue');
  }
  if (['pdd','oms','tms'].some((system) => auth[system]?.status !== 'authenticated')) {
    failures.push('system-authentication');
  }
  if (!runtime || runtime.status !== 'idle' || runtime.lease_token
    || runtime.current_work_order_id) failures.push('runtime-active');
  if (activeVerification) failures.push('verification-active');
  if (!order || order.status !== 'paused' || order.runtime_status !== 'paused'
    || order.current_step !== 'flow-paused' || order.recovery_state !== 'ready'
    || order.completion_state !== 'pending'
    || !reason.startsWith('locator.click: Timeout 30000ms exceeded.')
    || !reason.includes("locator('.filter-panel:visible')")
    || !reason.includes("name: '应用'")
    || !reason.includes('el-overlay is-drawer')
    || !reason.includes('intercepts pointer events')
    || order.payload?.pddResolutionSubmission
    || order.payload?.tmsWorkOrder) {
    failures.push('paused-read-only-filter-overlay-only');
  }
  if (!order || order.instance_status !== 'paused'
    || order.instance_runtime_status !== 'paused'
    || order.identity_status !== 'verified'
    || !/^\d{6,30}$/u.test(String(order.platform_case_id || ''))
    || order.platform_case_key !== `pdd-work-order:${order.platform_case_id}`
    || order.detail_url !== `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${order.platform_case_id}`
    || order.payload?.latestDiscovery?.pddIdentityBindingToken !== binding?.token
    || String(order.payload?.pddShopIdentity?.mallId || '') !== String(binding?.mall_id || '')) {
    failures.push('ordinary-instance-or-binding');
  }
  if (Number(effectCount?.count || 0) !== 0) failures.push('external-effect-present');
  if (pendingCommand) failures.push('existing-operator-command');
  if (conflictingOrder) failures.push('cross-shop-order-conflict');

  const check = { shopId, orderNumber, expectedVersion,
    observedVersion: shop?.config_version ?? null,
    workerState: metadata.state || null,
    platformCaseId: order?.platform_case_id || null,
    effectCount: Number(effectCount?.count || 0),
    safe: failures.length === 0, failures };
  if (!apply || failures.length) {
    await client.query('ROLLBACK');
    transactionOpen = false;
    console.log(JSON.stringify({ applied: false, ...check }));
    if (apply && failures.length) process.exitCode = 2;
  } else {
    const backupDirectory = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory,
      `tms-filter-overlay-retry-${orderNumber}-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, `${JSON.stringify({ checkedAt: new Date().toISOString(),
      check, workOrderId: order.id, ordinaryInstanceId: order.current_ordinary_instance_id,
      priorStatus: order.status, priorStep: order.current_step,
      priorReason: order.manual_review_reason }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const commandId = crypto.randomUUID();
    await client.query(`INSERT INTO operator_commands
      (id,shop_id,work_order_id,ordinary_instance_id,command_type,payload,requested_by)
      VALUES($1,$2,$3,$4,'retry-stage',$5::jsonb,$6)`, [
      commandId, shopId, order.id, order.current_ordinary_instance_id,
      JSON.stringify({ reason: 'Verified no-action TMS read-only filter overlay after UI recovery',
        ordinaryInstanceId: order.current_ordinary_instance_id,
        platformCaseId: order.platform_case_id,
        platformCaseKey: order.platform_case_key,
        recoverySource: 'retry-verified-tms-filter-overlay-pause' }),
      'codex-verified-tms-filter-recovery',
    ]);
    await client.query('COMMIT');
    transactionOpen = false;
    console.log(JSON.stringify({ applied: true, ...check, commandId, backupPath }));
  }
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
