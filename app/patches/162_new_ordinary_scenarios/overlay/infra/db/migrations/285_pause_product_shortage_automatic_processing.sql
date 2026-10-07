BEGIN;

SET client_encoding = 'UTF8';

WITH eligible AS (
  SELECT work_order.id
  FROM work_orders work_order
  WHERE work_order.scenario_code = 'product-shortage'
    AND work_order.frontend_visibility = 'operational'
    AND work_order.completion_state = 'pending'
    AND work_order.status NOT IN ('completed', 'archived')
    AND NOT (
      work_order.status = 'paused'
      AND work_order.current_step = 'business-rule-paused-product-shortage'
      AND work_order.recovery_reason = 'business-rule-processing-disabled'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
  FOR UPDATE OF work_order
), paused_orders AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'business-rule-paused-product-shortage',
    manual_review_reason = '商品少发自动处理已按业务要求暂停，保留工单但不执行拼多多、OMS 或 TMS 操作',
    next_attempt_at = NULL,
    handling_classification = 'manual',
    classification_source = 'system',
    classification_reason = 'product-shortage-processing-disabled',
    classification_updated_at = now(),
    recovery_state = 'held',
    recovery_reason = 'business-rule-processing-disabled',
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    updated_at = now()
  FROM eligible
  WHERE work_order.id = eligible.id
  RETURNING work_order.id, work_order.shop_id, work_order.current_ordinary_instance_id,
    work_order.external_order_number
), paused_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'business-rule-paused-product-shortage',
    manual_review_reason = '商品少发自动处理已按业务要求暂停，保留工单但不执行拼多多、OMS 或 TMS 操作',
    next_attempt_at = NULL,
    updated_at = now()
  FROM paused_orders paused
  WHERE instance.work_order_id = paused.id
    AND instance.scenario_code = 'product-shortage'
    AND instance.completed_at IS NULL
    AND lower(instance.status) NOT IN ('completed', 'archived', 'resolved', 'manual-completed')
  RETURNING instance.id, instance.work_order_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT paused.shop_id,
  paused.id,
  paused.current_ordinary_instance_id,
  'system',
  'product-shortage-automatic-processing-paused',
  jsonb_build_object(
    'orderNumber', paused.external_order_number,
    'reason', 'business-rule-processing-disabled',
    'externalActionsReplayed', false,
    'pausedAt', now()
  ),
  'product-shortage-automatic-processing-paused:' || paused.id::text
FROM paused_orders paused
LEFT JOIN paused_instances instance
  ON instance.id = paused.current_ordinary_instance_id
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
