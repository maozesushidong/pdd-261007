BEGIN;

-- A released 12-hour consumer-negotiation follow-up may render a direct
-- refund result. Resume only the PDD continuation after proving that the
-- earlier TMS create and PDD remark effects completed exactly once.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
    AND work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.current_step = 'manual-review-blocked'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) LIKE '%TMS 截图生命周期状态与当前订单不一致%'
    AND work_order.payload->'pddResolutionSubmission'->>'orderNumber'
      = work_order.external_order_number
    AND work_order.payload->'pddResolutionSubmission'->>'status'
      IN ('followup-waiting', 'followup-ready')
    AND work_order.payload->'pddResolutionSubmission'->>'interceptProgressOutcome'
      = '快递还在拦截中'
    AND nullif(
      work_order.payload->'pddResolutionSubmission'->>'consumerResponseWaitStartedAt',
      ''
    ) IS NOT NULL
    AND work_order.payload->'pddResolutionFlow'->>'flowCode' = 'primary-refund'
    AND work_order.payload->'consumerNegotiationFollowupRecovery'->>'strategy'
      = 'resume-pdd-followup-without-oms-or-tms-replay'
    AND (
      work_order.payload->'tmsEvidenceDisposition' IS NULL
      OR (
        work_order.payload->'tmsEvidenceDisposition'->>'orderNumber'
          = work_order.external_order_number
        AND work_order.payload->'tmsEvidenceDisposition'->>'status' = 'deleted'
      )
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-note'
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
    current_step = 'pdd-consumer-negotiation-followup-retry-ready',
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
      - 'pddResolutionDecision'
    ) || jsonb_build_object(
      'step', 'pdd-consumer-negotiation-followup-retry-ready',
      'pddResolutionFlow',
        coalesce(work_order.payload->'pddResolutionFlow', '{}'::jsonb)
          || jsonb_build_object('flowCode', 'consumer-negotiation-followup'),
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'followup-ready',
            'orderNumber', work_order.external_order_number
          ),
      'consumerNegotiationFollowupRecovery',
        coalesce(work_order.payload->'consumerNegotiationFollowupRecovery', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'retry-ready',
            'strategy', 'resume-pdd-followup-without-oms-or-tms-replay',
            'previousReason', candidate.previous_reason,
            'recoveredAt', now()
          ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-consumer-negotiation-followup-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-238',
    'consumer-negotiation-primary-refund-evidence-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', 'resume-pdd-followup-without-oms-or-tms-replay',
      'proof', 'succeeded-tms-create-and-pdd-note-with-no-final-pdd-submit'
    ),
    'migration-238:consumer-negotiation-primary-refund:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-238')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code NOT IN (
      'image-upload-failed',
      'pdd-upload-authorization-failed'
    )
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object('reason', 'automatic-safe-recovery-238')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('238_recover_consumer_negotiation_primary_refund_evidence_pause.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
