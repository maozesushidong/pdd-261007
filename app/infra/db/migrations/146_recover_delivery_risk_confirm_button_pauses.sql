BEGIN;

-- A newer delivery-risk form commits the selected radio option with a
-- "确认" button. Older workers waited only for "提交" and stopped before any
-- click. Recover only definitively not-applied attempts so existing TMS and
-- PDD-note successes remain reusable and no uncertain submission is repeated.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    submit_effect.id AS submit_effect_id,
    submit_effect.receipt AS submit_receipt
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN LATERAL (
    SELECT effect.*
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.effect_type = 'pdd-submit'
    ORDER BY effect.updated_at DESC
    LIMIT 1
  ) submit_effect ON true
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND work_order.manual_review_reason LIKE
      '拼多多ordinary-delivery-risk-concern-%提交按钮等待 % 秒仍未渲染（可见数量: 0）'
    AND submit_effect.status = 'failed'
    AND submit_effect.receipt->>'reason' = 'submit-button-not-rendered'
    AND submit_effect.receipt->>'clickAttempted' = 'false'
    AND submit_effect.receipt->>'stage' LIKE 'ordinary-delivery-risk-concern-%'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects unresolved
      WHERE unresolved.work_order_id = work_order.id
        AND unresolved.status IN ('reserved', 'unknown')
        AND (
          unresolved.ordinary_instance_id IS NULL
          OR unresolved.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects succeeded_submit
      WHERE succeeded_submit.work_order_id = work_order.id
        AND succeeded_submit.effect_type = 'pdd-submit'
        AND succeeded_submit.status = 'succeeded'
        AND (
          succeeded_submit.ordinary_instance_id IS NULL
          OR succeeded_submit.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'delivery-risk-confirm-button-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'pddResolutionRecovery')
      || jsonb_build_object(
        'step', 'delivery-risk-confirm-button-retry-ready',
        'pddResolutionSubmission', jsonb_build_object(
          'orderNumber', candidate.external_order_number,
          'status', 'render-retry',
          'submitAttemptCount', 0,
          'maximumAutomaticSubmitAttempts', 2,
          'lastFailedEffectId', candidate.submit_effect_id,
          'lastFailureReceipt', candidate.submit_receipt
        ),
        'deliveryRiskConfirmButtonRecovery146', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'strategy', 'accept-form-scoped-confirm-button',
          'preserveSucceededEffects', true,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.previous_reason,
    candidate.submit_effect_id
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'delivery-risk-confirm-button-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.previous_reason,
    recovered.submit_effect_id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-146', 'delivery-risk-confirm-button-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'failedEffectId', recovered.submit_effect_id,
      'strategy', 'accept-form-scoped-confirm-button',
      'preserveSucceededEffects', true
    ),
    'migration-146:delivery-risk-confirm-button:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-146')
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
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('146_recover_delivery_risk_confirm_button_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
