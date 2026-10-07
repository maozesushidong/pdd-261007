DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'external_effects'::regclass
      AND conname = 'external_effects_effect_type_check'
  ) THEN
    ALTER TABLE external_effects DROP CONSTRAINT external_effects_effect_type_check;
  END IF;
  ALTER TABLE external_effects ADD CONSTRAINT external_effects_effect_type_check
    CHECK (effect_type IN ('tms-create', 'pdd-submit', 'pdd-note', 'evidence-upload'));
END $$;

CREATE TABLE IF NOT EXISTS shop_identity_bindings (
  shop_id text PRIMARY KEY REFERENCES shops(id),
  expected_shop_name text NOT NULL,
  profile_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'revoked')),
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cross_shop_order_conflicts (
  id bigserial PRIMARY KEY,
  external_order_number text NOT NULL,
  discovered_shop_id text NOT NULL REFERENCES shops(id),
  conflicting_shop_ids text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'resolved')) DEFAULT 'open',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_shop_id text REFERENCES shops(id),
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cross_shop_order_conflicts_open
  ON cross_shop_order_conflicts (external_order_number, status, created_at DESC);
