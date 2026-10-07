BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:delivered-contact-date-validation-263')
);

-- The exact inspected submission never reached a PDD business endpoint. Both
-- clicks were rejected in the browser by DatePicker2 validation, and the same
-- verified detail remained pending. Close the unknown effect as not applied
-- and authorize one form-fixed retry without replaying prior external steps.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  unknown_effect_id,
  original_effect_stage
) AS (
  VALUES (
    'be3140d8-166d-4792-ba3d-89d88f23f3c6'::uuid,
    'shop-mse1sff3-b85aa4'::text,
    '260823-585912881472561'::text,
    '1dd0cbdf-32a6-48e5-8771-95cede4c91b2'::uuid,
    '500013050641440'::text,
    '0228b005-eda8-4ac5-85fc-c447b58aa538'::uuid,
    'ordinary-delivered-not-received-delivered-not-received-result-ready'::text
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
    expected.original_effect_stage || '-form-validation-v2' AS retry_effect_stage
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = 'delivered-not-received'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'external-state-unresolved'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
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
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'delivered-not-received'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'external-state-unresolved'
    AND instance.detail_url =
      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
        || expected.platform_case_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
    AND nullif(binding.mall_id, '') IS NOT NULL
  JOIN external_effects unknown_effect
    ON unknown_effect.id = expected.unknown_effect_id
    AND unknown_effect.work_order_id = work_order.id
    AND unknown_effect.shop_id = work_order.shop_id
    AND unknown_effect.ordinary_instance_id = instance.id
    AND unknown_effect.effect_type = 'pdd-submit'
    AND unknown_effect.status = 'unknown'
    AND unknown_effect.idempotency_key =
      'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.original_effect_stage
    AND unknown_effect.receipt->>'clickAttempted' = 'true'
    AND unknown_effect.receipt->>'requestCaptured' = 'false'
    AND unknown_effect.receipt->>'responseCaptured' = 'false'
    AND unknown_effect.receipt->>'transitionConfirmed' = 'false'
    AND unknown_effect.receipt::text LIKE '%btnSubmit.fail%'
    AND unknown_effect.receipt::text LIKE '%DatePicker2%'
  WHERE work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
      'delivered-not-received'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'submitting'
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.original_effect_stage
    AND work_order.payload#>>'{pddResolutionSubmission,selectedOption}' =
      '可以送达'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '2'
    AND work_order.payload#>>'{pddResolutionSubmission,maximumAutomaticSubmitAttempts}' = '2'
    AND work_order.payload#>>'{externalStateReconciliation,effectId}' =
      expected.unknown_effect_id::text
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmedNotApplied}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmationMethod}' =
      'present-in-pending-list'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{externalStateReconciliation,pageState,orderMatches}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,isPending}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,isCompleted}' =
      'false'
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
        AND effect.idempotency_key =
          unknown_effect.idempotency_key || '-form-validation-v2'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, unknown_effect
), corrected_effects AS (
  UPDATE external_effects effect
  SET status = 'failed',
    receipt = coalesce(effect.receipt, '{}'::jsonb) || jsonb_build_object(
      'correctedBy', 'migration-263',
      'confirmedNotApplied', true,
      'confirmationMethod', 'pdd-form-validation-failed-before-business-request',
      'unknownEffectRetried', false,
      'correctedAt', now()
    ),
    error = jsonb_build_object(
      'code', 'PDD_FORM_VALIDATION_REJECTED_CONFIRMED_NOT_APPLIED',
      'message', '预计联系时间为空，拼多多前端校验阻止业务请求',
      'field', 'DatePicker2',
      'confirmedNotApplied', true,
      'correctedBy', 'migration-263'
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
    current_step = 'ordinary-form-validation-retry-ready',
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
      'step', 'ordinary-form-validation-retry-ready',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          - 'externalActionStartedAt'
          - 'lastClickAttemptedAt'
          - 'notAppliedAt'
          - 'notAppliedRetryAuthorizedAt'
          - 'confirmationMethod'
          || jsonb_build_object(
            'status', 'form-validation-retry-authorized',
            'effectStage', corrected.retry_effect_stage,
            'submitAttemptCount', 2,
            'maximumAutomaticSubmitAttempts', 3,
            'formValidationRetryAuthorizedAt', now()
          ),
      'ordinaryPddFormValidationRecovery263', jsonb_build_object(
        'status', 'retry-authorized',
        'source', 'migration-263',
        'orderNumber', work_order.external_order_number,
        'platformCaseId', corrected.platform_case_id,
        'originalEffectId', corrected.unknown_effect_id,
        'originalEffectStage', corrected.original_effect_stage,
        'retryEffectStage', corrected.retry_effect_stage,
        'confirmedNotApplied', true,
        'confirmationMethod',
          'pdd-form-validation-failed-before-business-request',
        'failedField', 'DatePicker2',
        'unknownEffectRetried', false,
        'externalActionsReplayedByMigration', false,
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
    current_step = 'ordinary-form-validation-retry-ready',
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
    'migration-263',
    'delivered-contact-date-validation-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'originalEffectId', recovered.unknown_effect_id,
      'originalEffectStage', recovered.original_effect_stage,
      'retryEffectStage', recovered.retry_effect_stage,
      'confirmedNotApplied', true,
      'failedField', 'DatePicker2',
      'externalActionsReplayedByMigration', false
    ),
    'migration-263:delivered-contact-date-validation:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-263')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'pdd-submit-reconciliation-exhausted'
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-safe-recovery-263'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('263_recover_delivered_contact_date_validation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
