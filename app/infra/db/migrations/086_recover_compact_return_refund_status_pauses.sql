BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, work_order.manual_review_reason AS reason
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'return-refund-manual-review'
    AND work_order.manual_review_reason = '售后状态不包含“待商家”'
    AND refund.action_state = 'manual-review'
    AND refund.aftersale_status IS NULL
    AND refund.action_button_visible = true
    AND refund.detail_url IS NOT NULL
    AND refund.evidence#>>'{fieldSources,aftersaleType,value}' LIKE '退货退款%待商家%'
    AND refund.rule_results#>>'{type,passed}' = 'true'
    AND refund.rule_results#>>'{status,passed}' = 'false'
    AND refund.rule_results#>>'{amount,passed}' = 'true'
    AND refund.rule_results#>>'{destination,passed}' = 'true'
    AND refund.rule_results#>>'{logisticsAge,passed}' = 'true'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered_refunds AS (
  UPDATE return_refunds refund
  SET action_state = 'ready',
    decision = 'auto-refund',
    risk_level = NULL,
    next_check_at = now(),
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'compactStatusRecovery', jsonb_build_object(
        'strategy', 're-read-live-detail-before-refund',
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id, candidate.shop_id,
    candidate.external_order_number, candidate.aftersale_number, candidate.reason
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'compact-return-refund-status-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'compact-return-refund-status-retry-ready',
        'compactReturnRefundStatusRecovery', jsonb_build_object(
          'previousReason', recovered_refund.reason,
          'aftersaleNumber', recovered_refund.aftersale_number,
          'strategy', 're-read-live-detail-before-refund',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered_refunds recovered_refund
  WHERE work_order.id = recovered_refund.work_order_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    recovered_refund.aftersale_number, recovered_refund.reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-086',
  'compact-return-refund-status-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'previousReason', recovered.reason,
    'strategy', 're-read-live-detail-before-refund'
  ),
  'migration-086:compact-return-refund-status:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-086')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'return-refund-manual-review'
    AND work_order.current_step = 'compact-return-refund-status-retry-ready'
    AND work_order.payload ? 'compactReturnRefundStatusRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
