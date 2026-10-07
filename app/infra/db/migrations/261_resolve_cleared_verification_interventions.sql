BEGIN;

-- Close only authentication-assistance records backed by a resolved challenge.
-- Business interventions and active challenges remain untouched.
WITH candidates AS MATERIALIZED (
  SELECT intervention.id,
    intervention.shop_id,
    intervention.work_order_id,
    intervention.ordinary_instance_id,
    work_order.external_order_number,
    resolved_verification.resolved_at AS verification_resolved_at
  FROM manual_interventions intervention
  JOIN work_orders work_order
    ON work_order.id = intervention.work_order_id
   AND work_order.shop_id = intervention.shop_id
  JOIN LATERAL (
    SELECT max(verification.resolved_at) AS resolved_at
    FROM verification_locations verification
    WHERE verification.shop_id = intervention.shop_id
      AND verification.work_order_id = intervention.work_order_id
      AND verification.ordinary_instance_id IS NOT DISTINCT FROM
        coalesce(intervention.ordinary_instance_id, work_order.current_ordinary_instance_id)
      AND verification.status IN ('resolved', 'expired')
      AND verification.resolved_at IS NOT NULL
      AND verification.resolved_at >= intervention.created_at
  ) resolved_verification ON resolved_verification.resolved_at IS NOT NULL
  WHERE intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code IN (
      'verification-required',
      'return-refund-verification-required'
    )
    AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.current_step NOT IN (
      'human-verification-required',
      'manual-login-required',
      'required-login'
    )
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id IS NOT DISTINCT FROM
        work_order.current_ordinary_instance_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM verification_locations active_verification
      WHERE active_verification.shop_id = intervention.shop_id
        AND active_verification.work_order_id = intervention.work_order_id
        AND active_verification.ordinary_instance_id IS NOT DISTINCT FROM
          coalesce(intervention.ordinary_instance_id, work_order.current_ordinary_instance_id)
        AND active_verification.status IN (
          'detected',
          'waiting-human',
          'verification-required'
        )
        AND active_verification.resolved_at IS NULL
    )
  FOR UPDATE OF intervention
), resolved AS (
  UPDATE manual_interventions intervention SET
    status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, candidate.verification_resolved_at),
    resolved_by = coalesce(intervention.resolved_by, 'migration-261')
  FROM candidates candidate
  WHERE intervention.id = candidate.id
  RETURNING intervention.id,
    candidate.shop_id,
    candidate.work_order_id,
    candidate.ordinary_instance_id,
    candidate.external_order_number,
    candidate.verification_resolved_at
), cancelled AS (
  UPDATE notification_outbox outbox SET
    status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object('reason', 'verification-resolved-auto-close-261')
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT resolved.shop_id,
  resolved.work_order_id,
  resolved.ordinary_instance_id,
  'migration-261',
  'cleared-verification-intervention-resolved',
  jsonb_build_object(
    'orderNumber', resolved.external_order_number,
    'verificationResolvedAt', resolved.verification_resolved_at,
    'strategy', 'close-auth-assistance-without-changing-business-state'
  ),
  'migration-261:verification-intervention:' || resolved.id::text
FROM resolved
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('261_resolve_cleared_verification_interventions.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
