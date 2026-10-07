import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';
import { matchesStaleMissingMallReload } from './stale-missing-mall-reload-policy.mjs';
import { matchesFreshLegacyPddBusinessObservation } from './fresh-legacy-pdd-business-observation.mjs';
import { matchesDispatchedRefundManualHold } from './dispatched-refund-hold-reload-policy.mjs';
import { createCodeReloadScanCadence } from '../apps/worker/src/worker-code-reload-cadence.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = arg('--shop');
const expectedVersion = Number(arg('--expected-version'));
const apply = process.argv.includes('--apply');
const allowPddLoginWaiting = process.argv.includes('--allow-pdd-login-waiting');
const allowPddBusinessWaiting = process.argv.includes('--allow-pdd-business-waiting');
const allowObservedPddLogin = process.argv.includes('--allow-observed-pdd-login');
const allowStalePddVerificationLogin = process.argv.includes('--allow-stale-pdd-verification-login');
const allowMaintenanceDrain = process.argv.includes('--allow-maintenance-drain');
const allowPddVerificationWaiting = process.argv.includes('--allow-pdd-verification-waiting');
const allowStuckTmsLogin = process.argv.includes('--allow-stuck-tms-login');
const allowTmsExpiredIdle = process.argv.includes('--allow-tms-expired-idle');
const allowStaleMissingMall = process.argv.includes('--allow-stale-verification-missing-mall');
const allowArchivedDiscardedUnknown = process.argv.includes('--allow-archived-discarded-unknown');
const allowDeferredUnknownForCodeReload = process.argv.includes('--allow-deferred-unknown-for-code-reload');
const allowDispatchedRefundManualHold = process.argv.includes('--allow-dispatched-refund-manual-hold');
const expectedManualHoldWorkOrderId = arg('--manual-hold-work-order-id');
const expectedManualHoldEffectId = arg('--manual-hold-effect-id');
const expectedAftersaleNumber = arg('--expected-aftersale');
const expectedVerificationId = arg('--verification-id');
const expectedOrderNumber = arg('--expected-order');
const expectedDiscardedWorkOrderId = arg('--discarded-work-order-id');
const expectedDiscardedEffectId = arg('--discarded-effect-id');
const expectedUnknownEffectId = arg('--unknown-effect-id');
const expectedSupersedingEffectId = arg('--superseding-effect-id');
const acceptReloginRisk = process.argv.includes('--accept-relogin-risk');
if (!shopId || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
  throw new Error('Usage: safe-single-shop-reload.mjs --shop ID --expected-version N [--allow-pdd-login-waiting] [--allow-pdd-business-waiting] [--allow-observed-pdd-login] [--allow-stale-pdd-verification-login --verification-id UUID --expected-order ORDER --accept-relogin-risk] [--allow-maintenance-drain] [--allow-tms-expired-idle] [--allow-pdd-verification-waiting --verification-id UUID --accept-relogin-risk] [--allow-stuck-tms-login --expected-order ORDER --accept-relogin-risk] [--allow-archived-discarded-unknown --discarded-work-order-id UUID --discarded-effect-id UUID] [--allow-deferred-unknown-for-code-reload --expected-order ORDER --unknown-effect-id UUID --superseding-effect-id UUID] [--apply]');
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
if (allowDispatchedRefundManualHold
  && (!uuidPattern.test(String(expectedManualHoldWorkOrderId || ''))
    || !uuidPattern.test(String(expectedManualHoldEffectId || ''))
    || !/^\d{6}-\d{15}$/u.test(String(expectedOrderNumber || ''))
    || !/^\d{6,30}$/u.test(String(expectedAftersaleNumber || '')))) {
  throw new Error('--allow-dispatched-refund-manual-hold requires exact --manual-hold-work-order-id, --manual-hold-effect-id, --expected-order and --expected-aftersale');
}
if (allowStaleMissingMall && !uuidPattern.test(String(expectedVerificationId || ''))) {
  throw new Error('--allow-stale-verification-missing-mall requires an exact --verification-id');
}
const confirmedExpiredPddSession = (pddAuth, now = Date.now()) => {
  if (pddAuth?.status !== 'expired') return false;
  if (['rendered-login-url', 'controlled-login-check'].includes(pddAuth.evidence)) return true;
  const checkedAtMs = Date.parse(String(pddAuth.checkedAt || ''));
  return pddAuth.evidence === 'session-cookie-unusable'
    && pddAuth.confidence === 'confirmed'
    && ['resident-session-recovery', 'pdd-post-login-stability'].includes(pddAuth.source)
    && Number.isFinite(checkedAtMs)
    && now >= checkedAtMs
    && now - checkedAtMs <= 30_000;
};
const freshObservedPddLoginUrl = (systemTabs, now = Date.now()) => {
  const checkedAtMs = Date.parse(String(systemTabs?.checkedAt || ''));
  if (!Number.isFinite(checkedAtMs) || now < checkedAtMs
    || now - checkedAtMs > 20_000) return false;
  try {
    const url = new URL(String(systemTabs?.pdd?.url || ''));
    return url.origin === 'https://mms.pinduoduo.com'
      && /^\/login\/?$/u.test(url.pathname);
  } catch { return false; }
};
const observedPddBusinessUrl = (systemTabs) => {
  try {
    const url = new URL(String(systemTabs?.pdd?.url || ''));
    return url.origin === 'https://mms.pinduoduo.com'
      && url.pathname.startsWith('/aftersales/');
  } catch { return false; }
};
const loginRedirectMatchesRefund = (rawUrl, orderNumber, aftersaleNumber) => {
  try {
    const login = new URL(String(rawUrl || ''));
    const target = new URL(login.searchParams.get('redirectUrl') || '');
    return login.origin === 'https://mms.pinduoduo.com'
      && /^\/login\/?$/u.test(login.pathname)
      && target.origin === login.origin
      && target.pathname === '/aftersales-ssr/detail'
      && target.searchParams.get('orderSn') === orderNumber
      && target.searchParams.get('id') === aftersaleNumber;
  } catch { return false; }
};
if (allowArchivedDiscardedUnknown
  && (!uuidPattern.test(String(expectedDiscardedWorkOrderId || ''))
    || !uuidPattern.test(String(expectedDiscardedEffectId || '')))) {
  throw new Error('--allow-archived-discarded-unknown requires exact --discarded-work-order-id and --discarded-effect-id UUIDs');
}
if (allowDeferredUnknownForCodeReload
  && (!/^\d{6}-\d{15}$/u.test(String(expectedOrderNumber || ''))
    || !uuidPattern.test(String(expectedUnknownEffectId || ''))
    || !uuidPattern.test(String(expectedSupersedingEffectId || ''))
    || expectedUnknownEffectId === expectedSupersedingEffectId)) {
  throw new Error('--allow-deferred-unknown-for-code-reload requires an exact order and distinct unknown/superseding effect UUIDs');
}
if (allowStalePddVerificationLogin
  && (!uuidPattern.test(String(expectedVerificationId || ''))
    || !/^\d{6}-\d{15}$/u.test(String(expectedOrderNumber || ''))
    || !allowPddLoginWaiting)) {
  throw new Error('--allow-stale-pdd-verification-login requires --allow-pdd-login-waiting, exact --verification-id and --expected-order');
}
if (apply && allowStalePddVerificationLogin && !acceptReloginRisk) {
  throw new Error('Applying a stale PDD verification login reload requires --accept-relogin-risk');
}
if (allowPddVerificationWaiting && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
  .test(String(expectedVerificationId || ''))) {
  throw new Error('--allow-pdd-verification-waiting requires --verification-id UUID');
}
if (apply && allowPddVerificationWaiting && !acceptReloginRisk) {
  throw new Error('Applying a verification restart requires --accept-relogin-risk');
}
if (allowStuckTmsLogin && !/^\d{6}-\d{15}$/u.test(String(expectedOrderNumber || ''))) {
  throw new Error('--allow-stuck-tms-login requires --expected-order with an exact PDD order number');
}
if (apply && allowStuckTmsLogin && !acceptReloginRisk) {
  throw new Error('Applying a TMS login restart requires --accept-relogin-risk');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const schedulerMode = envText.match(/^WORKER_SCHEDULER_MODE=(.+)$/mu)?.[1].trim()
  || process.env.WORKER_SCHEDULER_MODE || 'legacy';
const databaseLine = envText.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'safe-single-shop-code-reload' });
await client.connect();
let inTransaction = false;
try {
  await client.query('BEGIN');
  inTransaction = true;
  const queryOne = async (sql) => (await client.query(sql, [shopId])).rows[0] || null;
  const shop = await queryOne(`
    SELECT id, name, enabled, onboarding_status, expected_shop_name, config_version
    FROM shops WHERE id = $1 FOR UPDATE`);
  const binding = await queryOne(`
    SELECT binding_token::text AS binding_token, actual_shop_name, mall_id,
      last_seen_at, profile_fingerprint
    FROM pdd_shop_runtime_bindings WHERE shop_id = $1`);
  const identity = await queryOne(`
    SELECT status, expected_shop_name, mall_id, profile_fingerprint
    FROM shop_identity_bindings WHERE shop_id = $1`);
  const runtime = await queryOne(`
    SELECT status, lease_token, lease_expires_at, current_work_order_id, metadata
    FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`);
  const heartbeat = await queryOne(`
    SELECT worker_id, heartbeat_at, metadata
    FROM worker_heartbeats WHERE shop_id = $1
    ORDER BY heartbeat_at DESC LIMIT 1`);
  const active = await queryOne(`
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
  const activeVerificationRows = (await client.query(`
    SELECT verification.id, verification.system_name, verification.status,
      verification.work_order_id, work_order.status AS work_status,
      work_order.runtime_status AS work_runtime_status
    FROM verification_locations verification
    LEFT JOIN work_orders work_order ON work_order.id = verification.work_order_id
    WHERE verification.shop_id = $1
      AND verification.status IN ('detected', 'waiting-human', 'verification-required')
      AND verification.resolved_at IS NULL
    ORDER BY verification.detected_at DESC LIMIT 2 FOR UPDATE OF verification`, [shopId])).rows;
  const uncertainEffectRows = (await client.query(`
    SELECT effect.id, effect.effect_type, effect.status AS effect_status,
      effect.idempotency_key, effect.updated_at AS effect_updated_at,
      effect.ordinary_instance_id,
      work_order.id AS work_order_id, work_order.external_order_number,
      work_order.scenario_code, work_order.status AS work_status,
      work_order.runtime_status AS work_runtime_status,
      work_order.frontend_visibility, work_order.updated_at AS work_updated_at,
      work_order.current_step, work_order.recovery_state,
      work_order.completion_state,
      work_order.next_attempt_at,
      work_order.current_ordinary_instance_id,
      instance.id AS instance_id, instance.status AS instance_status,
      instance.runtime_status AS instance_runtime_status,
      instance.current_step AS instance_current_step,
      instance.completed_at AS instance_completed_at,
      instance.work_order_id AS instance_work_order_id,
      instance.shop_id AS instance_shop_id,
      instance.identity_status AS instance_identity_status,
      instance.platform_case_id, instance.platform_case_key,
      instance.detail_url,
      effect.receipt AS effect_receipt, effect.error AS effect_error
    FROM external_effects effect
    LEFT JOIN work_orders work_order ON work_order.id = effect.work_order_id
    LEFT JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE effect.shop_id = $1 AND effect.status = 'unknown'`, [shopId])).rows;
  const archivedUnknownIsInert = async (row) => {
    if (row.effect_type === 'pdd-return-refund'
      || row.work_status !== 'archived' || row.work_runtime_status !== 'archived'
      || row.completion_state !== 'confirmed'
      || row.instance_status !== 'archived'
      || row.instance_runtime_status !== 'archived'
      || !row.instance_id || row.instance_id !== row.current_ordinary_instance_id
      || row.ordinary_instance_id !== row.instance_id
      || !/^\d{6,30}$/u.test(String(row.platform_case_id || ''))
      || row.platform_case_key !== `pdd-work-order:${row.platform_case_id}`) return false;
    const archivePath = path.resolve(appRoot, '..', 'data', 'workflow', 'shops', shopId,
      'state', 'completed-work-orders', `pdd-work-order-${row.platform_case_id}.json`);
    try {
      const archive = JSON.parse(await fs.readFile(archivePath, 'utf8'));
      return archive.completionArchive?.orderNumber === row.external_order_number
        && archive.completionArchive?.platformCaseKey === row.platform_case_key
        && String(archive.completionArchive?.outcome || '').trim().length > 0;
    } catch { return false; }
  };
  const heldUnknownIsInertForCodeReload = async (row) => {
    if (row.effect_type !== 'pdd-submit'
      || row.effect_status !== 'unknown'
      || row.work_status !== 'paused'
      || row.work_runtime_status !== 'paused'
      || row.current_step !== 'external-state-unresolved'
      || row.recovery_state !== 'held'
      || row.completion_state !== 'pending'
      || row.next_attempt_at != null
      || row.instance_status !== 'paused'
      || row.instance_runtime_status !== 'paused'
      || row.instance_identity_status !== 'verified'
      || !row.instance_id
      || row.instance_id !== row.current_ordinary_instance_id
      || row.ordinary_instance_id !== row.instance_id
      || row.instance_work_order_id !== row.work_order_id
      || row.instance_shop_id !== shopId
      || !/^[0-9]{6,30}$/u.test(String(row.platform_case_id || ''))
      || row.platform_case_key !== `pdd-work-order:${row.platform_case_id}`) return false;
    const { rows: [commands] } = await client.query(`
      SELECT count(*)::int AS active FROM operator_commands
      WHERE work_order_id = $1 AND status IN ('pending','delivered')`,
    [row.work_order_id]);
    return commands?.active === 0;
  };
  const archivedDiscardedUnknownIsInert = async (row) => {
    // This exception only permits a code reload. It neither reconciles the
    // unknown PDD effect nor makes the archived order claimable again.
    if (!allowArchivedDiscardedUnknown
      || row.id !== expectedDiscardedEffectId
      || row.work_order_id !== expectedDiscardedWorkOrderId
      || row.effect_type !== 'pdd-submit'
      || row.effect_status !== 'unknown'
      || !String(row.idempotency_key || '').endsWith(':handover')
      || row.work_status !== 'archived'
      || row.work_runtime_status !== 'archived'
      || row.current_step !== 'operator-discarded-new-start'
      || row.completion_state !== 'pending'
      || row.frontend_visibility !== 'recovery-audit'
      || row.instance_status !== 'archived'
      || row.instance_runtime_status !== 'archived'
      || row.instance_current_step !== 'operator-discarded-new-start'
      || !row.instance_completed_at
      || row.instance_identity_status !== 'verified'
      || row.instance_work_order_id !== row.work_order_id
      || row.instance_shop_id !== shopId
      || row.instance_id !== row.current_ordinary_instance_id
      || row.ordinary_instance_id !== row.instance_id
      || !/^\d{6,30}$/u.test(String(row.platform_case_id || ''))
      || row.platform_case_key !== `pdd-work-order:${row.platform_case_id}`
      || row.detail_url !== `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${row.platform_case_id}`
      || !(Date.parse(row.effect_updated_at || '') < Date.parse(row.work_updated_at || ''))) {
      return false;
    }
    const { rows: [counts] } = await client.query(`
      SELECT
        (SELECT count(*)::int FROM external_effects
         WHERE work_order_id=$1) AS effects,
        (SELECT count(*)::int FROM operator_commands
         WHERE work_order_id=$1 AND status IN ('pending','delivered')) AS active_commands`,
    [row.work_order_id]);
    return counts?.effects === 1 && counts.active_commands === 0;
  };
  // This exception changes only whether a Worker may reload its code. It does
  // not reconcile, clear, or replay the unknown effect or advance the order.
  // Require a later confirmed submit for the same exact case and option, and
  // keep the still-pending order well outside the claim window.
  const deferredUnknownIsSafeForCodeReload = async (row) => {
    if (!allowDeferredUnknownForCodeReload
      || row.id !== expectedUnknownEffectId
      || row.work_order_id == null
      || row.external_order_number !== expectedOrderNumber
      || row.effect_type !== 'pdd-submit'
      || row.effect_status !== 'unknown'
      || row.effect_receipt != null
      || row.effect_error?.name !== 'HumanVerificationRequiredError'
      || row.work_status !== 'retry-ready'
      || row.work_runtime_status !== 'retry-ready'
      || row.current_step !== 'logistics-waiting-released'
      || row.completion_state !== 'pending'
      || !Number.isFinite(Date.parse(row.next_attempt_at || ''))
      || Date.parse(row.next_attempt_at) <= Date.now() + 6 * 60 * 60_000
      || row.instance_id !== row.current_ordinary_instance_id
      || row.ordinary_instance_id !== row.instance_id
      || row.instance_work_order_id !== row.work_order_id
      || row.instance_shop_id !== shopId
      || row.instance_status !== 'retry-ready'
      || row.instance_runtime_status !== 'retry-ready'
      || row.instance_identity_status !== 'verified'
      || !/^\d{6,30}$/u.test(String(row.platform_case_id || ''))
      || row.platform_case_key !== `pdd-work-order:${row.platform_case_id}`
      || row.detail_url !== `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${row.platform_case_id}`
      || !String(row.idempotency_key || '').endsWith(':result')
      || !String(row.idempotency_key || '').includes(`pdd-work-order:${row.platform_case_id}:`)) return false;
    const { rows: [later] } = await client.query(`
      SELECT id, status, effect_type, idempotency_key, reserved_at, receipt
      FROM external_effects
      WHERE id = $1 AND shop_id = $2 AND work_order_id = $3
        AND ordinary_instance_id = $4 FOR SHARE`,
    [expectedSupersedingEffectId, shopId, row.work_order_id, row.instance_id]);
    const result = later?.receipt?.result || {};
    const selectedOption = String(result.selectedPddOption || '').trim();
    const errorText = String(row.effect_error?.message || '');
    const { rows: [commands] } = await client.query(`
      SELECT count(*)::int AS active FROM operator_commands
      WHERE work_order_id = $1 AND status IN ('pending','delivered')`,
    [row.work_order_id]);
    return Boolean(later?.status === 'succeeded'
      && later.effect_type === 'pdd-submit'
      && later.idempotency_key !== row.idempotency_key
      && later.idempotency_key.endsWith(':result')
      && later.idempotency_key.includes(`pdd-work-order:${row.platform_case_id}:`)
      && Number.isFinite(Date.parse(later.reserved_at || ''))
      && Number.isFinite(Date.parse(row.effect_updated_at || ''))
      && Date.parse(later.reserved_at) > Date.parse(row.effect_updated_at)
      && selectedOption
      && result.selectedPddOutcome === selectedOption
      && errorText.includes(`阶段: select-pdd-${selectedOption}`)
      && errorText.includes(`URL: ${row.detail_url}`)
      && result.submitClicked === true
      && result.transitionConfirmed === true
      && result.submitReceipt?.success === true
      && result.submitReceipt?.clickAttempted === true
      && result.submitReceipt?.responseCaptured === true
      && commands?.active === 0);
  };
  let notSafelyPaused = 0;
  const manualHoldOptions = {
    enabled: allowDispatchedRefundManualHold, shopId, expectedShopName: shop?.expected_shop_name,
    expectedWorkOrderId: expectedManualHoldWorkOrderId, expectedEffectId: expectedManualHoldEffectId,
    expectedOrderNumber, expectedAftersaleNumber,
  };
  const readLockedManualRefundHold = async () => {
    if (!allowDispatchedRefundManualHold) return null;
    // Lock the exact held records. Both queue claim and rescan acquire these
    // work/refund locks, so the hold cannot be released during the reload.
    const row = (await client.query(`SELECT effect.id, effect.shop_id AS effect_shop_id,
      effect.effect_type, effect.status AS effect_status, effect.idempotency_key,
      effect.ordinary_instance_id, effect.receipt AS effect_receipt,
      work_order.id AS work_order_id, work_order.shop_id AS work_shop_id,
      work_order.external_order_number, work_order.scenario_code,
      work_order.status AS work_status, work_order.runtime_status AS work_runtime_status,
      work_order.current_step, work_order.recovery_state, work_order.recovery_reason,
      work_order.completion_state, work_order.current_ordinary_instance_id, work_order.next_attempt_at,
      refund.shop_id AS refund_shop_id, refund.work_order_id AS refund_work_order_id,
      refund.external_order_number AS refund_order, refund.aftersale_number, refund.detail_url,
      refund.action_state, refund.next_check_at,
      refund.evidence->>'pddIdentityBindingToken' AS refund_binding_token,
      refund.evidence->>'pddMallId' AS refund_mall_id,
      refund.evidence->>'detectedShopName' AS refund_shop_name,
      (SELECT count(*)::int FROM external_effects other WHERE other.work_order_id=work_order.id) AS effect_count,
      (SELECT count(*)::int FROM operator_commands command WHERE command.work_order_id=work_order.id
        AND command.status IN ('pending','delivered')) AS active_commands,
      $4::uuid IS NOT DISTINCT FROM work_order.id AS owns_current_lease
      FROM external_effects effect JOIN work_orders work_order ON work_order.id=effect.work_order_id
      JOIN return_refunds refund ON refund.work_order_id=work_order.id AND refund.shop_id=effect.shop_id
      WHERE effect.id=$1::uuid AND effect.shop_id=$2 AND work_order.id=$3::uuid
      FOR UPDATE OF effect, work_order, refund NOWAIT`,
    [expectedManualHoldEffectId, shopId, expectedManualHoldWorkOrderId, runtime?.current_work_order_id || null])).rows[0] || null;
    return row;
  };
  const manualHoldRow = await readLockedManualRefundHold();
  const dispatchedRefundHoldMatched = matchesDispatchedRefundManualHold({ ...manualHoldOptions, row: manualHoldRow, binding });
  let archivedConfirmed = 0;
  let heldInertForCodeReload = 0;
  let archivedDiscarded = 0;
  let deferredForCodeReload = 0;
  let dispatchedRefundManualHold = 0;
  for (const row of uncertainEffectRows) {
    if (dispatchedRefundHoldMatched && row.id === manualHoldRow.id) {
      dispatchedRefundManualHold += 1;
      continue;
    }
    if (await heldUnknownIsInertForCodeReload(row)) {
      heldInertForCodeReload += 1;
      continue;
    }
    if (row.work_status === 'paused'
      && row.current_step === 'external-state-unresolved') continue;
    if (await archivedUnknownIsInert(row)) archivedConfirmed += 1;
    else if (await archivedDiscardedUnknownIsInert(row)) archivedDiscarded += 1;
    else if (await deferredUnknownIsSafeForCodeReload(row)) deferredForCodeReload += 1;
    else notSafelyPaused += 1;
  }
  const uncertainEffects = {
    count: uncertainEffectRows.length,
    not_safely_paused: notSafelyPaused,
    archived_confirmed: archivedConfirmed,
    held_inert_for_code_reload: heldInertForCodeReload,
    archived_discarded: archivedDiscarded,
    deferred_for_code_reload: deferredForCodeReload,
    dispatched_refund_manual_hold: dispatchedRefundManualHold,
  };
  const expiredLoginUnknownEffectsInert = uncertainEffects.count === 0
    || (uncertainEffects.not_safely_paused === 0
      && uncertainEffects.count === uncertainEffects.archived_confirmed
        + uncertainEffects.held_inert_for_code_reload
        + uncertainEffects.archived_discarded
        + uncertainEffects.deferred_for_code_reload
        + uncertainEffects.dispatched_refund_manual_hold);

  // An active ordinary claim can be drained only for an exact, already-created
  // TMS ticket that is stuck on the TMS login page. The supervisor sends IPC
  // shutdown, and the runner hands the claim back as retry-ready. Never use
  // this exception for a pending PDD submit or an uncertain external effect.
  const stuckTmsProgressPath = path.resolve(appRoot, '..', 'data', 'workflow', 'shops', shopId,
    'state', 'workflow-progress.json');
  let stuckTmsProgress = null;
  if (allowStuckTmsLogin) {
    try { stuckTmsProgress = JSON.parse(await fs.readFile(stuckTmsProgressPath, 'utf8')); }
    catch { /* Missing or unreadable progress fails the exact gate below. */ }
  }
  const stuckTmsOrder = allowStuckTmsLogin && runtime?.current_work_order_id
    ? (await client.query(`
      SELECT id, shop_id, external_order_number, status, runtime_status,
        current_step, completion_state, current_ordinary_instance_id
      FROM work_orders WHERE id = $1 AND shop_id = $2 FOR UPDATE`,
    [runtime.current_work_order_id, shopId])).rows[0] || null
    : null;
  const stuckTmsInstance = stuckTmsOrder?.current_ordinary_instance_id
    ? (await client.query(`
      SELECT id, work_order_id, shop_id, status, runtime_status
      FROM ordinary_work_order_instances WHERE id = $1 AND shop_id = $2 FOR UPDATE`,
    [stuckTmsOrder.current_ordinary_instance_id, shopId])).rows[0] || null
    : null;
  const stuckTmsEffects = stuckTmsOrder
    ? (await client.query(`
      SELECT effect_type, status, receipt FROM external_effects
      WHERE shop_id = $1 AND work_order_id = $2`, [shopId, stuckTmsOrder.id])).rows
    : [];
  const createdTmsEffect = stuckTmsEffects.length === 1
    && stuckTmsEffects[0].effect_type === 'tms-create'
    && stuckTmsEffects[0].status === 'succeeded'
    ? stuckTmsEffects[0] : null;
  let stuckTmsLoginUrl = false;
  try {
    const url = new URL(stuckTmsProgress?.currentUrl);
    stuckTmsLoginUrl = url.origin === 'http://tms.aipro123.top'
      && url.pathname.startsWith('/login');
  } catch { /* An invalid URL fails the exact gate. */ }

  let staleLoginProgress = null;
  if (allowStalePddVerificationLogin) {
    try { staleLoginProgress = JSON.parse(await fs.readFile(stuckTmsProgressPath, 'utf8')); }
    catch { /* A missing or unreadable progress file fails the exact gate. */ }
  }
  const staleLoginOrder = allowStalePddVerificationLogin
    ? (await client.query(`
      SELECT work_order.id, work_order.external_order_number, work_order.scenario_code,
        work_order.status, work_order.runtime_status, work_order.current_step,
        work_order.completion_state, work_order.current_ordinary_instance_id,
        refund.action_state, refund.aftersale_number,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_order.id) AS effect_count,
        (SELECT count(*)::int FROM operator_commands command
         WHERE command.work_order_id = work_order.id
           AND command.status IN ('pending','delivered')) AS active_commands
      FROM work_orders work_order
      JOIN return_refunds refund ON refund.work_order_id = work_order.id
      WHERE work_order.shop_id = $1 AND work_order.external_order_number = $2
      FOR SHARE OF work_order, refund`, [shopId, expectedOrderNumber])).rows
    : [];
  const staleMarkerExists = (allowStalePddVerificationLogin || allowStaleMissingMall)
    ? (await client.query(`SELECT 1 FROM verification_locations
      WHERE id = $1::uuid AND shop_id = $2 LIMIT 1`,
    [expectedVerificationId, shopId])).rowCount > 0
    : false;

  const metadata = heartbeat?.metadata || {};
  const auth = metadata.authHealth || {};
  const heartbeatAtMs = Date.parse(heartbeat?.heartbeat_at || '');
  const stuckTmsLogin = allowStuckTmsLogin
    && acceptReloginRisk
    && ['processing', 'manual-login-required'].includes(metadata.state)
    && metadata.currentOrderNumber === expectedOrderNumber
    && auth.pdd?.status === 'authenticated'
    && auth.oms?.status === 'authenticated'
    && auth.tms?.status === 'expired'
    && runtime?.status === 'processing'
    && Boolean(runtime.lease_token)
    && Date.parse(runtime.lease_expires_at || '') > Date.now() + 30_000
    && stuckTmsOrder?.external_order_number === expectedOrderNumber
    && stuckTmsOrder.status === 'processing'
    && stuckTmsOrder.runtime_status === 'processing'
    && stuckTmsOrder.completion_state === 'pending'
    && stuckTmsInstance?.id === stuckTmsOrder.current_ordinary_instance_id
    && stuckTmsInstance.work_order_id === stuckTmsOrder.id
    && stuckTmsInstance.status === 'processing'
    && stuckTmsInstance.runtime_status === 'processing'
    && stuckTmsProgress?.shopId === shopId
    && stuckTmsProgress.orderNumber === expectedOrderNumber
    && stuckTmsProgress.ordinaryInstanceId === stuckTmsInstance.id
    && stuckTmsProgress.pddIdentityBindingToken === binding?.binding_token
    && stuckTmsProgress.residentCommand?.action === 'run-order'
    && stuckTmsProgress.residentCommand.status === 'active'
    && ['tms-auto-login-attempt', 'tms-login-retry', 'tms-login-result',
      'manual-login-required'].includes(stuckTmsProgress.step)
    && stuckTmsProgress.authHealth?.tms?.status === 'expired'
    && stuckTmsLoginUrl
    && stuckTmsProgress.tmsWorkOrder?.orderNumber === expectedOrderNumber
    && stuckTmsProgress.tmsWorkOrder.status === 'created'
    && Boolean(String(stuckTmsProgress.tmsWorkOrder.ticketId || '').trim())
    && Boolean(String(stuckTmsProgress.tmsWorkOrder.ticketNo || '').trim())
    && String(createdTmsEffect?.receipt?.result?.data?.ticketId || '')
      === String(stuckTmsProgress.tmsWorkOrder.ticketId)
    && String(createdTmsEffect?.receipt?.result?.data?.ticketNo || '')
      === String(stuckTmsProgress.tmsWorkOrder.ticketNo)
    && Number(active.work_orders) === 1
    && Number(active.ordinary_instances) === 1
    && Number(active.refunds) === 0
    && Number(active.reserved_effects) === 0
    && Number(active.verifications) === 0
    && uncertainEffects.not_safely_paused === 0;
  const maintenanceIdle = allowMaintenanceDrain
    && schedulerMode === 'legacy'
    && runtime?.metadata?.maintenanceDrain?.active === true
    && runtime.metadata.maintenanceDrain.previousOperatorPaused === false
    && runtime.metadata.operatorPaused === true
    // Completing a claim releases its runtime to idle even though the
    // explicit drain still prevents the Runner from taking another claim.
    && ['operator-paused', 'idle'].includes(runtime.status)
    && !runtime.lease_token
    && !runtime.current_work_order_id
    && metadata.state === 'operator-paused';
  const observedExpiredLogin = allowPddLoginWaiting && allowObservedPddLogin
    && metadata.state === 'pdd-identity-observed'
    && auth.pdd?.status === 'expired'
    && auth.pdd?.evidence === 'session-cookie-unusable'
    && auth.pdd?.confidence === 'confirmed'
    && freshObservedPddLoginUrl(metadata.systemTabs);
  const expiredIdleLogin = allowPddLoginWaiting
    && ((metadata.state === 'manual-login-required'
      && confirmedExpiredPddSession(auth.pdd)) || observedExpiredLogin)
    && auth.oms?.status === 'authenticated'
    && auth.tms?.status === 'authenticated'
    && expiredLoginUnknownEffectsInert;
  let businessWaitingProgress = null;
  if (allowPddBusinessWaiting) {
    try { businessWaitingProgress = JSON.parse(await fs.readFile(stuckTmsProgressPath, 'utf8')); }
    catch { /* A missing checkpoint fails this narrow reload gate. */ }
  }
  const pddBoundProfileAwaitingIdentity = metadata.actualShopName == null
    && metadata.profileFingerprint === binding?.profile_fingerprint
    && metadata.identityBindingToken === binding?.binding_token
    && businessWaitingProgress?.pddShopIdentity?.profileFingerprint === binding?.profile_fingerprint
    && !businessWaitingProgress?.pddShopIdentity?.actualShopName;
  const pddBusinessWaiting = allowPddBusinessWaiting
    && ['manual-login-required', 'pdd-identity-observed'].includes(metadata.state)
    && auth.pdd?.status === 'expired'
    && auth.pdd?.evidence === 'session-cookie-unusable'
    && (observedPddBusinessUrl(metadata.systemTabs)
      || matchesFreshLegacyPddBusinessObservation({ metadata, progress: businessWaitingProgress }))
    && businessWaitingProgress?.shopId === shopId
    && ((businessWaitingProgress.pddShopIdentity?.status === 'detected'
      && String(businessWaitingProgress.pddShopIdentity.mallId || '') === String(binding?.mall_id || ''))
      || pddBoundProfileAwaitingIdentity)
    && auth.oms?.status === 'authenticated'
    && auth.tms?.status === 'authenticated'
    && expiredLoginUnknownEffectsInert;
  const stalePddVerificationAtLogin = allowStalePddVerificationLogin
    && acceptReloginRisk
    && metadata.state === 'human-verification-required'
    && metadata.currentOrderNumber === expectedOrderNumber
    && auth.pdd?.status === 'verification-required'
    && Number.isFinite(Date.parse(String(auth.pdd.checkedAt || '')))
    && Date.now() - Date.parse(auth.pdd.checkedAt) > 30 * 60_000
    && auth.oms?.status === 'authenticated'
    && auth.tms?.status === 'authenticated'
    && freshObservedPddLoginUrl(metadata.systemTabs)
    && staleLoginProgress?.shopId === shopId
    && staleLoginProgress.orderNumber === expectedOrderNumber
    && staleLoginProgress.step === 'human-verification-required'
    && staleLoginProgress.verificationLocation?.id === expectedVerificationId
    && staleLoginProgress.verificationLocation.status === 'waiting-human'
    && staleLoginProgress.authHealth?.pdd?.status === 'verification-required'
    && staleLoginProgress.residentCommand?.action === 'run-refund'
    && staleLoginProgress.residentCommand.status === 'idle'
    && freshObservedPddLoginUrl(staleLoginProgress.systemTabs)
    && staleLoginProgress.currentUrl === metadata.systemTabs?.pdd?.url
    && loginRedirectMatchesRefund(staleLoginProgress.currentUrl,
      expectedOrderNumber, staleLoginOrder[0]?.aftersale_number)
    && staleLoginOrder.length === 1
    && staleLoginOrder[0].external_order_number === expectedOrderNumber
    && staleLoginOrder[0].scenario_code === 'return-refund'
    && staleLoginOrder[0].status === 'retry-ready'
    && staleLoginOrder[0].runtime_status === 'waiting'
    && staleLoginOrder[0].current_step === 'return-refund-verification-required'
    && staleLoginOrder[0].completion_state === 'pending'
    && staleLoginOrder[0].current_ordinary_instance_id == null
    && staleLoginOrder[0].action_state === 'verification-required'
    && staleLoginOrder[0].effect_count === 0
    && staleLoginOrder[0].active_commands === 0
    && !staleMarkerExists
    && activeVerificationRows.length === 0
    && expiredLoginUnknownEffectsInert;
  // TMS can be unreachable while PDD-only refund scanning remains healthy.
  // This exception is for a fully idle, correctly bound shop only; all
  // lease/effect/verification guards below still apply unchanged.
  const tmsExpiredIdle = allowTmsExpiredIdle
    && (['queue-waiting', 'queue-identity-blocked', 'operator-paused'].includes(metadata.state)
      || (metadata.state === 'manual-login-required'
        && metadata.authenticationSystem === 'tms'))
    && auth.pdd?.status === 'authenticated'
    && auth.oms?.status === 'authenticated'
    && auth.tms?.status === 'expired';
  const verificationProgressPath = path.resolve(appRoot, '..', 'data', 'workflow', 'shops', shopId,
    'state', 'workflow-progress.json');
  let verificationProgress = null;
  if (allowPddVerificationWaiting || allowStaleMissingMall) {
    try { verificationProgress = JSON.parse(await fs.readFile(verificationProgressPath, 'utf8')); }
    catch { /* A missing or unreadable progress file fails the exact gate check below. */ }
  }
  const activeVerification = activeVerificationRows.length === 1
    ? activeVerificationRows[0] : null;
  const missingMallActiveCommands = allowStaleMissingMall
    ? (await client.query(`SELECT count(*)::int AS count FROM operator_commands
      WHERE shop_id = $1 AND status IN ('pending','delivered')`, [shopId])).rows[0].count : 0;
  const staleMissingMall = matchesStaleMissingMallReload({
    enabled: allowStaleMissingMall, shopId, expectedShopName: shop?.expected_shop_name,
    verificationId: expectedVerificationId, progress: verificationProgress, metadata, binding,
    verificationMarkerExists: staleMarkerExists,
    activeVerificationCount: activeVerificationRows.length,
    activeCommands: missingMallActiveCommands, uncertainEffectsInert: expiredLoginUnknownEffectsInert,
  });
  const verificationWaiting = allowPddVerificationWaiting
    && activeVerification?.id === expectedVerificationId
    && activeVerification.system_name === 'pdd'
    && Boolean(activeVerification.work_order_id)
    && !['archived', 'completed'].includes(activeVerification.work_status)
    && ['retry-ready', 'paused'].includes(activeVerification.work_runtime_status)
    && metadata.state === 'human-verification-required'
    && metadata.preClaimVerificationGate?.verificationId === expectedVerificationId
    && metadata.preClaimVerificationGate?.workOrderId === activeVerification.work_order_id
    && verificationProgress?.verificationRecovery?.verificationId === expectedVerificationId
    && verificationProgress.verificationRecovery.workOrderId === activeVerification.work_order_id
    && ['restoring', 'waiting-human', 'retryable-error']
      .includes(verificationProgress.verificationRecovery.status)
    && ['verification-required', 'authenticated'].includes(auth.pdd?.status)
    && auth.oms?.status === 'authenticated'
    && auth.tms?.status === 'authenticated';
  const failures = [];
  if (allowStaleMissingMall && !staleMissingMall) failures.push('stale-missing-mall-gate-not-matched');
  if (allowStuckTmsLogin && !stuckTmsLogin) {
    failures.push('exact-stuck-tms-login-gate-not-matched');
  }
  if (allowPddVerificationWaiting && !verificationWaiting) {
    failures.push('exact-verification-gate-not-matched');
  }
  if (allowStalePddVerificationLogin && !stalePddVerificationAtLogin) {
    failures.push('exact-stale-pdd-login-gate-not-matched');
  }
  if (allowTmsExpiredIdle && !tmsExpiredIdle) {
    failures.push('exact-tms-expired-idle-gate-not-matched');
  }
  if (!shop?.enabled || !(verificationWaiting
    ? ['ready', 'verification-required'].includes(shop.onboarding_status)
    : ['ready', ...((expiredIdleLogin || pddBusinessWaiting) ? ['waiting-login'] : [])]
      .includes(shop.onboarding_status))
    || shop.config_version !== expectedVersion) failures.push('shop-version-or-readiness');
  if (!binding || !identity || identity.status !== 'confirmed'
    || binding.actual_shop_name !== shop?.expected_shop_name
    || identity.expected_shop_name !== shop?.expected_shop_name
    || String(binding.mall_id || '') !== String(identity.mall_id || '')
    || binding.profile_fingerprint !== identity.profile_fingerprint) {
    failures.push('shop-identity-binding');
  }
  if (!heartbeat || !Number.isFinite(heartbeatAtMs)
    || Date.now() - heartbeatAtMs > 20_000
    || !(['queue-waiting', 'queue-identity-blocked'].includes(metadata.state)
      || expiredIdleLogin || pddBusinessWaiting || stalePddVerificationAtLogin
      || maintenanceIdle || verificationWaiting || stuckTmsLogin
      || tmsExpiredIdle || staleMissingMall)
    || (metadata.currentOrderNumber && !stuckTmsLogin && !stalePddVerificationAtLogin)
    || (metadata.actualShopName !== shop?.expected_shop_name
      && !(stalePddVerificationAtLogin
        && metadata.actualShopName == null
        && metadata.profileFingerprint === binding?.profile_fingerprint)
      && !(pddBusinessWaiting && pddBoundProfileAwaitingIdentity))
    || !(metadata.identityBindingToken === binding?.binding_token
      || ((expiredIdleLogin || pddBusinessWaiting || verificationWaiting) && !metadata.identityBindingToken
        && metadata.profileFingerprint === binding?.profile_fingerprint))
    || String(metadata.mallId || '') !== String(binding?.mall_id || '')) {
    failures.push('worker-heartbeat-or-queue');
  }
  if (!expiredIdleLogin && !pddBusinessWaiting && !stalePddVerificationAtLogin
    && !verificationWaiting && !stuckTmsLogin && !tmsExpiredIdle && !staleMissingMall
    && ['pdd', 'oms', 'tms'].some((system) => auth[system]?.status !== 'authenticated')) {
    failures.push('system-authentication');
  }
  if ((allowPddLoginWaiting || allowPddBusinessWaiting) && !expiredLoginUnknownEffectsInert) {
    failures.push('uncertain-effects-present');
  }
  if (Number(uncertainEffects?.not_safely_paused || 0) !== 0) {
    failures.push('uncertain-effects-not-paused');
  }
  if (allowDispatchedRefundManualHold && (!dispatchedRefundHoldMatched || dispatchedRefundManualHold !== 1)) {
    failures.push('exact-dispatched-refund-manual-hold-not-matched');
  }
  if (maintenanceIdle && (!Number.isInteger(Number(metadata.processId))
    || Number(metadata.processId) <= 0)) failures.push('old-worker-process-id-missing');
  if (!runtime || (!stuckTmsLogin
    && (!['idle', ...(maintenanceIdle ? ['operator-paused'] : [])].includes(runtime.status)
      || runtime.lease_token || runtime.current_work_order_id))) failures.push('runtime-active');
  if (Object.entries(active || {}).some(([name, count]) => Number(count) !== 0
    && !(verificationWaiting && name === 'verifications' && Number(count) === 1)
    && !(stuckTmsLogin && ['work_orders', 'ordinary_instances'].includes(name)
      && Number(count) === 1))) {
    failures.push('work-or-verification-active');
  }

  const check = {
    shopId,
    expectedVersion,
    observedVersion: shop?.config_version ?? null,
    observedOnboardingStatus: shop?.onboarding_status || null,
    observedPddAuthStatus: auth.pdd?.status || null,
    workerState: metadata.state || null,
    currentOrderNumber: metadata.currentOrderNumber || null,
    heartbeatAt: heartbeat?.heartbeat_at || null,
    reloadMode: staleMissingMall ? 'stale-verification-missing-mall'
      : stuckTmsLogin ? 'stuck-tms-login-drain'
      : verificationWaiting ? 'pdd-verification-waiting'
        : stalePddVerificationAtLogin ? 'stale-pdd-verification-at-login'
        : observedExpiredLogin ? 'pdd-observed-login-waiting'
          : expiredIdleLogin ? 'pdd-login-waiting'
            : pddBusinessWaiting ? 'pdd-business-waiting'
          : tmsExpiredIdle ? 'pdd-only-tms-expired-idle' : 'authenticated-idle',
    expectedVerificationId: allowPddVerificationWaiting || allowStalePddVerificationLogin || allowStaleMissingMall
      ? expectedVerificationId : null,
    observedVerificationId: activeVerification?.id || null,
    verificationWaiting: Boolean(verificationWaiting),
    staleMissingMall: Boolean(staleMissingMall),
    stalePddVerificationAtLogin: Boolean(stalePddVerificationAtLogin),
    stuckTmsLogin: Boolean(stuckTmsLogin),
    tmsExpiredIdle: Boolean(tmsExpiredIdle),
    expectedOrderNumber: allowStuckTmsLogin || allowStalePddVerificationLogin
      ? expectedOrderNumber : null,
    tmsCreatedTicketMatched: Boolean(stuckTmsLogin && createdTmsEffect),
    ...(allowPddVerificationWaiting ? { verificationChecks: {
      singleActive: activeVerificationRows.length === 1,
      idMatches: activeVerification?.id === expectedVerificationId,
      pddSystem: activeVerification?.system_name === 'pdd',
      workOrderPresent: Boolean(activeVerification?.work_order_id),
      workOrderStillPending: Boolean(activeVerification?.work_status)
        && !['archived', 'completed'].includes(activeVerification.work_status)
        && ['retry-ready', 'paused'].includes(activeVerification.work_runtime_status),
      heartbeatState: metadata.state === 'human-verification-required',
      heartbeatId: metadata.preClaimVerificationGate?.verificationId === expectedVerificationId,
      heartbeatWorkOrder: metadata.preClaimVerificationGate?.workOrderId
        === activeVerification?.work_order_id,
      progressId: verificationProgress?.verificationRecovery?.verificationId
        === expectedVerificationId,
      progressWorkOrder: verificationProgress?.verificationRecovery?.workOrderId
        === activeVerification?.work_order_id,
      progressStatus: ['restoring', 'waiting-human', 'retryable-error']
        .includes(verificationProgress?.verificationRecovery?.status),
      pddSessionKnown: ['verification-required', 'authenticated'].includes(auth.pdd?.status),
      omsAuthenticated: auth.oms?.status === 'authenticated',
      tmsAuthenticated: auth.tms?.status === 'authenticated',
    } } : {}),
    maintenanceIdle,
    unknownEffects: Number(uncertainEffects?.count || 0),
    unknownEffectsNotSafelyPaused: Number(uncertainEffects?.not_safely_paused || 0),
    archivedConfirmedUnknownEffects: Number(uncertainEffects?.archived_confirmed || 0),
    heldUnknownForCodeReload: Number(uncertainEffects?.held_inert_for_code_reload || 0),
    archivedDiscardedUnknownEffects: Number(uncertainEffects?.archived_discarded || 0),
    deferredUnknownForCodeReload: Number(uncertainEffects?.deferred_for_code_reload || 0),
    dispatchedRefundManualHold: Number(uncertainEffects?.dispatched_refund_manual_hold || 0),
    active,
    // The refund cursor is durable, but its verified list page lives only in
    // this Worker process. A reload at a deep cursor can require a first
    // page-one-to-cursor seek and increase PDD verification pressure.
    refundScanPageReplayOnReload: Number(runtime?.metadata?.returnRefundScanCursor?.page || 1) > 1
      ? {
        page: Number(runtime.metadata.returnRefundScanCursor.page),
        itemOffset: Number(runtime.metadata.returnRefundScanCursor.itemOffset || 0),
        lastProofCapturedAt: runtime.metadata.returnRefundLastScan?.resumeProof?.capturedAt || null,
      } : null,
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
      `safe-shop-reload-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({ checkedAt: new Date().toISOString(),
      shop, binding, identity, runtime, heartbeat, active,
      activeVerification, uncertainEffects,
      ...(staleMissingMall ? { missingMallCheckpoint: verificationProgress } : {}) }, null, 2), {
      flag: 'wx', mode: 0o600,
    });
    if (staleMissingMall) {
      const latestProgress = JSON.parse(await fs.readFile(verificationProgressPath, 'utf8'));
      const latestHeartbeat = await queryOne(`SELECT heartbeat_at, metadata
        FROM worker_heartbeats WHERE shop_id = $1 ORDER BY heartbeat_at DESC LIMIT 1`);
      const { rows: [latestCounts] } = await client.query(`SELECT
        (SELECT count(*)::int FROM verification_locations WHERE shop_id=$1
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL) AS verifications,
        (SELECT count(*)::int FROM operator_commands WHERE shop_id=$1
          AND status IN ('pending','delivered')) AS commands`, [shopId]);
      if (!matchesStaleMissingMallReload({
        enabled: true, shopId, expectedShopName: shop.expected_shop_name,
        verificationId: expectedVerificationId, progress: latestProgress,
        metadata: latestHeartbeat?.metadata, binding,
        verificationMarkerExists: staleMarkerExists,
        activeVerificationCount: latestCounts.verifications,
        activeCommands: latestCounts.commands, uncertainEffectsInert: expiredLoginUnknownEffectsInert,
      })) throw new Error('Stale missing-mall checkpoint changed before code reload');
    }
    if (verificationWaiting) {
      const latestProgress = JSON.parse(await fs.readFile(verificationProgressPath, 'utf8'));
      const latestHeartbeat = await queryOne(`
        SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE shop_id = $1
        ORDER BY heartbeat_at DESC LIMIT 1`);
      const latestHeartbeatAtMs = Date.parse(latestHeartbeat?.heartbeat_at || '');
      const latestWorkOrder = (await client.query(`
        SELECT status, runtime_status FROM work_orders WHERE id = $1 FOR UPDATE`,
      [activeVerification.work_order_id])).rows[0] || null;
      if (latestProgress.verificationRecovery?.verificationId !== expectedVerificationId
        || latestProgress.verificationRecovery?.workOrderId !== activeVerification.work_order_id
        || !['restoring', 'waiting-human', 'retryable-error']
          .includes(latestProgress.verificationRecovery?.status)
        || latestHeartbeat?.metadata?.state !== 'human-verification-required'
        || latestHeartbeat.metadata.preClaimVerificationGate?.verificationId !== expectedVerificationId
        || !Number.isFinite(latestHeartbeatAtMs)
        || Date.now() - latestHeartbeatAtMs > 20_000
        || !latestWorkOrder
        || ['archived', 'completed'].includes(latestWorkOrder.status)
        || !['retry-ready', 'paused'].includes(latestWorkOrder.runtime_status)) {
        throw new Error('Verification state changed before the controlled reload');
      }
    }
    if (stuckTmsLogin) {
      const latestProgress = JSON.parse(await fs.readFile(stuckTmsProgressPath, 'utf8'));
      const latestHeartbeat = await queryOne(`
        SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE shop_id = $1
        ORDER BY heartbeat_at DESC LIMIT 1`);
      const latestHeartbeatAtMs = Date.parse(latestHeartbeat?.heartbeat_at || '');
      const latestEffects = (await client.query(`
        SELECT effect_type, status, receipt FROM external_effects
        WHERE shop_id = $1 AND work_order_id = $2 FOR UPDATE`,
      [shopId, stuckTmsOrder.id])).rows;
      const latestTicket = latestEffects.length === 1
        && latestEffects[0].effect_type === 'tms-create'
        && latestEffects[0].status === 'succeeded'
        ? latestEffects[0].receipt?.result?.data : null;
      let latestLoginUrl = false;
      try {
        const url = new URL(latestProgress.currentUrl);
        latestLoginUrl = url.origin === 'http://tms.aipro123.top'
          && url.pathname.startsWith('/login');
      } catch { /* Invalid URL fails revalidation. */ }
      if (!Number.isFinite(latestHeartbeatAtMs)
        || Date.now() - latestHeartbeatAtMs > 20_000
        || !['processing', 'manual-login-required'].includes(latestHeartbeat.metadata?.state)
        || latestHeartbeat.metadata.currentOrderNumber !== expectedOrderNumber
        || latestHeartbeat.metadata.authHealth?.pdd?.status !== 'authenticated'
        || latestHeartbeat.metadata.authHealth?.oms?.status !== 'authenticated'
        || latestHeartbeat.metadata.authHealth?.tms?.status !== 'expired'
        || latestProgress.shopId !== shopId
        || latestProgress.orderNumber !== expectedOrderNumber
        || latestProgress.ordinaryInstanceId !== stuckTmsInstance.id
        || latestProgress.residentCommand?.requestId
          !== stuckTmsProgress.residentCommand.requestId
        || latestProgress.residentCommand?.status !== 'active'
        || !['tms-auto-login-attempt', 'tms-login-retry', 'tms-login-result',
          'manual-login-required'].includes(latestProgress.step)
        || !latestLoginUrl
        || String(latestTicket?.ticketId || '')
          !== String(latestProgress.tmsWorkOrder?.ticketId || '')
        || String(latestTicket?.ticketNo || '')
          !== String(latestProgress.tmsWorkOrder?.ticketNo || '')) {
        throw new Error('TMS login or exact created ticket changed before the controlled reload');
      }
    }
    if (tmsExpiredIdle) {
      const latestHeartbeat = await queryOne(`
        SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE shop_id = $1
        ORDER BY heartbeat_at DESC LIMIT 1`);
      const latestAtMs = Date.parse(latestHeartbeat?.heartbeat_at || '');
      const latest = latestHeartbeat?.metadata || {};
      if (!Number.isFinite(latestAtMs) || Date.now() - latestAtMs > 20_000
        || !(['queue-waiting', 'queue-identity-blocked', 'operator-paused'].includes(latest.state)
          || (latest.state === 'manual-login-required'
            && latest.authenticationSystem === 'tms'))
        || latest.currentOrderNumber
        || latest.authHealth?.pdd?.status !== 'authenticated'
        || latest.authHealth?.oms?.status !== 'authenticated'
        || latest.authHealth?.tms?.status !== 'expired'
        || latest.identityBindingToken !== binding.binding_token
        || String(latest.mallId || '') !== String(binding.mall_id || '')) {
        throw new Error('TMS-expired idle shop state changed before the controlled reload');
      }
    }
    if (expiredIdleLogin) {
      const latestHeartbeat = await queryOne(`
        SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE shop_id = $1
        ORDER BY heartbeat_at DESC LIMIT 1`);
      const latestAtMs = Date.parse(latestHeartbeat?.heartbeat_at || '');
      const latest = latestHeartbeat?.metadata || {};
      if (!Number.isFinite(latestAtMs) || Date.now() - latestAtMs > 20_000
        || latest.processId !== metadata.processId
        || !(latest.state === 'manual-login-required'
          ? confirmedExpiredPddSession(latest.authHealth?.pdd)
          : observedExpiredLogin && latest.state === 'pdd-identity-observed'
            && latest.authHealth?.pdd?.status === 'expired'
            && latest.authHealth.pdd.evidence === 'session-cookie-unusable'
            && latest.authHealth.pdd.confidence === 'confirmed'
            && freshObservedPddLoginUrl(latest.systemTabs))
        || latest.currentOrderNumber
        || latest.authHealth?.oms?.status !== 'authenticated'
        || latest.authHealth?.tms?.status !== 'authenticated'
        || latest.actualShopName !== shop.expected_shop_name
        || String(latest.mallId || '') !== String(binding.mall_id || '')
        || !(latest.identityBindingToken === binding.binding_token
          || (!latest.identityBindingToken
            && latest.profileFingerprint === binding.profile_fingerprint))) {
        throw new Error('PDD-expired idle shop state changed before the controlled reload');
      }
    }
    if (pddBusinessWaiting) {
      const latestHeartbeat = await queryOne(`
        SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE shop_id = $1
        ORDER BY heartbeat_at DESC LIMIT 1`);
      const latest = latestHeartbeat?.metadata || {};
      const latestProgress = JSON.parse(await fs.readFile(stuckTmsProgressPath, 'utf8'));
      if (Date.now() - Date.parse(latestHeartbeat?.heartbeat_at || '') > 20_000
        || latest.processId !== metadata.processId
        || !['manual-login-required', 'pdd-identity-observed'].includes(latest.state)
        || latest.currentOrderNumber
        || latest.authHealth?.pdd?.status !== 'expired'
        || latest.authHealth.pdd.evidence !== 'session-cookie-unusable'
        || latest.authHealth?.oms?.status !== 'authenticated'
        || latest.authHealth?.tms?.status !== 'authenticated'
        || !(observedPddBusinessUrl(latest.systemTabs)
          || matchesFreshLegacyPddBusinessObservation({ metadata: latest, progress: latestProgress }))
        || (latest.actualShopName !== shop.expected_shop_name
          && !(pddBoundProfileAwaitingIdentity && latest.actualShopName == null
            && latest.profileFingerprint === binding.profile_fingerprint))
        || String(latest.mallId || '') !== String(binding.mall_id || '')
        || !(latest.identityBindingToken === binding.binding_token
          || (!latest.identityBindingToken
            && latest.profileFingerprint === binding.profile_fingerprint))
        || latestProgress.shopId !== shopId
        || !((latestProgress.pddShopIdentity?.status === 'detected'
          && String(latestProgress.pddShopIdentity.mallId || '') === String(binding.mall_id || ''))
          || (pddBoundProfileAwaitingIdentity
            && latestProgress.pddShopIdentity?.profileFingerprint === binding.profile_fingerprint
            && !latestProgress.pddShopIdentity?.actualShopName))) {
        throw new Error('PDD business-page idle shop changed before the controlled reload');
      }
    }
    if (stalePddVerificationAtLogin) {
      const latestProgress = JSON.parse(await fs.readFile(stuckTmsProgressPath, 'utf8'));
      const latestHeartbeat = await queryOne(`
        SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE shop_id = $1
        ORDER BY heartbeat_at DESC LIMIT 1`);
      const latestAtMs = Date.parse(latestHeartbeat?.heartbeat_at || '');
      const latest = latestHeartbeat?.metadata || {};
      const latestVerification = await client.query(`
        SELECT count(*)::int AS active FROM verification_locations
        WHERE shop_id = $1 AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL`, [shopId]);
      const latestMarker = await client.query(`
        SELECT 1 FROM verification_locations WHERE id = $1::uuid LIMIT 1`,
      [expectedVerificationId]);
      const latestOrder = await client.query(`
        SELECT work_order.status, work_order.runtime_status, work_order.current_step,
          refund.action_state,
          (SELECT count(*)::int FROM external_effects effect
           WHERE effect.work_order_id = work_order.id) AS effect_count,
          (SELECT count(*)::int FROM operator_commands command
           WHERE command.work_order_id = work_order.id
             AND command.status IN ('pending','delivered')) AS active_commands
        FROM work_orders work_order
        JOIN return_refunds refund ON refund.work_order_id = work_order.id
        WHERE work_order.id = $1 AND work_order.shop_id = $2`,
      [staleLoginOrder[0].id, shopId]);
      const order = latestOrder.rows[0];
      if (!Number.isFinite(latestAtMs) || Date.now() - latestAtMs > 20_000
        || latest.processId !== metadata.processId
        || latest.state !== 'human-verification-required'
        || latest.currentOrderNumber !== expectedOrderNumber
        || latest.authHealth?.pdd?.status !== 'verification-required'
        || latest.authHealth?.oms?.status !== 'authenticated'
        || latest.authHealth?.tms?.status !== 'authenticated'
        || !freshObservedPddLoginUrl(latest.systemTabs)
        || latest.profileFingerprint !== binding.profile_fingerprint
        || latest.identityBindingToken !== binding.binding_token
        || String(latest.mallId || '') !== String(binding.mall_id || '')
        || latestProgress.shopId !== shopId
        || latestProgress.orderNumber !== expectedOrderNumber
        || latestProgress.step !== 'human-verification-required'
        || latestProgress.verificationLocation?.id !== expectedVerificationId
        || latestProgress.verificationLocation.status !== 'waiting-human'
        || latestProgress.residentCommand?.action !== 'run-refund'
        || latestProgress.residentCommand.status !== 'idle'
        || !freshObservedPddLoginUrl(latestProgress.systemTabs)
        || latestProgress.currentUrl !== latest.systemTabs?.pdd?.url
        || !loginRedirectMatchesRefund(latestProgress.currentUrl,
          expectedOrderNumber, staleLoginOrder[0].aftersale_number)
        || latestVerification.rows[0]?.active !== 0
        || latestMarker.rowCount !== 0
        || order?.status !== 'retry-ready'
        || order.runtime_status !== 'waiting'
        || order.current_step !== 'return-refund-verification-required'
        || order.action_state !== 'verification-required'
        || order.effect_count !== 0
        || order.active_commands !== 0) {
        throw new Error('Stale PDD verification login state changed before the controlled reload');
      }
    }
    if (allowDispatchedRefundManualHold) {
      const latestHold = await readLockedManualRefundHold();
      const latestBinding = (await client.query(`SELECT binding_token::text AS binding_token,
        actual_shop_name, mall_id FROM pdd_shop_runtime_bindings WHERE shop_id=$1 FOR SHARE NOWAIT`, [shopId])).rows[0];
      if (!matchesDispatchedRefundManualHold({ ...manualHoldOptions, row: latestHold, binding: latestBinding })) {
        throw new Error('Dispatched refund manual hold changed before code reload');
      }
    }
    const updated = await client.query(`
      UPDATE shops SET config_version = config_version + 1, updated_at = now()
      WHERE id = $1 AND config_version = $2 RETURNING config_version`,
    [shopId, expectedVersion]);
    if (updated.rowCount !== 1) throw new Error('Shop version changed during reload');
    if (maintenanceIdle) {
      const scanCadence = createCodeReloadScanCadence({
        shopId, fromVersion: expectedVersion, toVersion: updated.rows[0].config_version,
        metadata,
      });
      await client.query(`
        UPDATE shop_runtime_state
        SET metadata = jsonb_set(metadata, '{maintenanceDrain}',
          metadata->'maintenanceDrain' || jsonb_build_object(
            'reloadFromProcessId', $2::int,
            'reloadToConfigVersion', $3::int
          )) || CASE WHEN $4::jsonb IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('codeReloadScanCadence', $4::jsonb) END,
          updated_at = now()
        WHERE shop_id = $1`, [shopId, Number(metadata.processId),
        updated.rows[0].config_version, scanCadence ? JSON.stringify(scanCadence) : null]);
    }
    await client.query('COMMIT');
    inTransaction = false;
    let oldWorkerExited = null;
    if (maintenanceIdle) {
      oldWorkerExited = false;
      const oldPid = Number(metadata.processId);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        try { process.kill(oldPid, 0); }
        catch (error) {
          if (error?.code !== 'ESRCH') throw error;
          oldWorkerExited = true;
          break;
        }
        await delay(1_000);
      }
      if (!oldWorkerExited) process.exitCode = 3;
    }
    console.log(JSON.stringify({ applied: true, ...check,
      newVersion: updated.rows[0].config_version, backupPath, oldWorkerExited,
      drainMustRemainActive: maintenanceIdle && !oldWorkerExited }));
  }
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
