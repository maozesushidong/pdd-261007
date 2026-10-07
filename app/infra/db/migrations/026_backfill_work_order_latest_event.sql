UPDATE work_orders work_order
SET latest_event_at = latest_event.occurred_at
FROM (
  SELECT work_order_id, max(occurred_at) AS occurred_at
  FROM workflow_events
  WHERE work_order_id IS NOT NULL
  GROUP BY work_order_id
) latest_event
WHERE work_order.id = latest_event.work_order_id
  AND (work_order.latest_event_at IS NULL OR work_order.latest_event_at < latest_event.occurred_at);
