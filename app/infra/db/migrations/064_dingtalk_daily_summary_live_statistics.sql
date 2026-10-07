BEGIN;

ALTER TABLE dingtalk_daily_summaries
  ADD COLUMN IF NOT EXISTS statistics_refreshed_at timestamptz;

UPDATE dingtalk_daily_summaries
SET statistics_refreshed_at = coalesce(statistics_refreshed_at, updated_at, created_at, now())
WHERE statistics_refreshed_at IS NULL;

ALTER TABLE dingtalk_daily_summaries
  ALTER COLUMN statistics_refreshed_at SET DEFAULT now(),
  ALTER COLUMN statistics_refreshed_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_events_return_refund_wait_logistics
  ON workflow_events (work_order_id, occurred_at)
  WHERE event_type IN ('return-refund.decision', 'return-refund.result')
    AND (payload->>'outcome') = 'wait-logistics';

COMMIT;
