BEGIN;

CREATE TABLE IF NOT EXISTS pdd_shop_runtime_bindings (
  identity_key text PRIMARY KEY,
  shop_id text NOT NULL UNIQUE REFERENCES shops(id),
  actual_shop_name text NOT NULL,
  binding_token uuid NOT NULL,
  profile_fingerprint text,
  bound_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

UPDATE work_orders work_order
SET payload = coalesce(work_order.payload, '{}'::jsonb)
  || jsonb_build_object('shopNameSnapshot', shop.name)
FROM shops shop
WHERE shop.id = work_order.shop_id
  AND coalesce(work_order.payload->>'shopNameSnapshot', '') = '';

COMMIT;
