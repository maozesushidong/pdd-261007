BEGIN;

INSERT INTO system_settings (key, value, updated_by)
VALUES ('dingtalk-automatic-enabled', 'false'::jsonb, 'migration')
ON CONFLICT (key) DO NOTHING;

COMMIT;
