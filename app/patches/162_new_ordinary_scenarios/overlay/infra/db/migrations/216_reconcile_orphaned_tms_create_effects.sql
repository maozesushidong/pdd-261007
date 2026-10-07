BEGIN;

-- A worker can stop after reserving tms-create but before it persists the API
-- response. Never replay that POST blindly. Move the order into the resident
-- browser's read-only TMS reconciliation queue instead.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready')
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.shop_id = work_order.shop_id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), uncertain_effects AS (
  UPDATE external_effects effect SET
    status = 'unknown',
    error = coalesce(effect.error, '{}'::jsonb) || jsonb_build_object(
      'reason', 'orphaned-tms-create-requires-read-only-reconciliation',
      'markedUnknownAt', now(),
      'recoverySource', 'migration-216'
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE effect.work_order_id = candidate.id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM
      candidate.current_ordinary_instance_id
    AND effect.effect_type = 'tms-create'
    AND effect.status = 'reserved'
  RETURNING effect.id
), recovered AS (
  UPDATE work_orders work_order SET
    status = 'paused', runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对 TMS 建单结果，禁止重复建单',
    next_attempt_at = now(), recovery_state = 'ready', recovery_reason = NULL,
    recovery_version = recovery_version + 1, recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview')
      || jsonb_build_object(
        'step', 'external-state-reconciliation-ready',
        'externalStateReconciliationTarget', jsonb_build_object(
          'effectType', 'tms-create',
          'status', 'unknown',
          'strategy', 'read-only-tms-exact-order-query'
        ),
        'tmsCreateOrphanRecovery', jsonb_build_object(
          'status', 'reconciliation-ready',
          'strategy', 'unique-match-or-refreshed-two-pass-zero-result',
          'recoveredAt', now(),
          'recoverySource', 'migration-216'
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance SET
    status = 'paused', runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对 TMS 建单结果，禁止重复建单',
    next_attempt_at = now(), payload = recovered.payload, updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.id, recovered.shop_id,
    recovered.external_order_number, recovered.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-216', 'orphaned-tms-create-reconciliation-ready',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'strategy', 'read-only-tms-exact-order-query-no-blind-replay'
  ),
  'migration-216:orphaned-tms-create:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('216_reconcile_orphaned_tms_create_effects.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
