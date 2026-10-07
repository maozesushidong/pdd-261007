\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:archive-confirmed-return-refund-duplicate-293')
);

-- One legacy discovery row was reused as a return-refund queue item after a
-- separate, aftersale-bound work order had already reached an authoritative
-- terminal state. Quarantine only this exact stale row. No PDD, OMS, or TMS
-- action is replayed by this migration.
CREATE TEMP TABLE migration_293_candidates ON COMMIT DROP AS
WITH expected (
  stale_work_order_id,
  stale_instance_id,
  authoritative_work_order_id,
  shop_id,
  order_number,
  aftersale_number
) AS (
  VALUES (
    '8e53bcd2-b3b0-4f44-9c3f-e9ed20bf7b51'::uuid,
    'ece76f93-c992-4d63-9262-eeefb906d043'::uuid,
    '3911a128-2df0-45fd-bf45-841b230fd14d'::uuid,
    'shop-msrd6wm5-1af283'::text,
    '260819-615398848931401'::text,
    '22488883624746'::text
  )
)
SELECT
  stale.id,
  stale.shop_id,
  stale.external_order_number,
  stale.current_ordinary_instance_id,
  authoritative.id AS authoritative_work_order_id,
  refund.aftersale_number,
  stale.status AS previous_status,
  stale.runtime_status AS previous_runtime_status,
  stale.current_step AS previous_step
FROM expected
JOIN work_orders stale
  ON stale.id = expected.stale_work_order_id
  AND stale.shop_id = expected.shop_id
  AND stale.external_order_number = expected.order_number
  AND stale.current_ordinary_instance_id = expected.stale_instance_id
  AND stale.scenario_code = 'return-refund'
  AND stale.idempotency_key =
    'pdd-discovered:shop-msrd6wm5-1af283:260819-615398848931401:消费者担忧货物无法送达'
  AND stale.status = 'queued'
  AND stale.runtime_status = 'queued'
  AND stale.current_step = 'pdd-discovered'
  AND stale.completion_state = 'pending'
  AND coalesce(stale.frontend_visibility, 'operational') = 'operational'
  AND stale.recovery_state = 'ready'
JOIN ordinary_work_order_instances instance
  ON instance.id = expected.stale_instance_id
  AND instance.work_order_id = stale.id
  AND instance.shop_id = stale.shop_id
  AND instance.work_order_type = '退货退款'
  AND instance.scenario_code = 'return-refund'
  AND instance.runtime_status = 'queued'
  AND instance.current_step = 'pdd-discovered'
JOIN work_orders authoritative
  ON authoritative.id = expected.authoritative_work_order_id
  AND authoritative.shop_id = stale.shop_id
  AND authoritative.external_order_number = stale.external_order_number
  AND authoritative.scenario_code = 'return-refund'
  AND authoritative.status = 'completed'
  AND authoritative.runtime_status = 'completed'
  AND authoritative.current_step = 'return-refund-read-only-complete'
  AND authoritative.completion_state = 'confirmed'
  AND coalesce(authoritative.frontend_visibility, 'operational') = 'operational'
JOIN return_refunds refund
  ON refund.work_order_id = authoritative.id
  AND refund.shop_id = authoritative.shop_id
  AND refund.external_order_number = authoritative.external_order_number
  AND refund.aftersale_number = expected.aftersale_number
  AND refund.action_state = 'manual-completed'
  AND refund.decision = 'manual-completed'
  AND refund.completed_at IS NOT NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM external_effects effect
    WHERE effect.work_order_id = stale.id
      AND effect.status IN ('reserved', 'unknown')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM external_effects effect
    WHERE effect.work_order_id = stale.id
      AND effect.ordinary_instance_id = expected.stale_instance_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM shop_runtime_state runtime
    WHERE runtime.current_work_order_id = stale.id
      AND runtime.lease_token IS NOT NULL
      AND runtime.lease_expires_at > now()
  )
  AND NOT EXISTS (
    SELECT 1
    FROM manual_interventions intervention
    WHERE intervention.work_order_id = stale.id
      AND intervention.status IN ('open', 'acknowledged')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM verification_locations verification
    WHERE verification.work_order_id = stale.id
      AND verification.status IN (
        'detected', 'waiting-human', 'verification-required'
      )
      AND verification.resolved_at IS NULL
  )
FOR UPDATE OF stale, instance, authoritative, refund;

DO $$
BEGIN
  IF (SELECT count(*) FROM migration_293_candidates) <> 1 THEN
    RAISE EXCEPTION
      'migration 293 expected exactly one proven stale duplicate candidate';
  END IF;
END;
$$;

WITH archived AS (
  UPDATE work_orders work_order
  SET status = 'archived',
    runtime_status = 'archived',
    current_step = 'superseded-duplicate',
    manual_review_reason = NULL,
    next_attempt_at = NULL,
    completion_state = 'not-applicable',
    completion_confirmation_method = 'superseded-duplicate',
    completion_confirmed_at = NULL,
    frontend_visibility = 'recovery-audit',
    recovery_state = 'held',
    recovery_reason = 'confirmed-return-refund-duplicate',
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'superseded-duplicate',
        'duplicateReconciliation', jsonb_build_object(
          'status', 'superseded',
          'reason', 'authoritative-aftersale-work-order-already-completed',
          'authoritativeWorkOrderId', candidate.authoritative_work_order_id,
          'aftersaleNumber', candidate.aftersale_number,
          'previousStatus', candidate.previous_status,
          'previousRuntimeStatus', candidate.previous_runtime_status,
          'previousCurrentStep', candidate.previous_step,
          'externalActionsReplayedByMigration', false,
          'reconciledAt', now()
        )
      ),
    updated_at = now()
  FROM migration_293_candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    candidate.authoritative_work_order_id,
    candidate.aftersale_number
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
     payload, deduplication_key)
  SELECT
    archived.shop_id,
    archived.id,
    archived.current_ordinary_instance_id,
    'migration-293',
    'confirmed-return-refund-duplicate-superseded',
    jsonb_build_object(
      'orderNumber', archived.external_order_number,
      'authoritativeWorkOrderId', archived.authoritative_work_order_id,
      'aftersaleNumber', archived.aftersale_number,
      'countedAsSuccess', false,
      'externalActionsReplayedByMigration', false,
      'strategy', 'exact-completed-aftersale-identity-reconciliation'
    ),
    'migration-293:confirmed-return-refund-duplicate:' || archived.id::text
  FROM archived
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
SELECT count(*) AS archived_count,
  jsonb_agg(jsonb_build_object(
    'shopId', archived.shop_id,
    'orderNumber', archived.external_order_number,
    'staleWorkOrderId', archived.id,
    'authoritativeWorkOrderId', archived.authoritative_work_order_id,
    'aftersaleNumber', archived.aftersale_number
  )) AS archived_orders,
  (SELECT count(*) FROM audited) AS audit_count
FROM archived;

INSERT INTO schema_migrations (version)
VALUES ('293_archive_confirmed_return_refund_duplicate.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
