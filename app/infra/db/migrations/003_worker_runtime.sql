CREATE TABLE IF NOT EXISTS external_effects (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL REFERENCES shops(id),
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  effect_type text NOT NULL CHECK (effect_type IN ('tms-create', 'pdd-submit', 'evidence-upload')),
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'unknown')),
  request_hash text NOT NULL,
  receipt jsonb,
  error jsonb,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_external_effects_work_order ON external_effects (work_order_id, effect_type);

CREATE TABLE IF NOT EXISTS shop_runtime_state (
  shop_id text PRIMARY KEY REFERENCES shops(id),
  worker_id text,
  status text NOT NULL DEFAULT 'idle',
  lease_token uuid,
  lease_expires_at timestamptz,
  current_work_order_id uuid REFERENCES work_orders(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
