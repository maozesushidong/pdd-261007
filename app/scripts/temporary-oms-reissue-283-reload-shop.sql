BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:oms-reissue-vue-model-commit:shop-mt9vci3e-20eedf')
);

DO $$
BEGIN
  IF 1 <> (
    SELECT count(*)
    FROM shops shop
    JOIN work_orders work_order
      ON work_order.id = 'f0f3e232-b7e5-4e89-b103-56713cee5141'::uuid
      AND work_order.shop_id = shop.id
    JOIN ordinary_work_order_instances instance
      ON instance.id = 'bb3b6e11-c9b7-4ff3-b52a-ed92963f0bd5'::uuid
      AND instance.id = work_order.current_ordinary_instance_id
      AND instance.work_order_id = work_order.id
    JOIN external_effects effect
      ON effect.id = 'a9821ce9-d209-4254-8fdf-10ae2335fd80'::uuid
      AND effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    WHERE shop.id = 'shop-mt9vci3e-20eedf'
      AND shop.enabled = true
      AND shop.onboarding_status = 'ready'
      AND work_order.external_order_number = '260822-371762153000016'
      AND work_order.status = 'paused'
      AND work_order.runtime_status = 'paused'
      AND work_order.current_step = 'flow-paused'
      AND instance.status = 'paused'
      AND instance.runtime_status = 'paused'
      AND effect.effect_type = 'oms-reissue-create'
      AND effect.status = 'failed'
      AND effect.request_hash =
        'fdee4a5301def8c31036779b5c2b2425808322a1d712e8485accc0cf357cc7e1'
      AND effect.receipt->>'reason' = 'oms-reissue-required-fields-incomplete'
      AND effect.receipt->>'clickAttempted' = 'false'
      AND NOT EXISTS (
        SELECT 1
        FROM shop_runtime_state runtime
        WHERE runtime.shop_id = shop.id
          AND runtime.lease_token IS NOT NULL
          AND runtime.lease_expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM external_effects unsafe_effect
        WHERE unsafe_effect.shop_id = shop.id
          AND unsafe_effect.status IN ('reserved', 'unknown')
      )
  ) THEN
    RAISE EXCEPTION 'target-shop reload safety precondition failed';
  END IF;
END
$$;

UPDATE shops
SET config_version = config_version + 1,
  updated_at = now()
WHERE id = 'shop-mt9vci3e-20eedf'
RETURNING id, config_version, updated_at;

COMMIT;
