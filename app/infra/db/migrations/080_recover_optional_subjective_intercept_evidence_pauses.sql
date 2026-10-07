BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'manual-review-blocked'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
      '%阶段: pdd-resolution-submit%48143%非法请求%'
    AND work_order.payload#>>'{pddResolutionFlow,flowCode}' = 'subjective-intercept'
    AND work_order.payload#>>'{pddResolutionFlow,secondaryReason}' = '主观原因不想要'
    AND work_order.payload#>>'{pddResolutionFlow,tertiaryOutcome}' = '尝试拦截快递'
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'retry-authorized'
    AND coalesce(
      (work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}')::integer,
      0
    ) = 0
    AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
    AND work_order.payload#>>'{pddResolutionRecovery,status}' = 'exhausted'
    AND work_order.payload#>>'{pddEvidenceUpload,status}' = 'failed'
    AND work_order.payload#>>'{pddEvidenceUpload,diagnostics,authorizationFailure,errorCode}' = '48143'
    AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
    AND nullif(work_order.payload#>>'{tmsWorkOrder,ticketId}', '') IS NOT NULL
    AND nullif(work_order.payload#>>'{tmsWorkOrder,ticketNo}', '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
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
    current_step = 'legacy-pdd-evidence-optional-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'pddEvidenceUpload' - 'pddResolutionRecovery')
      || jsonb_build_object(
        'step', 'legacy-pdd-evidence-optional-retry-ready',
        'pddEvidenceOptionalRecovery', jsonb_build_object(
          'previousReason', candidate.reason,
          'strategy', 'omit-rejected-subjective-intercept-evidence-only-when-submit-remains-enabled',
          'recoveredAt', now()
        )
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
  'migration-080', 'optional-subjective-intercept-evidence-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'strategy', 'omit-rejected-subjective-intercept-evidence-only-when-submit-remains-enabled'
  ),
  'migration-080:optional-subjective-intercept-evidence:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'legacy-pdd-evidence-optional-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'pddEvidenceUpload' - 'pddResolutionRecovery')
    || jsonb_build_object(
      'step', 'legacy-pdd-evidence-optional-retry-ready',
      'pddResolutionFlow', work_order.payload->'pddResolutionFlow',
      'pddResolutionSubmission', work_order.payload->'pddResolutionSubmission',
      'pddEvidenceOptionalRecovery', work_order.payload->'pddEvidenceOptionalRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'legacy-pdd-evidence-optional-retry-ready'
  AND work_order.payload ? 'pddEvidenceOptionalRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-080')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN (
    'external-system-error',
    'manual-review-required',
    'pdd-upload-authorization-failed'
  )
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'legacy-pdd-evidence-optional-retry-ready'
  AND work_order.payload ? 'pddEvidenceOptionalRecovery';

COMMIT;
