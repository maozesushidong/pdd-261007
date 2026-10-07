BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.recovery_state = 'held'
    AND work_order.payload#>>'{pddResolutionFlow,flowCode}' = 'subjective-intercept'
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'manual-review-blocked'
    AND coalesce(
      (work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}')::integer,
      0
    ) = 2
    AND work_order.payload#>>'{pddEvidenceOmission,reasonCode}' =
      'pdd-upload-authorization-rejected'
    AND work_order.payload#>>'{pddEvidenceOmission,errorCode}' = '48143'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,automaticRetryExhausted}' = 'true'
    AND work_order.payload#>>'{pddResolutionSubmission,historicalEvidenceRefundFallbackAuthorizedAt}'
      IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'subjective-refund-fallback-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = jsonb_set(
      (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
        || jsonb_build_object(
          'step', 'subjective-refund-fallback-retry-ready',
          'subjectiveRefundFallbackRecovery', jsonb_build_object(
            'status', 'retry-ready',
            'previousReason', candidate.reason,
            'strategy', 'select-refund-after-pdd-evidence-48143',
            'recoveredAt', now()
          )
        ),
      '{pddResolutionSubmission}',
      coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
        || jsonb_build_object(
          'status', 'retry-authorized',
          'historicalEvidenceRefundFallbackAuthorizedAt', now(),
          'historicalEvidenceRefundFallbackReason', 'pdd-upload-authorization-rejected'
        ),
      true
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-099', 'subjective-refund-fallback-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'strategy', 'select-refund-after-pdd-evidence-48143'
  ),
  'migration-099:subjective-refund-fallback:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'subjective-refund-fallback-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'manualReview' - 'error')
    || jsonb_build_object(
      'step', 'subjective-refund-fallback-retry-ready',
      'pddResolutionSubmission', work_order.payload->'pddResolutionSubmission',
      'subjectiveRefundFallbackRecovery',
        work_order.payload->'subjectiveRefundFallbackRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'subjective-refund-fallback-retry-ready'
  AND work_order.payload ? 'subjectiveRefundFallbackRecovery';

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-099')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'subjective-refund-fallback-retry-ready'
    AND work_order.payload ? 'subjectiveRefundFallbackRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'failed');

COMMIT;
