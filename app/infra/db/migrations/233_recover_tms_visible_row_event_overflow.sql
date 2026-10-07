BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.status = 'paused'
    AND coalesce(work_order.runtime_status, work_order.status) = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.manual_review_reason = 'Maximum call stack size exceeded'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.payload ? 'tmsPayloadTraversalRecovery231'
    AND nullif(work_order.payload->'tmsFormDecision'->>'status', '') = 'ready'
    AND coalesce(instance.status, '') = 'paused'
    AND coalesce(instance.current_step, '') = 'flow-paused'
    AND EXISTS (
      SELECT 1 FROM workflow_events failure
      WHERE failure.work_order_id = work_order.id
        AND failure.ordinary_instance_id = work_order.current_ordinary_instance_id
        AND failure.stage = 'flow-paused'
        AND failure.message = 'Maximum call stack size exceeded'
        AND coalesce(failure.payload->'patch'->>'currentUrl', '')
          LIKE 'http://tms.aipro123.top/%'
    )
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
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-visible-row-correlation-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = 'tms-visible-row-event-bypass-recovery',
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'step', 'tms-visible-row-correlation-retry-ready',
      'error', NULL,
      'manualReview', NULL,
      'tmsVisibleRowEventBypassRecovery233', jsonb_build_object(
        'previousStep', 'flow-paused',
        'previousError', 'Maximum call stack size exceeded',
        'evidence', 'workflow-event-tms-current-url',
        'strategy', 'prefer-complete-visible-row-before-api-payload',
        'externalActionsReplayed', false,
        'recoveredAt', now()
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
    work_order.payload
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-visible-row-correlation-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING
    recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT
  recovered.shop_id,
  recovered.id,
  recovered.current_ordinary_instance_id,
  'migration-233',
  'tms-visible-row-event-overflow-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousStep', 'flow-paused',
    'currentStep', 'tms-visible-row-correlation-retry-ready',
    'evidence', 'workflow-event-tms-current-url',
    'strategy', 'prefer-complete-visible-row-before-api-payload',
    'externalActionsReplayed', false
  ),
  'migration-233:tms-visible-row-event-overflow:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('233_recover_tms_visible_row_event_overflow.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
