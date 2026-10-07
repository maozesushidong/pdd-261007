\encoding UTF8

SELECT 'migration_count' AS check_name, count(*)::text AS value
FROM schema_migrations
WHERE version = '277_rehydrate_product_shortage_tms_effect.sql';

SELECT 'shop_enabled' AS check_name, enabled::text AS value
FROM shops
WHERE id = 'songteng-yazc-overseas';

SELECT 'work_order_state' AS check_name,
  concat_ws('|', status, runtime_status, current_step,
    coalesce(manual_review_reason, ''),
    coalesce(payload#>>'{tmsWorkOrder,ticketId}', ''),
    coalesce(payload#>>'{tmsWorkOrder,ticketNo}', ''),
    coalesce(payload#>>'{tmsWorkOrder,recoverySource}', '')) AS value
FROM work_orders
WHERE id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;

SELECT 'instance_state' AS check_name,
  concat_ws('|', status, runtime_status, current_step,
    coalesce(manual_review_reason, '')) AS value
FROM ordinary_work_order_instances
WHERE id = '5f710fc0-f8ac-4070-8eff-2e0387df87f1'::uuid;

SELECT 'exact_tms_effect' AS check_name,
  concat_ws('|', count(*),
    coalesce(string_agg(status, ',' ORDER BY updated_at), ''),
    coalesce(string_agg(receipt#>>'{result,data,ticketId}', ',' ORDER BY updated_at), ''),
    coalesce(string_agg(receipt#>>'{result,data,ticketNo}', ',' ORDER BY updated_at), '')) AS value
FROM external_effects
WHERE work_order_id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid
  AND ordinary_instance_id = '5f710fc0-f8ac-4070-8eff-2e0387df87f1'::uuid
  AND effect_type = 'tms-create';

SELECT 'all_effects' AS check_name,
  concat_ws('|', count(*),
    count(*) FILTER (WHERE status IN ('reserved', 'unknown'))) AS value
FROM external_effects
WHERE work_order_id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid
  AND ordinary_instance_id IS NOT DISTINCT FROM
    '5f710fc0-f8ac-4070-8eff-2e0387df87f1'::uuid;

SELECT 'exact_tms_rows' AS check_name,
  concat_ws('|', count(*),
    coalesce(string_agg(external_ticket_id, ',' ORDER BY created_at), ''),
    coalesce(string_agg(payload->>'ticketNo', ',' ORDER BY created_at), '')) AS value
FROM tms_work_orders
WHERE work_order_id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid
  AND ordinary_instance_id = '5f710fc0-f8ac-4070-8eff-2e0387df87f1'::uuid;

SELECT 'migration_audit_count' AS check_name, count(*)::text AS value
FROM audit_events
WHERE work_order_id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid
  AND ordinary_instance_id = '5f710fc0-f8ac-4070-8eff-2e0387df87f1'::uuid
  AND event_type = 'product-shortage-tms-effect-rehydrated-retry-ready'
  AND actor_id = 'migration-277';

SELECT 'active_lease_count' AS check_name, count(*)::text AS value
FROM shop_runtime_state
WHERE shop_id = 'songteng-yazc-overseas'
  AND current_work_order_id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid
  AND lease_token IS NOT NULL
  AND lease_expires_at > now();
