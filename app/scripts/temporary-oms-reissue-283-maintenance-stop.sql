BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:oms-reissue-vue-model-commit:shop-mt9vci3e-20eedf')
);

DO $$
BEGIN
  IF 1 <> (
    SELECT count(*)
    FROM shops shop
    JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
    JOIN work_orders active_order ON active_order.id = runtime.current_work_order_id
    JOIN work_orders target_order
      ON target_order.id = 'f0f3e232-b7e5-4e89-b103-56713cee5141'::uuid
      AND target_order.shop_id = shop.id
    JOIN external_effects target_effect
      ON target_effect.id = 'a9821ce9-d209-4254-8fdf-10ae2335fd80'::uuid
      AND target_effect.work_order_id = target_order.id
    WHERE shop.id = 'shop-mt9vci3e-20eedf'
      AND shop.enabled = true
      AND shop.onboarding_status = 'ready'
      AND runtime.status = 'processing'
      AND runtime.lease_token IS NOT NULL
      AND runtime.lease_expires_at > now()
      AND active_order.id = 'd79f5e8a-2fb1-458f-9b49-043aeb21c924'::uuid
      AND active_order.external_order_number = '260818-659973804462110'
      AND active_order.scenario_code = 'in-transit-refund'
      AND active_order.status = 'processing'
      AND active_order.runtime_status = 'processing'
      AND active_order.current_step = 'pdd-session-recovered'
      AND target_order.external_order_number = '260822-371762153000016'
      AND target_order.status = 'paused'
      AND target_order.runtime_status = 'paused'
      AND target_order.current_step = 'flow-paused'
      AND target_effect.effect_type = 'oms-reissue-create'
      AND target_effect.status = 'failed'
      AND target_effect.receipt->>'clickAttempted' = 'false'
      AND NOT EXISTS (
        SELECT 1
        FROM external_effects unsafe_effect
        WHERE unsafe_effect.shop_id = shop.id
          AND unsafe_effect.status IN ('reserved', 'unknown')
      )
  ) THEN
    RAISE EXCEPTION 'target-shop maintenance-stop safety precondition failed';
  END IF;
END
$$;

UPDATE shops
SET enabled = false,
  config_version = config_version + 1,
  updated_at = now()
WHERE id = 'shop-mt9vci3e-20eedf'
  AND enabled = true
RETURNING id, enabled, config_version, updated_at;

COMMIT;
