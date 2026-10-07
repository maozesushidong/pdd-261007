BEGIN;

-- The frame-bound final submit was clicked for these three inspected
-- proactive-logistics work orders, but the old proxy prevented the exact
-- pending-list query from rendering. Requeue only read-only reconciliation;
-- preserve the unknown effect so no business action can be replayed.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  unknown_effect_id,
  retry_effect_stage
) AS (
  VALUES
    (
      'de78db2a-d862-41cc-b032-c68302f2587c'::uuid,
      'shop-msrd6wm5-1af283'::text,
      '260810-655664167331689'::text,
      '21d49d89-d08f-49cb-b633-ec02b9fa40ce'::uuid,
      '500013040430248'::text,
      '55817a27-7a0e-4128-ac12-46ed69a498cd'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics-frame-submit-v3'::text
    ),
    (
      '1cf42c61-d525-4252-8edb-6b0cdc712d9d'::uuid,
      'shop-mse1sff3-b85aa4'::text,
      '260814-043421570680710'::text,
      'a0780021-af1d-4e89-b103-77066638764a'::uuid,
      '500013040654925'::text,
      'c140cee8-4235-49d7-87fb-5c77e36f6a3e'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics-frame-submit-v3'::text
    ),
    (
      'f84e338a-d07c-4d31-b14f-b9bb9be42971'::uuid,
      'panapopo-medical-device'::text,
      '260817-295866274161800'::text,
      '38cdffd5-2da5-4742-9821-bbe779faa88b'::uuid,
      '500013040147422'::text,
      'd396f643-2fd6-4484-aa9c-6e85a027aa7e'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics-frame-submit-v3'::text
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
    expected.unknown_effect_id,
    expected.retry_effect_stage,
    unknown_effect.idempotency_key
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = 'proactive-logistics-service'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.status = 'paused'
    AND instance.detail_url =
      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
        || expected.platform_case_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND nullif(binding.binding_token::text, '') IS NOT NULL
    AND nullif(binding.mall_id, '') IS NOT NULL
  JOIN external_effects unknown_effect
    ON unknown_effect.id = expected.unknown_effect_id
    AND unknown_effect.work_order_id = work_order.id
    AND unknown_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND unknown_effect.effect_type = 'pdd-submit'
    AND unknown_effect.status = 'unknown'
    AND unknown_effect.idempotency_key =
      'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.retry_effect_stage
    AND unknown_effect.receipt->>'clickAttempted' = 'true'
    AND unknown_effect.receipt->>'responseCaptured' = 'false'
  WHERE work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'external-state-unresolved'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.manual_review_reason =
      '拼多多completion-ordinary-list-query-controls刷新后等待 30000 毫秒仍未出现有效结果'
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
      'proactive-logistics-service'
    AND work_order.payload#>>'{pddResolutionSubmission,selectedOption}' =
      '无法确认快递单号'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'submitting'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '3'
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.retry_effect_stage
    AND work_order.payload#>>'{ordinaryPddFrameSubmitRecovery239,status}' =
      'retry-authorized'
    AND work_order.payload#>>'{ordinaryPddFrameSubmitRecovery239,retryEffectStage}' =
      expected.retry_effect_stage
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key LIKE '%:primary'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key LIKE '%:result'
        AND effect.receipt#>>'{result,submitReceipt,success}' = 'true'
    )
    AND 1 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status = 'unknown'
        AND effect.effect_type = 'pdd-submit'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status = 'reserved'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-unresolved',
    manual_review_reason = '等待只读核对拼多多最终提交结果，禁止重复提交',
    next_attempt_at = NULL,
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      - 'externalStateReconciliation'
    ) || jsonb_build_object(
      'step', 'external-state-unresolved',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'submitted-unconfirmed',
            'effectId', candidate.unknown_effect_id,
            'idempotencyKey', candidate.idempotency_key,
            'effectStage', candidate.retry_effect_stage,
            'submitAttemptCount', 3,
            'maximumAutomaticSubmitAttempts', 3
          ),
      'externalStateReconciliationTarget', jsonb_build_object(
        'effectId', candidate.unknown_effect_id,
        'effectType', 'pdd-submit',
        'idempotencyKey', candidate.idempotency_key,
        'status', 'unknown',
        'submitAttemptCount', 3,
        'maximumAutomaticSubmitAttempts', 3
      ),
      'externalStateReconciliationRetry', jsonb_build_object(
        'attempts', 0,
        'maxAttempts', 3,
        'scheduledAt', now(),
        'recoverySource', 'migration-242'
      ),
      'proactiveIframeSubmitReconciliation242', jsonb_build_object(
        'status', 'read-only-reconciliation-ready',
        'strategy', 'observe-pdd-state-without-resubmit',
        'previousReason', candidate.previous_reason,
        'unknownEffectPreserved', true,
        'businessEffectsReplayed', false,
        'scheduledAt', now()
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
    candidate.unknown_effect_id,
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-unresolved',
    manual_review_reason = '等待只读核对拼多多最终提交结果，禁止重复提交',
    next_attempt_at = NULL,
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
     payload, deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-242',
    'proactive-iframe-submit-read-only-reconciliation-scheduled',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'unknownEffectId', recovered.unknown_effect_id,
      'previousReason', recovered.previous_reason,
      'strategy', 'observe-pdd-state-without-resubmit',
      'unknownEffectPreserved', true,
      'businessEffectsReplayed', false
    ),
    'migration-242:proactive-iframe-submit-reconciliation:'
      || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-242')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'external-system-error'
    AND intervention.reason = recovered.previous_reason
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-read-only-reconciliation-recovery-242'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('242_retry_proactive_iframe_submit_reconciliation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
