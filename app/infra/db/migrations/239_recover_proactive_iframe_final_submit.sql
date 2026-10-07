BEGIN;

-- Three inspected proactive-logistics work orders completed their first two
-- PDD stages, but the legacy final click targeted an unrelated main-document
-- submit button while the selected result lived in a child frame. Six exact
-- pending-detail reconciliations prove each final action was not applied.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  unknown_effect_id,
  original_effect_stage
) AS (
  VALUES
    (
      'de78db2a-d862-41cc-b032-c68302f2587c'::uuid,
      'shop-msrd6wm5-1af283'::text,
      '260810-655664167331689'::text,
      '21d49d89-d08f-49cb-b633-ec02b9fa40ce'::uuid,
      '500013040430248'::text,
      'fe7d0783-6573-430f-af9e-b57b8ed455b1'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics'::text
    ),
    (
      '1cf42c61-d525-4252-8edb-6b0cdc712d9d'::uuid,
      'shop-mse1sff3-b85aa4'::text,
      '260814-043421570680710'::text,
      'a0780021-af1d-4e89-b103-77066638764a'::uuid,
      '500013040654925'::text,
      'f5a1b8bf-4573-4374-b087-65ff1bfff175'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics'::text
    ),
    (
      'f84e338a-d07c-4d31-b14f-b9bb9be42971'::uuid,
      'panapopo-medical-device'::text,
      '260817-295866274161800'::text,
      '38cdffd5-2da5-4742-9821-bbe779faa88b'::uuid,
      '500013040147422'::text,
      '4c114291-f354-4ff6-918a-19fc793b09d6'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics'::text
    )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    expected.platform_case_id,
    expected.unknown_effect_id,
    expected.original_effect_stage,
    expected.original_effect_stage || '-frame-submit-v3' AS retry_effect_stage
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
    AND instance.detail_url =
      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
        || expected.platform_case_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
  JOIN external_effects unknown_effect
    ON unknown_effect.id = expected.unknown_effect_id
    AND unknown_effect.work_order_id = work_order.id
    AND unknown_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND unknown_effect.effect_type = 'pdd-submit'
    AND unknown_effect.status = 'unknown'
    AND unknown_effect.idempotency_key =
      'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.original_effect_stage
    AND unknown_effect.receipt->>'clickAttempted' = 'true'
    AND unknown_effect.receipt->>'responseCaptured' = 'false'
  WHERE work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.manual_review_reason =
      '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对'
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
      'proactive-logistics-service'
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.original_effect_stage
    AND work_order.payload#>>'{pddResolutionSubmission,selectedOption}' =
      '无法确认快递单号'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '2'
    AND work_order.payload#>>'{externalStateReconciliation,effectId}' =
      expected.unknown_effect_id::text
    AND work_order.payload#>>'{externalStateReconciliation,automaticRetryExhausted}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,isPending}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,orderMatches}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,isExpectedWorkOrderType}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,workOrderStatus}' = '待处理'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,workOrderType}' =
      '物流异常主动服务'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmationMethod}' =
      'present-in-pending-list'
    AND EXISTS (
      SELECT 1
      FROM external_effects primary_effect
      WHERE primary_effect.work_order_id = work_order.id
        AND primary_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND primary_effect.effect_type = 'pdd-submit'
        AND primary_effect.status = 'succeeded'
        AND primary_effect.idempotency_key LIKE '%:primary'
        AND primary_effect.receipt#>>'{result,selectedPddOption}' =
          '未收到退回的商品'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects result_effect
      WHERE result_effect.work_order_id = work_order.id
        AND result_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND result_effect.effect_type = 'pdd-submit'
        AND result_effect.status = 'succeeded'
        AND result_effect.idempotency_key LIKE '%:result'
        AND result_effect.receipt#>>'{result,selectedPddOption}' =
          '未查到退货物流轨迹'
        AND result_effect.receipt#>>'{result,submitReceipt,success}' = 'true'
        AND result_effect.receipt#>>'{result,submitReceipt,requestUrl}' =
          'https://mms.pinduoduo.com/latitude/mallTicket/submitForm'
    )
    AND 6 <= (
      SELECT count(*)
      FROM audit_events audit
      WHERE audit.work_order_id = work_order.id
        AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND audit.event_type = 'external-state-reconciled'
        AND audit.payload->>'effectId' = expected.unknown_effect_id::text
        AND audit.payload#>>'{pageState,confirmedNotApplied}' = 'true'
        AND audit.payload#>>'{pageState,confirmationMethod}' =
          'present-in-pending-list'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.id <> expected.unknown_effect_id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.idempotency_key LIKE '%-frame-submit-v3'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, unknown_effect
), corrected_effects AS (
  UPDATE external_effects effect
  SET status = 'failed',
    receipt = coalesce(effect.receipt, '{}'::jsonb) || jsonb_build_object(
      'correctedBy', 'migration-239',
      'confirmedNotApplied', true,
      'confirmationMethod', 'six-exact-pending-detail-observations',
      'unknownEffectRetried', false,
      'correctedAt', now()
    ),
    error = jsonb_build_object(
      'code', 'PDD_WRONG_DOCUMENT_SUBMIT_CONFIRMED_NOT_APPLIED',
      'message', '所选结果位于子框架，旧实现未点击同框架业务提交按钮',
      'confirmedNotApplied', true,
      'correctedBy', 'migration-239'
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE effect.id = candidate.unknown_effect_id
    AND effect.status = 'unknown'
  RETURNING candidate.*
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-frame-submit-retry-ready',
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
      - 'externalStateReconciliation'
      - 'externalStateReconciliationRetry'
      - 'externalStateReconciliationTarget'
    ) || jsonb_build_object(
      'step', 'ordinary-frame-submit-retry-ready',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          - 'externalActionStartedAt'
          - 'lastClickAttemptedAt'
          - 'notAppliedAt'
          - 'notAppliedRetryAuthorizedAt'
          - 'confirmationMethod'
          || jsonb_build_object(
            'status', 'frame-submit-retry-authorized',
            'effectStage', corrected.retry_effect_stage,
            'submitAttemptCount', 2,
            'maximumAutomaticSubmitAttempts', 3,
            'frameSubmitRetryAuthorizedAt', now()
          ),
      'ordinaryPddFrameSubmitRecovery239', jsonb_build_object(
        'status', 'retry-authorized',
        'source', 'migration-239',
        'orderNumber', work_order.external_order_number,
        'platformCaseId', corrected.platform_case_id,
        'originalEffectId', corrected.unknown_effect_id,
        'originalEffectStage', corrected.original_effect_stage,
        'retryEffectStage', corrected.retry_effect_stage,
        'confirmedNotApplied', true,
        'proofCount', 6,
        'unknownEffectRetried', false,
        'strategy', 'select-and-submit-in-the-same-pdd-frame',
        'authorizedAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM corrected_effects corrected
  WHERE work_order.id = corrected.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    corrected.platform_case_id,
    corrected.unknown_effect_id,
    corrected.original_effect_stage,
    corrected.retry_effect_stage
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-frame-submit-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-239',
    'ordinary-proactive-iframe-final-submit-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'originalEffectId', recovered.unknown_effect_id,
      'originalEffectStage', recovered.original_effect_stage,
      'retryEffectStage', recovered.retry_effect_stage,
      'confirmedNotApplied', true,
      'proofCount', 6,
      'unknownEffectRetried', false,
      'strategy', 'select-and-submit-in-the-same-pdd-frame'
    ),
    'migration-239:ordinary-proactive-iframe-final-submit:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-239')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'external-system-error'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object('reason', 'automatic-safe-recovery-239')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('239_recover_proactive_iframe_final_submit.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
