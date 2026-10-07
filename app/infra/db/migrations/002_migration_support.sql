ALTER TABLE evidence_assets ALTER COLUMN work_order_id DROP NOT NULL;
ALTER TABLE evidence_assets ADD COLUMN IF NOT EXISTS shop_id text REFERENCES shops(id);
ALTER TABLE evidence_assets ADD COLUMN IF NOT EXISTS size_bytes bigint;
ALTER TABLE evidence_assets ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE evidence_assets ADD COLUMN IF NOT EXISTS source_path text;

ALTER TABLE logistics_analyses ADD COLUMN IF NOT EXISTS source_hash text;
ALTER TABLE oms_analyses ADD COLUMN IF NOT EXISTS source_hash text;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS deduplication_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_analysis_source
  ON logistics_analyses (work_order_id, source_hash)
  WHERE source_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_oms_analysis_source
  ON oms_analyses (work_order_id, source_hash)
  WHERE source_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_source
  ON evidence_assets (shop_id, object_key, sha256)
  WHERE shop_id IS NOT NULL AND sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_deduplication_key
  ON audit_events (deduplication_key)
  WHERE deduplication_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  migration_kind text NOT NULL,
  manifest_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  expected_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (migration_kind, manifest_hash)
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  mode text NOT NULL,
  shop_id text REFERENCES shops(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_assets_shop ON evidence_assets (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_time ON worker_heartbeats (heartbeat_at DESC);
