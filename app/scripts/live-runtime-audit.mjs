import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { activeRefundCooldowns, classifyOverdueRefunds } from './refund-audit-classification.mjs';
import { authObservationEvidence } from './auth-observation-freshness.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(scriptRoot);

const readNativeEnvironmentValue = (name) => {
  const envPath = path.join(appRoot, '.env.native');
  if (!fs.existsSync(envPath)) return null;
  const line = fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/u, '$2') || null;
};

const numberArgument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a non-negative number`);
  return value;
};

const databaseUrl = process.env.DATABASE_URL || readNativeEnvironmentValue('DATABASE_URL');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const lookbackHours = numberArgument('--lookback-hours', 24);
const refundGraceMinutes = numberArgument('--refund-grace-minutes', 10);
const staleSyncSeconds = numberArgument('--stale-sync-seconds', 60);
const since = new Date(Date.now() - lookbackHours * 60 * 60_000).toISOString();
const apiBase = process.env.RUNTIME_AUDIT_API_BASE || 'http://127.0.0.1:3000';
const nonActionableInterventionReasonCodes = [
  'verification-required',
  'login-required',
  'return-refund-verification-required',
  'waiting-logistics',
  'waiting-consumer-response',
  'page-render-deferred',
  'rate-limited',
];

const getJson = async (pathname) => {
  const response = await fetch(`${apiBase}${pathname}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return response.json();
};

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: 'live-runtime-readonly-audit',
});

try {
  const query = async (text, values = []) => (await pool.query(text, values)).rows;
  const [shopsResponse, capacityResponse, activeOrdinary, queueEmptyContradictions,
    pausedOrdinary, refundStates, overdueRefundWaits, overdueRefundRetries, activeVerifications,
    staleResolvedVerifications, unresolvedInterventions, recentEvents, optionGaps,
    identityBlockedUncertainOrdinary, identityBlockedShops,
    residentTerminalClaimCandidates, autoRefundProofMismatches,
    ordinaryCompletionProofMismatches, unverifiedInTransitArchives,
    unverifiedFeedbackArchives] = await Promise.all([
    getJson('/api/v1/shops'),
    getJson('/api/v1/runtime/capacity'),
    query(`
      SELECT work_order.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        coalesce(instance.scenario_code, work_order.scenario_code) AS "scenarioCode",
        instance.runtime_status AS "runtimeStatus", instance.current_step AS "currentStep",
        instance.next_attempt_at AS "nextAttemptAt", instance.updated_at AS "updatedAt",
        (instance.next_attempt_at IS NULL OR instance.next_attempt_at <= now()) AS due,
        greatest(0, extract(epoch FROM (
          now() - coalesce(instance.next_attempt_at, instance.updated_at)
        )))::int AS "dueSeconds"
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE instance.completed_at IS NULL
        AND instance.runtime_status IN ('queued', 'retry-ready', 'processing')
        AND coalesce(instance.scenario_code, work_order.scenario_code) <> 'return-refund'
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      ORDER BY due DESC, instance.updated_at`),
    query(`
      WITH due_ordinary AS (
        SELECT work_order.shop_id, work_order.external_order_number,
          instance.runtime_status, instance.current_step, instance.next_attempt_at
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
        JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
        WHERE instance.completed_at IS NULL
          AND instance.runtime_status IN ('queued', 'retry-ready', 'processing')
          AND coalesce(instance.scenario_code, work_order.scenario_code) <> 'return-refund'
          AND (instance.next_attempt_at IS NULL OR instance.next_attempt_at <= now())
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      )
      SELECT checkpoint.shop_id AS "shopId", checkpoint.current_step AS "checkpointStep",
        ordinary.runtime_status AS "runtimeStatus", ordinary.current_step AS "orderStep",
        ordinary.external_order_number AS "orderNumber", ordinary.next_attempt_at AS "nextAttemptAt"
      FROM workflow_checkpoints checkpoint
      JOIN due_ordinary ordinary ON ordinary.shop_id = checkpoint.shop_id
      WHERE checkpoint.current_step = 'queue-empty'
        AND checkpoint.synchronized_at >= now() - interval '5 minutes'
      ORDER BY checkpoint.shop_id, ordinary.external_order_number`),
    query(`
      SELECT work_order.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        coalesce(instance.scenario_code, work_order.scenario_code) AS "scenarioCode",
        instance.runtime_status AS "runtimeStatus", instance.current_step AS "currentStep",
        instance.updated_at AS "updatedAt", work_order.manual_review_reason AS "manualReviewReason"
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE instance.completed_at IS NULL
        AND instance.runtime_status IN ('paused', 'failed', 'manual-review')
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      ORDER BY instance.updated_at`),
    query(`
      SELECT refund.action_state AS "actionState", count(*)::int AS total,
        count(*) FILTER (
          WHERE refund.next_check_at < now() - ($1::double precision * interval '1 minute')
            AND work_order.recovery_state IN ('ready', 'retry-authorized')
        )::int AS overdue
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
        AND work_order.status NOT IN ('archived', 'completed')
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      GROUP BY refund.action_state
      ORDER BY refund.action_state`, [refundGraceMinutes]),
    query(`
      SELECT work_order.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        work_order.status AS "workOrderStatus",
        work_order.current_step AS "currentStep",
        EXISTS (SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved','unknown')) AS "unresolvedExternalEffect",
        refund.aftersale_number AS "aftersaleNumber", refund.action_state AS "actionState",
        refund.next_check_at AS "nextCheckAt",
        extract(epoch FROM (now() - refund.next_check_at))::int AS "overdueSeconds"
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
        AND work_order.status NOT IN ('archived', 'completed')
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE refund.action_state = 'waiting-logistics'
        AND refund.next_check_at < now() - ($1::double precision * interval '1 minute')
        AND work_order.recovery_state IN ('ready', 'retry-authorized')
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      ORDER BY refund.next_check_at`, [refundGraceMinutes]),
    query(`
      SELECT work_order.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        work_order.status AS "workOrderStatus",
        work_order.current_step AS "currentStep",
        EXISTS (SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved','unknown')) AS "unresolvedExternalEffect",
        refund.aftersale_number AS "aftersaleNumber", refund.action_state AS "actionState",
        refund.next_check_at AS "nextCheckAt", refund.updated_at AS "updatedAt",
        extract(epoch FROM (
          now() - CASE refund.action_state
            WHEN 'verification-required' THEN coalesce(refund.next_check_at, refund.updated_at)
            ELSE refund.updated_at
          END
        ))::int AS "overdueSeconds"
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
        AND work_order.status NOT IN ('archived', 'completed')
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE ((
          refund.action_state = 'page-error'
          AND refund.updated_at < now() - ($1::double precision * interval '1 minute')
        ) OR (
          refund.action_state = 'verification-required'
          AND coalesce(refund.next_check_at, refund.updated_at)
            < now() - ($1::double precision * interval '1 minute')
        ))
        AND work_order.recovery_state IN ('ready', 'retry-authorized')
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      ORDER BY "overdueSeconds" DESC`, [refundGraceMinutes]),
    query(`
      SELECT verification.id, verification.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        verification.system_name AS system, verification.stage, verification.status,
        verification.detected_at AS "detectedAt"
      FROM verification_locations verification
      JOIN shops shop ON shop.id = verification.shop_id
      JOIN workflow_checkpoints checkpoint ON checkpoint.shop_id = verification.shop_id
      LEFT JOIN work_orders work_order ON work_order.id = verification.work_order_id
      WHERE verification.status IN ('detected', 'waiting-human', 'verification-required')
        AND verification.resolved_at IS NULL
        AND shop.enabled = true
        AND checkpoint.snapshot->'verificationLocation'->>'id' = verification.id::text
      ORDER BY verification.detected_at`),
    query(`
      SELECT verification.id, verification.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber", verification.system_name AS system,
        verification.stage, verification.resolved_at AS "resolvedAt",
        extract(epoch FROM (now() - verification.resolved_at))::int AS "resolvedSeconds",
        instance.runtime_status AS "ordinaryRuntimeStatus",
        instance.current_step AS "ordinaryCurrentStep",
        instance.next_attempt_at AS "ordinaryNextAttemptAt",
        refund.action_state AS "refundActionState", refund.next_check_at AS "refundNextCheckAt",
        work_order.runtime_status AS "workOrderRuntimeStatus",
        work_order.current_step AS "workOrderCurrentStep"
      FROM verification_locations verification
      JOIN work_orders work_order ON work_order.id = verification.work_order_id
        AND work_order.status NOT IN ('archived', 'completed')
      JOIN shops shop ON shop.id = verification.shop_id AND shop.enabled = true
      LEFT JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      LEFT JOIN return_refunds refund ON refund.work_order_id = work_order.id
      WHERE verification.resolved_at IS NOT NULL
        AND verification.resolved_at >= $1::timestamptz
        AND verification.resolved_at
          <= now() - ($2::double precision * interval '1 minute')
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND work_order.recovery_state IN ('ready', 'retry-authorized')
        AND NOT EXISTS (
          SELECT 1 FROM verification_locations active
          WHERE active.work_order_id = verification.work_order_id
            AND active.status IN ('detected', 'waiting-human', 'verification-required')
            AND active.resolved_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM shop_runtime_state runtime
          WHERE runtime.shop_id = work_order.shop_id
            AND runtime.current_work_order_id = work_order.id
            AND runtime.lease_token IS NOT NULL
            AND runtime.lease_expires_at > now()
        )
        -- A resolved challenge can schedule an ordinary retry after a safety
        -- cooldown. Give the worker the normal resume grace period after that
        -- due time before treating the record as stalled.
        AND NOT (instance.runtime_status = 'retry-ready'
          AND instance.next_attempt_at > now()
            - ($2::double precision * interval '1 minute'))
        AND (
          (instance.completed_at IS NULL
            AND instance.current_step IN ('human-verification-required', 'manual-login-required'))
          OR (refund.completed_at IS NULL AND refund.action_state = 'verification-required'
            AND work_order.current_step = 'return-refund-verification-required'
            AND coalesce(refund.last_scanned_at, verification.resolved_at)
              <= verification.resolved_at + interval '30 seconds'
            AND greatest(
              verification.resolved_at,
              coalesce(refund.last_scanned_at, verification.resolved_at),
              coalesce(refund.next_check_at, verification.resolved_at)
            ) <= now() - ($2::double precision * interval '1 minute'))
          OR (work_order.scenario_code IS DISTINCT FROM 'return-refund'
            AND work_order.current_step IN (
              'human-verification-required', 'manual-login-required'
            ))
        )
      ORDER BY verification.resolved_at
      LIMIT 100`, [since, refundGraceMinutes]),
    query(`
      SELECT intervention.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber", intervention.channel,
        intervention.reason_code AS "reasonCode", intervention.reason,
        intervention.status, intervention.created_at AS "createdAt"
      FROM manual_interventions intervention
      LEFT JOIN work_orders work_order ON work_order.id = intervention.work_order_id
      JOIN shops shop ON shop.id = intervention.shop_id AND shop.enabled = true
      WHERE intervention.created_at >= $1::timestamptz
        AND intervention.status NOT IN ('resolved', 'dismissed', 'closed', 'cancelled')
        AND coalesce(intervention.reason_code, '') <> ALL($2::text[])
      ORDER BY intervention.created_at
      LIMIT 100`, [since, nonActionableInterventionReasonCodes]),
    query(`
      SELECT event.severity, event.stage, event.reason_code AS "reasonCode",
        count(*)::int AS total, max(event.occurred_at) AS "latestAt"
      FROM workflow_events event
      WHERE event.occurred_at >= $1::timestamptz
        AND event.severity IN ('error', 'warning')
      GROUP BY event.severity, event.stage, event.reason_code
      ORDER BY max(event.occurred_at) DESC`, [since]),
    query(`
      SELECT event.shop_id AS "shopId", shop.name AS "shopName",
        event.external_order_number AS "orderNumber", event.stage,
        event.reason_code AS "reasonCode", event.message, event.occurred_at AS "occurredAt"
      FROM workflow_events event
      LEFT JOIN shops shop ON shop.id = event.shop_id
      WHERE event.occurred_at >= $1::timestamptz
        AND event.severity IN ('error', 'warning')
        AND (
          coalesce(event.reason_code, '') ILIKE ANY(ARRAY['%unknown%', '%option%'])
          OR coalesce(event.message, '') ILIKE ANY(ARRAY[
            '%\u672a\u627e\u5230%\u9009\u9879%', '%48143%', '%option not found%'
          ])
        )
      ORDER BY event.occurred_at DESC
      LIMIT 100`, [since]),
    query(`
      SELECT work_order.shop_id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        instance.platform_case_id AS "platformCaseId",
        work_order.current_step AS "currentStep",
        work_order.next_attempt_at AS "nextAttemptAt",
        min(effect.updated_at) AS "unknownSince"
      FROM work_orders work_order
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN pdd_shop_runtime_bindings binding
        ON binding.shop_id = work_order.shop_id
        AND binding.actual_shop_name = shop.expected_shop_name
      JOIN external_effects effect
        ON effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit' AND effect.status = 'unknown'
      WHERE work_order.scenario_code IS DISTINCT FROM 'return-refund'
        AND work_order.status IN ('queued', 'retry-ready')
        AND work_order.completion_state = 'pending'
        AND work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken'
          IS DISTINCT FROM binding.binding_token::text
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      GROUP BY work_order.shop_id, shop.name, work_order.external_order_number,
        instance.platform_case_id, work_order.current_step, work_order.next_attempt_at
      ORDER BY min(effect.updated_at)
      LIMIT 100`),
    query(`
      SELECT shop.id AS "shopId", shop.name AS "shopName",
        heartbeat.metadata->>'state' AS state,
        heartbeat.metadata->>'identityStatus' AS "identityStatus",
        heartbeat.metadata->>'actualShopName' AS "actualShopName",
        shop.expected_shop_name AS "expectedShopName"
      FROM shops shop
      JOIN LATERAL (
        SELECT heartbeat_at, metadata FROM worker_heartbeats
        WHERE shop_id = shop.id ORDER BY heartbeat_at DESC LIMIT 1
      ) heartbeat ON true
      WHERE shop.enabled = true
        AND heartbeat.heartbeat_at >= now() - interval '2 minutes'
        AND (heartbeat.metadata->>'state' IN (
          'pdd-identity-duplicate-login-waiting',
          'pdd-identity-binding-waiting'
        ) OR heartbeat.metadata->>'identityStatus' = 'mismatch')`),
    query(`
      SELECT shop.id AS "shopId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        checkpoint.snapshot #>> '{residentCommand,outcome}' AS outcome,
        checkpoint.snapshot #>> '{residentCommand,completedAt}' AS "commandCompletedAt",
        checkpoint.snapshot->>'updatedAt' AS "progressUpdatedAt",
        (SELECT count(*)::int FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved','unknown')) AS "unresolvedEffects"
      FROM shop_runtime_state runtime
      JOIN shops shop ON shop.id = runtime.shop_id AND shop.enabled = true
      JOIN work_orders work_order ON work_order.id = runtime.current_work_order_id
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN workflow_checkpoints checkpoint ON checkpoint.shop_id = shop.id
      JOIN LATERAL (
        SELECT heartbeat_at FROM worker_heartbeats
        WHERE shop_id = shop.id ORDER BY heartbeat_at DESC LIMIT 1
      ) heartbeat ON heartbeat.heartbeat_at >= now() - interval '2 minutes'
      WHERE runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
        AND work_order.status = 'processing'
        AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
        AND checkpoint.snapshot->>'step' = 'pdd-session-recovered'
        AND checkpoint.snapshot #>> '{residentCommand,action}' = 'run-order'
        AND checkpoint.snapshot #>> '{residentCommand,status}' = 'idle'
        AND checkpoint.snapshot #>> '{residentCommand,outcome}'
          IN ('flow-paused','manual-review-blocked')
        AND checkpoint.snapshot #>> '{residentCommand,assignmentId}' = runtime.lease_token::text
        AND checkpoint.snapshot->>'orderNumber' = work_order.external_order_number
        AND checkpoint.snapshot->>'ordinaryInstanceId' = instance.id::text
      ORDER BY checkpoint.synchronized_at`),
    query(`
      SELECT shop.name AS "shopName", refund.external_order_number AS "orderNumber",
        refund.aftersale_number AS "aftersaleNumber",
        refund.aftersale_status AS "aftersaleStatus",
        refund.completed_at AS "completedAt",
        effects.succeeded_count AS "succeededEffects",
        effects.unresolved_count AS "unresolvedEffects",
        effects.total_count AS "totalEffects"
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
      JOIN shops shop ON shop.id = refund.shop_id AND shop.enabled = true
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE effect.status = 'succeeded')::int AS succeeded_count,
          count(*) FILTER (WHERE effect.status IN ('reserved', 'unknown'))::int AS unresolved_count,
          count(*)::int AS total_count
        FROM external_effects effect
        WHERE effect.work_order_id = refund.work_order_id
          AND effect.effect_type = 'pdd-return-refund'
      ) effects
      WHERE refund.action_state = 'auto-refunded'
        AND refund.completed_at >= $1::timestamptz
        AND refund.completed_at <= now() - interval '2 minutes'
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND (
          coalesce(refund.aftersale_status, '') NOT LIKE '%退款成功%'
          OR effects.succeeded_count <> 1
          OR effects.unresolved_count <> 0
          OR effects.total_count <> 1
        )
      ORDER BY refund.completed_at DESC
      LIMIT 100`, [since]),
    query(`
      SELECT shop.name AS "shopName", work_order.external_order_number AS "orderNumber",
        instance.platform_case_id AS "platformCaseId",
        instance.identity_status AS "identityStatus",
        instance.completion_method AS "instanceCompletionMethod",
        work_order.completion_state AS "completionState",
        work_order.completion_confirmation_method AS "confirmationMethod",
        instance.completed_at AS "completedAt"
      FROM ordinary_work_order_instances instance
      JOIN work_orders work_order ON work_order.id = instance.work_order_id
        AND work_order.current_ordinary_instance_id = instance.id
      JOIN shops shop ON shop.id = instance.shop_id AND shop.enabled = true
      WHERE instance.completed_at >= $1::timestamptz
        AND instance.completed_at <= now() - interval '2 minutes'
        AND instance.runtime_status IN ('completed', 'archived')
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND (
          work_order.completion_state <> 'confirmed'
          OR instance.identity_status <> 'verified'
          OR instance.platform_case_id IS NULL
          OR nullif(instance.completion_method, '') IS NULL
          OR nullif(work_order.completion_confirmation_method, '') IS NULL
        )
      ORDER BY instance.completed_at DESC
      LIMIT 100`, [since]),
    query(`
      SELECT shop.name AS "shopName", work_order.external_order_number AS "orderNumber",
        work_order.completion_confirmed_at AS "completedAt",
        work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' AS "ordinaryInstanceId",
        work_order.payload #>> '{lastCompletedOrder,platformWorkOrderId}' AS "platformCaseId",
        work_order.payload #>> '{lastCompletedOrder,outcome}' AS "recordedOutcome",
        work_order.payload #>> '{lastCompletedOrder,confirmationMethod}' AS "confirmationMethod"
      FROM work_orders work_order
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE work_order.scenario_code = 'consumer-address-change-in-transit'
        AND work_order.status = 'archived'
        AND work_order.completion_confirmed_at >= $1::timestamptz
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND (
          work_order.payload #>> '{lastCompletedOrder,completionServiceEvidence,confirmed}'
            IS DISTINCT FROM 'true'
          OR work_order.payload #>> '{lastCompletedOrder,completionServiceEvidence,stage1Record}'
            IS DISTINCT FROM 'true'
          OR work_order.payload #>> '{lastCompletedOrder,completionServiceEvidence,stage2Record}'
            IS DISTINCT FROM 'true'
        )
      ORDER BY work_order.completion_confirmed_at DESC
      LIMIT 100`, [since]),
    query(`
      SELECT shop.name AS "shopName", work_order.external_order_number AS "orderNumber",
        instance.platform_case_id AS "platformCaseId",
        work_order.completion_confirmed_at AS "completedAt",
        work_order.payload #>> '{lastCompletedOrder,confirmationMethod}' AS "confirmationMethod",
        work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,isCompleted}'
          AS "pageCompleted",
        work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,orderMatches}'
          AS "pageOrderMatches",
        (work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,platformCaseMatches}' = 'true'
          AND work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,observedPlatformWorkOrderId}'
            = instance.platform_case_id) AS "exactCaseCompletedProof",
        (SELECT effect.receipt #>> '{result,clickAttempted}'
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.idempotency_key LIKE '%:ordinary-product-shortage-no-shortage-feedback'
            AND effect.status = 'succeeded'
          ORDER BY effect.reserved_at DESC LIMIT 1) AS "clickAttempted",
        (SELECT effect.receipt #>> '{result,postClickTransitionObserved}'
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.idempotency_key LIKE '%:ordinary-product-shortage-no-shortage-feedback'
            AND effect.status = 'succeeded'
          ORDER BY effect.reserved_at DESC LIMIT 1) AS "postClickTransitionObserved"
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE work_order.scenario_code = 'product-shortage'
        AND work_order.status = 'archived'
        AND work_order.completion_state = 'confirmed'
        AND work_order.completion_confirmed_at >= $1::timestamptz
        AND work_order.completion_confirmed_at <= now() - interval '2 minutes'
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        AND nullif(work_order.payload #>> '{lastCompletedOrder,completionEvidence}', '') IS NULL
        AND EXISTS (
          SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.idempotency_key LIKE '%:ordinary-product-shortage-no-shortage-feedback'
            AND effect.status = 'succeeded'
        )
      ORDER BY work_order.completion_confirmed_at DESC
      LIMIT 100`, [since]),
  ]);

  const shops = (shopsResponse.data || []).filter((shop) => shop.enabled === true);
  const capacity = capacityResponse.data || {};
  // A local worker writes its live state directly to PostgreSQL and emits a
  // heartbeat even when no remote sync cursor advances. Use the heartbeat for
  // runtime freshness; syncLagSeconds may legitimately point at an older
  // import cursor after a local cutover.
  const staleShopState = shops.filter((shop) => (
    shop.workerOnline !== true
    || !Number.isFinite(Number(shop.heartbeatAgeSeconds))
    || Number(shop.heartbeatAgeSeconds) > staleSyncSeconds
  )).map((shop) => ({
    shopId: shop.shopId,
    heartbeatAgeSeconds: shop.heartbeatAgeSeconds,
    runtimeObservationAgeSeconds: shop.runtimeObservationAgeSeconds,
    syncLagSeconds: shop.syncLagSeconds,
  }));
  const shopHealth = {
    total: shops.length,
    online: shops.filter((shop) => shop.workerOnline).length,
    authenticated: {
      pdd: shops.filter((shop) => shop.authHealth?.pdd?.status === 'authenticated').length,
      oms: shops.filter((shop) => shop.authHealth?.oms?.status === 'authenticated').length,
      tms: shops.filter((shop) => shop.authHealth?.tms?.status === 'authenticated').length,
    },
    stale: staleShopState,
  };
  const activePddVerificationShopIds = new Set(activeVerifications
    .filter((verification) => /^(?:pdd|pinduoduo)$/iu.test(String(verification.system || '').trim()))
    .map((verification) => verification.shopId));
  const pddVerificationStatusShopIds = new Set(shops
    .filter((shop) => shop.authHealth?.pdd?.status === 'verification-required')
    .map((shop) => shop.shopId));
  // A fresh worker heartbeat can carry an old verification result indefinitely.
  // A login URL observed after that result needs a new page check; it is not
  // evidence of a currently rendered slider or of a confirmed expired cookie.
  const loginPageVerificationUncertain = shops.filter((shop) => {
    const health = shop.authHealth?.pdd;
    const observation = health?.lastObservation;
    const resultAt = Date.parse(health?.checkedAt || '');
    const observationAt = Date.parse(observation?.checkedAt || '');
    return health?.status === 'verification-required'
      && !activePddVerificationShopIds.has(shop.shopId)
      && /^https:\/\/mms\.pinduoduo\.com\/login(?:\/|\?|$)/u.test(String(observation?.url || ''))
      && observation?.evidence === 'login-url-only'
      && Number.isFinite(resultAt)
      && Number.isFinite(observationAt)
      && Date.now() - resultAt > 5 * 60_000
      && Date.now() - observationAt > 5 * 60_000;
  }).map((shop) => ({
    shopId: shop.shopId,
    shopName: shop.name,
    lastVerificationCheckedAt: shop.authHealth.pdd.checkedAt,
    loginPageObservedAt: shop.authHealth.pdd.lastObservation.checkedAt,
    workerHeartbeatAt: shop.heartbeatAt,
  }));
  const loginPageVerificationUncertainIds = new Set(
    loginPageVerificationUncertain.map((shop) => shop.shopId),
  );
  const verificationBlockedShopIds = new Set([
    ...activePddVerificationShopIds,
    ...pddVerificationStatusShopIds,
  ]);
  const identityBlockedShopIds = new Set(identityBlockedShops.map((shop) => shop.shopId));
  const loginBlockedShopIds = new Set(shops
    .filter((shop) => shop.authHealth?.pdd?.status === 'expired'
      && shop.authHealth.pdd.confidence === 'confirmed'
      && ['rendered-login-url', 'controlled-login-check', 'session-cookie-unusable']
        .includes(shop.authHealth.pdd.evidence))
    .map((shop) => shop.shopId));
  const shopsById = new Map(shops.map((shop) => [shop.shopId, shop]));
  // A single ordinary claim waiting on TMS login also prevents this shop's
  // otherwise healthy PDD refund scanner from running. Attribute that queue
  // delay to the live claim only when PDD and OMS are still authenticated.
  const tmsLoginBlockedShopIds = new Set(activeOrdinary
    .filter((order) => {
      const shop = shopsById.get(order.shopId);
      return order.runtimeStatus === 'processing'
        && shop?.authHealth?.pdd?.status === 'authenticated'
        && shop.authHealth?.oms?.status === 'authenticated'
        && shop.authHealth?.tms?.status === 'expired'
        && ['tms-auto-login-attempt', 'tms-login-retry', 'manual-login-required']
          .includes(order.currentStep);
    })
    .map((order) => order.shopId));
  // A confirmed live login page supersedes an older unresolved CAPTCHA row.
  // Otherwise the audit hides the operator action that can actually recover
  // this shop and mislabels its overdue refunds as verification-only waits.
  for (const shopId of loginBlockedShopIds) verificationBlockedShopIds.delete(shopId);
  const recordedAuthenticationGaps = shops.flatMap((shop) => ['pdd', 'oms', 'tms']
    .filter((system) => shop.authHealth?.[system]?.status !== 'authenticated')
    .filter((system) => !(system === 'pdd' && verificationBlockedShopIds.has(shop.shopId)))
    .map((system) => ({
      shopId: shop.shopId,
      shopName: shop.name,
      system,
      status: shop.authHealth?.[system]?.status || 'unknown',
      ...authObservationEvidence(shop, system),
    })));
  const authenticationGaps = recordedAuthenticationGaps.filter(item => item.evidenceState === 'current');
  const staleAuthenticationObservations = recordedAuthenticationGaps.filter(item => item.evidenceState === 'stale');
  shopHealth.verificationAssisted = {
    pdd: verificationBlockedShopIds.size,
    shops: shops.filter((shop) => verificationBlockedShopIds.has(shop.shopId))
      .map((shop) => ({
        shopId: shop.shopId,
        shopName: shop.name,
        source: loginPageVerificationUncertainIds.has(shop.shopId)
          ? 'stale-verification-status-at-login-page'
          : pddVerificationStatusShopIds.has(shop.shopId)
            ? 'worker-auth-status' : 'active-verification-record',
      })),
  };
  shopHealth.authenticationGaps = authenticationGaps;
  shopHealth.staleAuthenticationObservations = staleAuthenticationObservations;
  shopHealth.identityBlocked = identityBlockedShops;
  const refundCooldowns = activeRefundCooldowns(shops);
  shopHealth.verificationCooldown = [...refundCooldowns.values()];
  const refundBlockers = {
    verificationShopIds: verificationBlockedShopIds,
    identityShopIds: identityBlockedShopIds,
    loginShopIds: loginBlockedShopIds,
    tmsLoginShopIds: tmsLoginBlockedShopIds,
    cooldowns: refundCooldowns,
  };
  const waitClassification = classifyOverdueRefunds(overdueRefundWaits, refundBlockers);
  const retryClassification = classifyOverdueRefunds(overdueRefundRetries, refundBlockers);
  const unexplainedOverdueRefundWaits = waitClassification.unexplained;
  const unresolvedEffectRefundWaits = waitClassification.unresolvedEffect;
  const verificationBlockedRefundWaits = waitClassification.verificationBlocked;
  const identityBlockedRefundWaits = waitClassification.identityBlocked;
  const loginBlockedRefundWaits = waitClassification.loginBlocked;
  const tmsLoginBlockedRefundWaits = waitClassification.tmsLoginBlocked;
  const cooldownBlockedRefundWaits = waitClassification.cooldownBlocked;
  const unexplainedOverdueRefundRetries = retryClassification.unexplained;
  const unresolvedEffectRefundRetries = retryClassification.unresolvedEffect;
  const verificationBlockedRefundRetries = retryClassification.verificationBlocked;
  const identityBlockedRefundRetries = retryClassification.identityBlocked;
  const loginBlockedRefundRetries = retryClassification.loginBlocked;
  const tmsLoginBlockedRefundRetries = retryClassification.tmsLoginBlocked;
  const cooldownBlockedRefundRetries = retryClassification.cooldownBlocked;
  const staleResidentTerminalClaims = residentTerminalClaimCandidates.filter((claim) => {
    const completedAt = Date.parse(claim.commandCompletedAt || '');
    const progressUpdatedAt = Date.parse(claim.progressUpdatedAt || '');
    return Number.isFinite(completedAt) && Number.isFinite(progressUpdatedAt)
      && progressUpdatedAt >= completedAt
      && Date.now() - completedAt > 5 * 60_000;
  });
  const verificationBlockedResolvedVerifications = staleResolvedVerifications.filter(
    (verification) => verificationBlockedShopIds.has(verification.shopId),
  );
  const unexplainedStaleResolvedVerifications = staleResolvedVerifications.filter(
    (verification) => !verificationBlockedShopIds.has(verification.shopId)
      && !identityBlockedShopIds.has(verification.shopId)
      && !loginBlockedShopIds.has(verification.shopId),
  );
  const hardIssues = [
    ...(shopHealth.online < shopHealth.total ? ['offline-workers'] : []),
    ...(identityBlockedShops.some((shop) => shop.identityStatus === 'mismatch')
      ? ['shop-identity-mismatch'] : []),
    ...(authenticationGaps.length ? ['system-authentication'] : []),
    ...(staleAuthenticationObservations.length ? ['resident-runtime-observation-stale'] : []),
    ...(shopHealth.stale.length ? ['stale-shop-state'] : []),
    ...(Number(capacity.overdueShops || 0) > 0 ? ['overdue-shop-scans'] : []),
    ...(queueEmptyContradictions.length ? ['queue-empty-contradiction'] : []),
    ...(unexplainedStaleResolvedVerifications.length ? ['verification-resume-timeout'] : []),
    ...(unexplainedOverdueRefundWaits.length ? ['overdue-return-refund-waits'] : []),
    ...(unexplainedOverdueRefundRetries.length ? ['overdue-return-refund-retries'] : []),
    ...(tmsLoginBlockedRefundWaits.length ? ['tms-login-blocked-refund-waits'] : []),
    ...(tmsLoginBlockedRefundRetries.length ? ['tms-login-blocked-refund-retries'] : []),
    ...(staleResidentTerminalClaims.length ? ['resident-terminal-claim-stuck'] : []),
    ...(autoRefundProofMismatches.length ? ['auto-refund-platform-proof-mismatch'] : []),
    ...(ordinaryCompletionProofMismatches.length
      ? ['ordinary-completion-proof-mismatch'] : []),
  ];
  const attention = [
    ...(verificationBlockedShopIds.size ? ['active-verification'] : []),
    ...(refundCooldowns.size ? ['verification-cooldown'] : []),
    ...(cooldownBlockedRefundWaits.length ? ['cooldown-blocked-refund-waits'] : []),
    ...(cooldownBlockedRefundRetries.length ? ['cooldown-blocked-refund-retries'] : []),
    ...(loginPageVerificationUncertain.length ? ['pdd-login-page-needs-live-check'] : []),
    ...(verificationBlockedRefundWaits.length ? ['verification-blocked-refund-waits'] : []),
    ...(verificationBlockedRefundRetries.length ? ['verification-blocked-refund-retries'] : []),
    ...(identityBlockedRefundWaits.length ? ['identity-blocked-refund-waits'] : []),
    ...(identityBlockedRefundRetries.length ? ['identity-blocked-refund-retries'] : []),
    ...(unresolvedEffectRefundWaits.length ? ['unresolved-refund-effect-waits'] : []),
    ...(unresolvedEffectRefundRetries.length ? ['unresolved-refund-effect-retries'] : []),
    ...(loginBlockedRefundWaits.length ? ['login-blocked-refund-waits'] : []),
    ...(loginBlockedRefundRetries.length ? ['login-blocked-refund-retries'] : []),
    ...(verificationBlockedResolvedVerifications.length
      ? ['verification-blocked-resolved-orders'] : []),
    ...(unresolvedInterventions.length ? ['unresolved-manual-intervention'] : []),
    ...(pausedOrdinary.length ? ['paused-ordinary-order'] : []),
    ...(identityBlockedUncertainOrdinary.length ? ['identity-blocked-uncertain-submission'] : []),
    ...(unverifiedInTransitArchives.length ? ['in-transit-address-change-archive-unverified'] : []),
    ...(unverifiedFeedbackArchives.length ? ['product-shortage-feedback-outcome-not-stored'] : []),
    ...(unverifiedFeedbackArchives.some((order) => order.exactCaseCompletedProof !== true)
      ? ['product-shortage-feedback-exact-case-proof-missing'] : []),
  ];

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    since,
    status: hardIssues.length ? 'unhealthy' : attention.length ? 'attention' : 'healthy',
    hardIssues,
    attention,
    shopHealth,
    capacity,
    queues: {
      activeOrdinary,
      queueEmptyContradictions,
      pausedOrdinary,
      identityBlockedUncertainOrdinary,
      staleResidentTerminalClaims,
      autoRefundProofMismatches,
      ordinaryCompletionProofMismatches,
      unverifiedInTransitArchives,
      unverifiedFeedbackArchives,
      refundStates,
      overdueRefundWaits: unexplainedOverdueRefundWaits,
      unresolvedEffectRefundWaits,
      verificationBlockedRefundWaits,
      identityBlockedRefundWaits,
      loginBlockedRefundWaits,
      tmsLoginBlockedRefundWaits,
      cooldownBlockedRefundWaits,
      overdueRefundRetries: unexplainedOverdueRefundRetries,
      unresolvedEffectRefundRetries,
      verificationBlockedRefundRetries,
      identityBlockedRefundRetries,
      loginBlockedRefundRetries,
      tmsLoginBlockedRefundRetries,
      cooldownBlockedRefundRetries,
    },
    activeVerifications,
    loginPageVerificationUncertain,
    staleResolvedVerifications: unexplainedStaleResolvedVerifications,
    verificationBlockedResolvedVerifications,
    unresolvedInterventions,
    recentEvents,
    optionGaps,
  }, null, 2));
  if (hardIssues.length) process.exitCode = 1;
} finally {
  await pool.end();
}
