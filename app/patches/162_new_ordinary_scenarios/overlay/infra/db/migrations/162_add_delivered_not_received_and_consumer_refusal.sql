BEGIN;

INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
VALUES
  (
    'delivered-not-received',
    '["消费者反馈未收到货"]'::jsonb,
    1,
    true,
    '{"displayName":"消费者反馈未收到货","displayOrder":80,"requiresPdd":true,"requiresOms":true,"requiresTms":true,"allowAutoSubmit":true}'::jsonb
  ),
  (
    'consumer-refusal',
    '["消费者拒收问题处理"]'::jsonb,
    1,
    true,
    '{"displayName":"消费者拒收问题处理","displayOrder":90,"requiresPdd":true,"requiresOms":true,"requiresTms":true,"allowAutoSubmit":true}'::jsonb
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
      coalesce(shop.scenario_codes, ARRAY[]::text[]) || ARRAY[
        'delivered-not-received',
        'consumer-refusal'
      ]::text[]
    ) WITH ORDINALITY AS item(code, position)
    GROUP BY item.code
    ORDER BY min(item.position)
  ),
  config_version = config_version + 1,
  updated_at = now()
WHERE NOT (
  ARRAY['delivered-not-received', 'consumer-refusal']::text[]
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
    'intercept-recall',
    'good-deed-expedited-shipping',
    'delivered-not-received',
    'consumer-refusal'
  ]::text[];

INSERT INTO schema_migrations (version)
VALUES ('162_add_delivered_not_received_and_consumer_refusal.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
