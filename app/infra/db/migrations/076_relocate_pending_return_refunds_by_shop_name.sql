BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id AS previous_shop_id,
    work_order.external_order_number, refund.aftersale_number,
    target.shop_id AS target_shop_id, target.actual_shop_name,
    target.binding_token,
    refund.evidence->>'pddIdentityBindingToken' AS previous_binding_token
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings target
    ON target.actual_shop_name = ANY(ARRAY[
      nullif(refund.evidence->>'detectedShopName', ''),
      nullif(refund.evidence->>'shopNameSnapshot', ''),
      nullif(refund.evidence->>'actualShopName', ''),
      nullif(work_order.payload->>'detectedShopName', ''),
      nullif(work_order.payload->>'shopNameSnapshot', '')
    ])
    AND target.shop_id <> work_order.shop_id
  JOIN shops target_shop ON target_shop.id = target.shop_id
    AND target_shop.enabled = true
    AND target_shop.onboarding_status = 'ready'
  WHERE work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('queued','retry-ready','paused')
    AND work_order.recovery_state <> 'held'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved','unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM return_refunds other_refund
      JOIN work_orders other ON other.id = other_refund.work_order_id
      WHERE other_refund.work_order_id <> refund.work_order_id
        AND other_refund.aftersale_number = refund.aftersale_number
        AND other.status IN ('processing','queued','retry-ready')
        AND other.recovery_state <> 'held'
    )
), moved_orders AS (
  UPDATE work_orders work_order
  SET shop_id = candidate.target_shop_id,
    payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'pddIdentityBindingToken', candidate.binding_token,
      'detectedShopName', candidate.actual_shop_name,
      'shopNameSnapshot', candidate.actual_shop_name
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id
), moved_refunds AS (
  UPDATE return_refunds refund
  SET shop_id = candidate.target_shop_id,
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'pddIdentityBindingToken', candidate.binding_token,
      'detectedShopName', candidate.actual_shop_name,
      'shopNameSnapshot', candidate.actual_shop_name,
      'identityBackfilledAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id
), moved_external_effects AS (
  UPDATE external_effects item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_evidence_assets AS (
  UPDATE evidence_assets item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_verifications AS (
  UPDATE verification_locations item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_audits AS (
  UPDATE audit_events item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_events AS (
  UPDATE workflow_events item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_commands AS (
  UPDATE operator_commands item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_interventions AS (
  UPDATE manual_interventions item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT candidate.target_shop_id, candidate.id, 'migration-076',
  'pending-return-refund-shop-corrected',
  jsonb_build_object(
    'orderNumber', candidate.external_order_number,
    'aftersaleNumber', candidate.aftersale_number,
    'actualShopName', candidate.actual_shop_name,
    'bindingToken', candidate.binding_token,
    'previousBindingToken', candidate.previous_binding_token,
    'previousShopId', candidate.previous_shop_id
  ),
  'migration-076:return-refund-shop:' || candidate.id::text || ':' ||
    candidate.target_shop_id || ':' || candidate.binding_token::text
FROM candidates candidate
JOIN moved_orders moved_order ON moved_order.id = candidate.id
JOIN moved_refunds moved_refund ON moved_refund.work_order_id = candidate.id
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
