BEGIN;

WITH hidden AS (
  UPDATE work_orders work_order
  SET payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb),
      '{frontendVisibility}',
      '"recovery-audit"'::jsonb,
      true
    ),
    updated_at = now()
  WHERE EXISTS (
    SELECT 1 FROM operator_commands command
    WHERE command.work_order_id = work_order.id
      AND command.command_type = 'reconcile-external-state'
  )
    AND coalesce(work_order.payload->>'frontendVisibility', '') <> 'recovery-audit'
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'recovery-audit-visibility', 'work-order-ui-hidden',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'visibility', 'recovery-audit',
    'reason', 'read-only reconciliation records are excluded from operational metrics'
  ),
  'migration-022:ui-hidden:' || id::text
FROM hidden
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
