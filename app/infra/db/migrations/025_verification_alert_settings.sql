BEGIN;

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'system'
);

INSERT INTO system_settings (key, value, updated_by)
VALUES ('verification-alerts-enabled', 'true'::jsonb, 'migration')
ON CONFLICT (key) DO NOTHING;

COMMIT;
