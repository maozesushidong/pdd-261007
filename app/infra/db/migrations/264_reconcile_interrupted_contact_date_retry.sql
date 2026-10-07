BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:interrupted-contact-date-retry-264')
);

-- Migration 263 was claimed by the prior Worker before the form fix was
-- installed. That Worker recorded one click and was then stopped before an
-- outcome receipt was captured. Preserve the click as unknown and schedule a
-- read-only PDD detail reconciliation; this migration performs no resubmit.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  effect_id,
  original_effect_stage,
  retry_effect_stage
) AS (
  VALUES (
    'be3140d8-166d-4792-ba3d-89d88f23f3c6'::uuid,
    'shop-mse1sff3-b85aa4'::text,
    '260823-585912881472561'::text,
    '1dd0cbdf-32a6-48e5-8771-95cede4c91b2'::uuid,
    '500013050641440'::text,
    '0228b005-eda8-4ac5-85fc-c447b58aa538'::uuid,
    'ordinary-delivered-not-received-delivered-not-received-result-ready'::text,
    'ordinary-delivered-not-received-delivered-not-received-result-ready-form-validation-v2'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    expected.platform_case_id,
    expected.effect_id,
    effect.idempotency_key,
    effect.reserved_at,
    work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' AS
      last_click_attempted_at
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = 'delivered-not-received'
    AND work_order.status IN ('processing', 'retry-ready')
    AND work_order.runtime_status IN ('processing', 'retry-ready')
    AND work_order.current_step = 'ordinary-scenario-decision-ready'
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
    AND instance.status IN ('processing', 'retry-ready')
    AND instance.runtime_status IN ('processing', 'retry-ready')
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects effect
    ON effect.id = expected.effect_id
    AND effect.work_order_id = work_order.id
    AND effect.shop_id = work_order.shop_id
    AND effect.ordinary_instance_id = instance.id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'reserved'
    AND effect.receipt IS NULL
    AND effect.error IS NULL
    AND effect.idempotency_key =
      'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.original_effect_stage
  WHERE work_order.payload#>>'{ordinaryPddFormValidationRecovery263,status}' =
      'retry-authorized'
    AND work_order.payload#>>'{ordinaryPddFormValidationRecovery263,source}' =
      'migration-263'
    AND work_order.payload#>>'{ordinaryPddFormValidationRecovery263,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{ordinaryPddFormValidationRecovery263,originalEffectId}' =
      expected.effect_id::text
    AND work_order.payload#>>'{ordinaryPddFormValidationRecovery263,originalEffectStage}' =
      expected.original_effect_stage
    AND work_order.payload#>>'{ordinaryPddFormValidationRecovery263,retryEffectStage}' =
      expected.retry_effect_stage
    AND work_order.payload#>>'{ordinaryPddFormValidationRecovery263,confirmedNotApplied}' =
      'true'
    AND work_order.payload#>>'{ordinaryPddFormValidationRecovery263,unknownEffectRetried}' =
      'false'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'submitting'
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.original_effect_stage
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{pddResolutionSubmission,selectedOption}' =
      '可以送达'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '1'
    AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}'
      IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM audit_events audit
      WHERE audit.work_order_id = work_order.id
        AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND audit.actor_id = 'migration-263'
        AND audit.event_type =
          'delivered-contact-date-validation-retry-ready'
        AND audit.payload->>'originalEffectId' = expected.effect_id::text
        AND audit.payload->>'externalActionsReplayedByMigration' = 'false'
    )
    AND EXISTS (
      SELECT 1 FROM schema_migrations migration
      WHERE migration.version =
        '263_recover_delivered_contact_date_validation.sql'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects other_effect
      WHERE other_effect.work_order_id = work_order.id
        AND other_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND other_effect.id <> expected.effect_id
        AND other_effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, effect
), uncertain_effects AS (
  UPDATE external_effects effect
  SET status = 'unknown',
    receipt = jsonb_build_object(
      'clickAttempted', true,
      'outcomeCaptureInterrupted', true,
      'reconciliationRequired', true,
      'interruptedBy', 'controlled-worker-stop-before-code-deploy',
      'lastClickAttemptedAt', candidate.last_click_attempted_at,
      'scheduledBy', 'migration-264'
    ),
    error = jsonb_build_object(
      'code', 'PDD_SUBMIT_OUTCOME_CAPTURE_INTERRUPTED',
      'message', '点击后结果采集被 Worker 停止打断，必须先只读核对'
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE effect.id = candidate.effect_id
    AND effect.status = 'reserved'
  RETURNING candidate.*
), scheduled AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
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
    ) || jsonb_build_object(
      'step', 'external-state-reconciliation-ready',
      'externalStateReconciliationTarget', jsonb_build_object(
        'effectId', candidate.effect_id,
        'effectType', 'pdd-submit',
        'idempotencyKey', candidate.idempotency_key,
        'status', 'unknown',
        'submitAttemptCount', 1,
        'maximumAutomaticSubmitAttempts', 2,
        'updatedAt', now()
      ),
      'externalStateReconciliationRetry', jsonb_build_object(
        'attempts', 0,
        'maxAttempts', 3,
        'scheduledAt', now(),
        'recoverySource', 'migration-264'
      ),
      'ordinaryPddInterruptedSubmitRecovery264', jsonb_build_object(
        'status', 'read-only-reconciliation-ready',
        'source', 'migration-264',
        'orderNumber', work_order.external_order_number,
        'platformCaseId', candidate.platform_case_id,
        'effectId', candidate.effect_id,
        'lastClickAttemptedAt', candidate.last_click_attempted_at,
        'outcomeUnknown', true,
        'strategy', 'read-only-pdd-detail-before-any-resubmit',
        'externalActionsReplayedByMigration', false,
        'scheduledAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM uncertain_effects candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id,
    work_order.external_order_number, work_order.current_ordinary_instance_id,
    work_order.payload, candidate.platform_case_id, candidate.effect_id
), scheduled_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
    next_attempt_at = now(),
    payload = scheduled.payload,
    updated_at = now()
  FROM scheduled
  WHERE instance.id = scheduled.current_ordinary_instance_id
    AND instance.work_order_id = scheduled.id
    AND instance.shop_id = scheduled.shop_id
  RETURNING scheduled.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    scheduled.shop_id,
    scheduled.id,
    scheduled.current_ordinary_instance_id,
    'migration-264',
    'interrupted-contact-date-retry-read-only-reconciliation-ready',
    jsonb_build_object(
      'orderNumber', scheduled.external_order_number,
      'platformCaseId', scheduled.platform_case_id,
      'effectId', scheduled.effect_id,
      'outcomeUnknown', true,
      'strategy', 'read-only-pdd-detail-before-any-resubmit',
      'externalActionsReplayedByMigration', false
    ),
    'migration-264:interrupted-contact-date-retry:' || scheduled.id::text
  FROM scheduled_instances scheduled
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
)
SELECT count(*) AS scheduled_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS scheduled_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('264_reconcile_interrupted_contact_date_retry.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
