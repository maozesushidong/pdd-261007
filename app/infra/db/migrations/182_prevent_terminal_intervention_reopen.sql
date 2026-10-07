BEGIN;

-- Delayed browser events can arrive after an authoritative completion was
-- archived. They must not recreate an actionable dashboard/DingTalk record.
-- Owner-requested messages remain allowed for historical completed orders.
CREATE OR REPLACE FUNCTION prevent_terminal_automatic_intervention_reopen()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('open', 'acknowledged')
    AND coalesce(NEW.deduplication_key, '') NOT LIKE 'dingtalk:owner-manual:%'
    AND EXISTS (
      SELECT 1
      FROM work_orders work_order
      WHERE work_order.id = NEW.work_order_id
        AND work_order.status IN ('completed', 'archived')
        AND coalesce(work_order.completion_state, 'pending')
          IN ('confirmed', 'not-applicable')
    ) THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NULL;
    END IF;
    NEW.status := 'resolved';
    NEW.resolved_at := coalesce(NEW.resolved_at, now());
    NEW.resolved_by := coalesce(
      NEW.resolved_by,
      'terminal-work-order-intervention-guard'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS terminal_automatic_intervention_reopen_guard
  ON manual_interventions;
CREATE TRIGGER terminal_automatic_intervention_reopen_guard
BEFORE INSERT OR UPDATE OF status, work_order_id, deduplication_key
ON manual_interventions
FOR EACH ROW
EXECUTE FUNCTION prevent_terminal_automatic_intervention_reopen();

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(
      intervention.resolved_by,
      'migration-182-terminal-work-order-cleanup'
    )
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND coalesce(intervention.deduplication_key, '')
      NOT LIKE 'dingtalk:owner-manual:%'
    AND work_order.status IN ('completed', 'archived')
    AND coalesce(work_order.completion_state, 'pending')
      IN ('confirmed', 'not-applicable')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'terminal-work-order-intervention-cleanup-182'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('182_prevent_terminal_intervention_reopen.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
