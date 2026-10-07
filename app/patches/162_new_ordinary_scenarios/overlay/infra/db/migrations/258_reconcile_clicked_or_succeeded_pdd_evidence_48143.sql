BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:clicked-or-succeeded-pdd-evidence-48143-258')
);

-- A successful PDD submit effect or a persisted lastClickAttemptedAt makes a
-- normal retry unsafe. Schedule exact-detail read-only reconciliation for all
-- such stale 48143 rows. The migration preserves every external effect and
-- never invokes a PDD, OMS, or TMS business action.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.scenario_code,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    instance.platform_case_id,
    target_effect.id AS effect_id,
    target_effect.idempotency_key,
    target_effect.status AS effect_status,
    target_effect.updated_at AS effect_updated_at,
    target_effect.status = 'succeeded' AS has_succeeded_submit,
    work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}'
      AS last_click_attempted_at
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND nullif(binding.binding_token::text, '') IS NOT NULL
    AND nullif(binding.mall_id, '') IS NOT NULL
  JOIN LATERAL (
    SELECT
      effect.id,
      effect.idempotency_key,
      effect.status,
      effect.updated_at
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.effect_type = 'pdd-submit'
      AND (
        (
          effect.status = 'succeeded'
          AND (
            effect.receipt->>'clickAttempted' = 'true'
            OR effect.receipt#>>'{result,submitReceipt,clickAttempted}' = 'true'
          )
        )
        OR (
          effect.status = 'failed'
          AND effect.error->>'message' LIKE '%48143%'
          AND (effect.receipt IS NULL OR jsonb_typeof(effect.receipt) = 'null')
          AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}'
            IS NOT NULL
        )
      )
    ORDER BY CASE WHEN effect.status = 'succeeded' THEN 0 ELSE 1 END,
      effect.updated_at DESC,
      effect.id
    LIMIT 1
  ) target_effect ON true
  WHERE work_order.scenario_code IN (
      'intercept-recall',
      'delivery-risk-concern',
      'delivered-not-received'
    )
    AND instance.identity_status = 'verified'
    AND instance.platform_case_id IS NOT NULL
    AND instance.platform_case_key =
      'pdd-work-order:' || instance.platform_case_id
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') = 'ready'
    AND work_order.manual_review_reason =
      '拼多多凭证上传授权失败（48143）：非法请求'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,status}' = 'failed'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,authorizationFailure,errorCode}' =
      '48143'
    AND work_order.payload#>>'{ordinaryEvidenceUploadRecovery,status}' = 'exhausted'
    AND (
      target_effect.status = 'succeeded'
      OR work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  ORDER BY target_effect.status DESC,
    target_effect.updated_at DESC,
    work_order.id
  FOR UPDATE OF work_order, instance SKIP LOCKED
), scheduled AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason =
      '等待只读核对拼多多提交结果，禁止重复提交',
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      - 'externalStateReconciliation'
    ) || jsonb_build_object(
      'step', 'external-state-reconciliation-ready',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          || jsonb_build_object(
            'shopId', work_order.shop_id,
            'orderNumber', work_order.external_order_number,
            'scenarioCode', work_order.scenario_code,
            'status', 'submitted-unconfirmed',
            'effectId', candidate.effect_id,
            'idempotencyKey', candidate.idempotency_key,
            'effectStage', split_part(candidate.idempotency_key, ':', 5),
            'submitAttemptCount', CASE
              WHEN coalesce(
                work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}',
                ''
              ) ~ '^[0-9]+$'
              THEN greatest(1, (
                work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}'
              )::int)
              ELSE 1
            END,
            'maximumAutomaticSubmitAttempts', 1
          ),
      'externalStateReconciliationTarget', jsonb_build_object(
        'effectId', candidate.effect_id,
        'effectType', 'pdd-submit',
        'idempotencyKey', candidate.idempotency_key,
        'status', candidate.effect_status,
        'submitAttemptCount', CASE
          WHEN coalesce(
            work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}',
            ''
          ) ~ '^[0-9]+$'
          THEN greatest(1, (
            work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}'
          )::int)
          ELSE 1
        END,
        'maximumAutomaticSubmitAttempts', 1,
        'updatedAt', candidate.effect_updated_at
      ),
      'externalStateReconciliationRetry', jsonb_build_object(
        'attempts', 0,
        'maxAttempts', 3,
        'scheduledAt', now(),
        'recoverySource', 'migration-258'
      ),
      'clickedOrSucceededPddEvidence48143Reconciliation258',
        jsonb_build_object(
          'status', 'read-only-reconciliation-ready',
          'strategy', 'observe-exact-pdd-state-without-resubmit',
          'previousReason', candidate.previous_reason,
          'effectId', candidate.effect_id,
          'effectStatus', candidate.effect_status,
          'hasSucceededSubmit', candidate.has_succeeded_submit,
          'lastClickAttemptedAt', candidate.last_click_attempted_at,
          'externalActionsReplayedByMigration', false,
          'scheduledAt', now()
        ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.platform_case_id,
    candidate.scenario_code,
    candidate.previous_reason,
    candidate.effect_id,
    candidate.idempotency_key,
    candidate.effect_status,
    candidate.has_succeeded_submit,
    candidate.last_click_attempted_at
), scheduled_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason =
      '等待只读核对拼多多提交结果，禁止重复提交',
    next_attempt_at = now(),
    payload = scheduled.payload,
    updated_at = now()
  FROM scheduled
  WHERE instance.id = scheduled.current_ordinary_instance_id
    AND instance.work_order_id = scheduled.id
    AND instance.shop_id = scheduled.shop_id
  RETURNING scheduled.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    scheduled.shop_id,
    scheduled.id,
    scheduled.current_ordinary_instance_id,
    'migration-258',
    'clicked-or-succeeded-pdd-evidence-48143-read-only-reconciliation-ready',
    jsonb_build_object(
      'orderNumber', scheduled.external_order_number,
      'platformCaseId', scheduled.platform_case_id,
      'scenarioCode', scheduled.scenario_code,
      'previousReason', scheduled.previous_reason,
      'effectId', scheduled.effect_id,
      'idempotencyKey', scheduled.idempotency_key,
      'effectStatus', scheduled.effect_status,
      'hasSucceededSubmit', scheduled.has_succeeded_submit,
      'lastClickAttemptedAt', scheduled.last_click_attempted_at,
      'strategy', 'observe-exact-pdd-state-without-resubmit',
      'proof', CASE
        WHEN scheduled.has_succeeded_submit
          THEN 'successful-clicked-submit-effect'
        ELSE 'persisted-last-click-time-with-failed-48143-submit-effect'
      END,
      'externalActionsReplayedByMigration', false
    ),
    'migration-258:clicked-or-succeeded-pdd-evidence-48143:'
      || scheduled.id::text
  FROM scheduled_instances scheduled
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
)
SELECT count(*) AS scheduled_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS scheduled_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('258_reconcile_clicked_or_succeeded_pdd_evidence_48143.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
