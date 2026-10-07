BEGIN;

-- Requeue only rows whose persisted evidence already satisfies every stable
-- core rule. The worker still rereads the live detail page and reevaluates the
-- policy before it is allowed to click the irreversible refund action.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready')
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND refund.action_state = 'manual-review'
    AND refund.detail_url IS NOT NULL
    AND refund.action_button_visible = true
    AND refund.aftersale_type = '退货退款'
    AND coalesce(refund.aftersale_status, '') LIKE '%待商家%'
    AND refund.refund_amount >= 0
    AND refund.refund_amount < 500
    AND refund.latest_logistics_at IS NOT NULL
    AND NOT (coalesce(refund.aftersale_status, '') LIKE ANY (ARRAY[
      '%退款成功%', '%退款完成%', '%售后完成%', '%售后关闭%',
      '%平台已退款%', '%已退款%', '%已关闭%', '%交易关闭%'
    ]))
    AND work_order.manual_review_reason IN (
      '当前时间距最新物流节点超过72小时',
      '物流首尾时间跨度超过72小时，任一节点仍未出现长沙或衡水冀州'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
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
    next_check_at = NULL,
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'agingPolicyRecovery117', jsonb_build_object(
        'strategy', 'live-rule-recheck-before-auto-refund',
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id, candidate.shop_id,
    candidate.external_order_number, candidate.aftersale_number,
    candidate.previous_reason
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'queued',
    runtime_status = 'queued',
    current_step = 'return-refund-ready',
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = NULL,
    classification_updated_at = now(),
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-ready',
        'agingPolicyRecovery117', jsonb_build_object(
          'aftersaleNumber', recovered_refund.aftersale_number,
          'previousReason', recovered_refund.previous_reason,
          'strategy', 'live-rule-recheck-before-auto-refund',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered_refunds recovered_refund
  WHERE work_order.id = recovered_refund.work_order_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    recovered_refund.aftersale_number, recovered_refund.previous_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-117',
  'return-refund-aging-policy-review-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'previousReason', recovered.previous_reason,
    'strategy', 'live-rule-recheck-before-auto-refund'
  ),
  'migration-117:return-refund-aging-policy:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-117')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND work_order.current_step = 'return-refund-ready'
    AND work_order.payload ? 'agingPolicyRecovery117'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

UPDATE scenario_definitions
SET policy_version = greatest(policy_version, 5),
  config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
    'staleLogisticsOver72HoursDecision', 'auto-refund-when-core-rules-pass',
    'directionTimeoutOver72HoursDecision', 'auto-refund-when-core-rules-pass'
  ),
  updated_at = now()
WHERE code = 'return-refund';

COMMIT;
