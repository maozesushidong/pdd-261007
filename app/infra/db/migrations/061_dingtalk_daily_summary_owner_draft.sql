BEGIN;

ALTER TABLE dingtalk_daily_summaries
  ADD COLUMN IF NOT EXISTS message_text text,
  ADD COLUMN IF NOT EXISTS edited_by text,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_requested_by text,
  ADD COLUMN IF NOT EXISTS send_requested_at timestamptz;

UPDATE dingtalk_daily_summaries
SET message_text = concat(
  '今日处理：', today_processed, '单', E'\n',
  '历史总处理单量：', historical_processed, '单'
)
WHERE message_text IS NULL;

ALTER TABLE dingtalk_daily_summaries
  ALTER COLUMN message_text SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dingtalk_daily_summaries'::regclass
      AND conname = 'dingtalk_daily_summaries_message_text_check'
  ) THEN
    ALTER TABLE dingtalk_daily_summaries
      ADD CONSTRAINT dingtalk_daily_summaries_message_text_check
      CHECK (char_length(message_text) BETWEEN 1 AND 2000);
  END IF;
END $$;

COMMIT;
