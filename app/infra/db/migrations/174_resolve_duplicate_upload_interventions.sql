BEGIN;

WITH duplicate_generic AS (
  SELECT generic.id
  FROM manual_interventions generic
  WHERE generic.reason_code = 'external-system-error'
    AND generic.status IN ('open', 'acknowledged')
    AND generic.reason ~* '(48143|非法请求|凭证.*上传|图片.*上传|附件.*上传)'
    AND EXISTS (
      SELECT 1
      FROM manual_interventions specific
      WHERE specific.work_order_id = generic.work_order_id
        AND specific.ordinary_instance_id IS NOT DISTINCT FROM generic.ordinary_instance_id
        AND specific.reason_code = 'image-upload-failed'
        AND specific.status IN ('open', 'acknowledged')
    )
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-174')
  FROM duplicate_generic duplicate
  WHERE intervention.id = duplicate.id
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object('reason', 'specific-upload-failure-superseded')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('174_resolve_duplicate_upload_interventions.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
