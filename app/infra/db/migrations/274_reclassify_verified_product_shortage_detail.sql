\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:reclassify-verified-product-shortage-detail-274')
);

INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
VALUES (
  'product-shortage',
  '["商品少发"]'::jsonb,
  1,
  true,
  '{"displayName":"商品少发","displayOrder":100,"requiresPdd":true,"requiresOms":true,"requiresTms":true,"allowAutoSubmit":true}'::jsonb
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
        || ARRAY['product-shortage']::text[]
    ) WITH ORDINALITY AS item(code, position)
    GROUP BY item.code
    ORDER BY min(item.position)
  ),
  config_version = config_version + 1,
  updated_at = now()
WHERE NOT (
  ARRAY['product-shortage']::text[]
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
    'consumer-refusal',
    'product-shortage'
  ]::text[];

-- The rendered PDD detail proves this exact paused row is 商品少发. Reclassify
-- only that verified instance and discard the stale in-transit runtime
-- artifacts. Historical TMS rows stay intact, but the new flow must create or
-- reuse only an independently matched product-shortage verification record.
WITH expected (
  work_order_id,
  ordinary_instance_id,
  shop_id,
  order_number,
  platform_case_id
) AS (
  VALUES (
    '1188c9b9-1aca-4e31-a2f1-45df23e1651e'::uuid,
    '90943530-ff24-4339-9dcc-44110f637cbd'::uuid,
    'shop-mt9vdd44-99aa93'::text,
    '260815-309466315071690'::text,
    '500013063470291'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.work_order_type AS previous_work_order_type,
    work_order.scenario_code AS previous_scenario_code,
    work_order.manual_review_reason AS previous_reason,
    expected.platform_case_id
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.work_order_type = '在途无理由退款处理'
    AND work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key = 'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'in-transit-refund'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE work_order.manual_review_reason =
      'PDD_ORDINARY_DETAIL_TYPE_MISMATCH: 拼多多详情页真实工单类型“商品少发”与当前队列类型“在途无理由退款处理”不一致，已禁止沿用原业务流程'
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), corrected AS (
  UPDATE work_orders work_order
  SET work_order_type = '商品少发',
    scenario_code = 'product-shortage',
    status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'detail-classification-corrected-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      - 'transientWorkflowRecovery'
      - 'pddResolutionDecision'
      - 'pddResolutionFlow'
      - 'pddResolutionSubmission'
      - 'pddCoreOptionLookupFailure'
      - 'pddSubmitButtonLookupFailure'
      - 'pddResolutionDetailReuse'
      - 'pddResolutionDetailRevalidation'
      - 'ordinaryScenarioDecision'
      - 'ordinaryScenarioFacts'
      - 'ordinaryScenarioExecution'
      - 'ordinaryEvidenceUpload'
      - 'logisticsWait'
      - 'logisticsAnalysis'
      - 'omsAnalysis'
      - 'tmsWorkOrder'
      - 'tmsDuplicateCheck'
      - 'tmsFormDecision'
      - 'tmsRoutingDecision'
      - 'tmsEvidenceScreenshot'
      - 'tmsEvidenceDisposition'
      - 'tmsAttachmentTransfer'
      - 'pddEvidenceScreenshot'
    ) || jsonb_build_object(
      'step', 'detail-classification-corrected-retry-ready',
      'workOrderType', '商品少发',
      'scenarioCode', 'product-shortage',
      'pddDetailIdentityCorrection', jsonb_build_object(
        'listWorkOrderType', candidate.previous_work_order_type,
        'listScenarioCode', candidate.previous_scenario_code,
        'detailWorkOrderType', '商品少发',
        'detailScenarioCode', 'product-shortage',
        'source', 'migration-274-exact-detail-revalidation',
        'correctedAt', now()
      ),
      'productShortageRecovery274', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-274',
        'previousReason', candidate.previous_reason,
        'platformCaseId', candidate.platform_case_id,
        'unrelatedHistoricalTmsRecordsPreserved', true,
        'externalActionsReplayedByMigration', false,
        'correctedAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.platform_case_id,
    candidate.previous_work_order_type,
    candidate.previous_scenario_code,
    candidate.previous_reason
), corrected_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET work_order_type = '商品少发',
    scenario_code = 'product-shortage',
    status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'detail-classification-corrected-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = corrected.payload,
    updated_at = now()
  FROM corrected
  WHERE instance.id = corrected.current_ordinary_instance_id
    AND instance.work_order_id = corrected.id
    AND instance.shop_id = corrected.shop_id
  RETURNING corrected.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    corrected.shop_id,
    corrected.id,
    corrected.current_ordinary_instance_id,
    'migration-274',
    'ordinary-detail-classification-corrected',
    jsonb_build_object(
      'orderNumber', corrected.external_order_number,
      'platformCaseId', corrected.platform_case_id,
      'previousWorkOrderType', corrected.previous_work_order_type,
      'previousScenarioCode', corrected.previous_scenario_code,
      'detailWorkOrderType', '商品少发',
      'detailScenarioCode', 'product-shortage',
      'unrelatedHistoricalTmsRecordsPreserved', true,
      'externalActionsReplayedByMigration', false
    ),
    'migration-274:product-shortage-detail:' || corrected.id::text
  FROM corrected_instances corrected
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-274')
  FROM corrected
  WHERE intervention.work_order_id = corrected.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      corrected.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object('reason', 'automatic-safe-reclassification-274')
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS corrected_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS corrected_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('274_reclassify_verified_product_shortage_detail.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
