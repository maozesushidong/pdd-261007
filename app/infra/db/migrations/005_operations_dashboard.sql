ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS runtime_status text,
  ADD COLUMN IF NOT EXISTS handling_classification text,
  ADD COLUMN IF NOT EXISTS classification_source text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS classification_reason text,
  ADD COLUMN IF NOT EXISTS classification_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS classification_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS classification_updated_by text,
  ADD COLUMN IF NOT EXISTS data_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS latest_event_at timestamptz;

UPDATE work_orders
SET runtime_status = COALESCE(runtime_status, status),
    handling_classification = COALESCE(
      handling_classification,
      CASE WHEN status = 'paused' OR manual_review_reason IS NOT NULL THEN 'manual' ELSE 'automated' END
    ),
    classification_updated_at = COALESCE(classification_updated_at, updated_at)
WHERE runtime_status IS NULL
   OR handling_classification IS NULL
   OR classification_updated_at IS NULL;

ALTER TABLE work_orders
  ALTER COLUMN runtime_status SET DEFAULT 'queued',
  ALTER COLUMN handling_classification SET DEFAULT 'automated';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_orders'::regclass
      AND conname = 'work_orders_handling_classification_check'
  ) THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_handling_classification_check
      CHECK (handling_classification IN ('automated', 'manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_orders'::regclass
      AND conname = 'work_orders_classification_source_check'
  ) THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_classification_source_check
      CHECK (classification_source IN ('system', 'admin-override'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workflow_events (
  id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  shop_id text NOT NULL REFERENCES shops(id),
  work_order_id uuid REFERENCES work_orders(id),
  external_order_number text,
  run_id text,
  sequence bigint,
  system_name text,
  stage text NOT NULL,
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  reason_code text,
  message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_shop_time
  ON workflow_events (shop_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_events_order_time
  ON workflow_events (work_order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_events_reason
  ON workflow_events (reason_code, occurred_at DESC)
  WHERE reason_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  shop_id text PRIMARY KEY REFERENCES shops(id),
  work_order_id uuid REFERENCES work_orders(id),
  external_order_number text,
  current_step text NOT NULL,
  runtime_status text NOT NULL,
  snapshot jsonb NOT NULL,
  source_hash text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  synchronized_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  source_id text NOT NULL,
  shop_id text NOT NULL REFERENCES shops(id),
  last_sequence bigint NOT NULL DEFAULT 0,
  last_event_key text,
  last_snapshot_hash text,
  backlog_count integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, shop_id)
);

CREATE TABLE IF NOT EXISTS classification_history (
  id uuid PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  previous_classification text,
  next_classification text NOT NULL CHECK (next_classification IN ('automated', 'manual')),
  reason text NOT NULL,
  actor_id text NOT NULL,
  source text NOT NULL DEFAULT 'admin-override',
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classification_history_order
  ON classification_history (work_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_corrections (
  id uuid PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  patch jsonb NOT NULL,
  previous_values jsonb NOT NULL,
  reason text NOT NULL,
  actor_id text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  rolled_back_by text
);

CREATE TABLE IF NOT EXISTS operator_commands (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL REFERENCES shops(id),
  work_order_id uuid REFERENCES work_orders(id),
  command_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'acknowledged', 'failed', 'cancelled')),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  result jsonb
);

CREATE INDEX IF NOT EXISTS idx_operator_commands_pending
  ON operator_commands (shop_id, status, requested_at);

CREATE TABLE IF NOT EXISTS manual_interventions (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL REFERENCES shops(id),
  work_order_id uuid REFERENCES work_orders(id),
  channel text NOT NULL CHECK (channel IN ('dashboard', 'dingtalk')),
  reason_code text NOT NULL,
  reason text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('medium', 'high')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'cancelled')),
  deduplication_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolved_by text
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY,
  intervention_id uuid NOT NULL REFERENCES manual_interventions(id),
  channel text NOT NULL DEFAULT 'dingtalk',
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES notification_outbox(id),
  attempt integer NOT NULL,
  status text NOT NULL,
  response_status integer,
  response_payload jsonb,
  error jsonb,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION notify_dashboard_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('dashboard_events', json_build_object(
    'type', TG_ARGV[0],
    'id', NEW.id,
    'shopId', NEW.shop_id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_events_dashboard_notify ON workflow_events;
CREATE TRIGGER workflow_events_dashboard_notify
AFTER INSERT ON workflow_events
FOR EACH ROW EXECUTE FUNCTION notify_dashboard_event('workflow.event');
