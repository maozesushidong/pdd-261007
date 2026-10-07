BEGIN;

-- Refund discovery was explicitly disabled in the owner console. Restore the
-- scanner without clearing its durable cursor or touching any refund decision.
WITH previous_setting AS MATERIALIZED (
  SELECT value
  FROM system_settings
  WHERE key = 'return-refund-scan-enabled'
  FOR UPDATE
), restored AS (
  INSERT INTO system_settings (key, value, updated_at, updated_by)
  VALUES ('return-refund-scan-enabled', 'true'::jsonb, now(), 'migration-197')
  ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
    updated_at = EXCLUDED.updated_at,
    updated_by = EXCLUDED.updated_by
  WHERE system_settings.value IS DISTINCT FROM 'true'::jsonb
  RETURNING key
)
INSERT INTO audit_events
  (actor_id, event_type, payload, deduplication_key)
SELECT 'migration-197',
  'return-refund-scan-restored',
  jsonb_build_object(
    'previousValue', (SELECT value FROM previous_setting),
    'scanEnabled', true,
    'cursorReset', false,
    'externalSubmissionStarted', false
  ),
  'migration-197:return-refund-scan-restored'
FROM restored
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE shop_schedule_state schedule
SET next_refund_scan_at = least(schedule.next_refund_scan_at, now()),
  refund_overdue_reason = NULL,
  updated_at = now(),
  version = version + 1
FROM shops shop
WHERE shop.id = schedule.shop_id
  AND shop.enabled = true
  AND 'return-refund' = ANY(shop.scenario_codes);

INSERT INTO schema_migrations (version)
VALUES ('197_restore_return_refund_scanning.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
