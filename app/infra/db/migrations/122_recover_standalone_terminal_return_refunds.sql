BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, refund.aftersale_status,
    work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready')
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND refund.action_state = 'manual-review'
    AND refund.action_button_visible = false
    AND refund.detail_url IS NOT NULL
    AND btrim(refund.aftersale_status) = ANY (ARRAY[
      '退款成功', '退款完成', '售后完成', '售后关闭',
      '平台已退款', '已退款', '已关闭', '交易关闭'
    ])
    AND nullif(refund.aftersale_number, '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered_refunds AS (
  UPDATE return_refunds refund
  SET next_check_at = now(),
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'standaloneTerminalStatusRecovery', jsonb_build_object(
        'strategy', 'read-only-standalone-terminal-status-reconciliation',
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id, candidate.shop_id,
    candidate.external_order_number, candidate.aftersale_number,
    candidate.aftersale_status, candidate.previous_reason
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'return-refund-terminal-reconciliation-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-terminal-reconciliation-ready',
        'standaloneTerminalStatusRecovery', jsonb_build_object(
          'aftersaleNumber', recovered_refund.aftersale_number,
          'aftersaleStatus', recovered_refund.aftersale_status,
          'previousReason', recovered_refund.previous_reason,
          'strategy', 'read-only-standalone-terminal-status-reconciliation',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered_refunds recovered_refund
  WHERE work_order.id = recovered_refund.work_order_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    recovered_refund.aftersale_number, recovered_refund.aftersale_status,
    recovered_refund.previous_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-122',
  'return-refund-standalone-terminal-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'aftersaleStatus', recovered.aftersale_status,
    'previousReason', recovered.previous_reason,
    'strategy', 'read-only-standalone-terminal-status-reconciliation'
  ),
  'migration-122:return-refund-standalone-terminal:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-122')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND work_order.current_step = 'return-refund-terminal-reconciliation-ready'
    AND work_order.payload ? 'standaloneTerminalStatusRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
