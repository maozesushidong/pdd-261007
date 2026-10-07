BEGIN;

-- A TMS create interrupted after submission can leave an unknown effect. When
-- an exact-order read-only query returns duplicate rows, use the first visible
-- row authorized by the business rule and verify its identity before resuming.
-- The unknown effect is intentionally preserved so no TMS create is replayed.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    work_order.payload #>> '{externalStateReconciliation,candidateCount}'
      AS previous_candidate_count
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND coalesce(work_order.runtime_status, work_order.status) = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.recovery_state = 'held'
    AND work_order.payload->>'orderNumber' = work_order.external_order_number
    AND work_order.payload #>> '{externalStateReconciliation,effectType}' = 'tms-create'
    AND work_order.payload #>> '{externalStateReconciliation,state}' = 'unresolved'
    AND coalesce(
      work_order.payload #>> '{externalStateReconciliation,reason}',
      work_order.manual_review_reason,
      ''
    ) ~ '^TMS 精确查询到 ([2-9]|[1-9][0-9]+) 条同订单记录，无法唯一核对中断前的创建结果$'
    AND coalesce(
      work_order.payload #>> '{externalStateReconciliation,candidateCount}',
      '0'
    ) ~ '^([2-9]|[1-9][0-9]+)$'
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND effect.effect_type = 'tms-create'
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND effect.effect_type IN (
          'oms-manual-allocation', 'oms-reissue-create', 'pdd-submit'
        )
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对 TMS 第一条同订单记录，禁止重复建单',
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = work_order.recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error'
    ) || jsonb_build_object(
      'step', 'external-state-reconciliation-ready',
      'externalStateReconciliationTarget', jsonb_build_object(
        'effectType', 'tms-create',
        'status', 'unknown',
        'strategy', 'read-only-first-exact-order-user-authorized'
      ),
      'externalStateReconciliationRetry', jsonb_build_object(
        'attempts', 0,
        'maxAttempts', 6,
        'resetAt', now(),
        'recoverySource', 'migration-227'
      ),
      'tmsCreateReconciliation',
        coalesce(work_order.payload->'tmsCreateReconciliation', '{}'::jsonb)
        || jsonb_build_object(
          'status', 'retry-ready',
          'selectionStrategy', 'read-only-first-exact-order-user-authorized',
          'selectedIndex', 0,
          'candidateCount', candidate.previous_candidate_count,
          'recoveredAt', now()
        ),
      'tmsDuplicateRecordRecovery227', jsonb_build_object(
        'status', 'reconciliation-ready',
        'previousReason', candidate.previous_reason,
        'candidateCount', candidate.previous_candidate_count,
        'selectedIndex', 0,
        'externalEffectPreserved', true,
        'externalActionsReplayed', false,
        'recoveredAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason,
    candidate.previous_candidate_count
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-ready',
    manual_review_reason = '等待只读核对 TMS 第一条同订单记录，禁止重复建单',
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING
    recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.previous_reason,
    recovered.previous_candidate_count
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT
  recovered.shop_id,
  recovered.id,
  recovered.current_ordinary_instance_id,
  'migration-227',
  'duplicate-tms-first-row-reconciliation-ready',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.previous_reason,
    'candidateCount', recovered.previous_candidate_count,
    'selectedIndex', 0,
    'strategy', 'read-only-first-exact-order-user-authorized',
    'externalEffectPreserved', true,
    'externalActionsReplayed', false
  ),
  'migration-227:duplicate-tms-first-row:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('227_reconcile_duplicate_tms_rows_by_first_match.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
