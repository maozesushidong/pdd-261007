BEGIN;
CREATE TABLE IF NOT EXISTS chat_analysis_settings (
  id integer PRIMARY KEY CHECK (id = 1), mode text NOT NULL DEFAULT 'analyze-only'
    CHECK (mode IN ('off','analyze-only','auto-feedback')),
  approved_at timestamptz, approved_by text, updated_at timestamptz NOT NULL DEFAULT now(),
  model_error text, model_config_hash text
);
INSERT INTO chat_analysis_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS chat_cases (
  id uuid PRIMARY KEY, shop_id text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_number text NOT NULL, platform_case_key text NOT NULL, platform_case_id text NOT NULL,
  detail_url text NOT NULL, scenario_code text NOT NULL DEFAULT 'product-shortage',
  status text NOT NULL DEFAULT 'collecting', last_error text,
  collect_requested boolean NOT NULL DEFAULT false, collect_token uuid, collect_lease_until timestamptz,
  next_collect_at timestamptz NOT NULL DEFAULT now(), collect_generation integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, platform_case_key)
);
CREATE TABLE IF NOT EXISTS chat_snapshots (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES chat_cases(id) ON DELETE CASCADE,
  content_hash text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,content_hash)
);
CREATE TABLE IF NOT EXISTS chat_attachments (
  snapshot_id uuid NOT NULL REFERENCES chat_snapshots(id) ON DELETE CASCADE,
  id text NOT NULL, mime_type text NOT NULL, content bytea NOT NULL,
  PRIMARY KEY(snapshot_id,id)
);
CREATE TABLE IF NOT EXISTS chat_analysis_jobs (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES chat_cases(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES chat_snapshots(id) ON DELETE CASCADE,
  request_hash text NOT NULL, policy_id text NOT NULL, policy_version integer NOT NULL,
  model text NOT NULL, base_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  result jsonb, checkpoint jsonb NOT NULL DEFAULT '{}', error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id,request_hash)
);
CREATE INDEX IF NOT EXISTS chat_analysis_jobs_ready ON chat_analysis_jobs(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS chat_feedback_effects (
  case_id uuid PRIMARY KEY REFERENCES chat_cases(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES chat_analysis_jobs(id),
  status text NOT NULL CHECK (status IN ('reserved','confirmed','unknown','not-applied')),
  receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES ('296_chat_analysis.sql') ON CONFLICT DO NOTHING;
COMMIT;
