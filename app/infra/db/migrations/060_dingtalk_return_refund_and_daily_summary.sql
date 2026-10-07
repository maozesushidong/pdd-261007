BEGIN;

CREATE TABLE IF NOT EXISTS dingtalk_daily_summaries (
  summary_date date PRIMARY KEY,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  today_processed integer NOT NULL CHECK (today_processed >= 0),
  historical_processed integer NOT NULL CHECK (historical_processed >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  response_payload jsonb,
  last_error jsonb,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dingtalk_daily_summaries_pending
  ON dingtalk_daily_summaries (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

INSERT INTO system_settings (key, value, updated_by)
VALUES
  ('return-refund-dingtalk-enabled', 'true'::jsonb, 'migration-060'),
  ('dingtalk-extended-ordinary-enabled', 'true'::jsonb, 'migration-060')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = CASE
    WHEN system_settings.value IS DISTINCT FROM EXCLUDED.value THEN now()
    ELSE system_settings.updated_at
  END,
  updated_by = EXCLUDED.updated_by;

COMMIT;
