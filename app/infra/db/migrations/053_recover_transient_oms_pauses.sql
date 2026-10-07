BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND (
      coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
        'OMS 生成配货单后未确认订单状态已越过配货阶段%'
      OR (
        coalesce(work_order.payload->>'currentUrl', '') LIKE '%jeoms.com%'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') ~
          'locator\.(click|waitFor): Timeout'
      )
    )
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
    current_step = 'transient-workflow-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'transient-workflow-retry-ready',
        'transientWorkflowRecovery', jsonb_build_object(
          'count', 0,
          'maxAttempts', 5,
          'lastReason', candidate.reason,
          'retryAt', now(),
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
SELECT recovered.shop_id, recovered.id, 'migration-053',
  'transient-oms-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'reason', 'transient-oms-ui-or-allocation-state-delay'
  ),
  'migration-053:transient-oms-pause:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-053')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'transient-workflow-retry-ready'
  AND work_order.payload ? 'transientWorkflowRecovery';

COMMIT;
