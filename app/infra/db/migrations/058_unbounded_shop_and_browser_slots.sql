BEGIN;

ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_display_slot_check;
ALTER TABLE shops ADD CONSTRAINT shops_display_slot_check
  CHECK (display_slot >= 0);

COMMIT;
