BEGIN;

DO $$
DECLARE
  fixture_shop_id constant text := 'ordinary-reconciliation-b31efec982';
BEGIN
  IF EXISTS (SELECT 1 FROM shops WHERE id = fixture_shop_id) THEN
    IF 1 <> (
      SELECT count(*)
      FROM shops shop
      WHERE shop.id = fixture_shop_id
        AND shop.name = 'Ordinary instance test b31efec982 reconciliation'
        AND shop.expected_shop_name = 'Ordinary instance test b31efec982 reconciliation'
        AND shop.enabled = false
        AND shop.onboarding_status = 'disabled'
        AND shop.created_by IS NULL
        AND shop.display_slot = 12
    ) THEN
      RAISE EXCEPTION 'migration-284 fixture shop identity mismatch';
    END IF;

    IF 2 <> (
      SELECT count(*)
      FROM work_orders work_order
      WHERE work_order.shop_id = fixture_shop_id
        AND work_order.external_order_number IN (
          'old-recovered-b31efec982',
          'metric-manual-b31efec982'
        )
        AND work_order.idempotency_key LIKE '%b31efec982%'
    ) OR 2 <> (
      SELECT count(*) FROM work_orders WHERE shop_id = fixture_shop_id
    ) OR 2 <> (
      SELECT count(*) FROM ordinary_work_order_instances WHERE shop_id = fixture_shop_id
    ) OR 3 <> (
      SELECT count(*) FROM manual_interventions WHERE shop_id = fixture_shop_id
    ) OR 2 <> (
      SELECT count(*)
      FROM notification_outbox outbox
      WHERE outbox.intervention_id IN (
        SELECT intervention.id
        FROM manual_interventions intervention
        WHERE intervention.shop_id = fixture_shop_id
      )
    ) OR 1 <> (
      SELECT count(*)
      FROM notification_deliveries delivery
      WHERE delivery.outbox_id IN (
        SELECT outbox.id
        FROM notification_outbox outbox
        JOIN manual_interventions intervention
          ON intervention.id = outbox.intervention_id
        WHERE intervention.shop_id = fixture_shop_id
      )
    ) OR 1 <> (
      SELECT count(*) FROM shop_schedule_state WHERE shop_id = fixture_shop_id
    ) THEN
      RAISE EXCEPTION 'migration-284 fixture relation counts changed';
    END IF;

    IF EXISTS (
      SELECT 1 FROM external_effects WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM evidence_assets WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM verification_locations WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM audit_events WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM workflow_events WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM workflow_checkpoints WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM operator_commands WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM return_refunds WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM shop_runtime_state WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM worker_heartbeats WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM sync_cursors WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM shop_identity_bindings WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM pdd_shop_runtime_bindings WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM rule_versions WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM browser_slots WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM shop_deletion_requests WHERE shop_id = fixture_shop_id
      UNION ALL SELECT 1 FROM cross_shop_order_conflicts
        WHERE discovered_shop_id = fixture_shop_id OR resolved_shop_id = fixture_shop_id
    ) THEN
      RAISE EXCEPTION 'migration-284 found unexpected fixture relations';
    END IF;
  END IF;
END
$$;

DELETE FROM notification_deliveries delivery
WHERE delivery.outbox_id IN (
  SELECT outbox.id
  FROM notification_outbox outbox
  JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id
  WHERE intervention.shop_id = 'ordinary-reconciliation-b31efec982'
);

DELETE FROM notification_outbox outbox
WHERE outbox.intervention_id IN (
  SELECT intervention.id
  FROM manual_interventions intervention
  WHERE intervention.shop_id = 'ordinary-reconciliation-b31efec982'
);

DELETE FROM manual_interventions
WHERE shop_id = 'ordinary-reconciliation-b31efec982';

DELETE FROM work_orders
WHERE shop_id = 'ordinary-reconciliation-b31efec982';

DELETE FROM shop_schedule_state
WHERE shop_id = 'ordinary-reconciliation-b31efec982';

DELETE FROM shops
WHERE id = 'ordinary-reconciliation-b31efec982';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shops WHERE id = 'ordinary-reconciliation-b31efec982'
    UNION ALL SELECT 1 FROM work_orders WHERE shop_id = 'ordinary-reconciliation-b31efec982'
    UNION ALL SELECT 1 FROM ordinary_work_order_instances WHERE shop_id = 'ordinary-reconciliation-b31efec982'
    UNION ALL SELECT 1 FROM manual_interventions WHERE shop_id = 'ordinary-reconciliation-b31efec982'
    UNION ALL SELECT 1 FROM shop_schedule_state WHERE shop_id = 'ordinary-reconciliation-b31efec982'
  ) THEN
    RAISE EXCEPTION 'migration-284 fixture cleanup incomplete';
  END IF;
END
$$;

INSERT INTO schema_migrations (version)
VALUES ('284_remove_production_ordinary_reconciliation_fixture.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
