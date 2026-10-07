import crypto from 'node:crypto';
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
const expectedVersion = Number(argument('--expected-version'));
const apply = process.argv.includes('--apply');
const queueAfterScan = process.argv.includes('--queue-after-scan');
const repairedCodeWrittenAt = Math.max(
  (await fs.stat(path.join(appRoot, 'workflow.mjs'))).mtimeMs,
  (await fs.stat(path.join(appRoot,
    'packages/adapters/src/pdd/consumer-address-change-in-transit.mjs'))).mtimeMs,
);
const contactStage = 'ordinary-consumer-address-change-in-transit-contact-logistics-address-change-v1';
const expectedStage = 'ordinary-consumer-address-change-in-transit-address-change-in-transit-result-v1';
const completedContactStage = 'contact-logistics-address-change';
if (!/^[a-z0-9-]{5,100}$/u.test(shopId || '')
  || !/^\d{6}-\d{15}$/u.test(orderNumber || '')
  || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
  throw new Error('Usage: retry-verified-in-transit-result-message-pause.mjs --shop ID --order N --expected-version N [--queue-after-scan] [--apply]');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'retry-verified-in-transit-result-message-pause' });
await client.connect();
let transactionOpen = false;
try {
  await client.query('BEGIN');
  transactionOpen = true;
  const one = async (sql, parameters) => (await client.query(sql, parameters)).rows[0] || null;
  const shop = await one(`SELECT id, enabled, onboarding_status, expected_shop_name, config_version
    FROM shops WHERE id = $1 FOR UPDATE`, [shopId]);
  const binding = await one(`SELECT binding_token::text AS token, actual_shop_name,
      mall_id, profile_fingerprint
    FROM pdd_shop_runtime_bindings WHERE shop_id = $1`, [shopId]);
  const identity = await one(`SELECT status, expected_shop_name, mall_id, profile_fingerprint
    FROM shop_identity_bindings WHERE shop_id = $1`, [shopId]);
  const runtime = await one(`SELECT status, lease_token, current_work_order_id
    FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`, [shopId]);
  const heartbeat = await one(`SELECT heartbeat_at, metadata FROM worker_heartbeats
    WHERE shop_id = $1 ORDER BY heartbeat_at DESC LIMIT 1`, [shopId]);
  const order = await one(`SELECT w.id, w.shop_id, w.status, w.runtime_status,
      w.current_step, w.recovery_state, w.completion_state, w.manual_review_reason,
      w.current_ordinary_instance_id, w.payload,
      i.status AS instance_status, i.runtime_status AS instance_runtime_status,
      i.identity_status, i.platform_case_id, i.platform_case_key, i.detail_url
    FROM work_orders w
    JOIN ordinary_work_order_instances i ON i.id = w.current_ordinary_instance_id
      AND i.work_order_id = w.id AND i.shop_id = w.shop_id
    WHERE w.shop_id = $1 AND w.external_order_number = $2
      AND w.scenario_code = 'consumer-address-change-in-transit'
    FOR UPDATE OF w, i`, [shopId, orderNumber]);
  const effects = order ? (await client.query(`SELECT effect_type, status,
      idempotency_key, receipt
    FROM external_effects WHERE work_order_id = $1 ORDER BY reserved_at, id`,
  [order.id])).rows : [];
  const pendingCommand = order ? await one(`SELECT id FROM operator_commands
    WHERE work_order_id = $1 AND status IN ('pending', 'delivered') LIMIT 1`,
  [order.id]) : null;
  const activeVerification = await one(`SELECT id FROM verification_locations
    WHERE shop_id = $1 AND resolved_at IS NULL
      AND status IN ('detected', 'waiting-human', 'verification-required') LIMIT 1`, [shopId]);
  const conflictingOrder = await one(`SELECT id FROM work_orders
    WHERE external_order_number = $1 AND shop_id <> $2
      AND status NOT IN ('archived', 'completed') LIMIT 1`, [orderNumber, shopId]);

  const metadata = heartbeat?.metadata || {};
  const auth = metadata.authHealth || {};
  const submission = order?.payload?.pddResolutionSubmission || {};
  const formRecovery = order?.payload?.ordinaryPddFormRecovery || {};
  const proof = formRecovery.notAppliedProof || {};
  const submits = effects.filter((effect) => effect.effect_type === 'pdd-submit');
  const contactSubmit = submits.find((effect) => effect.idempotency_key ===
    `pdd-submit:${shopId}:pdd-work-order:${order?.platform_case_id}:${contactStage}`);
  const failedSubmit = submits.find((effect) => effect.idempotency_key ===
    `pdd-submit:${shopId}:pdd-work-order:${order?.platform_case_id}:${expectedStage}`);
  const tms = effects.filter((effect) => effect.effect_type === 'tms-create');
  const note = effects.filter((effect) => effect.effect_type === 'pdd-note');
  // This command is only queued here; the runner applies it after the scan.
  // Keep the no-lease requirement so no active external action is interrupted.
  const scanningWithoutClaim = queueAfterScan
    && metadata.state === 'return-refund-scan-running'
    && !metadata.currentOrderNumber
    && runtime?.status === 'idle'
    && !runtime.lease_token
    && !runtime.current_work_order_id;
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
    || !(metadata.state === 'queue-waiting' || scanningWithoutClaim)
    || metadata.currentOrderNumber
    || metadata.actualShopName !== shop?.expected_shop_name
    || metadata.identityBindingToken !== binding?.token
    || String(metadata.mallId || '') !== String(binding?.mall_id || '')
    || !(Date.parse(metadata.runnerStartedAt || '') >= repairedCodeWrittenAt)) {
    failures.push('new-worker-heartbeat-or-queue');
  }
  if (['pdd', 'oms', 'tms'].some((system) => auth[system]?.status !== 'authenticated')) {
    failures.push('system-authentication');
  }
  if (!runtime || runtime.status !== 'idle' || runtime.lease_token
    || runtime.current_work_order_id) failures.push('runtime-active');
  if (activeVerification) failures.push('verification-active');
  if (!order || order.status !== 'paused' || order.runtime_status !== 'paused'
    || order.current_step !== 'flow-paused' || order.recovery_state !== 'ready'
    || order.completion_state !== 'pending'
    || !String(order.manual_review_reason || '').startsWith(
      'PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE: 拼多多自动话术未包含必需内容:')
    || submission.status !== 'form-retry' || submission.effectStage !== expectedStage
    || submission.orderNumber !== orderNumber || submission.submitAttemptCount !== 0
    || submission.lastClickAttemptedAt
    || formRecovery.status !== 'retry-ready' || formRecovery.effectStage !== expectedStage
    || proof.state !== 'not-applied' || proof.clickAttempted !== false
    || proof.observedOrderNumber !== orderNumber || proof.exactPendingEditableDetail !== true
    || !(Number(proof.editableControlCount) > 0)
    || !order.payload?.ordinaryScenarioFacts?.completedPddStages?.includes(completedContactStage)
    || !order.payload?.ordinaryScenarioExecution?.completedPddStages?.includes(completedContactStage)) {
    failures.push('paused-no-click-form-proof');
  }
  if (!order || order.instance_status !== 'paused' || order.instance_runtime_status !== 'paused'
    || order.identity_status !== 'verified'
    || !/^\d{6,30}$/u.test(String(order.platform_case_id || ''))
    || order.platform_case_key !== `pdd-work-order:${order.platform_case_id}`
    || order.detail_url !== `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${order.platform_case_id}`
    || order.payload?.latestDiscovery?.pddIdentityBindingToken !== binding?.token
    || String(order.payload?.pddShopIdentity?.mallId || '') !== String(binding?.mall_id || '')) {
    failures.push('ordinary-instance-or-binding');
  }
  if (effects.length !== 4 || tms.length !== 1 || note.length !== 1
    || submits.length !== 2 || tms[0]?.status !== 'succeeded'
    || tms[0]?.receipt?.result?.success !== true
    || note[0]?.status !== 'succeeded'
    || note[0]?.receipt?.result?.saved !== true
    || contactSubmit?.status !== 'succeeded'
    || contactSubmit?.receipt?.result?.submitReceipt?.success !== true
    || contactSubmit?.receipt?.result?.submitClicked !== true
    || contactSubmit?.receipt?.result?.transitionConfirmed !== true
    || !['联系物流协商修改地址', '尝试联系物流修改收件地址']
      .includes(contactSubmit?.receipt?.result?.selectedPddOption)
    || failedSubmit?.status !== 'failed'
    || failedSubmit?.receipt?.clickAttempted !== false
    || failedSubmit?.receipt?.notAppliedProof?.state !== 'not-applied'
    || failedSubmit?.receipt?.notAppliedProof?.observedOrderNumber !== orderNumber) {
    failures.push('external-effects-not-proven-safe');
  }
  if (pendingCommand) failures.push('existing-operator-command');
  if (conflictingOrder) failures.push('cross-shop-order-conflict');

  const check = {
    shopId, orderNumber, expectedVersion,
    queueAfterScan,
    observedVersion: shop?.config_version ?? null,
    workerState: metadata.state || null,
    runnerStartedAt: metadata.runnerStartedAt || null,
    platformCaseId: order?.platform_case_id || null,
    effects: effects.map((effect) => ({ type: effect.effect_type, status: effect.status })),
    safe: failures.length === 0, failures,
  };
  if (!apply || failures.length) {
    await client.query('ROLLBACK');
    transactionOpen = false;
    console.log(JSON.stringify({ applied: false, ...check }));
    if (apply && failures.length) process.exitCode = 2;
  } else {
    const backupDirectory = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory,
      `in-transit-result-message-retry-${orderNumber}-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({ checkedAt: new Date().toISOString(),
      check, workOrderId: order.id, ordinaryInstanceId: order.current_ordinary_instance_id,
      priorStatus: order.status, priorStep: order.current_step,
      priorReason: order.manual_review_reason }, null, 2), { flag: 'wx' });
    const commandId = crypto.randomUUID();
    await client.query(`INSERT INTO operator_commands
      (id, shop_id, work_order_id, ordinary_instance_id, command_type, payload, requested_by)
      VALUES ($1, $2, $3, $4, 'retry-stage', $5::jsonb, $6)`, [
      commandId, shopId, order.id, order.current_ordinary_instance_id,
      JSON.stringify({ reason: 'Verified no-click second-stage form failure after PDD wording change; preserve successful first stage',
        ordinaryInstanceId: order.current_ordinary_instance_id,
        platformCaseId: order.platform_case_id,
        platformCaseKey: order.platform_case_key,
        recoverySource: 'retry-verified-in-transit-result-message-pause' }),
      'codex-verified-in-transit-result-message-recovery',
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
