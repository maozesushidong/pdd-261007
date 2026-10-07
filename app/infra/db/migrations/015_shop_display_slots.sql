BEGIN;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS display_slot integer;

UPDATE shops SET display_slot = CASE id
  WHEN 'panapopo-healthcare' THEN 0
  WHEN 'panapopo-medical-device' THEN 1
  WHEN 'songteng-yazc-overseas' THEN 2
  ELSE display_slot
END
WHERE id IN ('panapopo-healthcare', 'panapopo-medical-device', 'songteng-yazc-overseas');

WITH available AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) - 1
    + coalesce((SELECT max(display_slot) + 1 FROM shops WHERE display_slot IS NOT NULL), 0) AS slot
  FROM shops
  WHERE display_slot IS NULL
)
UPDATE shops SET display_slot = available.slot
FROM available
WHERE shops.id = available.id;

ALTER TABLE shops ALTER COLUMN display_slot SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'shops'::regclass
      AND conname = 'shops_display_slot_check'
  ) THEN
    ALTER TABLE shops ADD CONSTRAINT shops_display_slot_check
      CHECK (display_slot >= 0 AND display_slot < 100);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_display_slot_unique ON shops (display_slot);

COMMIT;
