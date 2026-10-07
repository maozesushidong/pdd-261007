BEGIN;

-- A delivery-risk page can expose only a prefilled consumer reply and a
-- submit button. The previous runner required a radio option and recorded a
-- click before one happened. Recover only the inspected order whose pending
-- page proved that both guarded attempts were not applied.
WITH candidate AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    effect.id AS effect_id
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN external_effects effect
    ON effect.id = 'bc4065a4-1986-42ea-a8d3-141b07acb68c'::uuid
    AND effect.work_order_id = work_order.id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'unknown'
    AND (
      effect.ordinary_instance_id IS NULL
      OR effect.ordinary_instance_id = instance.id
    )
  WHERE work_order.external_order_number = '260818-633948127562264'
    AND work_order.shop_id = 'shop-msrd6wm5-1af283'
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,isPending}' = 'true'
    AND work_order.payload#>>'{externalStateReconciliation,automaticRetryExhausted}' = 'true'
    AND work_order.payload#>>'{pddResolutionSubmission,selectedOption}' IS NULL
    AND work_order.payload#>>'{ordinaryPddOptionLookupFailure,frames,0,relevantLines}'
      LIKE '%提交后，此话术将自动发送给消费者%'
    AND work_order.payload#>>'{ordinaryPddOptionLookupFailure,frames,0,relevantLines}'
      LIKE '%消费者咨询物流情况%'
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects succeeded
      WHERE succeeded.work_order_id = work_order.id
        AND succeeded.effect_type = 'pdd-submit'
        AND succeeded.status = 'succeeded'
        AND (
          succeeded.ordinary_instance_id IS NULL
          OR succeeded.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), corrected_effect AS (
  UPDATE external_effects effect
  SET status = 'failed',
    receipt = coalesce(effect.receipt, '{}'::jsonb) || jsonb_build_object(
      'correctedBy', 'migration-168',
      'confirmedNotApplied', true,
      'confirmationMethod', 'two-read-pending-detail-and-prefilled-reply-form',
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
    current_step = 'prefilled-reply-submit-retry-ready',
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
      'step', 'prefilled-reply-submit-retry-ready',
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
            'recoverySource', 'migration-168'
          ),
      'prefilledReplySubmitRecovery', jsonb_build_object(
        'status', 'retry-ready',
        'previousEffectId', corrected_effect.effect_id,
        'confirmedNotApplied', true,
        'recoveredAt', now(),
        'recoverySource', 'migration-168'
      )
    ),
    updated_at = now()
  FROM corrected_effect
  WHERE work_order.id = corrected_effect.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    corrected_effect.effect_id
), recovered_instance AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'prefilled-reply-submit-retry-ready',
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
    'migration-168',
    'prefilled-reply-submit-form-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousEffectId', recovered.effect_id,
      'confirmedNotApplied', true,
      'strategy', 'guarded-prefilled-reply-submit'
    ),
    'migration-168:prefilled-reply-submit:' || recovered.id::text
  FROM recovered_instance recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-168')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('168_recover_prefilled_reply_submit_form.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
