BEGIN;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'transient-state-reconciliation')
WHERE intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN ('verification-required', 'login-required')
  AND NOT EXISTS (
    SELECT 1
    FROM verification_locations verification
    WHERE verification.shop_id = intervention.shop_id
      AND verification.status IN ('detected', 'waiting-human', 'verification-required')
  );

WITH retryable AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'browser-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = (work_order.payload - 'error' - 'manualReview') || jsonb_build_object(
      'browserRecovery',
      jsonb_build_object(
        'count', coalesce((work_order.payload->'browserRecovery'->>'count')::int, 0) + 1,
        'lastReason', coalesce(
          work_order.payload->'error'->>'message',
          work_order.payload->>'error',
          work_order.manual_review_reason
        ),
        'retryAt', now()
      )
    ),
    updated_at = now()
  WHERE work_order.status IN ('paused', 'failed')
    AND work_order.updated_at >= now() - interval '6 hours'
    AND coalesce(
      work_order.payload->'error'->>'message',
      work_order.payload->>'error',
      work_order.manual_review_reason,
      ''
    ) ~* 'Target page, context or browser has been closed|Target.createTarget|Failed to open a new tab|browserContext.newPage'
  RETURNING work_order.id
)
UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'browser-retry-reconciliation')
FROM retryable
WHERE intervention.work_order_id = retryable.id
  AND intervention.status IN ('open', 'acknowledged');

COMMIT;
