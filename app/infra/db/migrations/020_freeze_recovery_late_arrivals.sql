BEGIN;

WITH frozen AS (
  UPDATE work_orders work_order
  SET status = 'paused', runtime_status = 'paused',
    recovery_state = 'held',
    recovery_reason = coalesce(recovery_reason, 'operator-recovery-freeze'),
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(), updated_at = now()
  FROM shop_runtime_state runtime
  WHERE runtime.shop_id = work_order.shop_id
    AND (
      runtime.status = 'operator-paused'
      OR coalesce((runtime.metadata->>'operatorPaused')::boolean, false)
    )
    AND coalesce(work_order.runtime_status, work_order.status)
      NOT IN ('archived', 'completed', 'failed', 'paused')
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.recovery_reason, work_order.recovery_version
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'recovery-late-arrival-freeze', 'work-order-recovery-held',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', recovery_reason,
    'recoveryVersion', recovery_version
  ),
  'migration-020:recovery-held:' || id::text
FROM frozen
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE shop_runtime_state
SET status = 'operator-paused', lease_token = NULL, lease_expires_at = NULL,
  current_work_order_id = NULL,
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('operatorPaused', true),
  updated_at = now()
WHERE status = 'operator-paused'
  OR coalesce((metadata->>'operatorPaused')::boolean, false);

COMMIT;
