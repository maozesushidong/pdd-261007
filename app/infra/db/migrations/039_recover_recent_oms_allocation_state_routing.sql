BEGIN;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-allocation-state-routing-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-allocation-state-routing-ready',
        'omsAllocationStateRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', CASE
            WHEN work_order.payload #>> '{omsAnalysis,orderStatus}' IN ('已配货', '已发货', '已完成')
              THEN 'allocation-stage-already-passed'
            ELSE 'manual-allocation-toolbar-entry'
          END,
          'omsOrderStatus', work_order.payload #>> '{omsAnalysis,orderStatus}',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      LIKE '%OMS 订单行右键菜单未找到%手工配货%'
    AND coalesce(work_order.payload #>> '{omsAnalysis,orderStatus}', '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'oms-manual-allocation'
        AND effect.status = 'succeeded'
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.payload #>> '{omsAllocationStateRecovery,reason}' AS recovery_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-039',
  'recent-oms-allocation-state-routing-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'reason', recovered.recovery_reason
  ),
  'migration-039:oms-allocation-state:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-039')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'oms-allocation-state-routing-ready';

COMMIT;
