BEGIN;

ALTER TABLE pdd_shop_runtime_bindings
  ADD COLUMN IF NOT EXISTS mall_id text;

ALTER TABLE shop_identity_bindings
  ADD COLUMN IF NOT EXISTS mall_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pdd_shop_runtime_bindings_mall_id
  ON pdd_shop_runtime_bindings (mall_id)
  WHERE mall_id IS NOT NULL;

UPDATE pdd_shop_runtime_bindings
SET mall_id = substring(identity_key FROM '^mall:([0-9]{5,30})$')
WHERE mall_id IS NULL
  AND identity_key ~ '^mall:[0-9]{5,30}$';

COMMIT;
