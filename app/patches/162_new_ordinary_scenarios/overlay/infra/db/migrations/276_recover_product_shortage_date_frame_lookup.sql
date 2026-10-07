\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-product-shortage-date-frame-lookup-276')
);

-- Recover only the proven pre-submit failure produced by the old main-frame-
-- only date-field lookup. TMS creation and the PDD note remain committed and
-- are reused; no external action is replayed by this migration.
WITH expected (
  shop_id,
  order_number,
  platform_case_id,
  effect_stage
) AS (
  VALUES (
    'shop-mt9vci3e-20eedf'::text,
    '260803-676037998961915'::text,
    '500013072291819'::text,
    'ordinary-product-shortage-verification-request-v1'::text
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
    expected.effect_stage,
    coalesce(
      (work_order.payload#>>'{transientWorkflowRecovery,count}')::integer,
      0
    ) AS previous_retry_count,
    coalesce(
      (work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}')::integer,
      0
    ) AS previous_submit_count,
    coalesce(
      (work_order.payload#>>'{pddResolutionSubmission,reservationAttemptCount}')::integer,
      0
    ) AS previous_reservation_count
  FROM expected
  JOIN work_orders work_order
    ON work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = 'product-shortage'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'product-shortage'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.manual_review_reason LIKE
      'PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE:%未找到%核实时间%输入框%'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'form-retry'
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
      'product-shortage'
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.effect_stage
    AND work_order.payload#>>'{pddResolutionSubmission,outcome}' =
      '去核实，填写核实时间'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '1'
    AND nullif(
      work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}',
      ''
    ) IS NULL
    AND work_order.payload#>>'{pddResolutionSubmission,formFailureConfirmationMethod}' =
      'same-order-pending-editable-before-submit'
    AND work_order.payload#>>'{pddResolutionSubmission,formFailureNotAppliedAt}'
      IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'tms-create:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-product-shortage-verification-v1'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'failed'
        AND effect.idempotency_key =
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id || ':' || expected.effect_stage
        AND effect.receipt->>'clickAttempted' = 'false'
        AND effect.receipt->>'reason' =
          'same-order-pending-editable-before-submit'
        AND effect.receipt#>>'{notAppliedProof,state}' = 'not-applied'
        AND effect.receipt#>>'{notAppliedProof,clickAttempted}' = 'false'
        AND effect.receipt#>>'{notAppliedProof,exactPendingEditableDetail}' =
          'true'
        AND effect.receipt#>>'{notAppliedProof,observedOrderNumber}' =
          expected.order_number
        AND coalesce(
          (effect.receipt#>>'{notAppliedProof,editableControlCount}')::integer,
          0
        ) > 0
        AND effect.error->>'message' LIKE '%未找到%核实时间%输入框%'
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
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
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
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'product-shortage-date-frame-retry-ready',
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
      - 'ordinaryPddDateFieldLookupFailure'
    ) || jsonb_build_object(
      'step', 'product-shortage-date-frame-retry-ready',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          - 'externalActionStartedAt'
          - 'formFailureNotAppliedAt'
          - 'formFailureConfirmationMethod'
          - 'notAppliedAt'
          - 'confirmationMethod'
          || jsonb_build_object(
            'status', 'form-retry',
            'submitAttemptCount', 0,
            'reservationAttemptCount', 0,
            'dateFrameRetryAuthorizedAt', now(),
            'dateFrameRetrySource', 'migration-276'
          ),
      'transientWorkflowRecovery', jsonb_build_object(
        'count', 0,
        'maxAttempts', 6,
        'lastReason', candidate.previous_reason,
        'retryAt', now(),
        'recoveredAt', now(),
        'recoverySource', 'migration-276',
        'previousCount', candidate.previous_retry_count
      ),
      'ordinaryProductShortageDateFrameRecovery276', jsonb_build_object(
        'status', 'retry-ready',
        'orderNumber', work_order.external_order_number,
        'platformCaseId', candidate.platform_case_id,
        'effectStage', candidate.effect_stage,
        'previousReason', candidate.previous_reason,
        'previousRetryCount', candidate.previous_retry_count,
        'previousSubmitCount', candidate.previous_submit_count,
        'previousReservationCount', candidate.previous_reservation_count,
        'confirmedNotApplied', true,
        'externalActionsReplayedByMigration', false,
        'recoveredAt', now()
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
    candidate.effect_stage,
    candidate.previous_reason,
    candidate.previous_retry_count,
    candidate.previous_submit_count,
    candidate.previous_reservation_count
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'product-shortage-date-frame-retry-ready',
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
    'migration-276',
    'product-shortage-date-frame-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'effectStage', recovered.effect_stage,
      'previousReason', recovered.previous_reason,
      'previousRetryCount', recovered.previous_retry_count,
      'previousSubmitCount', recovered.previous_submit_count,
      'previousReservationCount', recovered.previous_reservation_count,
      'confirmedNotApplied', true,
      'externalActionsReplayedByMigration', false
    ),
    'migration-276:product-shortage-date-frame:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING
    work_order_id,
    shop_id,
    payload->>'orderNumber' AS order_number
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-276')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-safe-recovery-276'
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
VALUES ('276_recover_product_shortage_date_frame_lookup.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
