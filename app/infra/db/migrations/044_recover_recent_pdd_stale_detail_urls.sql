BEGIN;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-stale-detail-fresh-query-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'pdd-stale-detail-fresh-query-ready',
        'pddStaleDetailRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'previousDetailUrl', work_order.payload->>'detailUrl',
          'strategy', 'fresh-exact-order-query',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.external_order_number IN (
      '260810-359703518870444',
      '260810-494477022773679'
    )
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      LIKE '%locator.waitFor%'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      ~ '(订单编号|订单号)'
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
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-044',
  'recent-pdd-stale-detail-recovered',
  jsonb_build_object('orderNumber', recovered.external_order_number),
  'migration-044:pdd-stale-detail:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
