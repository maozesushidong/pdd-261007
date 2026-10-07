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
const cause = arg('--cause');
const expectedPlatformCaseId = arg('--platform-case-id');
const expectedVersion = Number(arg('--expected-version'));
const apply = process.argv.includes('--apply');
const allowMaintenanceDrain = process.argv.includes('--allow-maintenance-drain');
if (!/^[a-z0-9-]{5,100}$/u.test(shopId || '')
  || !/^\d{6}-\d{15}$/u.test(orderNumber || '')
  || !['empty-carrier', 'popup-animation', 'filter-no-response'].includes(cause)
  || (cause === 'filter-no-response'
    && !/^\d{6,30}$/u.test(String(expectedPlatformCaseId || '')))
  || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
  throw new Error('Usage: retry-verified-tms-no-effect-pause.mjs --shop ID --order N --cause empty-carrier|popup-animation|filter-no-response --expected-version N [--platform-case-id ID for filter-no-response] [--allow-maintenance-drain] [--apply]');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
const schedulerMode = envText.match(/^WORKER_SCHEDULER_MODE=(.+)$/mu)?.[1].trim()
  || process.env.WORKER_SCHEDULER_MODE || 'legacy';
const fixedCodeWrittenAt = (await fs.stat(path.join(appRoot, 'workflow.mjs'))).mtimeMs;
const filterCodeWrittenAt = Math.max(fixedCodeWrittenAt,
  (await fs.stat(path.join(appRoot, 'apps', 'worker', 'src',
    'postgres-playwright-runner.mjs'))).mtimeMs);
const filterCodeHashes = cause === 'filter-no-response' ? {
  workflowSha256: crypto.createHash('sha256')
    .update(await fs.readFile(path.join(appRoot, 'workflow.mjs'))).digest('hex'),
  runnerSha256: crypto.createHash('sha256')
    .update(await fs.readFile(path.join(appRoot, 'apps', 'worker', 'src',
      'postgres-playwright-runner.mjs'))).digest('hex'),
} : null;

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'retry-verified-tms-no-effect-pause' });
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
  const runtime = await one(`SELECT status, lease_token, current_work_order_id, metadata
    FROM shop_runtime_state WHERE shop_id=$1 FOR UPDATE`, [shopId]);
  const heartbeat = await one(`SELECT heartbeat_at, metadata FROM worker_heartbeats
    WHERE shop_id=$1 ORDER BY heartbeat_at DESC LIMIT 1`, [shopId]);
  const order = await one(`SELECT w.id, w.status, w.runtime_status, w.current_step,
      w.recovery_state, w.completion_state, w.manual_review_reason,
      w.current_ordinary_instance_id,
      i.status AS instance_status, i.runtime_status AS instance_runtime_status,
      i.identity_status, i.platform_case_id, i.platform_case_key, i.detail_url,
      i.payload
    FROM work_orders w JOIN ordinary_work_order_instances i
      ON i.id=w.current_ordinary_instance_id AND i.work_order_id=w.id
      AND i.shop_id=w.shop_id
    WHERE w.shop_id=$1 AND w.external_order_number=$2
      AND w.scenario_code=$3
    FOR UPDATE OF w,i`, [shopId, orderNumber,
    cause === 'empty-carrier' ? 'delivered-not-received'
      : cause === 'popup-animation' ? 'shipped-no-tracking-refund' : 'in-transit-refund']);
  const effectCount = order ? await one(`SELECT count(*)::int AS count FROM external_effects
    WHERE work_order_id=$1`, [order.id]) : null;
  const relatedUnsafeEffects = cause === 'filter-no-response'
    ? await one(`SELECT count(*)::int AS count FROM external_effects effect
      JOIN work_orders related ON related.id=effect.work_order_id
      WHERE related.shop_id=$1 AND related.external_order_number=$2
        AND effect.status IN ('failed','unknown','reserved')`, [shopId, orderNumber])
    : null;
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
  const progress = order?.payload || {};
  const autofill = progress.tmsAutofillVerification || {};
  const actual = autofill.actual || {};
  const logistics = progress.logisticsAnalysis || {};
  const reason = String(order?.manual_review_reason || '');
  const maintenanceIdle = allowMaintenanceDrain
    && schedulerMode === 'legacy'
    && runtime?.metadata?.maintenanceDrain?.active === true
    && runtime.metadata.maintenanceDrain.previousOperatorPaused === false
    && runtime.metadata.operatorPaused === true
    // finishClaimed() writes idle after an in-flight claim drains. The
    // operatorPaused flag still prevents another claim from starting.
    && ['idle', 'operator-paused'].includes(runtime.status)
    && metadata.state === 'operator-paused';
  const emptyCarrierPause = cause === 'empty-carrier'
    && order?.current_step === 'manual-review-blocked'
    && reason === '流程需要人工复核（阶段: tms-autofill-verification）：责任快递不一致'
    && autofill.conflicts?.length === 1 && autofill.conflicts[0] === '责任快递不一致'
    && actual.carrier === '优先自动带入，无匹配时请手动搜索选择'
    && /^SO[\w-]+$/iu.test(String(actual.orderNumber || '').trim())
    && Boolean(String(logistics.trackingNumber || '').trim())
    && String(actual.trackingNumber || '').replace(/\s+/gu, '')
      === String(logistics.trackingNumber || '').replace(/\s+/gu, '')
    && logistics.carrier === '邮政快递包裹';
  const popupAnimationPause = cause === 'popup-animation'
    && order?.current_step === 'flow-paused'
    && reason.startsWith('frame.click: Timeout 30000ms exceeded.')
    && reason.includes('el-dialog__headerbtn')
    && reason.includes('element is not stable')
    && !autofill.verifiedAt;
  const filterNoResponsePause = cause === 'filter-no-response'
    && order?.current_step === 'flow-paused'
    && String(order.platform_case_id) === String(expectedPlatformCaseId)
    && reason === 'TMS 交易号筛选未收到查询响应'
    && !progress.tmsWorkOrder
    && !progress.pddResolutionSubmission;
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
    || !(['queue-waiting'].includes(metadata.state) || maintenanceIdle)
    || metadata.currentOrderNumber
    || metadata.actualShopName !== shop?.expected_shop_name
    || metadata.identityBindingToken !== binding?.token
    || String(metadata.mallId || '') !== String(binding?.mall_id || '')
    || !(Date.parse(metadata.runnerStartedAt || '') >= (cause === 'filter-no-response'
      ? filterCodeWrittenAt : fixedCodeWrittenAt))
    || (filterCodeHashes && (metadata.codeBuild?.workflowSha256
      !== filterCodeHashes.workflowSha256 || metadata.codeBuild?.runnerSha256
      !== filterCodeHashes.runnerSha256))) {
    failures.push('new-worker-heartbeat-or-queue');
  }
  if (['pdd','oms','tms'].some((system) => auth[system]?.status !== 'authenticated')) {
    failures.push('system-authentication');
  }
  if (!runtime || !(['idle'].includes(runtime.status) || maintenanceIdle)
    || runtime.lease_token
    || runtime.current_work_order_id) failures.push('runtime-active');
  if (activeVerification) failures.push('verification-active');
  if (!order || order.status !== 'paused' || order.runtime_status !== 'paused'
    || order.recovery_state !== 'ready'
    || order.completion_state !== 'pending'
    || progress.pddResolutionSubmission || progress.tmsWorkOrder
    || !(emptyCarrierPause || popupAnimationPause || filterNoResponsePause)) {
    failures.push('verified-no-effect-ui-pause-only');
  }
  if (!order || order.instance_status !== 'paused'
    || order.instance_runtime_status !== 'paused'
    || order.identity_status !== 'verified'
    || !/^\d{6,30}$/u.test(String(order.platform_case_id || ''))
    || order.platform_case_key !== `pdd-work-order:${order.platform_case_id}`
    || order.detail_url !== `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${order.platform_case_id}`
    || progress.latestDiscovery?.pddIdentityBindingToken !== binding?.token
    || String(progress.pddShopIdentity?.mallId || '') !== String(binding?.mall_id || '')) {
    failures.push('ordinary-instance-or-binding');
  }
  if (Number(effectCount?.count || 0) !== 0) failures.push('external-effect-present');
  if (cause === 'filter-no-response' && Number(relatedUnsafeEffects?.count || 0) !== 0) {
    failures.push('related-unsafe-external-effect-present');
  }
  if (pendingCommand) failures.push('existing-operator-command');
  if (conflictingOrder) failures.push('cross-shop-order-conflict');

  const check = { shopId, orderNumber, cause,
    expectedPlatformCaseId: cause === 'filter-no-response' ? expectedPlatformCaseId : null,
    expectedVersion,
    observedVersion: shop?.config_version ?? null,
    workerState: metadata.state || null,
    maintenanceIdle,
    effectCount: Number(effectCount?.count || 0),
    relatedUnsafeEffectCount: cause === 'filter-no-response'
      ? Number(relatedUnsafeEffects?.count || 0) : null,
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
      `tms-${cause}-retry-${orderNumber}-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, `${JSON.stringify({ checkedAt: new Date().toISOString(),
      check, workOrderId: order.id, ordinaryInstanceId: order.current_ordinary_instance_id,
      priorStatus: order.status, priorStep: order.current_step,
      priorReason: order.manual_review_reason }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const commandId = crypto.randomUUID();
    await client.query(`INSERT INTO operator_commands
      (id,shop_id,work_order_id,ordinary_instance_id,command_type,payload,requested_by)
      VALUES($1,$2,$3,$4,'retry-stage',$5::jsonb,$6)`, [
      commandId, shopId, order.id, order.current_ordinary_instance_id,
      JSON.stringify({ reason: `Verified zero-effect TMS ${cause} UI pause after repair`,
        ordinaryInstanceId: order.current_ordinary_instance_id,
        platformCaseId: order.platform_case_id,
        platformCaseKey: order.platform_case_key,
        recoverySource: 'retry-verified-tms-no-effect-pause' }),
      'codex-verified-tms-ui-recovery',
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
