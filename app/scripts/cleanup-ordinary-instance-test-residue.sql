\set ON_ERROR_STOP on

BEGIN;

DO $cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shops
    WHERE (id LIKE 'ordinary-instance-test-%' OR id LIKE 'ordinary-instance-other-%')
      AND name NOT LIKE 'Ordinary instance test %'
  ) THEN
    RAISE EXCEPTION 'Refusing cleanup because an ordinary-instance test id has a non-test name';
  END IF;

  DELETE FROM notification_deliveries WHERE outbox_id IN (
    SELECT outbox.id FROM notification_outbox outbox
    JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id
    WHERE intervention.shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM notification_outbox WHERE intervention_id IN (
    SELECT id FROM manual_interventions WHERE shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM verification_locations WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM tms_work_orders WHERE work_order_id IN (
    SELECT id FROM work_orders WHERE shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM audit_events WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM external_effects WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM workflow_events WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM workflow_checkpoints WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM classification_history WHERE work_order_id IN (
    SELECT id FROM work_orders WHERE shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM data_corrections WHERE work_order_id IN (
    SELECT id FROM work_orders WHERE shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM logistics_analyses WHERE work_order_id IN (
    SELECT id FROM work_orders WHERE shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM oms_analyses WHERE work_order_id IN (
    SELECT id FROM work_orders WHERE shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM operator_commands WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM manual_interventions WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM workflow_runs WHERE work_order_id IN (
    SELECT id FROM work_orders WHERE shop_id LIKE 'ordinary-instance-test-%'
  );
  DELETE FROM evidence_assets WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM shop_runtime_state
    WHERE shop_id LIKE 'ordinary-instance-test-%' OR shop_id LIKE 'ordinary-instance-other-%';
  DELETE FROM work_orders WHERE shop_id LIKE 'ordinary-instance-test-%';
  DELETE FROM worker_heartbeats
    WHERE shop_id LIKE 'ordinary-instance-test-%' OR shop_id LIKE 'ordinary-instance-other-%';
  DELETE FROM sync_cursors
    WHERE shop_id LIKE 'ordinary-instance-test-%' OR shop_id LIKE 'ordinary-instance-other-%';
  DELETE FROM shop_identity_bindings
    WHERE shop_id LIKE 'ordinary-instance-test-%' OR shop_id LIKE 'ordinary-instance-other-%';
  DELETE FROM pdd_shop_runtime_bindings
    WHERE shop_id LIKE 'ordinary-instance-test-%' OR shop_id LIKE 'ordinary-instance-other-%';
  DELETE FROM shop_schedule_state
    WHERE shop_id LIKE 'ordinary-instance-test-%' OR shop_id LIKE 'ordinary-instance-other-%';
  DELETE FROM shops
    WHERE id LIKE 'ordinary-instance-test-%' OR id LIKE 'ordinary-instance-other-%';
END
$cleanup$;

COMMIT;
