BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number
  FROM work_orders work_order
  WHERE work_order.id = '338b77e1-da48-4c70-b4d3-a67d9ddfb187'::uuid
    AND work_order.external_order_number = '260811-120879859223953'
    AND work_order.frontend_visibility = 'operational'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'manual-review-blocked'
    AND coalesce(work_order.manual_review_reason, '') LIKE
      '流程需要人工复核（阶段: pdd-order-remark）：locator.click: Timeout 1500ms exceeded.%'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status = 'unknown'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-detail-click-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'pdd-detail-click-retry-ready',
        'pddDetailClickRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', 'transient-unblocked-click-timeout',
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
SELECT recovered.shop_id, recovered.id, 'migration-051',
  'pdd-detail-click-timeout-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'reason', 'transient-unblocked-click-timeout'
  ),
  'migration-051:pdd-detail-click-timeout:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-051')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'pdd-detail-click-retry-ready'
  AND work_order.payload #>> '{pddDetailClickRecovery,reason}' = 'transient-unblocked-click-timeout';

COMMIT;
