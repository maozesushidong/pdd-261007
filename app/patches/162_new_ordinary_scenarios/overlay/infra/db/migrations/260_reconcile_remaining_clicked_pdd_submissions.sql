BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:remaining-clicked-pdd-submissions-260')
);

-- These two exact PDD submissions recorded a click but never reached a
-- trustworthy terminal observation. Preserve all effects and schedule only a
-- read-only detail reconciliation. A pending page can authorize the normal
-- guarded retry; a completed page is archived without another submit.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    instance.platform_case_id,
    target_effect.id AS effect_id,
    target_effect.idempotency_key,
    target_effect.status AS effect_status,
    target_effect.updated_at AS effect_updated_at
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
    SELECT effect.id, effect.idempotency_key, effect.status, effect.updated_at
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.effect_type = 'pdd-submit'
      AND (
        effect.status IN ('succeeded', 'unknown')
        OR effect.receipt->>'clickAttempted' = 'true'
        OR effect.receipt#>>'{result,submitReceipt,clickAttempted}' = 'true'
      )
    ORDER BY effect.updated_at DESC, effect.id
    LIMIT 1
  ) target_effect ON true
  WHERE work_order.external_order_number = ANY(ARRAY[
      '260821-589824080293627',
      '260823-257205256602307'
    ])
    AND instance.identity_status = 'verified'
    AND instance.platform_case_id IS NOT NULL
    AND instance.platform_case_key =
      'pdd-work-order:' || instance.platform_case_id
    AND instance.detail_url =
      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
        || instance.platform_case_id
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'external-state-unresolved'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  ORDER BY work_order.updated_at, work_order.id
  FOR UPDATE OF work_order, instance SKIP LOCKED
), scheduled AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
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
        'maximumAutomaticSubmitAttempts', CASE
          WHEN coalesce(
            work_order.payload#>>'{pddResolutionSubmission,maximumAutomaticSubmitAttempts}',
            ''
          ) ~ '^[0-9]+$'
          THEN greatest(1, (
            work_order.payload#>>'{pddResolutionSubmission,maximumAutomaticSubmitAttempts}'
          )::int)
          ELSE 2
        END,
        'updatedAt', candidate.effect_updated_at
      ),
      'externalStateReconciliationRetry', jsonb_build_object(
        'attempts', 0,
        'maxAttempts', 3,
        'scheduledAt', now(),
        'recoverySource', 'migration-260'
      ),
      'remainingClickedPddSubmissionReconciliation260', jsonb_build_object(
        'status', 'read-only-reconciliation-ready',
        'strategy', 'observe-exact-pdd-state-without-resubmit',
        'previousReason', candidate.previous_reason,
        'effectId', candidate.effect_id,
        'effectStatus', candidate.effect_status,
        'externalActionsReplayedByMigration', false,
        'scheduledAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id,
    work_order.external_order_number, work_order.current_ordinary_instance_id,
    work_order.payload, candidate.platform_case_id, candidate.previous_reason,
    candidate.effect_id, candidate.idempotency_key, candidate.effect_status
), scheduled_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
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
    'migration-260',
    'remaining-clicked-pdd-submit-read-only-reconciliation-ready',
    jsonb_build_object(
      'orderNumber', scheduled.external_order_number,
      'platformCaseId', scheduled.platform_case_id,
      'previousReason', scheduled.previous_reason,
      'effectId', scheduled.effect_id,
      'idempotencyKey', scheduled.idempotency_key,
      'effectStatus', scheduled.effect_status,
      'strategy', 'observe-exact-pdd-state-without-resubmit',
      'externalActionsReplayedByMigration', false
    ),
    'migration-260:remaining-clicked-pdd-submit:' || scheduled.id::text
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
VALUES ('260_reconcile_remaining_clicked_pdd_submissions.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
