BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    effect.id AS effect_id, effect.idempotency_key, effect.updated_at AS submitted_at
  FROM work_orders work_order
  JOIN external_effects effect
    ON effect.id = 'ad6fd346-c917-4397-bf4b-263c86da6191'::uuid
    AND effect.work_order_id = work_order.id
    AND effect.shop_id = work_order.shop_id
    AND effect.ordinary_instance_id = work_order.current_ordinary_instance_id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'succeeded'
  WHERE work_order.id = '0b8f0ec9-5881-4d8f-9151-d6284f470bf5'::uuid
    AND work_order.external_order_number = '260817-674454618552185'
    AND work_order.current_ordinary_instance_id =
      '9abd787f-1bf0-4df6-b50a-1bd27dd34b35'::uuid
    AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'intercept-recall'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.manual_review_reason =
      '拼多多提交后未确认当前普通工单已完结，禁止重复提交'
    AND (
      SELECT count(*)
      FROM external_effects submit_effect
      WHERE submit_effect.work_order_id = work_order.id
        AND submit_effect.ordinary_instance_id = work_order.current_ordinary_instance_id
        AND submit_effect.effect_type = 'pdd-submit'
    ) = 1
    AND NOT EXISTS (
      SELECT 1 FROM external_effects unresolved
      WHERE unresolved.work_order_id = work_order.id
        AND unresolved.ordinary_instance_id = work_order.current_ordinary_instance_id
        AND unresolved.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对拼多多首次提交结果，禁止第二次提交',
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'external-state-reconciliation-ready',
        'externalStateReconciliationTarget', jsonb_build_object(
          'effectId', candidate.effect_id,
          'effectType', 'pdd-submit',
          'idempotencyKey', candidate.idempotency_key,
          'status', 'succeeded',
          'submitAttemptCount', 1,
          'maximumAutomaticSubmitAttempts', 1,
          'updatedAt', candidate.submitted_at
        ),
        'pddResolutionSubmission',
          coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          || jsonb_build_object(
            'orderNumber', candidate.external_order_number,
            'status', 'submitted-unconfirmed',
            'submitAttemptCount', 1,
            'maximumAutomaticSubmitAttempts', 1,
            'effectId', candidate.effect_id,
            'idempotencyKey', candidate.idempotency_key
          ),
        'unconfirmedOrdinarySubmissionRecovery', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'strategy', 'read-only-pdd-state-reconciliation-no-retry',
          'maximumAutomaticSubmitAttempts', 1,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.effect_id,
    candidate.idempotency_key, candidate.previous_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-131', 'single-submit-read-only-reconciliation-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'effectId', recovered.effect_id,
    'idempotencyKey', recovered.idempotency_key,
    'previousReason', recovered.previous_reason,
    'strategy', 'read-only-pdd-state-reconciliation-no-retry',
    'maximumAutomaticSubmitAttempts', 1
  ),
  'migration-131:single-submit-read-only:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'paused',
  runtime_status = 'paused',
  current_step = 'external-state-reconciliation-ready',
  manual_review_reason = '等待只读核对拼多多首次提交结果，禁止第二次提交',
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'manualReview' - 'error')
    || jsonb_build_object(
      'step', 'external-state-reconciliation-ready',
      'externalStateReconciliationTarget',
        work_order.payload->'externalStateReconciliationTarget',
      'pddResolutionSubmission', work_order.payload->'pddResolutionSubmission',
      'unconfirmedOrdinarySubmissionRecovery',
        work_order.payload->'unconfirmedOrdinarySubmissionRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.id = '0b8f0ec9-5881-4d8f-9151-d6284f470bf5'::uuid
  AND work_order.current_step = 'external-state-reconciliation-ready'
  AND work_order.payload #>>
    '{unconfirmedOrdinarySubmissionRecovery,maximumAutomaticSubmitAttempts}' = '1';

COMMIT;
