ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_work_orders_retry_queue
  ON work_orders (shop_id, status, next_attempt_at, created_at);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'external_effects'::regclass
      AND conname = 'external_effects_effect_type_check'
  ) THEN
    ALTER TABLE external_effects DROP CONSTRAINT external_effects_effect_type_check;
  END IF;
  ALTER TABLE external_effects ADD CONSTRAINT external_effects_effect_type_check
    CHECK (effect_type IN ('tms-create', 'pdd-submit', 'pdd-note', 'evidence-upload'));
END $$;
