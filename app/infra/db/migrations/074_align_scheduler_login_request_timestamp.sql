BEGIN;

-- The PostgreSQL driver exposes timestamptz values as millisecond JavaScript
-- Dates. Align only records that already identify the same request millisecond.
UPDATE shop_schedule_state schedule
SET last_login_request_at = shop.login_requested_at,
  updated_at = now(),
  version = version + 1
FROM shops shop
WHERE shop.id = schedule.shop_id
  AND shop.login_requested_at IS NOT NULL
  AND schedule.last_login_request_at IS NOT NULL
  AND schedule.last_login_request_at <> shop.login_requested_at
  AND date_trunc('milliseconds', schedule.last_login_request_at) =
    date_trunc('milliseconds', shop.login_requested_at);

COMMIT;
