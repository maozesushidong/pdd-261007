BEGIN;

INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
VALUES (
  'reverse-logistics-signed-refund',
  '["逆向物流已签收", "逆向物流签收催退款"]'::jsonb,
  1,
  true,
  '{"displayName":"逆向物流已签收退款","displayOrder":55,"titleMatchMode":"contains","requiresPdd":true,"requiresOms":false,"requiresTms":false,"allowAutoSubmit":true}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
  title_patterns = EXCLUDED.title_patterns,
  policy_version = EXCLUDED.policy_version,
  enabled = EXCLUDED.enabled,
  config = EXCLUDED.config,
  updated_at = now();

UPDATE shops shop
SET scenario_codes = ARRAY(
    SELECT item.code
    FROM unnest(
      coalesce(shop.scenario_codes, ARRAY[]::text[])
        || ARRAY['reverse-logistics-signed-refund']::text[]
    ) WITH ORDINALITY AS item(code, position)
    GROUP BY item.code
    ORDER BY min(item.position)
  ),
  config_version = config_version + 1,
  updated_at = now()
WHERE NOT (
  ARRAY['reverse-logistics-signed-refund']::text[]
    <@ coalesce(shop.scenario_codes, ARRAY[]::text[])
);

ALTER TABLE shops
  ALTER COLUMN scenario_codes SET DEFAULT ARRAY[
    'in-transit-refund',
    'shipped-no-tracking-refund',
    'abnormal-network-warning',
    'return-refund',
    'delivery-risk-concern',
    'proactive-logistics-service',
    'reverse-logistics-signed-refund',
    'intercept-recall',
    'good-deed-expedited-shipping',
    'delivered-not-received',
    'consumer-refusal'
  ]::text[];

INSERT INTO schema_migrations (version)
VALUES ('217_add_reverse_logistics_signed_refund.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
