BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:archive-post-submit-reference-error-241')
);

-- This exact ordinary work order completed all business effects, including a
-- confirmed PDD submit, before a local post-submit ReferenceError interrupted
-- progress finalization. Archive from the durable success receipt only; never
-- replay OMS, TMS, note, upload, or submit effects.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  scenario_code,
  submit_effect_stage,
  selected_outcome
) AS (
  VALUES (
    '331818da-a136-4cc1-9cee-bc21f4b9648a'::uuid,
    'shop-mse1sff3-b85aa4'::text,
    '260822-622959061370182'::text,
    '0b4ec484-048a-49f7-9e06-58d45af41038'::uuid,
    '500013044567047'::text,
    'delivered-not-received'::text,
    'ordinary-delivered-not-received-confirmation-v1'::text,
    '告知送达地址并承诺核实'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    expected.platform_case_id,
    expected.selected_outcome,
    submit_effect.id AS submit_effect_id,
    submit_effect.receipt#>'{result,submitReceipt}' AS submit_receipt,
    coalesce(
      nullif(submit_effect.receipt->>'completedAt', '')::timestamptz,
      submit_effect.updated_at
    ) AS completed_at
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = expected.scenario_code
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
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
    AND instance.platform_case_key = 'pdd-work-order:' || expected.platform_case_id
    AND instance.detail_url =
      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
        || expected.platform_case_id
    AND instance.identity_status = 'verified'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
    AND binding.mall_id = coalesce(
      nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
      nullif(work_order.payload->>'pddMallId', '')
    )
  JOIN external_effects submit_effect
    ON submit_effect.work_order_id = work_order.id
    AND submit_effect.shop_id = work_order.shop_id
    AND submit_effect.ordinary_instance_id = instance.id
    AND submit_effect.effect_type = 'pdd-submit'
    AND submit_effect.status = 'succeeded'
    AND submit_effect.idempotency_key =
      'pdd-submit:' || expected.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.submit_effect_stage
    AND submit_effect.receipt#>>'{result,selectedPddOutcome}' =
      expected.selected_outcome
    AND submit_effect.receipt#>>'{result,selectedPddOption}' =
      expected.selected_outcome
    AND submit_effect.receipt#>>'{result,submitClicked}' = 'true'
    AND submit_effect.receipt#>>'{result,submitReceipt,success}' = 'true'
    AND submit_effect.receipt#>>'{result,transitionConfirmed}' = 'true'
    AND nullif(submit_effect.receipt->>'completedAt', '') IS NOT NULL
  WHERE work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.manual_review_reason = 'retryAuthorized is not defined'
    AND instance.manual_review_reason = 'retryAuthorized is not defined'
    AND work_order.payload->>'error' = 'retryAuthorized is not defined'
    AND work_order.payload#>>'{latestDiscovery,platformCaseId}' =
      expected.platform_case_id
    AND work_order.payload#>>'{latestDiscovery,actualShopName}' =
      shop.expected_shop_name
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
      expected.scenario_code
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.submit_effect_stage
    AND work_order.payload#>>'{pddResolutionSubmission,outcome}' =
      expected.selected_outcome
    AND work_order.payload#>>'{pddResolutionSubmission,selectedOption}' =
      expected.selected_outcome
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'submitting'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '1'
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
    )
    AND 1 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
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
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, submit_effect
), archived AS (
  UPDATE work_orders work_order
  SET status = 'archived',
    runtime_status = 'archived',
    current_step = 'requested-order-complete',
    manual_review_reason = NULL,
    next_attempt_at = NULL,
    completion_state = 'confirmed',
    completion_confirmation_method = 'pdd-submit-success-receipt',
    completion_confirmed_at = candidate.completed_at,
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
    ) || jsonb_build_object(
      'step', 'requested-order-complete',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'succeeded',
            'outcome', candidate.selected_outcome,
            'selectedOption', candidate.selected_outcome,
            'submitClicked', true,
            'submitReceipt', candidate.submit_receipt,
            'transitionConfirmed', true,
            'confirmationMethod', 'pdd-submit-success-receipt',
            'recoveredFromCompletedPage', false,
            'completedAt', candidate.completed_at
          ),
      'lastCompletedOrder', jsonb_build_object(
        'orderNumber', work_order.external_order_number,
        'ordinaryInstanceId', work_order.current_ordinary_instance_id,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', candidate.selected_outcome,
        'completedAt', candidate.completed_at,
        'confirmationMethod', 'pdd-submit-success-receipt',
        'recoveredFromCompletedPage', false,
        'archivedAt', now()
      ),
      'completionArchive', jsonb_build_object(
        'shopId', work_order.shop_id,
        'orderNumber', work_order.external_order_number,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', candidate.selected_outcome,
        'confirmationMethod', 'pdd-submit-success-receipt',
        'recoveredFromCompletedPage', false,
        'completedAt', candidate.completed_at,
        'archivedAt', now()
      ),
      'ordinaryPostSubmitReferenceErrorRecovery241', jsonb_build_object(
        'status', 'archived',
        'source', 'migration-241',
        'technicalError', 'retryAuthorized is not defined',
        'submitEffectId', candidate.submit_effect_id,
        'businessEffectsReplayed', false,
        'proof', 'single-succeeded-pdd-submit-with-success-receipt-and-confirmed-transition',
        'archivedAt', now()
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
    candidate.selected_outcome,
    candidate.submit_effect_id,
    candidate.completed_at
), archived_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'archived',
    runtime_status = 'archived',
    current_step = 'requested-order-complete',
    manual_review_reason = NULL,
    next_attempt_at = NULL,
    completed_at = archived.completed_at,
    completion_method = 'pdd-submit-success-receipt',
    payload = archived.payload,
    updated_at = now()
  FROM archived
  WHERE instance.id = archived.current_ordinary_instance_id
    AND instance.work_order_id = archived.id
    AND instance.shop_id = archived.shop_id
  RETURNING archived.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    archived.shop_id,
    archived.id,
    archived.current_ordinary_instance_id,
    'migration-241',
    'ordinary-post-submit-reference-error-archived',
    jsonb_build_object(
      'orderNumber', archived.external_order_number,
      'platformCaseId', archived.platform_case_id,
      'outcome', archived.selected_outcome,
      'submitEffectId', archived.submit_effect_id,
      'completedAt', archived.completed_at,
      'confirmationMethod', 'pdd-submit-success-receipt',
      'businessEffectsReplayed', false,
      'technicalError', 'retryAuthorized is not defined'
    ),
    'migration-241:post-submit-reference-error:' || archived.id::text
  FROM archived_instances archived
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-241')
  FROM archived
  WHERE intervention.work_order_id = archived.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      archived.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'external-system-error'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'successful-business-submit-finalized-by-migration-241'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('241_archive_post_submit_reference_error.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
