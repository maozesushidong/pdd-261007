import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { capturedInterceptRecallPlatformOutcome } from './ordinary-platform-outcome-proof.mjs';

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

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const numberArgument = (name, fallback) => {
  const input = argument(name);
  if (input == null) return fallback;
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} requires a non-negative number`);
  }
  return value;
};

const sinceInput = argument('--since');
if (!sinceInput || Number.isNaN(Date.parse(sinceInput))) {
  throw new Error('--since requires an ISO-8601 timestamp');
}

const since = new Date(sinceInput).toISOString();
const refundGraceMinutes = numberArgument('--refund-grace-minutes', 10);
const orderNumbers = String(argument('--orders') || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const databaseUrl = process.env.DATABASE_URL || readNativeEnvironmentValue('DATABASE_URL');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: 'runtime-progress-readonly-audit',
});

const expectedWarningReasonCodes = [
  'waiting-logistics',
  'waiting-consumer-response',
  'verification-required',
  'page-render-deferred',
  'rate-limited',
];

try {
  const query = async (text, values = []) => (await pool.query(text, values)).rows;
  // A platform state-change response can be followed by an exact completed
  // detail page without a successful local submit effect. Attribute that page
  // proof only to the current instance of the same shop and order.
  const exactRecoveredPageProof = `(
    work_order.current_ordinary_instance_id = instance.id
    AND work_order.payload #>> '{pddResolutionSubmission,shopId}' = instance.shop_id
    AND work_order.payload #>> '{pddResolutionSubmission,orderNumber}' = work_order.external_order_number
    AND work_order.payload #>> '{pddResolutionSubmission,status}' = 'succeeded'
    AND work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
    AND work_order.payload #>> '{pddResolutionSubmission,confirmationMethod}'
      IN ('detail-completed', 'exact-order-completed')
    AND nullif(work_order.payload #>> '{pddResolutionSubmission,completionEvidence}', '') IS NOT NULL
  )`;
  const platformResultTextProof = `(
    EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
        AND nullif(effect.receipt #>> '{result,completedOutcome}', '') IS NOT NULL
    )
    OR (
      work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
      AND nullif(work_order.payload #>> '{lastCompletedOrder,completionEvidence}', '') IS NOT NULL
    )
    OR ${exactRecoveredPageProof}
  )`;
  const exactCompletedPageProof = `(
    (
      instance.shop_id = work_order.shop_id
      AND instance.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
      AND instance.payload #>> '{lastCompletedOrder,orderNumber}' = work_order.external_order_number
      AND instance.payload #>> '{lastCompletedOrder,platformWorkOrderId}' = instance.platform_case_id
      AND instance.payload #>> '{lastCompletedOrder,confirmationMethod}'
        IN ('detail-completed', 'refreshed-detail-completed', 'exact-order-completed')
      AND instance.payload #>> '{lastCompletedOrder,platformCompletionObservation,isCompleted}' = 'true'
      AND instance.payload #>> '{lastCompletedOrder,platformCompletionObservation,orderMatches}' = 'true'
      AND instance.payload #>> '{lastCompletedOrder,platformCompletionObservation,platformCaseMatches}' = 'true'
      AND instance.payload #>> '{lastCompletedOrder,platformCompletionObservation,observedPlatformWorkOrderId}'
        = instance.platform_case_id
    ) OR
    (
    work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
    AND work_order.payload #>> '{lastCompletedOrder,platformWorkOrderId}' = instance.platform_case_id
    AND work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,isCompleted}' = 'true'
    AND work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,orderMatches}' = 'true'
    AND work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,platformCaseMatches}' = 'true'
    ) OR (
      work_order.current_ordinary_instance_id = instance.id
      AND work_order.payload #>> '{pddResolutionSubmission,shopId}' = instance.shop_id
      AND work_order.payload #>> '{pddResolutionSubmission,orderNumber}' = work_order.external_order_number
      AND work_order.payload #>> '{pddResolutionSubmission,status}' = 'succeeded'
      AND work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
      AND work_order.payload #>> '{pddResolutionSubmission,confirmationMethod}'
        IN ('detail-completed', 'refreshed-detail-completed')
      AND work_order.payload #>> '{pddResolutionSubmission,platformCompletionObservation,isCompleted}' = 'true'
      AND work_order.payload #>> '{pddResolutionSubmission,platformCompletionObservation,orderMatches}' = 'true'
      AND work_order.payload #>> '{pddResolutionSubmission,platformCompletionObservation,platformCaseMatches}' = 'true'
      AND work_order.payload #>> '{pddResolutionSubmission,platformCompletionObservation,observedPlatformWorkOrderId}'
        = instance.platform_case_id
    )
  )`;
  const [ordinarySummary, ordinaryActivity, refundSummary, refundActivity,
    unexpectedEvents, optionGaps, selectedOrderSafety] = await Promise.all([
    query(`
      SELECT
        count(*) FILTER (WHERE instance.first_discovered_at >= $1)::int AS "newDiscovered",
        count(*) FILTER (WHERE instance.completed_at >= $1)::int AS "completedAfter",
        count(*) FILTER (
          WHERE instance.first_discovered_at >= $1 AND instance.completed_at >= $1
        )::int AS "newCompleted",
        count(*) FILTER (
          WHERE instance.completed_at >= $1 AND EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.ordinary_instance_id = instance.id
              AND effect.effect_type = 'pdd-submit'
              AND effect.status = 'succeeded'
          )
        )::int AS "completedWithLocalPddSubmit",
        count(*) FILTER (
          WHERE instance.completed_at >= $1 AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.ordinary_instance_id = instance.id
              AND effect.effect_type = 'pdd-submit'
              AND effect.status = 'succeeded'
          )
        )::int AS "completedWithoutLocalPddSubmit",
        count(*) FILTER (
          WHERE instance.completed_at >= $1 AND ${platformResultTextProof}
        )::int AS "completedWithCapturedPlatformOutcome",
        count(*) FILTER (
          WHERE instance.completed_at >= $1
            AND (${platformResultTextProof} OR ${exactCompletedPageProof})
        )::int AS "completedWithExactCompletionProof",
        count(*) FILTER (
          WHERE instance.updated_at >= $1
            AND instance.runtime_status IN ('paused', 'failed', 'manual-review')
        )::int AS "pausedOrFailedUpdatedAfter",
        count(*) FILTER (
          WHERE instance.completed_at >= $1 AND instance.started_at IS NOT NULL
        )::int AS "durationSampleSize",
        round(avg(extract(epoch FROM (instance.completed_at - instance.started_at))) FILTER (
          WHERE instance.completed_at >= $1 AND instance.started_at IS NOT NULL
        ))::int AS "averageRunSeconds",
        round(percentile_cont(0.95) WITHIN GROUP (
          ORDER BY extract(epoch FROM (instance.completed_at - instance.started_at))
        ) FILTER (
          WHERE instance.completed_at >= $1 AND instance.started_at IS NOT NULL
        ))::int AS "p95RunSeconds",
        count(*) FILTER (
          WHERE instance.first_discovered_at >= $1
            AND instance.completed_at >= $1
            AND instance.started_at IS NOT NULL
        )::int AS "freshDurationSampleSize",
        round(avg(extract(epoch FROM (instance.completed_at - instance.started_at))) FILTER (
          WHERE instance.first_discovered_at >= $1
            AND instance.completed_at >= $1
            AND instance.started_at IS NOT NULL
        ))::int AS "freshAverageRunSeconds",
        round(percentile_cont(0.95) WITHIN GROUP (
          ORDER BY extract(epoch FROM (instance.completed_at - instance.started_at))
        ) FILTER (
          WHERE instance.first_discovered_at >= $1
            AND instance.completed_at >= $1
            AND instance.started_at IS NOT NULL
        ))::int AS "freshP95RunSeconds"
      FROM ordinary_work_order_instances instance
      JOIN work_orders work_order ON work_order.id = instance.work_order_id
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'`, [since]),
    query(`
      SELECT instance.id AS "instanceId", shop.name AS "shopName",
        work_order.external_order_number AS "orderNumber",
        instance.platform_case_id AS "platformCaseId", instance.work_order_type AS "workOrderType",
        instance.scenario_code AS "scenarioCode", instance.runtime_status AS "runtimeStatus",
        instance.current_step AS "currentStep", instance.completion_method AS "completionMethod",
        EXISTS (
          SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.effect_type = 'pdd-submit'
            AND effect.status = 'succeeded'
        ) AS "hasLocalPddSubmit",
        (SELECT effect.receipt #>> '{result,selectedPddOutcome}'
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.effect_type = 'pdd-submit'
            AND effect.status = 'succeeded'
            AND nullif(effect.receipt #>> '{result,selectedPddOutcome}', '') IS NOT NULL
          ORDER BY effect.reserved_at DESC LIMIT 1) AS "selectedPddOutcome",
        coalesce((SELECT effect.receipt #>> '{result,completedOutcome}'
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.effect_type = 'pdd-submit'
            AND effect.status = 'succeeded'
            AND nullif(effect.receipt #>> '{result,completedOutcome}', '') IS NOT NULL
          ORDER BY effect.reserved_at DESC LIMIT 1),
          CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
            THEN work_order.payload #>> '{lastCompletedOrder,completionEvidence}'
            WHEN ${exactRecoveredPageProof}
              THEN work_order.payload #>> '{pddResolutionSubmission,completionEvidence}'
            ELSE NULL END) AS "observedPlatformOutcome",
        (${platformResultTextProof}) AS "hasPlatformResultText",
        (${platformResultTextProof} OR ${exactCompletedPageProof}) AS "hasExactCompletionProof",
        CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
          THEN work_order.payload #>> '{lastCompletedOrder,outcome}'
          WHEN ${exactRecoveredPageProof}
            THEN work_order.payload #>> '{pddResolutionSubmission,outcome}'
          ELSE NULL END AS "recordedOutcome",
        CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
          THEN (work_order.payload #>> '{lastCompletedOrder,recoveredFromCompletedPage}')::boolean
          WHEN ${exactRecoveredPageProof} THEN true
          ELSE NULL END AS "recoveredFromCompletedPage",
        instance.first_discovered_at AS "firstDiscoveredAt", instance.started_at AS "startedAt",
        instance.completed_at AS "completedAt", instance.updated_at AS "updatedAt",
        CASE WHEN instance.completed_at IS NOT NULL AND instance.started_at IS NOT NULL
          THEN extract(epoch FROM (instance.completed_at - instance.started_at))::int
          ELSE NULL END AS "runSeconds",
        instance.manual_review_reason AS "manualReviewReason"
      FROM ordinary_work_order_instances instance
      JOIN work_orders work_order ON work_order.id = instance.work_order_id
      JOIN shops shop ON shop.id = instance.shop_id AND shop.enabled = true
      WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND (instance.first_discovered_at >= $1
        OR instance.completed_at >= $1
        OR (
          instance.updated_at >= $1
          AND instance.runtime_status IN ('processing', 'paused', 'failed', 'manual-review')
        ))
      ORDER BY greatest(
        instance.first_discovered_at,
        coalesce(instance.completed_at, '-infinity'::timestamptz),
        instance.updated_at
      ) DESC
      LIMIT 200`, [since]),
    query(`
      SELECT
        count(*) FILTER (WHERE refund.first_discovered_at >= $1)::int AS "newDiscovered",
        count(*) FILTER (WHERE refund.completed_at >= $1)::int AS "completedAfter",
        count(*) FILTER (
          WHERE refund.first_discovered_at >= $1 AND refund.action_state = 'auto-refunded'
        )::int AS "newAutoRefunded",
        count(*) FILTER (
          WHERE refund.first_discovered_at >= $1 AND refund.action_state = 'manual-completed'
        )::int AS "newReadOnlyCompleted",
        count(*) FILTER (
          WHERE refund.first_discovered_at >= $1 AND refund.action_state = 'waiting-logistics'
        )::int AS "newWaitingLogistics",
        count(*) FILTER (
          WHERE refund.first_discovered_at >= $1
            AND refund.action_state IN ('manual-review', 'page-error', 'verification-required')
        )::int AS "newUnsuccessful",
        count(*) FILTER (
          WHERE refund.updated_at >= $1
            AND refund.action_state IN ('manual-review', 'page-error', 'verification-required')
        )::int AS "unsuccessfulUpdatedAfter",
        count(*) FILTER (
          WHERE refund.action_state = 'waiting-logistics'
            AND refund.next_check_at < now() - ($2::double precision * interval '1 minute')
            AND work_order.status NOT IN ('archived', 'completed')
            AND work_order.recovery_state IN ('ready', 'retry-authorized')
        )::int AS "overdueWaitingLogistics",
        count(*) FILTER (
          WHERE refund.action_state = 'waiting-logistics'
            AND refund.next_check_at < now() - ($2::double precision * interval '1 minute')
            AND work_order.status NOT IN ('archived', 'completed')
            AND work_order.recovery_state IN ('ready', 'retry-authorized')
            AND latest_heartbeat.state IN (
              'pdd-identity-duplicate-login-waiting',
              'pdd-identity-binding-waiting'
            )
        )::int AS "identityBlockedOverdueWaitingLogistics",
        count(*) FILTER (
          WHERE refund.action_state = 'waiting-logistics'
            AND refund.next_check_at < now() - ($2::double precision * interval '1 minute')
            AND work_order.status NOT IN ('archived', 'completed')
            AND work_order.recovery_state IN ('ready', 'retry-authorized')
            AND latest_heartbeat.pdd_auth_status = 'expired'
            AND (
              latest_heartbeat.state = 'manual-login-required'
              OR (latest_heartbeat.pdd_auth_confidence = 'confirmed'
                AND latest_heartbeat.pdd_auth_evidence IN (
                  'rendered-login-url', 'controlled-login-check',
                  'session-cookie-unusable'
                ))
            )
        )::int AS "loginBlockedOverdueWaitingLogistics"
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
      JOIN shops shop ON shop.id = work_order.shop_id AND shop.enabled = true
      LEFT JOIN LATERAL (
        SELECT heartbeat.metadata->>'state' AS state,
          heartbeat.metadata->'authHealth'->'pdd'->>'status' AS pdd_auth_status,
          heartbeat.metadata->'authHealth'->'pdd'->>'confidence' AS pdd_auth_confidence,
          heartbeat.metadata->'authHealth'->'pdd'->>'evidence' AS pdd_auth_evidence
        FROM worker_heartbeats heartbeat
        WHERE heartbeat.shop_id = shop.id
          AND heartbeat.heartbeat_at >= now() - interval '2 minutes'
        ORDER BY heartbeat.heartbeat_at DESC LIMIT 1
      ) latest_heartbeat ON true
      WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'`, [since, refundGraceMinutes]),
    query(`
      SELECT shop.name AS "shopName", refund.external_order_number AS "orderNumber",
        refund.aftersale_number AS "aftersaleNumber", refund.aftersale_type AS "aftersaleType",
        refund.aftersale_status AS "aftersaleStatus", refund.action_state AS "actionState",
        refund.decision, refund.completion_method AS "completionMethod",
        refund.first_discovered_at AS "firstDiscoveredAt", refund.last_scanned_at AS "lastScannedAt",
        refund.next_check_at AS "nextCheckAt", refund.completed_at AS "completedAt",
        refund.updated_at AS "updatedAt"
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
      JOIN shops shop ON shop.id = refund.shop_id AND shop.enabled = true
      WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND (refund.first_discovered_at >= $1
        OR refund.completed_at >= $1
        OR (
          refund.updated_at >= $1
          AND refund.action_state IN ('manual-review', 'page-error', 'verification-required', 'submitting')
        ))
      ORDER BY greatest(
        refund.first_discovered_at,
        coalesce(refund.completed_at, '-infinity'::timestamptz),
        refund.updated_at
      ) DESC
      LIMIT 200`, [since]),
    query(`
      SELECT event.occurred_at AS "occurredAt", event.severity,
        shop.name AS "shopName", event.external_order_number AS "orderNumber",
        event.stage, event.reason_code AS "reasonCode", event.message,
        work_order.runtime_status AS "workOrderRuntimeStatus",
        work_order.current_step AS "workOrderCurrentStep",
        instance.runtime_status AS "ordinaryRuntimeStatus",
        instance.current_step AS "ordinaryCurrentStep"
      FROM workflow_events event
      LEFT JOIN shops shop ON shop.id = event.shop_id
      LEFT JOIN work_orders work_order ON work_order.id = event.work_order_id
      LEFT JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE event.occurred_at >= $1
        AND event.severity IN ('error', 'warning')
        AND coalesce(event.reason_code, '') <> ALL($2::text[])
        AND NOT (
          coalesce(event.message, '') ILIKE '%人工验证%'
          AND coalesce(work_order.current_step, '') NOT IN (
            'human-verification-required', 'manual-login-required',
            'return-refund-verification-required'
          )
          AND coalesce(instance.current_step, '') NOT IN (
            'human-verification-required', 'manual-login-required'
          )
          AND NOT EXISTS (
            SELECT 1 FROM verification_locations active_verification
            WHERE active_verification.work_order_id = event.work_order_id
              AND active_verification.status IN (
                'detected', 'waiting-human', 'verification-required'
              )
              AND active_verification.resolved_at IS NULL
          )
        )
      ORDER BY event.occurred_at DESC
      LIMIT 200`, [since, expectedWarningReasonCodes]),
    query(`
      SELECT event.occurred_at AS "occurredAt", shop.name AS "shopName",
        event.external_order_number AS "orderNumber", event.stage,
        event.reason_code AS "reasonCode", event.message
      FROM workflow_events event
      LEFT JOIN shops shop ON shop.id = event.shop_id
      WHERE event.occurred_at >= $1
        AND event.severity IN ('error', 'warning')
        AND (
          coalesce(event.reason_code, '') ILIKE ANY(ARRAY['%unknown%', '%option%'])
          OR coalesce(event.message, '') ILIKE ANY(ARRAY[
            '%未找到%选项%', '%48143%', '%option not found%'
          ])
        )
      ORDER BY event.occurred_at DESC
      LIMIT 100`, [since]),
    orderNumbers.length
      ? query(`
        SELECT work_order.external_order_number AS "orderNumber",
          shop.name AS "shopName", instance.runtime_status AS "runtimeStatus",
          instance.current_step AS "currentStep",
          instance.payload->'pddResolutionSubmission' AS "pddResolutionSubmission",
          instance.payload->'ordinarySubmitRenderRecovery' AS "ordinarySubmitRenderRecovery",
          instance.payload->'ordinaryPddFormTransientRecovery' AS "ordinaryPddFormTransientRecovery",
          instance.payload->'pddCoreOptionLookupFailure' AS "pddCoreOptionLookupFailure",
          instance.payload->'ordinaryPddPickupAddressProof' AS "ordinaryPddPickupAddressProof",
          coalesce(jsonb_agg(jsonb_build_object(
            'effectType', effect.effect_type,
            'status', effect.status,
            'idempotencyKey', effect.idempotency_key,
            'receipt', effect.receipt,
            'error', effect.error,
            'reservedAt', effect.reserved_at,
            'updatedAt', effect.updated_at
          ) ORDER BY effect.updated_at) FILTER (WHERE effect.id IS NOT NULL), '[]'::jsonb)
            AS "externalEffects"
        FROM work_orders work_order
        LEFT JOIN shops shop ON shop.id = work_order.shop_id
        LEFT JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
        LEFT JOIN external_effects effect ON effect.work_order_id = work_order.id
        WHERE work_order.external_order_number = ANY($1::text[])
        GROUP BY work_order.id, shop.name, instance.id
        ORDER BY work_order.external_order_number`, [orderNumbers])
      : [],
  ]);

  // Some completed intercept forms expose the merchant's exact selected
  // result only in the same-case detail response captured after submission.
  // Require the separately persisted completed-page proof as well: a success
  // API response by itself is not enough to count a platform result.
  const outcomeCandidates = await query(`
    SELECT instance.id AS "instanceId", instance.scenario_code AS "scenarioCode",
      instance.platform_case_id AS "platformCaseId",
      work_order.external_order_number AS "orderNumber",
      effect.status AS "effectStatus", effect.reserved_at AS "effectReservedAt",
      effect.receipt AS receipt
    FROM ordinary_work_order_instances instance
    JOIN work_orders work_order ON work_order.id = instance.work_order_id
    JOIN shops shop ON shop.id = instance.shop_id AND shop.enabled = true
    JOIN external_effects effect ON effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id = instance.id
      AND effect.effect_type = 'pdd-submit' AND effect.status = 'succeeded'
    WHERE instance.completed_at >= $1
      AND instance.scenario_code = 'intercept-recall'
      AND instance.completion_method = 'detail-completed'
      AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
      AND ${exactCompletedPageProof}
      AND NOT ${platformResultTextProof}
      AND effect.receipt #>> '{result,selectedPddOutcome}' = '已进行召回'`, [since]);
  const supplementalOutcomes = new Map();
  for (const candidate of outcomeCandidates) {
    const outcome = capturedInterceptRecallPlatformOutcome(candidate);
    if (outcome) supplementalOutcomes.set(candidate.instanceId, outcome);
  }
  ordinarySummary[0].completedWithCapturedPlatformOutcome += supplementalOutcomes.size;
  ordinarySummary[0].capturedFromExactSubmitDetail = supplementalOutcomes.size;
  for (const activity of ordinaryActivity) {
    const outcome = supplementalOutcomes.get(activity.instanceId);
    if (!outcome) continue;
    activity.observedPlatformOutcome = outcome;
    activity.hasPlatformResultText = true;
    activity.platformOutcomeSource = 'same-case-detail-flow-after-submit';
  }

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    since,
    ordinary: {
      summary: ordinarySummary[0],
      activity: ordinaryActivity,
    },
    returnRefund: {
      summary: refundSummary[0],
      activity: refundActivity,
    },
    unexpectedEvents,
    optionGaps,
    selectedOrderSafety,
  }, null, 2));
} finally {
  await pool.end();
}
