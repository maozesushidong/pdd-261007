BEGIN;

-- Resume only the consumer follow-up whose first submission received a
-- definitive HTTP rejection and whose one authorized retry was interrupted
-- before the replacement PDD anchor could be used. Unknown or succeeded
-- external effects remain frozen.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    failed_effect.id AS failed_effect_id
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
  JOIN external_effects failed_effect
    ON failed_effect.work_order_id = work_order.id
    AND failed_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND failed_effect.effect_type = 'pdd-submit'
    AND failed_effect.status = 'failed'
    AND failed_effect.idempotency_key LIKE '%:consumer-negotiation-followup-v1'
    AND failed_effect.receipt->>'success' = 'false'
    AND failed_effect.receipt->>'responseCaptured' = 'true'
    AND failed_effect.receipt->>'clickAttempted' = 'true'
    AND coalesce(failed_effect.receipt->>'httpStatus', '') ~ '^[0-9]+$'
    AND (failed_effect.receipt->>'httpStatus')::integer >= 400
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'paused'
    AND coalesce(work_order.runtime_status, work_order.status) = 'paused'
    AND work_order.current_step = 'external-state-unresolved'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.manual_review_reason = 'pdd 标签页不可用'
    AND instance.status = 'paused'
    AND instance.current_step = 'external-state-unresolved'
    AND instance.manual_review_reason = 'pdd 标签页不可用'
    AND instance.detail_url ~ '^https://mms[.]pinduoduo[.]com/aftersales/work_order/tododetail/?[?]id=[0-9]+'
    AND work_order.payload#>>'{pddResolutionSubmission,flowCode}' =
      'consumer-negotiation-followup'
    AND work_order.payload#>>'{pddResolutionSubmission,notAppliedRetryAuthorizedAt}'
      IS NOT NULL
    AND coalesce(work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}', '')
      ~ '^[0-9]+$'
    AND (work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}')::integer = 1
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.idempotency_key LIKE '%:consumer-negotiation-followup-retry-v2'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-anchor-recovery-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = 'recover-closed-pdd-anchor-before-authorized-retry',
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'pdd-anchor-recovery-retry-ready',
        'pddResolutionSubmission',
          coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'retry-authorized',
            'submitEffectStage', 'consumer-negotiation-followup-retry-v2'
          ),
        'pddAnchorRecovery237', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', 'rebuild-pdd-anchor-and-use-authorized-idempotency-stage',
          'previousReason', candidate.previous_reason,
          'failedEffectId', candidate.failed_effect_id,
          'externalActionsReplayed', false,
          'unknownEffectsRetried', false,
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
    candidate.previous_reason,
    candidate.failed_effect_id
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-anchor-recovery-retry-ready',
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
    'migration-237',
    'pdd-anchor-unavailable-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'failedEffectId', recovered.failed_effect_id,
      'retryStage', 'consumer-negotiation-followup-retry-v2',
      'unknownEffectsRetried', false
    ),
    'migration-237:pdd-anchor-unavailable:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-237')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'external-system-error'
    AND intervention.reason = 'pdd 标签页不可用'
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'pdd-anchor-unavailable-automatic-recovery',
    'migration', '237'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('237_recover_pdd_anchor_unavailable.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;

