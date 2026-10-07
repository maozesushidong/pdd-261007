\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:reclassify-delivery-risk-consumer-confirmation-292')
);

-- PDD rejected the exact "logistics recovered" submission because the latest
-- trace still says the parcel cannot be delivered and consumer confirmation is
-- required. Six read-only pending-list observations prove that the failed
-- submission was not applied. Reclassify this one instance as a business
-- manual-review boundary; preserve every external-effect receipt and never
-- replay PDD, OMS, or TMS operations from this migration.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  failed_effect_id,
  failed_effect_stage
) AS (
  VALUES (
    '986a3f8a-94b7-4ef6-9953-2ba4b633ad5e'::uuid,
    'shop-mt9vci3e-20eedf'::text,
    '260828-638341661110347'::text,
    'e1d33f4f-f651-46e1-99be-282fa174044f'::uuid,
    '500013129117919'::text,
    'dfc6b17b-d7a2-462e-a3dd-88d91c1ae2a7'::uuid,
    'ordinary-delivery-risk-concern-delivery-risk-final-logistics-update-confirmed'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    expected.platform_case_id,
    expected.failed_effect_id,
    proof.proof_count
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND work_order.scenario_code <> 'product-shortage'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.recovery_state = 'held'
    AND work_order.recovery_reason = 'external-state-still-uncertain'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
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
    AND instance.scenario_code = 'delivery-risk-concern'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'external-state-unresolved'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text = coalesce(
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}',
      work_order.payload->>'pddIdentityBindingToken'
    )
  JOIN external_effects failed_effect
    ON failed_effect.id = expected.failed_effect_id
    AND failed_effect.work_order_id = work_order.id
    AND failed_effect.shop_id = work_order.shop_id
    AND failed_effect.ordinary_instance_id = instance.id
    AND failed_effect.effect_type = 'pdd-submit'
    AND failed_effect.status = 'failed'
    AND failed_effect.idempotency_key =
      'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.failed_effect_stage
    AND failed_effect.receipt->>'success' = 'false'
    AND failed_effect.receipt->>'clickAttempted' = 'true'
    AND failed_effect.receipt->>'requestCaptured' = 'true'
    AND failed_effect.receipt->>'responseCaptured' = 'true'
    AND failed_effect.receipt->>'errorCode' = '190001'
    AND failed_effect.receipt->>'errorMsg' =
      '该订单物流状态异常，请先和消费者确认'
  JOIN LATERAL (
    SELECT count(*)::int AS proof_count
    FROM audit_events audit
    WHERE audit.work_order_id = work_order.id
      AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND audit.event_type = 'external-state-reconciled'
      AND audit.payload#>>'{pageState,confirmedNotApplied}' = 'true'
      AND audit.payload#>>'{pageState,isPending}' = 'true'
      AND audit.payload#>>'{pageState,orderMatches}' = 'true'
      AND audit.payload#>>'{pageState,isExpectedWorkOrderType}' = 'true'
      AND audit.payload#>>'{pageState,confirmationMethod}' =
        'present-in-pending-list'
  ) proof ON proof.proof_count = 6
  WHERE work_order.manual_review_reason =
      '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'rejected-not-applied'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '2'
    AND work_order.payload#>>'{pddResolutionSubmission,reservationAttemptCount}' = '2'
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.failed_effect_stage
    AND work_order.payload#>>'{platformLogisticsUpdateRejection,errorCode}' = '190001'
    AND work_order.payload#>>'{platformLogisticsUpdateRejection,errorMessage}' =
      '该订单物流状态异常，请先和消费者确认'
    AND work_order.payload#>>'{platformLogisticsUpdateRejection,option}' =
      '物流已恢复更新'
    AND work_order.payload#>>'{platformLogisticsUpdateRejection,responseCaptured}' = 'true'
    AND work_order.payload#>>'{ordinaryScenarioDecision,reasonCode}' =
      'delivery-risk-final-logistics-update-confirmed'
    AND work_order.payload#>>'{ordinaryScenarioDecision,pdd,option}' =
      '物流已恢复更新'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(
        work_order.payload#>'{ordinaryScenarioFacts,shippingLogisticsTimeline}',
        '[]'::jsonb
      )) node
      WHERE node->>'occurredAt' = '2026-09-02 09:32:27'
        AND node->>'text' LIKE '%收件地址不详%'
        AND node->>'text' LIKE '%暂时无法为您配送%'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects note_effect
      WHERE note_effect.work_order_id = work_order.id
        AND note_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND note_effect.effect_type = 'pdd-note'
        AND note_effect.status = 'succeeded'
    )
    AND 1 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'failed'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, failed_effect
), reclassified AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'manual-review-blocked',
    manual_review_reason =
      '流程需要人工复核（阶段: ordinary-scenario-manual-review）：拼多多明确提示当前物流状态异常并要求先与消费者确认，未取得消费者同意前禁止自动提交履约结果',
    next_attempt_at = NULL,
    handling_classification = 'manual',
    classification_source = 'system',
    classification_reason = 'delivery-risk-consumer-confirmation-required',
    classification_updated_at = now(),
    recovery_state = 'held',
    recovery_reason = 'delivery-risk-consumer-confirmation-required',
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'externalStateReconciliation'
      - 'error'
    ) || jsonb_build_object(
      'step', 'manual-review-blocked',
      'ordinaryScenarioDecision', jsonb_build_object(
        'scenarioCode', 'delivery-risk-concern',
        'outcome', 'manual-review',
        'actionCode', 'manual-review',
        'reasonCode', 'delivery-risk-consumer-confirmation-required',
        'reason', '拼多多明确提示当前物流状态异常并要求先与消费者确认，未取得消费者同意前禁止自动提交履约结果',
        'requiredSystems', jsonb_build_array('PDD'),
        'nextAttemptAt', NULL,
        'retryAfterAt', NULL,
        'pdd', NULL,
        'external', NULL,
        'evidence', jsonb_build_object(
          'logistics', coalesce(
            work_order.payload#>'{ordinaryScenarioDecision,evidence,logistics}',
            '{}'::jsonb
          ),
          'latestLogisticsText',
            '【厦门市】您的包裹因收件地址不详，暂时无法为您配送，请及时联系客服',
          'platformLogisticsUpdateRejection',
            work_order.payload->'platformLogisticsUpdateRejection'
        )
      ),
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'rejected-consumer-confirmation-required',
            'automaticRetryAuthorized', false,
            'manualReviewRequired', true,
            'reclassifiedAt', now()
          ),
      'manualReview', jsonb_build_object(
        'status', 'blocked',
        'stage', 'ordinary-scenario-manual-review',
        'reason', '流程需要人工复核（阶段: ordinary-scenario-manual-review）：拼多多明确提示当前物流状态异常并要求先与消费者确认，未取得消费者同意前禁止自动提交履约结果',
        'orderNumber', work_order.external_order_number,
        'blockedAt', now(),
        'lastRetryAt', NULL
      ),
      'deliveryRiskConsumerConfirmation292', jsonb_build_object(
        'status', 'manual-review-blocked',
        'source', 'migration-292',
        'failedEffectId', candidate.failed_effect_id,
        'platformCaseId', candidate.platform_case_id,
        'pendingListProofCount', candidate.proof_count,
        'failedEffectPreserved', true,
        'externalActionsReplayedByMigration', false,
        'reclassifiedAt', now()
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
    work_order.manual_review_reason,
    candidate.previous_reason,
    candidate.failed_effect_id,
    candidate.proof_count
), reclassified_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'manual-review-blocked',
    manual_review_reason = reclassified.manual_review_reason,
    next_attempt_at = NULL,
    payload = reclassified.payload,
    updated_at = now()
  FROM reclassified
  WHERE instance.id = reclassified.current_ordinary_instance_id
    AND instance.work_order_id = reclassified.id
    AND instance.shop_id = reclassified.shop_id
  RETURNING
    reclassified.id,
    reclassified.shop_id,
    reclassified.external_order_number,
    reclassified.current_ordinary_instance_id,
    reclassified.manual_review_reason,
    reclassified.previous_reason,
    reclassified.failed_effect_id,
    reclassified.proof_count
), updated_interventions AS (
  UPDATE manual_interventions intervention
  SET reason = instance.manual_review_reason,
    risk_level = 'high'
  FROM reclassified_instances instance
  WHERE intervention.work_order_id = instance.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = instance.current_ordinary_instance_id
    )
  RETURNING intervention.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    instance.shop_id,
    instance.id,
    instance.current_ordinary_instance_id,
    'migration-292',
    'delivery-risk-consumer-confirmation-reclassified',
    jsonb_build_object(
      'orderNumber', instance.external_order_number,
      'previousReason', instance.previous_reason,
      'reasonCode', 'delivery-risk-consumer-confirmation-required',
      'failedEffectId', instance.failed_effect_id,
      'pendingListProofCount', instance.proof_count,
      'failedEffectPreserved', true,
      'externalActionsReplayedByMigration', false
    ),
    'migration-292:delivery-risk-consumer-confirmation:' || instance.id::text
  FROM reclassified_instances instance
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
)
SELECT count(*) AS reclassified_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS reclassified_orders,
  (SELECT count(*) FROM updated_interventions) AS updated_intervention_count
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('292_reclassify_delivery_risk_consumer_confirmation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
