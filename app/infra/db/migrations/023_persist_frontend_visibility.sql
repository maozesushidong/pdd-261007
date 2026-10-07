BEGIN;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS frontend_visibility text NOT NULL DEFAULT 'operational';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_orders_frontend_visibility_check'
  ) THEN
    ALTER TABLE work_orders
      ADD CONSTRAINT work_orders_frontend_visibility_check
      CHECK (frontend_visibility IN ('operational', 'recovery-audit'));
  END IF;
END $$;

UPDATE work_orders work_order
SET frontend_visibility = 'recovery-audit'
WHERE EXISTS (
  SELECT 1 FROM operator_commands command
  WHERE command.work_order_id = work_order.id
    AND command.command_type = 'reconcile-external-state'
);

CREATE INDEX IF NOT EXISTS idx_work_orders_frontend_visibility
  ON work_orders (frontend_visibility, updated_at DESC);

COMMIT;
