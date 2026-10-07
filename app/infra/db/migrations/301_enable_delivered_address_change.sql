\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:enable-delivered-address-change-301')
);

INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
VALUES (
  'delivered-address-change',
  '["已签收改地址"]'::jsonb,
  1,
  true,
  jsonb_build_object(
    'displayName', '已签收改地址',
    'displayOrder', 120,
    'processingEnabled', true,
    'requiresPdd', true,
    'requiresOms', true,
    'requiresTms', true,
    'allowAutoSubmit', true
  )
)
ON CONFLICT (code) DO UPDATE SET
  title_patterns = EXCLUDED.title_patterns,
  policy_version = greatest(scenario_definitions.policy_version, EXCLUDED.policy_version),
  enabled = true,
  config = coalesce(scenario_definitions.config, '{}'::jsonb) || EXCLUDED.config,
  updated_at = now();

UPDATE shops
SET scenario_codes = ARRAY(
    SELECT item.code
    FROM unnest(
      coalesce(scenario_codes, ARRAY[]::text[])
        || ARRAY['delivered-address-change']::text[]
    ) WITH ORDINALITY AS item(code, position)
    GROUP BY item.code
    ORDER BY min(item.position)
  ),
  config_version = config_version + 1,
  updated_at = now()
WHERE enabled = true
  AND onboarding_status = 'ready';

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
    'consumer-refusal',
    'product-shortage',
    'promise-reissue',
    'delivered-address-change'
  ]::text[];

INSERT INTO schema_migrations(version)
VALUES ('301_enable_delivered_address_change.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
