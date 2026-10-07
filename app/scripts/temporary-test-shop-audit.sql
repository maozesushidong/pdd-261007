\pset pager off

SELECT row_to_json(shop)::text
FROM shops shop
WHERE shop.id = 'ordinary-reconciliation-b31efec982';

SELECT row_to_json(work_order)::text
FROM work_orders work_order
WHERE work_order.shop_id = 'ordinary-reconciliation-b31efec982'
ORDER BY work_order.created_at;

SELECT source, count
FROM (
  SELECT 'work_orders' AS source, count(*)::bigint AS count FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'ordinary_work_order_instances', count(*) FROM ordinary_work_order_instances WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'external_effects', count(*) FROM external_effects WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'evidence_assets', count(*) FROM evidence_assets WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'verification_locations', count(*) FROM verification_locations WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'audit_events', count(*) FROM audit_events WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'workflow_events', count(*) FROM workflow_events WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'workflow_checkpoints', count(*) FROM workflow_checkpoints WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'operator_commands', count(*) FROM operator_commands WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'manual_interventions', count(*) FROM manual_interventions WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'return_refunds', count(*) FROM return_refunds WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'shop_runtime_state', count(*) FROM shop_runtime_state WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'worker_heartbeats', count(*) FROM worker_heartbeats WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'sync_cursors', count(*) FROM sync_cursors WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'shop_identity_bindings', count(*) FROM shop_identity_bindings WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'pdd_shop_runtime_bindings', count(*) FROM pdd_shop_runtime_bindings WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'shop_schedule_state', count(*) FROM shop_schedule_state WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'rule_versions', count(*) FROM rule_versions WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'browser_slots', count(*) FROM browser_slots WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'shop_deletion_requests', count(*) FROM shop_deletion_requests WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'cross_shop_order_conflicts', count(*) FROM cross_shop_order_conflicts WHERE discovered_shop_id = 'ordinary-reconciliation-b31efec982' OR resolved_shop_id = 'ordinary-reconciliation-b31efec982'
  UNION ALL SELECT 'notification_outbox', count(*) FROM notification_outbox WHERE intervention_id IN (SELECT id FROM manual_interventions WHERE shop_id = 'ordinary-reconciliation-b31efec982')
  UNION ALL SELECT 'notification_deliveries', count(*) FROM notification_deliveries WHERE outbox_id IN (SELECT outbox.id FROM notification_outbox outbox JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id WHERE intervention.shop_id = 'ordinary-reconciliation-b31efec982')
  UNION ALL SELECT 'tms_work_orders', count(*) FROM tms_work_orders WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982')
  UNION ALL SELECT 'classification_history', count(*) FROM classification_history WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982')
  UNION ALL SELECT 'data_corrections', count(*) FROM data_corrections WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982')
  UNION ALL SELECT 'logistics_analyses', count(*) FROM logistics_analyses WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982')
  UNION ALL SELECT 'oms_analyses', count(*) FROM oms_analyses WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982')
  UNION ALL SELECT 'workflow_runs', count(*) FROM workflow_runs WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982')
) counts
WHERE count > 0
ORDER BY source;

SELECT format(
  'SELECT %L AS relation, %L AS column_name, count(*) AS count FROM %s WHERE %I = %L HAVING count(*) > 0;',
  constraint_row.child_table::text,
  constraint_row.child_column,
  constraint_row.child_table,
  constraint_row.child_column,
  'ordinary-reconciliation-b31efec982'
)
FROM (
  SELECT constraint_row.conrelid::regclass AS child_table,
    attribute.attname AS child_column
  FROM pg_constraint constraint_row
  JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_row.conrelid
    AND attribute.attnum = constraint_row.conkey[1]
  WHERE constraint_row.contype = 'f'
    AND constraint_row.confrelid = 'shops'::regclass
    AND cardinality(constraint_row.conkey) = 1
) constraint_row
ORDER BY constraint_row.child_table::text, constraint_row.child_column
\gexec
