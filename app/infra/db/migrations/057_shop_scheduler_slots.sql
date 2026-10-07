BEGIN;

ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_display_slot_check;
ALTER TABLE shops ADD CONSTRAINT shops_display_slot_check
  CHECK (display_slot >= 0 AND display_slot < 1000);

CREATE TABLE IF NOT EXISTS browser_slots (
  id uuid PRIMARY KEY,
  slot_index integer NOT NULL CHECK (slot_index >= 0 AND slot_index < 100),
  kind text NOT NULL CHECK (kind IN ('business', 'verification', 'login')),
  state text NOT NULL DEFAULT 'starting'
    CHECK (state IN ('starting', 'running', 'draining', 'stopped')),
  shop_id text REFERENCES shops(id) ON DELETE SET NULL,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  memory_mb numeric(12, 2),
  cpu_percent numeric(6, 2),
  process_id integer,
  browser_started_at timestamptz,
  draining boolean NOT NULL DEFAULT false,
  external_effect_active boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_browser_slots_active_index
  ON browser_slots (slot_index) WHERE state <> 'stopped';
CREATE UNIQUE INDEX IF NOT EXISTS uq_browser_slots_active_shop
  ON browser_slots (shop_id) WHERE shop_id IS NOT NULL AND state <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_browser_slots_lease
  ON browser_slots (state, lease_expires_at);

CREATE TABLE IF NOT EXISTS shop_schedule_state (
  shop_id text PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  heat_state text NOT NULL DEFAULT 'hot' CHECK (heat_state IN ('hot', 'cold')),
  hot_until timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  last_business_at timestamptz,
  last_ordinary_scan_at timestamptz,
  next_ordinary_scan_at timestamptz NOT NULL DEFAULT now(),
  last_refund_scan_at timestamptz,
  next_refund_scan_at timestamptz NOT NULL DEFAULT now(),
  refund_scan_cursor jsonb NOT NULL DEFAULT '{"page":1,"itemOffset":0}'::jsonb,
  refund_scan_in_progress boolean NOT NULL DEFAULT false,
  refund_cycle_started_at timestamptz,
  refund_cycle_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule_state text NOT NULL DEFAULT 'queued' CHECK (schedule_state IN (
    'idle', 'queued', 'running', 'verification', 'login', 'backoff',
    'capacity-blocked', 'disabled'
  )),
  queue_entered_at timestamptz NOT NULL DEFAULT now(),
  retry_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_failure text,
  assignment_kind text CHECK (assignment_kind IS NULL OR assignment_kind IN (
    'recovery', 'ordinary', 'refund-execution', 'refund-scan', 'verification', 'login'
  )),
  assigned_slot_id uuid REFERENCES browser_slots(id) ON DELETE SET NULL,
  assignment_token uuid,
  assignment_started_at timestamptz,
  assignment_expires_at timestamptz,
  last_login_request_at timestamptz,
  ordinary_overdue_reason text,
  refund_overdue_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_schedule_ordinary_due
  ON shop_schedule_state (next_ordinary_scan_at, queue_entered_at)
  WHERE assigned_slot_id IS NULL AND schedule_state <> 'disabled';
CREATE INDEX IF NOT EXISTS idx_shop_schedule_refund_due
  ON shop_schedule_state (next_refund_scan_at, queue_entered_at)
  WHERE assigned_slot_id IS NULL AND schedule_state <> 'disabled';
CREATE INDEX IF NOT EXISTS idx_shop_schedule_assignment_lease
  ON shop_schedule_state (assignment_expires_at)
  WHERE assigned_slot_id IS NOT NULL;

INSERT INTO shop_schedule_state (
  shop_id, heat_state, hot_until, next_ordinary_scan_at, next_refund_scan_at,
  schedule_state
)
SELECT id, 'hot', now() + interval '2 hours', now(), now(),
  CASE WHEN enabled THEN 'queued' ELSE 'disabled' END
FROM shops
ON CONFLICT (shop_id) DO NOTHING;

CREATE OR REPLACE FUNCTION sync_shop_schedule_state() RETURNS trigger AS $$
BEGIN
  INSERT INTO shop_schedule_state (
    shop_id, heat_state, hot_until, next_ordinary_scan_at, next_refund_scan_at,
    schedule_state, queue_entered_at
  ) VALUES (
    NEW.id, 'hot', now() + interval '2 hours', now(), now(),
    CASE WHEN NEW.enabled THEN 'queued' ELSE 'disabled' END, now()
  )
  ON CONFLICT (shop_id) DO UPDATE SET
    schedule_state = CASE
      WHEN NEW.enabled = false THEN 'disabled'
      WHEN shop_schedule_state.schedule_state = 'disabled' THEN 'queued'
      ELSE shop_schedule_state.schedule_state
    END,
    next_ordinary_scan_at = CASE
      WHEN NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled) THEN now()
      ELSE shop_schedule_state.next_ordinary_scan_at
    END,
    next_refund_scan_at = CASE
      WHEN NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled) THEN now()
      ELSE shop_schedule_state.next_refund_scan_at
    END,
    queue_entered_at = CASE
      WHEN NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled) THEN now()
      ELSE shop_schedule_state.queue_entered_at
    END,
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_shop_schedule_state ON shops;
CREATE TRIGGER trg_sync_shop_schedule_state
AFTER INSERT OR UPDATE OF enabled ON shops
FOR EACH ROW EXECUTE FUNCTION sync_shop_schedule_state();

COMMIT;
