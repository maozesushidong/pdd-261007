BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND work_order.payload#>>'{tmsAttachmentTransfer,status}' = 'failed'
    AND work_order.payload#>>'{tmsAttachmentTransfer,orderNumber}' = work_order.external_order_number
    AND coalesce(
      work_order.payload#>>'{tmsAttachmentTransfer,error}',
      work_order.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) ~ 'page[.]waitForResponse: Timeout [0-9]+ms exceeded while waiting for event ["'']response["'']'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'tms-create'
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
    current_step = 'tms-attachment-upload-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'tms-attachment-upload-retry-ready',
        'transientWorkflowRecovery', jsonb_build_object(
          'reason', candidate.reason,
          'stage', 'tms-attachment-upload',
          'maxAttempts', 5,
          'retryIntervalMs', 120000,
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
  'migration-136', 'tms-attachment-response-timeout-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'strategy', 'confirm-visible-success-thumbnail-or-upload-once'
  ),
  'migration-136:tms-attachment-response-timeout:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'tms-attachment-upload-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'manualReview' - 'error')
    || jsonb_build_object(
      'step', 'tms-attachment-upload-retry-ready',
      'transientWorkflowRecovery', work_order.payload->'transientWorkflowRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'tms-attachment-upload-retry-ready'
  AND work_order.payload ? 'transientWorkflowRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-136')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'tms-attachment-upload-retry-ready'
  AND work_order.payload ? 'transientWorkflowRecovery';

COMMIT;
