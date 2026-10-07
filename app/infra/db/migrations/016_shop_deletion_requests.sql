BEGIN;

CREATE TABLE IF NOT EXISTS shop_deletion_requests (
  shop_id text PRIMARY KEY,
  display_slot integer NOT NULL,
  requested_by text,
  requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_deletion_requests_requested_at
  ON shop_deletion_requests (requested_at);

COMMIT;
