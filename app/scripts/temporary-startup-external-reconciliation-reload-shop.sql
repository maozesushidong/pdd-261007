\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:startup-external-reconciliation:shop-mt9vci3e-20eedf')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM shops shop
    JOIN work_orders work_order
      ON work_order.id = 'f0f3e232-b7e5-4e89-b103-56713cee5141'::uuid
      AND work_order.shop_id = shop.id
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
      AND instance.work_order_id = work_order.id
      AND instance.shop_id = work_order.shop_id
    JOIN external_effects effect
      ON effect.id = 'a9821ce9-d209-4254-8fdf-10ae2335fd80'::uuid
      AND effect.work_order_id = work_order.id
      AND effect.shop_id = work_order.shop_id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = shop.id
    WHERE shop.id = 'shop-mt9vci3e-20eedf'
      AND shop.enabled = true
      AND binding.actual_shop_name = shop.expected_shop_name
      AND work_order.external_order_number = '260822-371762153000016'
      AND work_order.status = 'paused'
      AND work_order.runtime_status = 'paused'
      AND work_order.current_step = 'system-shutdown-drained'
      AND work_order.recovery_state = 'held'
      AND work_order.recovery_reason = 'unknown-external-effect'
      AND instance.status = 'paused'
      AND instance.runtime_status = 'paused'
      AND effect.effect_type = 'oms-reissue-create'
      AND effect.status = 'unknown'
      AND effect.request_hash = 'efb4907136016fc2a3f9e1f7744dc72e456a083e91e3c94cf481069ac98dac1d'
      AND NOT EXISTS (
        SELECT 1
        FROM shop_runtime_state runtime
        WHERE runtime.shop_id = shop.id
          AND runtime.lease_token IS NOT NULL
          AND runtime.lease_expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM external_effects reserved_effect
        WHERE reserved_effect.shop_id = shop.id
          AND reserved_effect.status = 'reserved'
      )
      AND 1 = (
        SELECT count(*)
        FROM external_effects unknown_effect
        WHERE unknown_effect.shop_id = shop.id
          AND unknown_effect.status = 'unknown'
      )
  ) THEN
    RAISE EXCEPTION 'single-shop reload safety precondition failed';
  END IF;
END
$$;

UPDATE shops
SET config_version = config_version + 1,
  updated_at = now()
WHERE id = 'shop-mt9vci3e-20eedf'
RETURNING id, config_version, updated_at;

COMMIT;
