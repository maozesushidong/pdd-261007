BEGIN;

WITH resumed AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready', runtime_status = 'retry-ready',
    current_step = 'recovery-resume-requested',
    payload = jsonb_set(
      jsonb_set(
        coalesce(work_order.payload, '{}'::jsonb) - 'externalStateReconciliation',
        '{step}',
        '"recovery-resume-requested"'::jsonb,
        true
      ),
      '{frontendVisibility}',
      '"recovery-audit"'::jsonb,
      true
    ),
    manual_review_reason = NULL, next_attempt_at = now(),
    recovery_state = 'ready', recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(), updated_at = now()
  WHERE work_order.current_step = 'external-state-unresolved'
    AND work_order.payload->'externalStateReconciliation'->'pageState'->>'isPending' = 'true'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.recovery_version
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'recovery-pending-resume', 'work-order-recovery-released',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', 'pdd-detail-confirmed-pending-without-external-effects',
    'recoveryVersion', recovery_version
  ),
  'migration-021:pending-resumed:' || id::text
FROM resumed
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resumed AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready', runtime_status = 'retry-ready',
    current_step = 'recovery-resume-requested',
    payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb),
      '{step}',
      '"recovery-resume-requested"'::jsonb,
      true
    ),
    manual_review_reason = NULL, next_attempt_at = now(),
    recovery_state = 'ready', recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(), updated_at = now()
  WHERE work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND work_order.external_order_number IN (
      '260730-531711946390061',
      '260730-010527710722780'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.recovery_version
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'recovery-transient-resume', 'work-order-recovery-released',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', 'transient-browser-or-oms-read-failure',
    'recoveryVersion', recovery_version
  ),
  'migration-021:transient-resumed:' || id::text
FROM resumed
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
