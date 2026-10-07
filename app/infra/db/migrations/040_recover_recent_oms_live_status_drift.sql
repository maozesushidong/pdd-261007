BEGIN;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-live-status-refresh-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-live-status-refresh-ready',
        'omsLiveStatusRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', 'refresh-live-state-before-manual-allocation',
          'previousOmsOrderStatus', work_order.payload #>> '{omsAnalysis,orderStatus}',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.external_order_number IN (
      '260810-622078257510396',
      '260810-542491287102197',
      '260811-393970982513066'
    )
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      LIKE '%OMS 订单行右键菜单未找到%手工配货%'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'oms-manual-allocation'
        AND effect.status IN ('succeeded', 'unknown')
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.payload #>> '{omsLiveStatusRecovery,previousOmsOrderStatus}' AS previous_status
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-040',
  'recent-oms-live-status-drift-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousOmsOrderStatus', recovered.previous_status
  ),
  'migration-040:oms-live-status:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-040')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'oms-live-status-refresh-ready';

COMMIT;
