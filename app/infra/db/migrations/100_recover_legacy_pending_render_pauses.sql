BEGIN;

-- Re-run legacy orders that were paused before exact-order queries used the
-- bounded wait-refresh-wait path. A current exact PDD identity binding is
-- required because an empty result from a different shop is not evidence.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    instance.id AS ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text = work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND work_order.recovery_state <> 'held'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') ~
      '^未找到目标待处理工单（已等待 30 秒）:'
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND binding.actual_shop_name = coalesce(
      nullif(work_order.payload->'pddShopIdentity'->>'actualShopName', ''),
      nullif(work_order.payload->'latestDiscovery'->>'actualShopName', '')
    )
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.mall_id = coalesce(
      nullif(work_order.payload->'pddShopIdentity'->>'mallId', ''),
      nullif(work_order.payload->'latestDiscovery'->>'pddMallId', ''),
      nullif(work_order.payload->>'pddMallId', '')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved','unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
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
    current_step = 'legacy-pending-render-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'legacy-pending-render-retry-ready',
        'legacyPendingRenderRecovery', jsonb_build_object(
          'previousReason', candidate.reason,
          'strategy', 'wait-refresh-requery-with-exact-shop-identity',
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
  'migration-100', 'legacy-pending-render-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'strategy', 'wait-refresh-requery-with-exact-shop-identity'
  ),
  'migration-100:legacy-pending-render:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'legacy-pending-render-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = coalesce(work_order.payload, '{}'::jsonb),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'legacy-pending-render-retry-ready'
  AND work_order.payload ? 'legacyPendingRenderRecovery';

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-100')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'legacy-pending-render-retry-ready'
    AND work_order.payload ? 'legacyPendingRenderRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'failed');

COMMIT;
