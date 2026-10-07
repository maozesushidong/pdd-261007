\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:product-shortage-deploy-20260828')
);

WITH targets (shop_id) AS (
  VALUES
    ('songteng-yazc-overseas'::text),
    ('shop-mt9vci3e-20eedf'::text)
), started AS (
  UPDATE shops shop
  SET enabled = true,
    config_version = shop.config_version + 1,
    updated_at = now()
  FROM targets
  WHERE shop.id = targets.shop_id
    AND shop.enabled = false
  RETURNING shop.id, shop.config_version
)
SELECT id AS started_shop_id, config_version
FROM started
ORDER BY id;

COMMIT;
