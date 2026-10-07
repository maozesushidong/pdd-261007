BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.current_step IN ('flow-paused', 'manual-review-blocked')
    AND (
      coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') =
        '拼多多工单列表未找到订单号查询框'
      OR coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
        '%拼多多订单详情未在限定时间内完成渲染%'
      OR coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
        '%阶段: pdd-resolution-detail-loading%页面仍在加载或内容为空%'
      OR (
        coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          'locator.waitFor: Timeout %'
        AND (
          coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE '%.filter-panel:%'
          OR coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
            '%locator(''body'')%'
          OR coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
            '%订单编号|订单号%'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
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
    current_step = 'transient-page-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'transient-page-retry-ready',
        'transientPageRecovery', jsonb_build_object(
          'reason', candidate.reason,
          'maxAttempts', 5,
          'retryIntervalMs', 120000,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-067', 'transient-page-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'maxAttempts', 5,
    'retryIntervalMs', 120000
  ),
  'migration-067:transient-page:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'transient-page-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'manualReview' - 'error')
    || jsonb_build_object(
      'step', 'transient-page-retry-ready',
      'transientPageRecovery', work_order.payload->'transientPageRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'transient-page-retry-ready'
  AND work_order.payload ? 'transientPageRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-067')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN ('external-system-error', 'ordinary-manual-review')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'transient-page-retry-ready'
  AND work_order.payload ? 'transientPageRecovery';

COMMIT;
