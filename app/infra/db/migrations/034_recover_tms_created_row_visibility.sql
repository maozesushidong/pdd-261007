BEGIN;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-created-row-recovery-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview')
      || jsonb_build_object(
        'step', 'tms-created-row-recovery-ready',
        'error', NULL,
        'tmsCreatedRowRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'reason', 'created-ticket-list-visibility-delay',
          'ticketId', work_order.payload #>> '{tmsWorkOrder,ticketId}',
          'ticketNo', work_order.payload #>> '{tmsWorkOrder,ticketNo}',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'manual-review-blocked'
    AND work_order.manual_review_reason LIKE '%tms-created-row-verification%'
    AND work_order.payload #>> '{tmsWorkOrder,status}' = 'created'
    AND coalesce(work_order.payload #>> '{tmsWorkOrder,ticketId}', '') <> ''
    AND coalesce(work_order.payload #>> '{tmsWorkOrder,ticketNo}', '') <> ''
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.payload #>> '{tmsWorkOrder,ticketId}' AS ticket_id,
    work_order.payload #>> '{tmsWorkOrder,ticketNo}' AS ticket_no
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-034',
  'tms-created-row-visibility-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'ticketId', recovered.ticket_id,
    'ticketNo', recovered.ticket_no,
    'reason', 'created-ticket-list-visibility-delay'
  ),
  'migration-034:tms-created-row:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-034')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step = 'tms-created-row-recovery-ready'
  AND work_order.payload #>> '{tmsCreatedRowRecovery,reason}' = 'created-ticket-list-visibility-delay';

COMMIT;
