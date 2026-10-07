BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number
  FROM work_orders work_order
  WHERE work_order.id = '849d15dc-544c-46a5-92f7-193a7a6f0027'::uuid
    AND work_order.external_order_number = '260813-019152258631307'
    AND work_order.frontend_visibility = 'operational'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      = 'OMS 查询结果未找到订单所在行'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status = 'unknown'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type IN ('oms-manual-allocation', 'pdd-submit')
        AND effect.status = 'succeeded'
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-detached-row-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-detached-row-retry-ready',
        'omsRowRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', 'ag-grid-detached-order-cell',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-052',
  'oms-detached-order-row-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'reason', 'ag-grid-detached-order-cell'
  ),
  'migration-052:oms-detached-order-row:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-052')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'oms-detached-row-retry-ready'
  AND work_order.payload #>> '{omsRowRecovery,reason}' = 'ag-grid-detached-order-cell';

COMMIT;
