BEGIN;

UPDATE manual_interventions
SET status = 'resolved',
  resolved_at = coalesce(resolved_at, now()),
  resolved_by = coalesce(resolved_by, 'automatic-operational-state')
WHERE status IN ('open', 'acknowledged')
  AND reason_code IN ('waiting-logistics', 'rate-limited');

WITH duplicate_rows AS (
  SELECT duplicate.id
  FROM work_orders duplicate
  WHERE duplicate.idempotency_key LIKE 'worker-event:%'
    AND duplicate.status <> 'archived'
    AND EXISTS (
      SELECT 1
      FROM work_orders authoritative
      WHERE authoritative.shop_id = duplicate.shop_id
        AND authoritative.external_order_number = duplicate.external_order_number
        AND authoritative.id <> duplicate.id
        AND authoritative.idempotency_key LIKE 'pdd-discovered:%'
    )
), superseded AS (
  UPDATE work_orders work_order
  SET status = 'archived',
    runtime_status = 'archived',
    current_step = 'superseded-duplicate',
    manual_review_reason = NULL,
    payload = work_order.payload || jsonb_build_object(
      'duplicateReconciliation',
      jsonb_build_object('status', 'superseded', 'reconciledAt', now())
    ),
    updated_at = now()
  FROM duplicate_rows duplicate
  WHERE work_order.id = duplicate.id
  RETURNING work_order.id
)
UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'duplicate-reconciliation')
FROM superseded
WHERE intervention.work_order_id = superseded.id
  AND intervention.status IN ('open', 'acknowledged');

COMMIT;
