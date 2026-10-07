BEGIN;

ALTER TABLE dingtalk_daily_summaries
  ADD COLUMN IF NOT EXISTS today_completed integer NOT NULL DEFAULT 0
    CHECK (today_completed >= 0);

COMMIT;
