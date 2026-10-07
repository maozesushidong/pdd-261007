BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    effect.id AS effect_id, effect.idempotency_key, effect.updated_at AS submitted_at
  FROM work_orders work_order
  JOIN LATERAL (
    SELECT candidate_effect.*
    FROM external_effects candidate_effect
    WHERE candidate_effect.work_order_id = work_order.id
      AND candidate_effect.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
      AND candidate_effect.effect_type = 'pdd-submit'
      AND candidate_effect.status = 'succeeded'
      AND candidate_effect.idempotency_key NOT LIKE '%-send-script-v1'
    ORDER BY candidate_effect.updated_at DESC
    LIMIT 1
  ) effect ON true
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.current_step = 'flow-paused'
    AND work_order.manual_review_reason =
      '拼多多提交后未确认当前普通工单已完结，禁止重复提交'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects unresolved
      WHERE unresolved.work_order_id = work_order.id
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
    manual_review_reason = '等待只读核对拼多多首次提交结果',
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
          'updatedAt', candidate.submitted_at
        ),
        'pddResolutionSubmission', jsonb_build_object(
          'orderNumber', candidate.external_order_number,
          'status', 'submitted-unconfirmed',
          'submitAttemptCount', 1,
          'effectId', candidate.effect_id,
          'idempotencyKey', candidate.idempotency_key
        ),
        'unconfirmedOrdinarySubmissionRecovery', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'strategy', 'read-only-pdd-state-reconciliation',
          'maximumAutomaticSubmitAttempts', 2,
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
  'migration-126', 'ordinary-submit-confirmation-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'effectId', recovered.effect_id,
    'idempotencyKey', recovered.idempotency_key,
    'previousReason', recovered.previous_reason,
    'strategy', 'read-only-pdd-state-reconciliation',
    'maximumAutomaticSubmitAttempts', 2
  ),
  'migration-126:ordinary-submit-confirmation:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'paused',
  runtime_status = 'paused',
  current_step = 'external-state-reconciliation-ready',
  manual_review_reason = '等待只读核对拼多多首次提交结果',
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'manualReview' - 'error')
    || jsonb_build_object(
      'step', 'external-state-reconciliation-ready',
      'externalStateReconciliationTarget', work_order.payload->'externalStateReconciliationTarget',
      'pddResolutionSubmission', work_order.payload->'pddResolutionSubmission',
      'unconfirmedOrdinarySubmissionRecovery', work_order.payload->'unconfirmedOrdinarySubmissionRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'external-state-reconciliation-ready'
  AND work_order.payload ? 'unconfirmedOrdinarySubmissionRecovery';

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-126')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'external-state-reconciliation-ready'
    AND work_order.payload ? 'unconfirmedOrdinarySubmissionRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
