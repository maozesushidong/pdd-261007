BEGIN;

-- This instance was created after migration 179 was packaged. The legacy
-- runner reserved the same PDD effect twice while the decision form was still
-- collapsed, but never reached the submit button. Recover only this inspected
-- instance when both persisted and audit evidence still prove no action was
-- applied. The updated runner opens the decision form before resolving the
-- existing recall-option aliases.
WITH candidate AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    effect.id AS effect_id,
    intervention.reason AS previous_reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = '5453ef58-f065-432c-b547-4951d4aed7c1'::uuid
    AND instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
    AND instance.platform_case_key = 'pdd-work-order:500013005095448'
  JOIN external_effects effect
    ON effect.id = 'd806e5cd-09e8-4641-b829-e31cdb105bdb'::uuid
    AND effect.work_order_id = work_order.id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'unknown'
    AND (effect.receipt IS NULL OR jsonb_typeof(effect.receipt) = 'null')
    AND effect.error->>'message' =
      '拼多多未找到场景选项（已等待 30 秒）: 已进行召回 / 已召回 / 已完成召回 / 已拦截成功'
  JOIN manual_interventions intervention
    ON intervention.work_order_id = work_order.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND intervention.reason_code = 'pdd-submit-reconciliation-exhausted'
    AND intervention.reason =
      '拼多多提交结果未确认，已达到自动提交上限 2/2，禁止重复提交'
    AND (
      intervention.status IN ('open', 'acknowledged')
      OR (
        intervention.status = 'resolved'
        AND nullif(intervention.resolved_by, '') IS NULL
        AND intervention.resolved_at IS NOT NULL
        AND intervention.resolved_at < intervention.created_at
      )
    )
  WHERE work_order.id = '2e2fe5b6-8ba8-4eaa-87f6-06317f3a73b2'::uuid
    AND work_order.shop_id = 'songteng-yazc-overseas'
    AND work_order.external_order_number = '260812-465662133910366'
    AND work_order.scenario_code = 'intercept-recall'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state = 'held'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.manual_review_reason =
      '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对'
    AND work_order.payload #>> '{pddResolutionSubmission,effectStage}' =
      'ordinary-intercept-recall-unsigned-shipment-recalled'
    AND work_order.payload #>> '{pddResolutionSubmission,submitAttemptCount}' = '2'
    AND work_order.payload #>> '{pddResolutionSubmission,selectedOption}' IS NULL
    AND nullif(work_order.payload #>>
      '{pddResolutionSubmission,lastClickAttemptedAt}', '') IS NULL
    AND nullif(instance.payload #>>
      '{pddResolutionSubmission,lastClickAttemptedAt}', '') IS NULL
    AND work_order.payload #>> '{ordinaryScenarioDecision,pdd,option}' = '已进行召回'
    AND work_order.payload #>> '{externalStateReconciliation,effectId}' = effect.id::text
    AND work_order.payload #>>
      '{externalStateReconciliation,automaticRetryExhausted}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,isPending}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,orderMatches}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,confirmationMethod}' =
        'present-in-pending-list'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,workOrderType}' =
        '消费者申请退款后提示拦截'
    AND 2 <= (
      SELECT count(*)
      FROM audit_events audit
      WHERE audit.work_order_id = work_order.id
        AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND audit.event_type = 'external-state-reconciled'
        AND audit.payload->>'effectId' = effect.id::text
        AND audit.payload #>> '{pageState,confirmedNotApplied}' = 'true'
        AND audit.payload #>> '{pageState,isPending}' = 'true'
        AND audit.payload #>> '{pageState,orderMatches}' = 'true'
        AND audit.payload #>> '{pageState,confirmationMethod}' =
          'present-in-pending-list'
        AND audit.payload #>> '{pageState,workOrderType}' =
          '消费者申请退款后提示拦截'
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
        AND audit.payload #>> '{pageState,isPending}' = 'true'
        AND audit.payload #>> '{pageState,orderMatches}' = 'true'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects tms_effect
      WHERE tms_effect.work_order_id = work_order.id
        AND tms_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND tms_effect.effect_type = 'tms-create'
        AND tms_effect.status = 'succeeded'
        AND tms_effect.receipt #>> '{result,data,ticketId}' = '35513'
        AND tms_effect.receipt #>> '{result,data,ticketNo}' = 'L00035433'
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
), corrected_effect AS (
  UPDATE external_effects effect
  SET status = 'failed',
    receipt = CASE
      WHEN effect.receipt IS NULL OR jsonb_typeof(effect.receipt) = 'null'
        THEN '{}'::jsonb
      ELSE effect.receipt
    END || jsonb_build_object(
      'correctedBy', 'migration-187',
      'clickAttempted', false,
      'confirmedNotApplied', true,
      'priorActualSubmitAttemptCount', 0,
      'confirmationMethod', 'repeated-exact-pending-list-observation',
      'correctedAt', now()
    ),
    updated_at = now()
  FROM candidate
  WHERE effect.id = candidate.effect_id
    AND effect.status = 'unknown'
  RETURNING candidate.*
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-recall-option-retry-ready',
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
      'step', 'ordinary-recall-option-retry-ready',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          - 'lastClickAttemptedAt'
          - 'externalActionStartedAt'
          - 'notAppliedAt'
          - 'notAppliedRetryAuthorizedAt'
          || jsonb_build_object(
            'status', 'retry-authorized',
            'submitAttemptCount', 0,
            'maximumAutomaticSubmitAttempts', 2,
            'recoveredAt', now(),
            'recoverySource', 'migration-187'
          ),
      'ordinaryRecallOptionRecovery187', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'open-decision-form-before-recall-option',
        'previousEffectId', corrected_effect.effect_id,
        'previousReason', corrected_effect.previous_reason,
        'confirmedNotApplied', true,
        'clickAttempted', false,
        'priorActualSubmitAttemptCount', 0,
        'recoveredAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM corrected_effect
  WHERE work_order.id = corrected_effect.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    corrected_effect.effect_id,
    corrected_effect.previous_reason
), recovered_instance AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-recall-option-retry-ready',
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
    'migration-187',
    'ordinary-recall-option-no-click-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousEffectId', recovered.effect_id,
      'previousReason', recovered.previous_reason,
      'confirmedNotApplied', true,
      'clickAttempted', false,
      'priorActualSubmitAttemptCount', 0,
      'strategy', 'open-decision-form-before-recall-option'
    ),
    'migration-187:ordinary-recall-option:' || recovered.id::text
  FROM recovered_instance recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = CASE
      WHEN intervention.resolved_at < intervention.created_at THEN now()
      ELSE coalesce(intervention.resolved_at, now())
    END,
    resolved_by = coalesce(intervention.resolved_by, 'migration-187')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND (
      intervention.status IN ('open', 'acknowledged')
      OR (
        intervention.status = 'resolved'
        AND nullif(intervention.resolved_by, '') IS NULL
        AND intervention.resolved_at IS NOT NULL
        AND intervention.resolved_at < intervention.created_at
      )
    )
    AND intervention.reason_code = 'pdd-submit-reconciliation-exhausted'
    AND intervention.reason =
      '拼多多提交结果未确认，已达到自动提交上限 2/2，禁止重复提交'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-recall-option-recovery-187'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('187_recover_late_unclicked_recall_option.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
