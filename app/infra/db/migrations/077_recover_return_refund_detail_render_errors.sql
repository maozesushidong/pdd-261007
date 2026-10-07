BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, work_order.manual_review_reason AS reason
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'return-refund-page-error'
    AND refund.action_state = 'page-error'
    AND refund.detail_url IS NOT NULL
    AND work_order.manual_review_reason =
      '售后详情关键字段读取不完整，无法确认“同意退款”按钮消失代表已完成'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
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
    current_step = 'return-refund-detail-render-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-detail-render-retry-ready',
        'returnRefundDetailRenderRecovery', jsonb_build_object(
          'reason', candidate.reason,
          'aftersaleNumber', candidate.aftersale_number,
          'strategy', 'wait-30s-refresh-wait-30s',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    candidate.aftersale_number, candidate.reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-077',
  'return-refund-detail-render-error-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'previousReason', recovered.reason,
    'strategy', 'wait-30s-refresh-wait-30s'
  ),
  'migration-077:return-refund-detail-render:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-077')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN ('external-system-error', 'return-refund-manual-review')
  AND work_order.current_step = 'return-refund-detail-render-retry-ready'
  AND work_order.payload ? 'returnRefundDetailRenderRecovery';

COMMIT;
