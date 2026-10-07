\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:enable-product-shortage-and-promise-reissue-297')
);

-- The later business decision re-enabled both 商品少发 branches. Keep the
-- catalog and the worker's file configuration in agreement.
UPDATE scenario_definitions
SET config = coalesce(config, '{}'::jsonb)
  || jsonb_build_object('processingEnabled', true),
  updated_at = now()
WHERE code = 'product-shortage';

INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
VALUES (
  'promise-reissue',
  '["承诺补寄", "承诺补寄工单"]'::jsonb,
  1,
  true,
  jsonb_build_object(
    'displayName', '承诺补寄',
    'displayOrder', 110,
    'processingEnabled', true,
    'requiresPdd', true,
    'requiresOms', true,
    'requiresTms', false,
    'allowAutoSubmit', true
  )
)
ON CONFLICT (code) DO UPDATE SET
  title_patterns = EXCLUDED.title_patterns,
  policy_version = greatest(scenario_definitions.policy_version, EXCLUDED.policy_version),
  enabled = true,
  config = coalesce(scenario_definitions.config, '{}'::jsonb)
    || EXCLUDED.config,
  updated_at = now();

UPDATE shops
SET scenario_codes = ARRAY(
    SELECT item.code
    FROM unnest(
      coalesce(scenario_codes, ARRAY[]::text[])
        || ARRAY['product-shortage', 'promise-reissue']::text[]
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
    'promise-reissue'
  ]::text[];

WITH eligible AS MATERIALIZED (
  SELECT w.id, w.shop_id, w.external_order_number,
    w.current_ordinary_instance_id
  FROM work_orders w
  JOIN ordinary_work_order_instances i
    ON i.id = w.current_ordinary_instance_id
   AND i.work_order_id = w.id
   AND i.shop_id = w.shop_id
   AND i.scenario_code = 'product-shortage'
   AND i.status = 'paused'
   AND i.runtime_status = 'paused'
   AND i.current_step = 'business-rule-paused-product-shortage'
   AND i.identity_status = 'verified'
  WHERE w.scenario_code = 'product-shortage'
    AND w.status = 'paused'
    AND w.runtime_status = 'paused'
    AND w.current_step = 'business-rule-paused-product-shortage'
    AND w.recovery_state = 'held'
    AND w.recovery_reason = 'business-rule-processing-disabled'
    AND coalesce(w.completion_state, 'pending') = 'pending'
    AND coalesce(w.frontend_visibility, 'operational') = 'operational'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects e
      WHERE e.work_order_id = w.id
        AND e.ordinary_instance_id IS NOT DISTINCT FROM i.id
        AND e.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects e
      WHERE e.work_order_id = w.id
        AND e.ordinary_instance_id IS NOT DISTINCT FROM i.id
        AND e.effect_type = 'pdd-submit'
        AND e.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.shop_id = w.shop_id
        AND runtime.current_work_order_id = w.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF w, i
), resumed AS (
  UPDATE work_orders w
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'product-shortage-processing-reenabled',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'product-shortage-processing-enabled',
    classification_updated_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(w.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = coalesce(w.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      || jsonb_build_object(
        'productShortageProcessingReenabled', jsonb_build_object(
          'source', 'migration-297',
          'externalActionsReplayed', false,
          'resumedAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM eligible
  WHERE w.id = eligible.id
  RETURNING w.id, w.shop_id, w.current_ordinary_instance_id,
    w.external_order_number, w.payload
), resumed_instances AS (
  UPDATE ordinary_work_order_instances i
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'product-shortage-processing-reenabled',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = resumed.payload,
    updated_at = now()
  FROM resumed
  WHERE i.id = resumed.current_ordinary_instance_id
    AND i.work_order_id = resumed.id
    AND i.shop_id = resumed.shop_id
  RETURNING resumed.id, resumed.shop_id, resumed.external_order_number,
    resumed.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT shop_id, id, current_ordinary_instance_id, 'system',
  'product-shortage-automatic-processing-resumed',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', 'business-rule-processing-enabled',
    'externalActionsReplayed', false,
    'resumedAt', now()
  ),
  'product-shortage-automatic-processing-resumed:' || id::text
FROM resumed_instances
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('297_enable_product_shortage_and_promise_reissue.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
