BEGIN;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-recall-status-recovery-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'pdd-recall-status-recovery-ready',
        'pddRecallStatusRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', 'recall-status-intermediate-form',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'manual-review-blocked'
    AND work_order.manual_review_reason LIKE '%pdd-resolution-submit%'
    AND work_order.manual_review_reason LIKE '%已同意退货退款%'
    AND work_order.payload #>> '{pddResolutionDecision,flowCode}' = 'primary-refund'
    AND coalesce(work_order.payload #>> '{pddResolutionDecision,tmsTicketId}', '') <> ''
    AND coalesce(work_order.payload #>> '{pddResolutionDecision,tmsTicketNo}', '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-037',
  'recent-pdd-recall-status-step-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'reason', 'recall-status-intermediate-form'
  ),
  'migration-037:pdd-recall-status:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-037')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'pdd-recall-status-recovery-ready';

COMMIT;
