\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:oms-reissue-280:shop-mt9vci3e-20eedf')
);

WITH reloaded AS (
  UPDATE shops shop
  SET config_version = shop.config_version + 1,
    updated_at = now()
  WHERE shop.id = 'shop-mt9vci3e-20eedf'
    AND shop.enabled = true
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = shop.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.shop_id = shop.id
        AND effect.status IN ('reserved', 'unknown')
    )
  RETURNING shop.id, shop.config_version, shop.updated_at
)
SELECT * FROM reloaded;

COMMIT;
