BEGIN;

-- Dashboard queries group return/refund rows by order and repeatedly inspect
-- the current ordinary instance's related facts. These indexes keep those
-- lookups proportional to the requested rows instead of every historical row.
CREATE INDEX IF NOT EXISTS idx_work_orders_return_refund_representative
  ON work_orders (shop_id, external_order_number, updated_at DESC, id DESC)
  WHERE scenario_code = 'return-refund';

CREATE INDEX IF NOT EXISTS idx_work_orders_authoritative_discovery
  ON work_orders (shop_id, external_order_number)
  WHERE idempotency_key LIKE 'pdd-discovered:%';

CREATE INDEX IF NOT EXISTS idx_manual_interventions_work_order_instance
  ON manual_interventions (work_order_id, ordinary_instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oms_analyses_work_order_instance_created
  ON oms_analyses (work_order_id, ordinary_instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_logistics_analyses_work_order_instance_created
  ON logistics_analyses (work_order_id, ordinary_instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_corrections_active_work_order_instance
  ON data_corrections (work_order_id, ordinary_instance_id)
  WHERE rolled_back_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_commands_active_work_order_instance
  ON operator_commands (work_order_id, ordinary_instance_id)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_notification_outbox_intervention_created
  ON notification_outbox (intervention_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_cursors_shop_success
  ON sync_cursors (shop_id, last_success_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('230_add_dashboard_relation_indexes.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
