BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:archive-confirmed-direct-submit-outcome-text-mismatch-250')
);

-- The target option was accepted by PDD and the detail transitioned to a
-- completed state. A different completed-page lifecycle phrase then tripped
-- the local outcome-text guard. Finalize local state only; never replay a
-- browser action or any OMS/TMS/PDD effect.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  scenario_code,
  selected_outcome,
  completed_page_text,
  submit_effect_stage
) AS (
  VALUES (
    '90e2c59e-2fb9-4639-8065-1ddfacbe8ae3'::uuid,
    'songteng-yazc-overseas'::text,
    '260822-677967378830137'::text,
    '0361652d-48dd-401a-87f5-7768072ab025'::uuid,
    '500013046624206'::text,
    'intercept-recall'::text,
    '消费者已收到货'::text,
    '已同意退货退款'::text,
    'ordinary-intercept-recall-consumer-received-shipment'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.completion_confirmed_at AS completed_at,
    expected.platform_case_id,
    expected.selected_outcome,
    expected.completed_page_text,
    submit_effect.id AS submit_effect_id,
    submit_effect.receipt#>'{result,submitReceipt}' AS submit_receipt
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
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key = 'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects submit_effect
    ON submit_effect.work_order_id = work_order.id
    AND submit_effect.shop_id = work_order.shop_id
    AND submit_effect.ordinary_instance_id = instance.id
    AND submit_effect.effect_type = 'pdd-submit'
    AND submit_effect.status = 'succeeded'
    AND submit_effect.idempotency_key =
      'pdd-submit:' || expected.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.submit_effect_stage
    AND submit_effect.receipt#>>'{result,selectedPddOutcome}' = expected.selected_outcome
    AND submit_effect.receipt#>>'{result,selectedPddOption}' = expected.selected_outcome
    AND submit_effect.receipt#>>'{result,submitClicked}' = 'true'
    AND submit_effect.receipt#>>'{result,submitReceipt,success}' = 'true'
    AND submit_effect.receipt#>>'{result,transitionConfirmed}' = 'true'
  WHERE work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.current_step = 'flow-paused'
    AND work_order.completion_state = 'confirmed'
    AND work_order.completion_confirmation_method = 'detail-completed'
    AND work_order.completion_confirmed_at IS NOT NULL
    AND work_order.recovery_state = 'ready'
    AND work_order.manual_review_reason =
      '当前订单禁止归档和清空进度: completion-outcome-mismatch'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'succeeded'
    AND work_order.payload#>>'{pddResolutionSubmission,outcome}' = expected.selected_outcome
    AND work_order.payload#>>'{pddResolutionSubmission,completionEvidence}' =
      expected.completed_page_text
    AND work_order.payload#>>'{pddResolutionSubmission,confirmationMethod}' =
      'detail-completed'
    AND work_order.payload#>>'{pddEvidenceScreenshot,status}' = 'deleted'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,status}' = 'deleted'
    AND work_order.payload#>>'{tmsEvidenceDisposition,status}' = 'deleted'
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
    )
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
    )
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'evidence-upload'
        AND effect.status = 'succeeded'
    )
    AND 1 = (
      SELECT count(*) FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
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
            'submitClicked', true,
            'submitReceipt', candidate.submit_receipt,
            'transitionConfirmed', true
          ),
      'lastCompletedOrder', jsonb_build_object(
        'orderNumber', work_order.external_order_number,
        'ordinaryInstanceId', work_order.current_ordinary_instance_id,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', candidate.selected_outcome,
        'completedAt', candidate.completed_at,
        'confirmationMethod', 'direct-submit-success-and-transition',
        'recoveredFromCompletedPage', false,
        'archivedAt', now()
      ),
      'completionArchive', jsonb_build_object(
        'shopId', work_order.shop_id,
        'orderNumber', work_order.external_order_number,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', candidate.selected_outcome,
        'confirmationMethod', 'direct-submit-success-and-transition',
        'recoveredFromCompletedPage', false,
        'completedAt', candidate.completed_at,
        'archivedAt', now()
      ),
      'directSubmitOutcomeTextMismatchRecovery250', jsonb_build_object(
        'status', 'archived',
        'source', 'migration-250',
        'selectedOutcome', candidate.selected_outcome,
        'completedPageText', candidate.completed_page_text,
        'submitEffectId', candidate.submit_effect_id,
        'businessEffectsReplayed', false,
        'proof', 'successful-submit-receipt-and-confirmed-page-transition',
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
    candidate.completed_page_text,
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
    completion_method = 'direct-submit-success-and-transition',
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
    'migration-250',
    'confirmed-direct-submit-outcome-text-mismatch-archived',
    jsonb_build_object(
      'orderNumber', archived.external_order_number,
      'platformCaseId', archived.platform_case_id,
      'selectedOutcome', archived.selected_outcome,
      'completedPageText', archived.completed_page_text,
      'submitEffectId', archived.submit_effect_id,
      'completedAt', archived.completed_at,
      'businessEffectsReplayed', false
    ),
    'migration-250:direct-submit-outcome-text-mismatch:' || archived.id::text
  FROM archived_instances archived
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-250')
  FROM archived
  WHERE intervention.work_order_id = archived.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      archived.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'confirmed-direct-submit-finalized-by-migration-250'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('250_archive_confirmed_direct_submit_outcome_text_mismatch.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
