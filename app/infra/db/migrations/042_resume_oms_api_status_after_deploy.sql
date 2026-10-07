BEGIN;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-api-status-deployed-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-api-status-deployed-ready',
        'omsApiStatusDeployRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', 'new-workflow-process-confirmed-before-retry',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  WHERE work_order.id = '59f48fc1-c7a3-4a7f-b15d-a30c4f4f86b0'::uuid
    AND work_order.frontend_visibility = 'operational'
    AND work_order.external_order_number = '260810-542491287102197'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'oms-api-status-refresh-ready'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') = ''
    AND EXISTS (
      SELECT 1 FROM audit_events event
      WHERE event.work_order_id = work_order.id
        AND event.event_type = 'recent-oms-api-status-race-recovered'
        AND event.actor_id = 'migration-041'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'oms-manual-allocation'
        AND effect.status IN ('succeeded', 'unknown')
    )
    AND EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.status = 'idle'
        AND runtime.current_work_order_id IS NULL
        AND runtime.lease_token IS NULL
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-042',
  'oms-api-status-deployment-retry-ready',
  jsonb_build_object('orderNumber', recovered.external_order_number),
  'migration-042:oms-api-status-deployed:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
