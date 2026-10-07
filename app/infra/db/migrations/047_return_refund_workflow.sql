BEGIN;

INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
VALUES (
  'return-refund',
  '["退货退款"]'::jsonb,
  1,
  true,
  jsonb_build_object(
    'requiresPdd', true,
    'requiresOms', false,
    'requiresTms', false,
    'notificationEnabled', false,
    'scanIntervalMinutes', 15,
    'missingLogisticsRetryMinutes', 60,
    'maxRefundAmountExclusive', 500,
    'maxLogisticsAgeHoursExclusive', 72,
    'requiredLogisticsCity', '长沙'
  )
)
ON CONFLICT (code) DO UPDATE SET
  title_patterns = EXCLUDED.title_patterns,
  policy_version = EXCLUDED.policy_version,
  enabled = EXCLUDED.enabled,
  config = EXCLUDED.config,
  updated_at = now();

UPDATE shops
SET scenario_codes = array_append(scenario_codes, 'return-refund'),
  config_version = config_version + 1,
  updated_at = now()
WHERE enabled = true
  AND NOT ('return-refund' = ANY(scenario_codes));

ALTER TABLE shops
  ALTER COLUMN scenario_codes SET DEFAULT ARRAY[
    'in-transit-refund',
    'shipped-no-tracking-refund',
    'abnormal-network-warning',
    'return-refund'
  ]::text[];

DROP INDEX IF EXISTS uq_work_orders_operational_order_number;

CREATE UNIQUE INDEX uq_work_orders_operational_order_number
  ON work_orders (external_order_number)
  WHERE frontend_visibility = 'operational'
    AND scenario_code IS DISTINCT FROM 'return-refund';

ALTER TABLE work_orders
  DROP CONSTRAINT IF EXISTS work_orders_shop_id_external_order_number_work_order_type_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_shop_order_type_non_return_refund
  ON work_orders (shop_id, external_order_number, work_order_type)
  WHERE scenario_code IS DISTINCT FROM 'return-refund';

CREATE TABLE IF NOT EXISTS return_refunds (
  work_order_id uuid PRIMARY KEY REFERENCES work_orders(id) ON DELETE CASCADE,
  shop_id text NOT NULL REFERENCES shops(id),
  external_order_number text NOT NULL,
  aftersale_number text NOT NULL,
  detail_url text,
  aftersale_type text,
  aftersale_status text,
  refund_amount numeric(12, 2),
  currency text NOT NULL DEFAULT 'CNY',
  return_carrier text,
  return_tracking_number text,
  logistics_timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  latest_logistics_at timestamptz,
  logistics_contains_changsha boolean,
  rule_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision text,
  risk_level text CHECK (risk_level IS NULL OR risk_level IN ('medium', 'high')),
  action_state text NOT NULL DEFAULT 'discovered' CHECK (action_state IN (
    'discovered',
    'waiting-logistics',
    'ready',
    'manual-review',
    'submitting',
    'verification-required',
    'auto-refunded',
    'manual-completed',
    'page-error'
  )),
  action_button_visible boolean,
  next_check_at timestamptz,
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_scanned_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completion_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, aftersale_number)
);

CREATE INDEX IF NOT EXISTS idx_return_refunds_due
  ON return_refunds (shop_id, action_state, next_check_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_return_refunds_order
  ON return_refunds (shop_id, external_order_number, updated_at DESC);

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
    CHECK (effect_type IN (
      'oms-manual-allocation',
      'tms-create',
      'pdd-submit',
      'pdd-note',
      'pdd-return-refund',
      'evidence-upload'
    ));
END $$;

INSERT INTO system_settings (key, value, updated_by)
VALUES
  ('return-refund-scan-enabled', 'true'::jsonb, 'migration'),
  ('return-refund-auto-approve-enabled', 'false'::jsonb, 'migration'),
  ('return-refund-dingtalk-enabled', 'false'::jsonb, 'migration')
ON CONFLICT (key) DO NOTHING;

COMMIT;
