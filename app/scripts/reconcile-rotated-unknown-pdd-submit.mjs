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
const orderNumber = argument('--order');
const platformCaseId = argument('--platform-case-id');
const expectedVersion = Number(argument('--expected-version'));
const apply = process.argv.includes('--apply');
if (!/^[a-z0-9-]{5,100}$/u.test(shopId || '')
  || !/^\d{6}-\d{15}$/u.test(orderNumber || '')
  || !/^\d{6,30}$/u.test(platformCaseId || '')
  || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
  throw new Error('Usage: reconcile-rotated-unknown-pdd-submit.mjs --shop ID --order N --platform-case-id N --expected-version N [--apply]');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'reconcile-rotated-unknown-pdd-submit' });
await client.connect();
let transactionOpen = false;
try {
  await client.query('BEGIN');
  transactionOpen = true;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0] || null;
  const shop = await one(`SELECT id, enabled, onboarding_status, expected_shop_name, config_version
    FROM shops WHERE id = $1 FOR UPDATE`, [shopId]);
  const binding = await one(`SELECT actual_shop_name, mall_id, binding_token::text AS token,
      profile_fingerprint FROM pdd_shop_runtime_bindings WHERE shop_id = $1
      FOR SHARE`, [shopId]);
  const identity = await one(`SELECT status, expected_shop_name, mall_id, profile_fingerprint
    FROM shop_identity_bindings WHERE shop_id = $1 FOR SHARE`, [shopId]);
  const runtime = await one(`SELECT status, lease_token, current_work_order_id
    FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`, [shopId]);
  const heartbeat = await one(`SELECT heartbeat_at, metadata FROM worker_heartbeats
    WHERE shop_id = $1 ORDER BY heartbeat_at DESC LIMIT 1`, [shopId]);
  const workOrder = await one(`SELECT work_order.*, instance.id AS instance_id,
      instance.status AS instance_status,
      instance.runtime_status AS instance_runtime_status,
      instance.identity_status, instance.platform_case_id,
      instance.platform_case_key, instance.detail_url,
      instance.payload AS instance_payload
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
      AND instance.work_order_id = work_order.id
      AND instance.shop_id = work_order.shop_id
    WHERE work_order.shop_id = $1 AND work_order.external_order_number = $2
      AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    FOR UPDATE OF work_order, instance`, [shopId, orderNumber]);
  const effects = workOrder ? (await client.query(`SELECT * FROM external_effects
    WHERE work_order_id = $1 ORDER BY updated_at FOR UPDATE`, [workOrder.id])).rows : [];
  const activeVerification = await one(`SELECT id FROM verification_locations
    WHERE shop_id = $1 AND resolved_at IS NULL
      AND status IN ('detected','waiting-human','verification-required') LIMIT 1`, [shopId]);
  const otherOrder = await one(`SELECT id FROM work_orders
    WHERE external_order_number = $1 AND shop_id <> $2
      AND status NOT IN ('archived','completed') LIMIT 1`, [orderNumber, shopId]);
  const pendingCommand = workOrder ? await one(`SELECT id FROM operator_commands
    WHERE work_order_id = $1 AND status IN ('pending','delivered') LIMIT 1`, [workOrder.id]) : null;

  const metadata = heartbeat?.metadata || {};
  const auth = metadata.authHealth || {};
  const oldToken = workOrder?.payload?.latestDiscovery?.pddIdentityBindingToken || null;
  const mallEvidence = [
    workOrder?.payload?.pddMallId,
    workOrder?.payload?.latestDiscovery?.pddMallId,
    workOrder?.payload?.pddShopIdentity?.mallId,
    workOrder?.instance_payload?.pddMallId,
    workOrder?.instance_payload?.latestDiscovery?.pddMallId,
    workOrder?.instance_payload?.pddShopIdentity?.mallId,
  ].filter(Boolean).map(String);
  const nameEvidence = [
    workOrder?.payload?.shopNameSnapshot,
    workOrder?.payload?.detectedShopName,
    workOrder?.payload?.latestDiscovery?.actualShopName,
    workOrder?.payload?.pddShopIdentity?.actualShopName,
    workOrder?.instance_payload?.shopNameSnapshot,
    workOrder?.instance_payload?.detectedShopName,
    workOrder?.instance_payload?.latestDiscovery?.actualShopName,
    workOrder?.instance_payload?.pddShopIdentity?.actualShopName,
  ].filter(Boolean).map((value) => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim());
  const unknownSubmit = effects.filter((effect) => effect.effect_type === 'pdd-submit'
    && effect.status === 'unknown'
    && effect.ordinary_instance_id === workOrder?.instance_id);
  const failures = [];
  if (!shop?.enabled || shop.onboarding_status !== 'ready'
    || shop.config_version !== expectedVersion) failures.push('shop-version-or-readiness');
  if (!binding || !identity || identity.status !== 'confirmed'
    || binding.actual_shop_name !== shop?.expected_shop_name
    || identity.expected_shop_name !== shop?.expected_shop_name
    || String(binding.mall_id || '') !== String(identity.mall_id || '')
    || binding.profile_fingerprint !== identity.profile_fingerprint) {
    failures.push('current-shop-identity');
  }
  if (!heartbeat || Date.now() - Date.parse(heartbeat.heartbeat_at) > 20_000
    || !['queue-identity-blocked', 'queue-waiting'].includes(metadata.state)
    || metadata.currentOrderNumber
    || metadata.actualShopName !== shop?.expected_shop_name
    || metadata.identityBindingToken !== binding?.token
    || String(metadata.mallId || '') !== String(binding?.mall_id || '')
    || ['pdd', 'oms', 'tms'].some((system) => auth[system]?.status !== 'authenticated')) {
    failures.push('fresh-idle-worker-and-authentication');
  }
  if (!runtime || runtime.status !== 'idle' || runtime.lease_token
    || runtime.current_work_order_id || activeVerification) failures.push('runtime-or-verification-active');
  if (!workOrder || workOrder.status !== 'retry-ready'
    || workOrder.runtime_status !== 'retry-ready'
    || workOrder.current_step !== 'logistics-waiting-released'
    || workOrder.recovery_state !== 'ready'
    || workOrder.completion_state !== 'pending'
    || workOrder.instance_status !== 'retry-ready'
    || workOrder.instance_runtime_status !== 'retry-ready'
    || workOrder.identity_status !== 'verified'
    || String(workOrder.platform_case_id || '') !== platformCaseId
    || workOrder.platform_case_key !== `pdd-work-order:${platformCaseId}`
    || workOrder.detail_url !==
      `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformCaseId}`) {
    failures.push('exact-work-order-and-instance');
  }
  if (!oldToken || oldToken === binding?.token
    || workOrder?.instance_payload?.latestDiscovery?.pddIdentityBindingToken !== oldToken
    || !mallEvidence.length || mallEvidence.some((value) => value !== String(binding?.mall_id || ''))
    || !nameEvidence.length || nameEvidence.some((value) => value !== shop?.expected_shop_name)) {
    failures.push('historical-binding-and-mall-evidence');
  }
  if (unknownSubmit.length !== 1 || effects.length < 2
    || effects.some((effect) => effect.ordinary_instance_id !== workOrder?.instance_id
      || (effect !== unknownSubmit[0] && effect.status !== 'succeeded'))
    || !unknownSubmit[0]?.idempotency_key?.startsWith(
      `pdd-submit:${shopId}:pdd-work-order:${platformCaseId}:`
    )) failures.push('unique-unknown-submit-and-other-effects');
  if (otherOrder || pendingCommand) failures.push('conflicting-order-or-command');

  const summary = {
    shopId, orderNumber, platformCaseId, expectedVersion,
    effectStatuses: effects.map((effect) => `${effect.effect_type}:${effect.status}`),
    oldBindingDiffers: Boolean(oldToken && oldToken !== binding?.token),
    mallEvidenceCount: mallEvidence.length,
    failures,
    apply,
  };
  if (failures.length || !apply) {
    await client.query('ROLLBACK');
    transactionOpen = false;
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) process.exitCode = 2;
  } else {
    const backupDir = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir,
      `unknown-pdd-submit-readonly-${orderNumber}-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({
      savedAt: new Date().toISOString(), shopId, orderNumber, platformCaseId,
      workOrder, effects,
    }, null, 2), { flag: 'wx', mode: 0o600 });
    const recovery = {
      status: 'read-only-reconciliation-ready',
      strategy: 'exact-mall-current-binding-unknown-submit-no-resubmit',
      platformCaseId,
      previousBindingToken: oldToken,
      currentBindingToken: binding.token,
      externalActionsReplayed: false,
      scheduledAt: new Date().toISOString(),
    };
    const latestDiscovery = {
      ...(workOrder.payload?.latestDiscovery || {}),
      pddIdentityBindingToken: binding.token,
      pddMallId: String(binding.mall_id),
      actualShopName: binding.actual_shop_name,
      historicalUnknownSubmitReadOnlyAt: recovery.scheduledAt,
    };
    const nextPayload = {
      ...(workOrder.payload || {}),
      pddIdentityBindingToken: binding.token,
      pddMallId: String(binding.mall_id),
      latestDiscovery,
      historicalUnknownPddSubmitReadOnlyRecovery: recovery,
      step: 'external-state-reconciliation-ready',
    };
    const nextInstancePayload = {
      ...(workOrder.instance_payload || {}),
      pddIdentityBindingToken: binding.token,
      pddMallId: String(binding.mall_id),
      latestDiscovery: {
        ...(workOrder.instance_payload?.latestDiscovery || {}),
        pddIdentityBindingToken: binding.token,
        pddMallId: String(binding.mall_id),
        actualShopName: binding.actual_shop_name,
      },
      historicalUnknownPddSubmitReadOnlyRecovery: recovery,
      step: 'external-state-reconciliation-ready',
    };
    const reason = '等待只读核对历史未知拼多多提交结果，禁止重复提交';
    await client.query(`UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
      current_step = 'external-state-reconciliation-ready', manual_review_reason = $2,
      next_attempt_at = now(), recovery_state = 'ready', recovery_reason = NULL,
      recovery_version = recovery_version + 1, recovery_updated_at = now(),
      payload = $3::jsonb, updated_at = now() WHERE id = $1`, [
      workOrder.id, reason, JSON.stringify(nextPayload),
    ]);
    await client.query(`UPDATE ordinary_work_order_instances SET status = 'paused',
      runtime_status = 'paused', current_step = 'external-state-reconciliation-ready',
      manual_review_reason = $2, next_attempt_at = now(), payload = $3::jsonb,
      updated_at = now() WHERE id = $1`, [
      workOrder.instance_id, reason, JSON.stringify(nextInstancePayload),
    ]);
    await client.query(`INSERT INTO audit_events
      (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
       deduplication_key) VALUES
      ($1,$2,$3,'system','historical-unknown-pdd-submit-read-only-reconciliation-ready',
       $4::jsonb,$5)`, [shopId, workOrder.id, workOrder.instance_id,
      JSON.stringify({ orderNumber, platformCaseId, strategy: recovery.strategy,
        effectId: unknownSubmit[0].id, externalActionsReplayed: false }),
      `historical-unknown-pdd-submit-readonly:${workOrder.id}:${binding.token}`]);
    await client.query('COMMIT');
    transactionOpen = false;
    console.log(JSON.stringify({ ...summary, backupPath,
      transition: 'paused/read-only-reconciliation-ready' }, null, 2));
  }
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
