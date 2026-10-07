BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.next_attempt_at AS previous_next_attempt_at,
    refund.next_check_at
  FROM work_orders work_order
  JOIN return_refunds refund
    ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE work_order.scenario_code = 'return-refund'
    AND work_order.completion_state = 'pending'
    AND work_order.status IN ('queued', 'retry-ready', 'paused')
    AND work_order.recovery_state <> 'held'
    AND refund.action_state IN (
      'waiting-logistics',
      'verification-required',
      'manual-review',
      'page-error'
    )
    AND refund.next_check_at IS NOT NULL
    AND work_order.next_attempt_at IS DISTINCT FROM refund.next_check_at
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order
), reconciled AS (
  UPDATE work_orders work_order
  SET next_attempt_at = candidate.next_check_at,
    payload = coalesce(work_order.payload, '{}'::jsonb)
      || jsonb_build_object(
        'returnRefundScheduleReconciliation173', jsonb_build_object(
          'status', 'reconciled',
          'source', 'return_refunds.next_check_at',
          'previousNextAttemptAt', candidate.previous_next_attempt_at,
          'nextCheckAt', candidate.next_check_at,
          'reconciledAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT candidate.shop_id,
  candidate.id,
  'migration-173',
  'return-refund-schedule-reconciled',
  jsonb_build_object(
    'orderNumber', candidate.external_order_number,
    'previousNextAttemptAt', candidate.previous_next_attempt_at,
    'nextCheckAt', candidate.next_check_at,
    'source', 'return_refunds.next_check_at'
  ),
  'migration-173:return-refund-schedule:' || candidate.id::text
FROM candidates candidate
JOIN reconciled ON reconciled.id = candidate.id
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.status AS previous_status,
    work_order.current_step AS previous_step,
    work_order.payload->>'shopNameSnapshot' AS observed_shop_name
  FROM work_orders work_order
  WHERE work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('queued', 'retry-ready', 'paused', 'failed')
    AND work_order.completion_state = 'pending'
    AND work_order.current_ordinary_instance_id IS NULL
    AND work_order.idempotency_key LIKE 'pdd-discovered:%'
    AND NOT EXISTS (
      SELECT 1 FROM return_refunds refund
      WHERE refund.work_order_id = work_order.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order
), quarantined AS (
  UPDATE work_orders work_order
  SET status = 'archived',
    runtime_status = 'archived',
    current_step = 'return-refund-orphan-quarantined',
    manual_review_reason = NULL,
    next_attempt_at = NULL,
    completion_state = 'not-applicable',
    completion_confirmation_method = 'legacy-return-refund-orphan-quarantined',
    completion_confirmed_at = now(),
    recovery_state = 'held',
    recovery_reason = 'missing-return-refund-record',
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    frontend_visibility = 'recovery-audit',
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-orphan-quarantined',
        'returnRefundOrphanQuarantine173', jsonb_build_object(
          'status', 'quarantined',
          'reason', 'missing-return-refund-record-and-aftersale-number',
          'previousStatus', candidate.previous_status,
          'previousStep', candidate.previous_step,
          'observedShopName', candidate.observed_shop_name,
          'quarantinedAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
  SELECT candidate.shop_id,
    candidate.id,
    'migration-173',
    'legacy-return-refund-orphan-quarantined',
    jsonb_build_object(
      'orderNumber', candidate.external_order_number,
      'previousStatus', candidate.previous_status,
      'previousStep', candidate.previous_step,
      'observedShopName', candidate.observed_shop_name,
      'reason', 'missing-return-refund-record-and-aftersale-number'
    ),
    'migration-173:return-refund-orphan:' || candidate.id::text
  FROM candidates candidate
  JOIN quarantined ON quarantined.id = candidate.id
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), closed_interventions AS (
  UPDATE manual_interventions intervention
  SET status = 'cancelled',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-173')
  FROM quarantined
  WHERE intervention.work_order_id = quarantined.id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM closed_interventions intervention
WHERE outbox.intervention_id = intervention.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('173_reconcile_return_refund_schedule_and_orphans.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
