BEGIN;

-- A saved PDD detail URL can remain after the exact pending-order query has
-- stopped returning the case. Requeue exhausted render failures so the runtime
-- can apply the refreshed exact-zero completion rule before reopening the stale
-- deep link. Never touch a live lease or an unresolved/submitted PDD effect.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      nullif(work_order.manual_review_reason, ''),
      nullif(work_order.payload->>'error', ''),
      nullif(work_order.payload#>>'{transientWorkflowRecovery,lastReason}', ''),
      ''
    ) AS reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready', 'failed')
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND coalesce(work_order.payload->>'detailUrl', '')
      LIKE 'https://mms.pinduoduo.com/aftersales/work_order/tododetail%'
    AND coalesce(
      nullif(work_order.manual_review_reason, ''),
      nullif(work_order.payload->>'error', ''),
      nullif(work_order.payload#>>'{transientWorkflowRecovery,lastReason}', ''),
      ''
    ) ~ '^(拼多多普通工单详情订单号渲染刷新后等待 [0-9]+ 毫秒仍未出现有效结果|目标工单不在待处理列表，且已验证详情无法确认订单号: .+)$'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('reserved', 'succeeded', 'unknown')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'stale-detail-pending-absence-recheck-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'transientWorkflowRecovery')
      || jsonb_build_object(
        'step', 'stale-detail-pending-absence-recheck-ready',
        'staleDetailAbsenceRecovery150', jsonb_build_object(
          'previousReason', candidate.reason,
          'strategy', 'refreshed-exact-pending-query-before-saved-detail',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'stale-detail-pending-absence-recheck-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-150', 'stale-detail-pending-absence-loop-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.reason,
      'strategy', 'refreshed-exact-pending-query-before-saved-detail'
    ),
    'migration-150:stale-detail-pending-absence:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-150')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('150_recover_stale_saved_detail_absence_loops.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
