BEGIN;

DROP INDEX IF EXISTS idx_shops_expected_name_unique;

CREATE INDEX IF NOT EXISTS idx_shops_expected_name
  ON shops (lower(expected_shop_name));

COMMIT;
