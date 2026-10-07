\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:resolve-terminal-return-refund-verification-residue-273')
);

-- This exact challenge remained active after the associated refund and work
-- order had both reached an authoritative terminal state. Resolve only the
-- stale authentication record; do not replay or change any business action.
WITH expected (
  verification_id,
  shop_id,
  order_number,
  aftersale_number
) AS (
  VALUES (
    '083473ea-e13b-4cb1-a0be-64af2de23aa4'::uuid,
    'shop-mt9v5wwf-54c76c'::text,
    '260823-044323315252257'::text,
    '22384032549329'::text
  )
), candidates AS MATERIALIZED (
  SELECT verification.id,
    verification.shop_id,
    verification.work_order_id,
    verification.ordinary_instance_id,
    verification.stage,
    verification.detected_at,
    work_order.external_order_number,
    refund.aftersale_number,
    refund.action_state,
    refund.completed_at
  FROM expected
  JOIN verification_locations verification
    ON verification.id = expected.verification_id
    AND verification.shop_id = expected.shop_id
    AND verification.system_name = 'pdd'
    AND verification.stage = 'return-refund-close-detail-before'
    AND verification.status IN (
      'detected',
      'waiting-human',
      'verification-required'
    )
    AND verification.resolved_at IS NULL
    AND verification.work_order_id IS NOT NULL
  JOIN work_orders work_order
    ON work_order.id = verification.work_order_id
    AND work_order.shop_id = verification.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status = 'completed'
    AND work_order.runtime_status = 'completed'
    AND work_order.current_step = 'return-refund-read-only-complete'
    AND work_order.completion_state = 'confirmed'
    AND work_order.completion_confirmation_method IS NOT NULL
  JOIN return_refunds refund
    ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
    AND refund.aftersale_number = expected.aftersale_number
    AND refund.action_state = 'manual-completed'
    AND refund.completed_at IS NOT NULL
  WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1 FROM verification_locations other
      WHERE other.shop_id = verification.shop_id
        AND other.work_order_id = verification.work_order_id
        AND other.id <> verification.id
        AND other.status IN (
          'detected',
          'waiting-human',
          'verification-required'
        )
        AND other.resolved_at IS NULL
    )
  FOR UPDATE OF verification
), resolved_verifications AS (
  UPDATE verification_locations verification
  SET status = 'resolved',
    resolved_at = coalesce(verification.resolved_at, now())
  FROM candidates candidate
  WHERE verification.id = candidate.id
  RETURNING candidate.*,
    verification.resolved_at
), resolved_interventions AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, resolved.resolved_at),
    resolved_by = coalesce(intervention.resolved_by, 'migration-273')
  FROM resolved_verifications resolved
  WHERE intervention.shop_id = resolved.shop_id
    AND intervention.work_order_id = resolved.work_order_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code IN (
      'verification-required',
      'return-refund-verification-required'
    )
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id IS NOT DISTINCT FROM
        resolved.ordinary_instance_id
    )
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'terminal-return-refund-verification-resolved-273'
    )
  FROM resolved_interventions intervention
  WHERE outbox.intervention_id = intervention.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
     payload, deduplication_key)
  SELECT resolved.shop_id,
    resolved.work_order_id,
    resolved.ordinary_instance_id,
    'migration-273',
    'terminal-return-refund-verification-resolved',
    jsonb_build_object(
      'verificationId', resolved.id,
      'orderNumber', resolved.external_order_number,
      'aftersaleNumber', resolved.aftersale_number,
      'stage', resolved.stage,
      'detectedAt', resolved.detected_at,
      'resolvedAt', resolved.resolved_at,
      'refundActionState', resolved.action_state,
      'refundCompletedAt', resolved.completed_at,
      'externalActionsReplayed', false,
      'strategy', 'exact-terminal-refund-state-reconciliation'
    ),
    'migration-273:terminal-return-refund-verification:' || resolved.id::text
  FROM resolved_verifications resolved
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
SELECT count(*) AS resolved_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', external_order_number,
    'aftersaleNumber', aftersale_number,
    'verificationId', id
  ) ORDER BY shop_id, external_order_number) AS resolved_verifications
FROM resolved_verifications;

INSERT INTO schema_migrations (version)
VALUES ('273_resolve_terminal_return_refund_verification_residue.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
