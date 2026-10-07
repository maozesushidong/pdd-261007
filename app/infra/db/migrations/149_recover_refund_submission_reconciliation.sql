BEGIN;

-- Submission ambiguity is not a human verification state. Requeue these
-- records for an exact, read-only detail check. A confirmation dialog that was
-- never dispatched is safe to retry; a dispatched confirmation keeps its
-- unknown effect until terminal state or two pending observations prove it did
-- not apply.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, refund.aftersale_status,
    effect.id AS effect_id,
    (coalesce(effect.receipt#>>'{submission,confirmationDispatchStarted}', 'false') = 'true'
      OR coalesce(effect.receipt#>>'{submission,confirmationClicked}', 'false') = 'true')
      AS confirmation_dispatched,
    effect.error AS previous_error
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  JOIN LATERAL (
    SELECT candidate_effect.id, candidate_effect.receipt, candidate_effect.error
    FROM external_effects candidate_effect
    WHERE candidate_effect.work_order_id = work_order.id
      AND candidate_effect.effect_type = 'pdd-return-refund'
      AND candidate_effect.status = 'unknown'
    ORDER BY candidate_effect.reserved_at DESC
    LIMIT 1
  ) effect ON true
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready')
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND refund.action_state = 'verification-required'
    AND refund.detail_url IS NOT NULL
    AND coalesce(effect.error->>'reason', '') IN (
      'pdd-return-refund-exception',
      'pdd-result-not-confirmed',
      'pdd-confirmation-not-dispatched'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects succeeded
      WHERE succeeded.work_order_id = work_order.id
        AND succeeded.effect_type = 'pdd-return-refund'
        AND succeeded.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), released_not_dispatched AS (
  UPDATE external_effects effect
  SET status = 'failed',
    receipt = coalesce(effect.receipt, '{}'::jsonb) || jsonb_build_object(
      'reconciliation', jsonb_build_object(
        'status', 'safe-retry-released',
        'reason', 'confirmation-not-dispatched',
        'releasedAt', now()
      )
    ),
    error = coalesce(effect.error, '{}'::jsonb) || jsonb_build_object(
      'reconciliationReason', 'confirmation-not-dispatched'
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE effect.id = candidate.effect_id
    AND effect.status = 'unknown'
    AND candidate.confirmation_dispatched = false
  RETURNING effect.id
), recovered_refunds AS (
  UPDATE return_refunds refund
  SET action_state = 'page-error',
    decision = 'submission-reconciliation-required',
    risk_level = NULL,
    next_check_at = now(),
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'submissionReconciliationRecovery149', jsonb_build_object(
        'strategy', 'exact-read-only-detail-reconciliation',
        'confirmationDispatched', candidate.confirmation_dispatched,
        'unknownEffectPreserved', candidate.confirmation_dispatched,
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id, candidate.shop_id,
    candidate.external_order_number, candidate.aftersale_number,
    candidate.aftersale_status, candidate.confirmation_dispatched,
    candidate.previous_error
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'waiting',
    current_step = 'return-refund-page-error',
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'exact-read-only-detail-reconciliation',
    classification_updated_at = now(),
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-page-error',
        'submissionReconciliationRecovery149', jsonb_build_object(
          'aftersaleNumber', recovered_refund.aftersale_number,
          'previousStatus', recovered_refund.aftersale_status,
          'previousError', recovered_refund.previous_error,
          'strategy', 'exact-read-only-detail-reconciliation',
          'confirmationDispatched', recovered_refund.confirmation_dispatched,
          'unknownEffectPreserved', recovered_refund.confirmation_dispatched,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered_refunds recovered_refund
  WHERE work_order.id = recovered_refund.work_order_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    recovered_refund.aftersale_number, recovered_refund.aftersale_status,
    recovered_refund.confirmation_dispatched, recovered_refund.previous_error
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
  SELECT recovered.shop_id, recovered.id, 'migration-149',
    'return-refund-submission-reconciliation-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'aftersaleNumber', recovered.aftersale_number,
      'previousStatus', recovered.aftersale_status,
      'previousError', recovered.previous_error,
      'confirmationDispatched', recovered.confirmation_dispatched,
      'unknownEffectPreserved', recovered.confirmation_dispatched,
      'strategy', 'exact-read-only-detail-reconciliation'
    ),
    'migration-149:return-refund-submission-reconciliation:' || recovered.id::text
  FROM recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-149')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

UPDATE scenario_definitions
SET policy_version = greatest(policy_version, 7),
  config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
    'submissionAmbiguityState', 'automatic-read-only-reconciliation',
    'confirmationEnableWaitMs', 30000,
    'dispatchedConfirmationProof', 'two-exact-pending-observations'
  ),
  updated_at = now()
WHERE code = 'return-refund';

INSERT INTO schema_migrations (version)
VALUES ('149_recover_refund_submission_reconciliation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
