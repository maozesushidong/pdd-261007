INSERT INTO manual_interventions
  (id, shop_id, work_order_id, channel, reason_code, reason, risk_level, deduplication_key, created_at)
SELECT gen_random_uuid(), event.shop_id, event.work_order_id, 'dashboard', event.reason_code,
  coalesce(event.message, event.reason_code),
  CASE WHEN event.severity = 'error' THEN 'high' ELSE 'medium' END,
  'dashboard:' || event.shop_id || ':' || coalesce(event.external_order_number, 'none') || ':' || event.stage || ':' || event.reason_code,
  event.occurred_at
FROM workflow_events event
WHERE event.reason_code IS NOT NULL
  AND event.stage !~ '(complete|succeeded|archived|next-order-ready|requested-order-complete)'
ON CONFLICT (deduplication_key) DO NOTHING;
