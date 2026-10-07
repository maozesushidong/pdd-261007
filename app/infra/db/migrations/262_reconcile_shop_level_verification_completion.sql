BEGIN;

-- Discovery/list-page challenges do not yet have a work order id. Reconcile
-- them only from a later durable completion event for the same shop.
WITH candidates AS MATERIALIZED (
  SELECT verification.id,
    verification.shop_id,
    verification.stage,
    verification.detected_at,
    completion.occurred_at AS completed_at
  FROM verification_locations verification
  JOIN LATERAL (
    SELECT event.occurred_at
    FROM workflow_events event
    WHERE event.shop_id = verification.shop_id
      AND event.work_order_id IS NULL
      AND event.occurred_at >= verification.detected_at
      AND event.stage IN ('human-verification-completed', 'pdd-session-recovered')
      AND NOT (
        coalesce(event.payload->'snapshot'->'verificationLocation'->>'status', '')
          IN ('detected', 'waiting-human', 'verification-required')
        AND event.payload->'snapshot'->'verificationLocation'->>'resolvedAt' IS NULL
      )
    ORDER BY event.occurred_at
    LIMIT 1
  ) completion ON true
  WHERE verification.work_order_id IS NULL
    AND verification.ordinary_instance_id IS NULL
    AND verification.system_name = 'pdd'
    AND verification.status IN ('detected', 'waiting-human', 'verification-required')
    AND verification.resolved_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM verification_locations newer
      WHERE newer.shop_id = verification.shop_id
        AND newer.system_name = verification.system_name
        AND newer.detected_at > completion.occurred_at
        AND newer.status IN ('detected', 'waiting-human', 'verification-required')
        AND newer.resolved_at IS NULL
    )
  FOR UPDATE OF verification
), resolved AS (
  UPDATE verification_locations verification SET
    status = 'resolved',
    resolved_at = coalesce(verification.resolved_at, candidate.completed_at)
  FROM candidates candidate
  WHERE verification.id = candidate.id
  RETURNING verification.id,
    candidate.shop_id,
    candidate.stage,
    candidate.detected_at,
    candidate.completed_at
)
INSERT INTO audit_events
  (shop_id, actor_id, event_type, payload, deduplication_key)
SELECT resolved.shop_id,
  'migration-262',
  'shop-level-verification-completion-reconciled',
  jsonb_build_object(
    'verificationId', resolved.id,
    'stage', resolved.stage,
    'detectedAt', resolved.detected_at,
    'completedAt', resolved.completed_at,
    'strategy', 'later-same-shop-verification-completion-event'
  ),
  'migration-262:shop-level-verification:' || resolved.id::text
FROM resolved
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('262_reconcile_shop_level_verification_completion.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
