-- Requeue a completion inferred from the wrong PDD shop. The TMS effect is
-- already idempotently recorded, so the retry can only continue with the
-- missing PDD-side completion after the correct identity is confirmed.
WITH candidate AS (
  SELECT work_order.id
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  WHERE work_order.id = '499d07c3-77f2-4bda-8649-718a0f5d13b8'::uuid
    AND work_order.shop_id = 'panapopo-healthcare'
    AND work_order.external_order_number = '260811-387469821563173'
    AND work_order.status = 'archived'
    AND work_order.current_step = 'requested-order-complete'
    AND work_order.payload->'lastCompletedOrder'->>'confirmationMethod' = 'absent-from-pending-list'
    AND lower(coalesce(work_order.payload->'pddShopIdentity'->>'actualShopName', ''))
      <> lower(coalesce(shop.expected_shop_name, ''))
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('reserved', 'succeeded', 'unknown')
    )
)
UPDATE work_orders work_order
SET status = 'retry-ready',
  current_step = 'pdd-identity-mismatch-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
    'identityMismatchArchiveRecovery', jsonb_build_object(
      'recoveredAt', now(),
      'previousStatus', work_order.status,
      'previousStep', work_order.current_step,
      'reason', 'absent-from-pending-list was observed in a different PDD shop'
    )
  ),
  updated_at = now()
FROM candidate
WHERE work_order.id = candidate.id;

INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
SELECT work_order.shop_id,
  'migration-094',
  'cross-shop-absent-pending-archive-recovered',
  jsonb_build_object(
    'workOrderId', work_order.id,
    'orderNumber', work_order.external_order_number,
    'status', work_order.status,
    'step', work_order.current_step
  )
FROM work_orders work_order
WHERE work_order.id = '499d07c3-77f2-4bda-8649-718a0f5d13b8'::uuid
  AND work_order.status = 'retry-ready'
  AND work_order.current_step = 'pdd-identity-mismatch-retry-ready'
  AND NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.event_type = 'cross-shop-absent-pending-archive-recovered'
      AND audit.payload->>'workOrderId' = work_order.id::text
  );
