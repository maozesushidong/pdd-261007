UPDATE manual_interventions intervention
SET status = 'resolved', resolved_at = coalesce(intervention.resolved_at, work_order.updated_at),
  resolved_by = coalesce(intervention.resolved_by, 'migration-reconciliation')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.channel = 'dashboard'
  AND intervention.status IN ('open', 'acknowledged')
  AND coalesce(work_order.runtime_status, work_order.status) IN ('completed', 'archived');
