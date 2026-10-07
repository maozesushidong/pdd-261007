BEGIN;

-- The dashboard and workflow-log views always read the newest events first.
-- Without this index PostgreSQL scans and sorts the full multi-gigabyte event
-- table even when the caller only asks for eight rows.
CREATE INDEX IF NOT EXISTS idx_workflow_events_feed_time
  ON workflow_events (occurred_at DESC, received_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('229_add_workflow_event_feed_index.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
