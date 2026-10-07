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
  throw new Error('Usage: retry-verified-chat-pause.mjs --shop ID --order N --expected-version N [--apply]');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'retry-verified-chat-pause' });
await client.connect();
let transactionOpen = false;
try {
  await client.query('BEGIN');
  transactionOpen = true;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0] || null;
  const shop = await one(`SELECT id, enabled, onboarding_status, expected_shop_name, config_version
    FROM shops WHERE id = $1 FOR UPDATE`, [shopId]);
  const binding = await one(`SELECT actual_shop_name, mall_id, binding_token::text AS token,
    profile_fingerprint FROM pdd_shop_runtime_bindings WHERE shop_id = $1`, [shopId]);
  const identity = await one(`SELECT status, expected_shop_name, mall_id, profile_fingerprint
    FROM shop_identity_bindings WHERE shop_id = $1`, [shopId]);
  const runtime = await one(`SELECT status, lease_token, current_work_order_id
    FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`, [shopId]);
  const heartbeat = await one(`SELECT heartbeat_at, metadata FROM worker_heartbeats
    WHERE shop_id = $1 ORDER BY heartbeat_at DESC LIMIT 1`, [shopId]);
  const workOrder = await one(`SELECT work_order.id, work_order.status,
      work_order.runtime_status, work_order.current_step, work_order.recovery_state,
      work_order.completion_state, work_order.manual_review_reason,
      work_order.current_ordinary_instance_id,
      work_order.payload, work_order.updated_at,
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
      AND work_order.scenario_code = 'product-shortage'
    FOR UPDATE OF work_order, instance`, [shopId, orderNumber]);
  const chat = await one(`SELECT chat.id AS case_id, chat.status, chat.collect_requested,
      chat.platform_case_id, chat.platform_case_key,
      snapshot.id AS snapshot_id, snapshot.payload AS snapshot_payload,
      job.id AS job_id, job.status AS job_status, job.result,
      job.updated_at AS analyzed_at
    FROM chat_cases chat
    JOIN LATERAL (
      SELECT * FROM chat_snapshots snapshot
      WHERE snapshot.case_id = chat.id
      ORDER BY snapshot.created_at DESC LIMIT 1
    ) snapshot ON true
    JOIN LATERAL (
      SELECT * FROM chat_analysis_jobs job
      WHERE job.case_id = chat.id AND job.snapshot_id = snapshot.id
      ORDER BY job.updated_at DESC LIMIT 1
    ) job ON true
    WHERE chat.shop_id = $1 AND chat.order_number = $2
      AND chat.scenario_code = 'product-shortage'
    FOR UPDATE OF chat`, [shopId, orderNumber]);
  const effects = workOrder ? await one(`SELECT count(*)::int AS count
    FROM external_effects WHERE work_order_id = $1`, [workOrder.id]) : null;
  const relocation = workOrder ? await one(`SELECT count(*)::int AS count
    FROM audit_events WHERE work_order_id = $1
      AND event_type = 'pending-ordinary-work-order-shop-corrected'`, [workOrder.id]) : null;
  const pendingCommand = workOrder ? await one(`SELECT id FROM operator_commands
    WHERE work_order_id = $1 AND status IN ('pending','delivered') LIMIT 1`, [workOrder.id]) : null;
  const conflictingOrder = await one(`SELECT id FROM work_orders
    WHERE external_order_number = $1 AND shop_id <> $2
      AND status NOT IN ('archived','completed') LIMIT 1`, [orderNumber, shopId]);
  const activeVerification = await one(`SELECT id FROM verification_locations
    WHERE shop_id = $1 AND resolved_at IS NULL
      AND status IN ('detected','waiting-human','verification-required') LIMIT 1`, [shopId]);
  const metadata = heartbeat?.metadata || {};
  const auth = metadata.authHealth || {};
  const messages = Array.isArray(chat?.snapshot_payload?.messages)
    ? chat.snapshot_payload.messages : [];
  const instanceIdentityChecks = {
    paused: workOrder?.instance_status === 'paused'
      && workOrder?.instance_runtime_status === 'paused',
    verified: workOrder?.identity_status === 'verified',
    platformCaseKey: workOrder?.platform_case_key ===
      `pdd-work-order:${workOrder?.platform_case_id}`,
    exactDetailUrl: workOrder?.detail_url ===
      `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${workOrder?.platform_case_id}`,
    bindingToken: workOrder?.payload?.latestDiscovery?.pddIdentityBindingToken === binding?.token,
    workOrderMall: String(workOrder?.payload?.pddMallId || '') === String(binding?.mall_id || ''),
    instanceMall: String(workOrder?.instance_payload?.pddMallId || '') === String(binding?.mall_id || ''),
    latestDiscoveryMall: workOrder?.payload?.latestDiscovery?.pddMallId
      ? String(workOrder.payload.latestDiscovery.pddMallId) === String(binding?.mall_id || '')
      : null,
  };
  const mallEvidence = {
    boundMallId: binding?.mall_id || null,
    workOrderMallId: workOrder?.payload?.pddMallId || null,
    instanceMallId: workOrder?.instance_payload?.pddMallId || null,
    latestDiscoveryMallId: workOrder?.payload?.latestDiscovery?.pddMallId || null,
  };
  const shopNameEvidence = {
    observed: workOrder?.payload?.pddShopIdentity?.actualShopName || null,
    latestDiscovery: workOrder?.payload?.latestDiscovery?.detectedShopName || null,
    instanceObserved: workOrder?.instance_payload?.pddShopIdentity?.actualShopName || null,
  };
  const mallValues = [mallEvidence.workOrderMallId, mallEvidence.instanceMallId,
    mallEvidence.latestDiscoveryMallId].filter(Boolean).map(String);
  const shopNames = Object.values(shopNameEvidence).filter(Boolean);
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
    || !['queue-waiting','queue-identity-blocked'].includes(metadata.state)
    || metadata.currentOrderNumber
    || metadata.actualShopName !== shop?.expected_shop_name
    || metadata.identityBindingToken !== binding?.token
    || String(metadata.mallId || '') !== String(binding?.mall_id || '')) {
    failures.push('worker-heartbeat-or-queue');
  }
  if (['pdd','oms','tms'].some((system) => auth[system]?.status !== 'authenticated')) {
    failures.push('system-authentication');
  }
  if (!runtime || runtime.status !== 'idle' || runtime.lease_token
    || runtime.current_work_order_id || activeVerification) failures.push('runtime-or-verification-active');
  if (!workOrder || workOrder.status !== 'paused'
    || workOrder.runtime_status !== 'paused'
    || workOrder.current_step !== 'manual-review-blocked'
    || workOrder.recovery_state !== 'ready'
    || workOrder.completion_state !== 'pending'
    || !/聊天记录|聊天采集/u.test(String(workOrder.manual_review_reason || ''))) {
    failures.push('chat-pause-state');
  }
  if (!workOrder || workOrder.instance_status !== 'paused'
    || workOrder.instance_runtime_status !== 'paused'
    || workOrder.identity_status !== 'verified'
    || !/^\d{6,30}$/u.test(String(workOrder.platform_case_id || ''))
    || workOrder.platform_case_key !== `pdd-work-order:${workOrder.platform_case_id}`
    || workOrder.detail_url !==
      `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${workOrder.platform_case_id}`
    || workOrder.payload?.latestDiscovery?.pddIdentityBindingToken !== binding?.token
    || mallValues.some((value) => value !== String(binding?.mall_id || ''))
    || shopNames.length === 0
    || shopNames.some((value) => value !== shop?.expected_shop_name)
    || Number(relocation?.count || 0) !== 0) {
    failures.push('ordinary-instance-or-binding');
  }
  if (!chat || chat.status !== 'auto-ready' || chat.collect_requested
    || chat.platform_case_id !== workOrder?.platform_case_id
    || chat.platform_case_key !== workOrder?.platform_case_key
    || chat.job_status !== 'analyzed'
    || chat.result?.analysis?.conclusion !== 'no-shortage'
    || chat.result?.policy?.eligible !== true
    || (chat.result?.policy?.issues || []).length !== 0
    || chat.snapshot_payload?.completeness?.complete !== true
    || (chat.snapshot_payload?.completeness?.issues || []).length !== 0
    || messages.length === 0
    || messages.some((message) => !['buyer','seller','system'].includes(message.role))
    || Date.parse(chat.analyzed_at) <= Date.parse(workOrder?.updated_at || 0)) {
    failures.push('fresh-chat-policy-not-eligible');
  }
  if (Number(effects?.count || 0) !== 0) failures.push('external-effect-present');
  if (pendingCommand) failures.push('existing-operator-command');
  if (conflictingOrder) failures.push('cross-shop-order-conflict');
  const check = { shopId, orderNumber, expectedVersion,
    observedVersion: shop?.config_version ?? null,
    workerState: metadata.state || null,
    platformCaseId: workOrder?.platform_case_id || null,
    chatSnapshotId: chat?.snapshot_id || null,
    chatJobId: chat?.job_id || null,
    chatConclusion: chat?.result?.analysis?.conclusion || null,
    chatEligible: chat?.result?.policy?.eligible === true,
    effectCount: Number(effects?.count || 0), instanceIdentityChecks,
    mallEvidence, shopNameEvidence, relocationCount: Number(relocation?.count || 0),
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
      `chat-pause-retry-${orderNumber}-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, `${JSON.stringify({ checkedAt: new Date().toISOString(),
      check, workOrderId: workOrder.id,
      ordinaryInstanceId: workOrder.current_ordinary_instance_id,
      previousReason: workOrder.manual_review_reason,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const commandId = crypto.randomUUID();
    await client.query(`INSERT INTO operator_commands
      (id, shop_id, work_order_id, ordinary_instance_id,
       command_type, payload, requested_by)
      VALUES ($1,$2,$3,$4,'retry-stage',$5::jsonb,$6)`, [
      commandId, shopId, workOrder.id, workOrder.current_ordinary_instance_id,
      JSON.stringify({ reason: 'Fresh complete chat analysis passed current shop policy; reevaluate exact paused order',
        ordinaryInstanceId: workOrder.current_ordinary_instance_id,
        platformCaseId: workOrder.platform_case_id,
        platformCaseKey: workOrder.platform_case_key,
        chatSnapshotId: chat.snapshot_id,
        chatJobId: chat.job_id,
        recoverySource: 'retry-verified-chat-pause' }),
      'codex-verified-chat-recovery',
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
