BEGIN;

-- Chat analysis is shared by every chat-driven work-order policy. Keep the
-- scenario and human-readable title on the case so the owner view never has
-- to infer every row as 商品少发.
ALTER TABLE chat_cases
  ADD COLUMN IF NOT EXISTS work_order_type text;

UPDATE chat_cases AS c
SET work_order_type = COALESCE(
  NULLIF(c.work_order_type, ''),
  (
    SELECT w.work_order_type
    FROM work_orders AS w
    WHERE w.shop_id = c.shop_id
      AND w.external_order_number = c.order_number
      AND (c.scenario_code IS NULL OR w.scenario_code = c.scenario_code)
    ORDER BY w.updated_at DESC, w.id DESC
    LIMIT 1
  )
)
WHERE c.work_order_type IS NULL OR btrim(c.work_order_type) = '';

UPDATE chat_cases
SET work_order_type = '商品少发'
WHERE work_order_type IS NULL OR btrim(work_order_type) = '';

ALTER TABLE chat_cases
  ALTER COLUMN work_order_type SET DEFAULT '商品少发';

INSERT INTO schema_migrations(version)
VALUES ('300_chat_case_work_order_identity.sql')
ON CONFLICT DO NOTHING;
COMMIT;
