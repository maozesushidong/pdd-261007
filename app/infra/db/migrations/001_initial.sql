CREATE TABLE IF NOT EXISTS shops (
  id text PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  rule_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenario_definitions (
  code text PRIMARY KEY,
  title_patterns jsonb NOT NULL,
  policy_version integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id bigserial PRIMARY KEY,
  rule_type text NOT NULL,
  shop_id text REFERENCES shops(id),
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'rolled-back')),
  payload jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_type, shop_id, version)
);

CREATE TABLE IF NOT EXISTS work_orders (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL REFERENCES shops(id),
  external_order_number text NOT NULL,
  work_order_type text NOT NULL,
  scenario_code text,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  current_step text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  manual_review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, external_order_number, work_order_type),
  UNIQUE (shop_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  worker_id text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error jsonb
);

CREATE TABLE IF NOT EXISTS logistics_analyses (
  id bigserial PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_analyses (
  id bigserial PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tms_work_orders (
  id uuid PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  scenario_code text NOT NULL,
  external_ticket_id text,
  status text NOT NULL,
  request_hash text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, scenario_code, request_hash)
);

CREATE TABLE IF NOT EXISTS evidence_assets (
  id uuid PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  kind text NOT NULL,
  status text NOT NULL,
  object_key text NOT NULL,
  mime_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS verification_locations (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL REFERENCES shops(id),
  work_order_id uuid REFERENCES work_orders(id),
  system_name text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  url text NOT NULL,
  frame_url text,
  selector text,
  bounding_box jsonb NOT NULL,
  screenshot_file_id uuid REFERENCES evidence_assets(id),
  confidence text NOT NULL,
  detected_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  shop_id text REFERENCES shops(id),
  work_order_id uuid REFERENCES work_orders(id),
  actor_id text,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_queue ON work_orders (shop_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_shop_time ON audit_events (shop_id, created_at DESC);

