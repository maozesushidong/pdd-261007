BEGIN;

-- Older workers classified every refund-claim exception as verification.
-- Requeue only pre-submit render failures with no external effect and no
-- active challenge. The current worker rereads the exact live detail page.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number,
    work_order.payload #>> '{returnRefundResult,error}' AS previous_error
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status = 'retry-ready'
    AND work_order.current_step = 'return-refund-verification-required'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND refund.action_state = 'verification-required'
    AND coalesce(work_order.payload #>> '{returnRefundResult,error}', '')
      LIKE '%return-refund-detail-load%'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
    )
    AND NOT EXISTS (
      SELECT 1 FROM verification_locations verification
      WHERE verification.work_order_id = work_order.id
        AND verification.status = 'waiting-human'
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered_refunds AS (
  UPDATE return_refunds refund
  SET action_state = 'page-error',
    decision = 'page-error',
    risk_level = 'high',
    next_check_at = now(),
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'renderTimeoutRecovery118', jsonb_build_object(
        'strategy', 'retry-live-detail-without-verification',
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id, candidate.shop_id,
    candidate.external_order_number, candidate.aftersale_number,
    candidate.previous_error
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'waiting',
    current_step = 'return-refund-page-error',
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'retryable-page-error',
    classification_updated_at = now(),
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'step', 'return-refund-page-error',
      'renderTimeoutRecovery118', jsonb_build_object(
        'previousError', recovered_refund.previous_error,
        'strategy', 'retry-live-detail-without-verification',
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM recovered_refunds recovered_refund
  WHERE work_order.id = recovered_refund.work_order_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    recovered_refund.aftersale_number, recovered_refund.previous_error
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-118',
  'return-refund-render-timeout-reclassified',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'previousError', recovered.previous_error,
    'strategy', 'retry-live-detail-without-verification'
  ),
  'migration-118:return-refund-render-timeout:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-118')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND work_order.current_step = 'return-refund-page-error'
    AND work_order.payload ? 'renderTimeoutRecovery118'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
