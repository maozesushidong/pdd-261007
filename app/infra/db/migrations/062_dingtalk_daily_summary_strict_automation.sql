BEGIN;

ALTER TABLE dingtalk_daily_summaries
  ADD COLUMN IF NOT EXISTS today_strict_automated integer NOT NULL DEFAULT 0
    CHECK (today_strict_automated >= 0);

COMMIT;
