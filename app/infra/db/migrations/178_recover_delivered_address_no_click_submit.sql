BEGIN;

-- The legacy delivered-not-received form reserved a PDD submit effect before
-- filling its React-controlled address field. The field was cleared before
-- the submit button was reached, but the old runner still consumed both
-- automatic submit attempts and left the effect unknown. Recover only the
-- inspected instance whose pending page proves the action was not applied.
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
    ON instance.id = '59ca4ce3-4b89-4b18-8e0c-4cf41d12db1d'::uuid
    AND instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN external_effects effect
    ON effect.id = 'a57ed69d-56a0-48b4-a3b8-c354466b3b40'::uuid
    AND effect.work_order_id = work_order.id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'unknown'
    AND (
      effect.receipt IS NULL
      OR jsonb_typeof(effect.receipt) = 'null'
    )
  JOIN manual_interventions intervention
    ON intervention.work_order_id = work_order.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND intervention.reason_code = 'external-system-error'
    AND intervention.reason = '拼多多“/送达地址/”填写后未保持内容'
    AND intervention.status IN ('open', 'acknowledged')
  WHERE work_order.id = 'bb999d89-b55a-46fd-93ad-1ac67992b2ea'::uuid
    AND work_order.shop_id = 'shop-msrd6wm5-1af283'
    AND work_order.external_order_number = '260819-138590349682279'
    AND work_order.scenario_code = 'delivered-not-received'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.manual_review_reason =
      '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对'
    AND work_order.payload #>> '{pddResolutionSubmission,effectStage}' =
      'ordinary-delivered-not-received-confirmation-v1'
    AND work_order.payload #>> '{pddResolutionSubmission,submitAttemptCount}' = '2'
    AND nullif(work_order.payload #>> '{pddResolutionSubmission,lastClickAttemptedAt}', '')
      IS NULL
    AND nullif(instance.payload #>> '{pddResolutionSubmission,lastClickAttemptedAt}', '')
      IS NULL
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,isPending}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,orderMatches}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,pageState,workOrderType}' = '消费者反馈未收到货'
    AND work_order.payload #>>
      '{externalStateReconciliation,effectId}' = effect.id::text
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
        AND tms_effect.receipt #>> '{result,data,ticketId}' = '35304'
        AND tms_effect.receipt #>> '{result,data,ticketNo}' = 'L00035224'
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
      'correctedBy', 'migration-178',
      'clickAttempted', false,
      'confirmedNotApplied', true,
      'confirmationMethod', 'pending-detail-and-not-applied-audit',
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
    current_step = 'ordinary-controlled-field-retry-ready',
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
      'step', 'ordinary-controlled-field-retry-ready',
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          - 'lastClickAttemptedAt'
          - 'externalActionStartedAt'
          - 'notAppliedAt'
          - 'notAppliedRetryAuthorizedAt'
          || jsonb_build_object(
            'status', 'retry-authorized',
            'submitAttemptCount', 0,
            'recoveredAt', now(),
            'recoverySource', 'migration-178'
          ),
      'ordinaryControlledFieldRecovery178', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'react-controlled-field-no-click-retry',
        'previousEffectId', corrected_effect.effect_id,
        'previousReason', corrected_effect.previous_reason,
        'confirmedNotApplied', true,
        'clickAttempted', false,
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
    current_step = 'ordinary-controlled-field-retry-ready',
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
    'migration-178',
    'ordinary-controlled-field-no-click-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousEffectId', recovered.effect_id,
      'previousReason', recovered.previous_reason,
      'confirmedNotApplied', true,
      'clickAttempted', false,
      'strategy', 'react-controlled-field-no-click-retry'
    ),
    'migration-178:ordinary-controlled-field:' || recovered.id::text
  FROM recovered_instance recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-178')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND (
      (
        intervention.reason_code = 'external-system-error'
        AND intervention.reason = '拼多多“/送达地址/”填写后未保持内容'
      )
      OR (
        intervention.reason_code = 'ordinary-manual-review'
        AND intervention.reason = '新增普通工单需要人工处理'
      )
      OR (
        intervention.reason_code = 'pdd-submit-reconciliation-exhausted'
        AND intervention.reason =
          '拼多多提交结果未确认，已达到自动提交上限 2/2，禁止重复提交'
      )
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-controlled-field-recovery-178'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('178_recover_delivered_address_no_click_submit.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
