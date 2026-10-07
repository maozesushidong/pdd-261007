BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    CASE
      WHEN coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
        LIKE '%locator.click: Timeout%el-drawer%' THEN 'tms-filter-drawer-click'
      WHEN coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
        LIKE '%OMS 查询结果未找到订单所在行%' THEN 'oms-order-row'
      WHEN coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
        LIKE '%OMS 目标订单行未找到选择框%' THEN 'oms-pinned-row-checkbox'
      WHEN coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
        LIKE '%pdd-order-remark%mms-header__%' THEN 'pdd-sticky-header-overlap'
      ELSE NULL
    END AS recovery_reason
  FROM work_orders work_order
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.status = 'paused'
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'recent-page-locator-recovery-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'recent-page-locator-recovery-ready',
        'pageLocatorRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', candidate.recovery_reason,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
    AND candidate.recovery_reason IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type IN ('pdd-submit', 'oms-manual-allocation')
        AND effect.status = 'succeeded'
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    candidate.recovery_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-035',
  'recent-page-locator-failure-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'reason', recovered.recovery_reason
  ),
  'migration-035:page-locator:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-035')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'recent-page-locator-recovery-ready'
  AND work_order.payload #>> '{pageLocatorRecovery,status}' = 'retry-ready';

COMMIT;
