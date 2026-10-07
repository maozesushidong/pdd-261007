BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number,
    refund.evidence->>'pddIdentityBindingToken' AS previous_binding_token,
    runtime.metadata->'pddIdentityBinding'->>'bindingToken' AS binding_token,
    runtime.metadata->'pddIdentityBinding'->>'actualShopName' AS actual_shop_name
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  JOIN shop_runtime_state runtime ON runtime.shop_id = work_order.shop_id
  WHERE work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('queued','retry-ready')
    AND work_order.recovery_state <> 'held'
    AND nullif(runtime.metadata->'pddIdentityBinding'->>'bindingToken', '') IS NOT NULL
    AND nullif(runtime.metadata->'pddIdentityBinding'->>'actualShopName', '') IS NOT NULL
    AND refund.evidence->>'pddIdentityBindingToken' IS DISTINCT FROM
      runtime.metadata->'pddIdentityBinding'->>'bindingToken'
    AND runtime.metadata->'pddIdentityBinding'->>'actualShopName' = ANY(ARRAY[
      nullif(refund.evidence->>'detectedShopName', ''),
      nullif(refund.evidence->>'shopNameSnapshot', ''),
      nullif(refund.evidence->>'actualShopName', ''),
      nullif(work_order.payload->>'detectedShopName', ''),
      nullif(work_order.payload->>'shopNameSnapshot', '')
    ])
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved','unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM return_refunds other_refund
      JOIN work_orders other ON other.id = other_refund.work_order_id
      WHERE other.shop_id <> work_order.shop_id
        AND other_refund.aftersale_number = refund.aftersale_number
        AND other.status IN ('processing','queued','retry-ready')
        AND other.recovery_state <> 'held'
    )
), rebound_refunds AS (
  UPDATE return_refunds refund
  SET evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'pddIdentityBindingToken', candidate.binding_token,
      'detectedShopName', candidate.actual_shop_name,
      'shopNameSnapshot', candidate.actual_shop_name,
      'identityBackfilledAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id
), rebound_orders AS (
  UPDATE work_orders work_order
  SET payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'pddIdentityBindingToken', candidate.binding_token,
      'detectedShopName', candidate.actual_shop_name,
      'shopNameSnapshot', candidate.actual_shop_name
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
    AND EXISTS (
      SELECT 1 FROM rebound_refunds rebound WHERE rebound.work_order_id = work_order.id
    )
  RETURNING work_order.id
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT candidate.shop_id, candidate.id, 'migration-075',
  'legacy-return-refund-identity-bound',
  jsonb_build_object(
    'orderNumber', candidate.external_order_number,
    'aftersaleNumber', candidate.aftersale_number,
    'actualShopName', candidate.actual_shop_name,
    'bindingToken', candidate.binding_token,
    'previousBindingToken', candidate.previous_binding_token
  ),
  'migration-075:return-refund-identity:' || candidate.id::text || ':' || candidate.binding_token
FROM candidates candidate
JOIN rebound_orders rebound ON rebound.id = candidate.id
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
