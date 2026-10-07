BEGIN;

-- The legacy ordinary runner incremented submitAttemptCount when it reserved
-- an effect, before the form reached the submit button. Recover the two
-- inspected second reservations that started after the last real click and
-- whose exact pending-list observations prove the action was not applied.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  effect_id,
  scenario_code,
  effect_stage,
  work_order_type,
  requires_exact_detail
) AS (
  VALUES
    (
      '22821432-6eb1-4b00-9d72-84740f1fb621'::uuid,
      'shop-mse1sff3-b85aa4'::text,
      '260812-150177062531564'::text,
      '9089b21c-828d-454b-afe3-aa1b8939e0c4'::uuid,
      '6a265257-b9f7-4ae3-91c3-878ecadb5238'::uuid,
      'proactive-logistics-service'::text,
      'ordinary-proactive-logistics-service-return-logistics-not-found-within-48-hours'::text,
      '物流异常主动服务'::text,
      true
    ),
    (
      'ebb7567e-700f-4903-a6b0-6150f69f2162'::uuid,
      'panapopo-healthcare'::text,
      '260819-168485230092969'::text,
      '058bc66d-a2d9-474c-9065-9ae788c4ab39'::uuid,
      '280c0ec1-7169-4467-b002-54ddd459122c'::uuid,
      'delivery-risk-concern'::text,
      'ordinary-delivery-risk-concern-platform-rejected-logistics-update-requires-reminder'::text,
      '消费者担忧货物无法送达'::text,
      false
    )
), candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    effect.id AS effect_id,
    expected.scenario_code,
    expected.effect_stage,
    expected.work_order_type
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = expected.scenario_code
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN external_effects effect
    ON effect.id = expected.effect_id
    AND effect.work_order_id = work_order.id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'unknown'
    AND (
      effect.receipt IS NULL
      OR jsonb_typeof(effect.receipt) = 'null'
    )
  WHERE work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.manual_review_reason =
      '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对'
    AND work_order.payload #>> '{pddResolutionSubmission,effectStage}' =
      expected.effect_stage
    AND work_order.payload #>> '{pddResolutionSubmission,submitAttemptCount}' = '2'
    AND work_order.payload #>> '{pddResolutionSubmission,externalActionStartedAt}'
      IS NOT NULL
    AND abs(extract(epoch FROM (
      (work_order.payload #>>
        '{pddResolutionSubmission,externalActionStartedAt}')::timestamptz
      - effect.reserved_at
    ))) < 2
    AND (
      nullif(work_order.payload #>>
        '{pddResolutionSubmission,lastClickAttemptedAt}', '') IS NULL
      OR (work_order.payload #>>
        '{pddResolutionSubmission,lastClickAttemptedAt}')::timestamptz
          < effect.reserved_at
    )
    AND (
      nullif(instance.payload #>>
        '{pddResolutionSubmission,lastClickAttemptedAt}', '') IS NULL
      OR (instance.payload #>>
        '{pddResolutionSubmission,lastClickAttemptedAt}')::timestamptz
          < effect.reserved_at
    )
    AND work_order.payload #>>
      '{externalStateReconciliation,effectId}' = effect.id::text
    AND work_order.payload #>>
      '{externalStateReconciliation,automaticRetryExhausted}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,confirmationMethod}' =
        'present-in-pending-list'
    AND (
      expected.requires_exact_detail = false
      OR (
        work_order.payload #>>
          '{externalStateReconciliation,pageState,isPending}' = 'true'
        AND work_order.payload #>>
          '{externalStateReconciliation,pageState,orderMatches}' = 'true'
        AND work_order.payload #>>
          '{externalStateReconciliation,pageState,workOrderType}' =
            expected.work_order_type
      )
    )
    AND EXISTS (
      SELECT 1
      FROM audit_events audit
      WHERE audit.work_order_id = work_order.id
        AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND audit.event_type = 'external-state-reconciled'
        AND audit.payload->>'state' = 'not-applied'
        AND audit.payload->>'effectId' = effect.id::text
        AND audit.payload #>> '{pageState,confirmedNotApplied}' = 'true'
        AND audit.payload #>> '{pageState,confirmationMethod}' =
          'present-in-pending-list'
    )
    AND 2 <= (
      SELECT count(*)
      FROM audit_events audit
      WHERE audit.work_order_id = work_order.id
        AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND audit.event_type = 'external-state-reconciled'
        AND audit.payload->>'effectId' = effect.id::text
        AND audit.payload #>> '{pageState,confirmedNotApplied}' = 'true'
        AND audit.payload #>> '{pageState,confirmationMethod}' =
          'present-in-pending-list'
    )
    AND EXISTS (
      SELECT 1
      FROM manual_interventions intervention
      WHERE intervention.work_order_id = work_order.id
        AND intervention.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND intervention.status IN ('open', 'acknowledged')
        AND intervention.reason_code = 'pdd-submit-reconciliation-exhausted'
        AND intervention.reason =
          '拼多多提交结果未确认，已达到自动提交上限 2/2，禁止重复提交'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects other_effect
      WHERE other_effect.work_order_id = work_order.id
        AND other_effect.id <> effect.id
        AND other_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND other_effect.effect_type = 'pdd-submit'
        AND other_effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, effect
), corrected_effects AS (
  UPDATE external_effects effect
  SET status = 'failed',
    receipt = CASE
      WHEN effect.receipt IS NULL OR jsonb_typeof(effect.receipt) = 'null'
        THEN '{}'::jsonb
      ELSE effect.receipt
    END || jsonb_build_object(
      'correctedBy', 'migration-179',
      'clickAttempted', false,
      'confirmedNotApplied', true,
      'priorActualSubmitAttemptCount', 1,
      'confirmationMethod', 'repeated-exact-pending-list-observation',
      'correctedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE effect.id = candidate.effect_id
    AND effect.status = 'unknown'
  RETURNING candidate.*
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-unclicked-attempt-refunded-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      - 'externalStateReconciliation'
      - 'externalStateReconciliationRetry'
      - 'externalStateReconciliationTarget'
    ) || jsonb_build_object(
      'step', 'ordinary-unclicked-attempt-refunded-retry-ready',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          - 'externalActionStartedAt'
          - 'notAppliedAt'
          - 'notAppliedRetryAuthorizedAt'
          || jsonb_build_object(
            'status', 'retry-authorized',
            'submitAttemptCount', 1,
            'maximumAutomaticSubmitAttempts', 2,
            'recoveredAt', now(),
            'recoverySource', 'migration-179'
          ),
      'ordinaryUnclickedAttemptRecovery179', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'refund-legacy-unclicked-second-attempt',
        'previousEffectId', corrected_effect.effect_id,
        'confirmedNotApplied', true,
        'currentReservationClickAttempted', false,
        'priorActualSubmitAttemptCount', 1,
        'recoveredAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM corrected_effects corrected_effect
  WHERE work_order.id = corrected_effect.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    corrected_effect.effect_id
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-unclicked-attempt-refunded-retry-ready',
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
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-179',
    'ordinary-legacy-unclicked-attempt-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousEffectId', recovered.effect_id,
      'confirmedNotApplied', true,
      'currentReservationClickAttempted', false,
      'priorActualSubmitAttemptCount', 1,
      'strategy', 'refund-legacy-unclicked-second-attempt'
    ),
    'migration-179:ordinary-unclicked-attempt:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-179')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      (
        intervention.reason_code = 'pdd-submit-reconciliation-exhausted'
        AND intervention.reason =
          '拼多多提交结果未确认，已达到自动提交上限 2/2，禁止重复提交'
      )
      OR (
        intervention.reason_code = 'manual-review-required'
        AND intervention.reason IN (
          '缺少订单号或工单详情标志',
          '流程需要人工复核（阶段: pdd-resolution-detail-loading）：缺少订单号或工单详情标志'
        )
      )
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-unclicked-attempt-recovery-179'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('179_recover_legacy_unclicked_second_submit_attempts.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
