BEGIN;

CREATE OR REPLACE FUNCTION resolve_completed_work_order_interventions()
RETURNS trigger AS $$
BEGIN
  IF coalesce(NEW.runtime_status, NEW.status) IN ('completed', 'archived') THEN
    WITH resolved AS (
      UPDATE manual_interventions
      SET status = 'resolved',
        resolved_at = coalesce(resolved_at, now()),
        resolved_by = coalesce(resolved_by, 'work-order-completion-trigger')
      WHERE work_order_id = NEW.id
        AND status IN ('open', 'acknowledged')
      RETURNING id
    )
    UPDATE notification_outbox outbox
    SET status = 'cancelled', updated_at = now()
    FROM resolved
    WHERE outbox.intervention_id = resolved.id
      AND outbox.status IN ('pending', 'sending', 'failed');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_orders_completed_intervention_cleanup ON work_orders;
CREATE TRIGGER work_orders_completed_intervention_cleanup
AFTER INSERT OR UPDATE OF status, runtime_status ON work_orders
FOR EACH ROW EXECUTE FUNCTION resolve_completed_work_order_interventions();

COMMIT;
