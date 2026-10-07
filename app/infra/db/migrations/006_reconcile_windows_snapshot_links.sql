BEGIN;

CREATE TEMP TABLE invalid_snapshot_links ON COMMIT DROP AS
SELECT DISTINCT e.work_order_id
FROM workflow_events e
WHERE e.event_type = 'workflow.snapshot-synchronized'
  AND e.work_order_id IS NOT NULL
  AND e.payload->>'source' = 'snapshot'
  AND nullif(e.payload->'snapshot'->>'orderNumber', '') IS NULL
  AND nullif(e.payload->'snapshot'->'loopState'->>'currentOrderNumber', '') IS NULL;

UPDATE workflow_events e
SET work_order_id = NULL, external_order_number = NULL
FROM invalid_snapshot_links invalid
WHERE e.work_order_id = invalid.work_order_id
  AND e.event_type = 'workflow.snapshot-synchronized'
  AND e.payload->>'source' = 'snapshot';

UPDATE workflow_checkpoints checkpoint
SET work_order_id = NULL, external_order_number = NULL
FROM invalid_snapshot_links invalid
WHERE checkpoint.work_order_id = invalid.work_order_id;

DELETE FROM work_orders work_order
USING invalid_snapshot_links invalid
WHERE work_order.id = invalid.work_order_id
  AND work_order.idempotency_key LIKE 'worker-event:%'
  AND NOT EXISTS (SELECT 1 FROM workflow_events event WHERE event.work_order_id = work_order.id)
  AND NOT EXISTS (SELECT 1 FROM logistics_analyses analysis WHERE analysis.work_order_id = work_order.id)
  AND NOT EXISTS (SELECT 1 FROM oms_analyses analysis WHERE analysis.work_order_id = work_order.id)
  AND NOT EXISTS (SELECT 1 FROM tms_work_orders ticket WHERE ticket.work_order_id = work_order.id)
  AND NOT EXISTS (SELECT 1 FROM evidence_assets evidence WHERE evidence.work_order_id = work_order.id);

COMMIT;
