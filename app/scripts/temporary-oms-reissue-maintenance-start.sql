\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:oms-reissue-submit-maintenance:shop-mt9vci3e-20eedf')
);

WITH started AS (
  UPDATE shops shop
  SET enabled = true,
    config_version = shop.config_version + 1,
    updated_at = now()
  WHERE shop.id = 'shop-mt9vci3e-20eedf'
    AND shop.enabled = false
  RETURNING shop.id, shop.enabled, shop.config_version, shop.updated_at
)
SELECT * FROM started;

COMMIT;
