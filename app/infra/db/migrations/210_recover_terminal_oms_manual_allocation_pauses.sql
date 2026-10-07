BEGIN;

-- An OMS order that is already voided, cancelled, or closed cannot expose the
-- manual-allocation action. Recover only strongly identified abnormal-network
-- orders with no allocation effect, then let the workflow report the terminal
-- OMS state to PDD instead of repeatedly looking for a nonexistent menu item.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason,
    coalesce(
      nullif(work_order.payload#>>'{omsAnalysis,orderStatus}', ''),
      nullif(work_order.payload->>'omsOrderStatus', ''),
      nullif(instance.payload#>>'{omsAnalysis,orderStatus}', ''),
      nullif(instance.payload->>'omsOrderStatus', ''),
      CASE upper(coalesce(
        work_order.payload#>>'{omsLiveOrderState,status}',
        instance.payload#>>'{omsLiveOrderState,status}',
        ''
      ))
        WHEN 'INVALID' THEN '作废'
        WHEN 'VOID' THEN '作废'
        WHEN 'CANCELLED' THEN '已取消'
        WHEN 'CANCELED' THEN '已取消'
        WHEN 'CLOSED' THEN '已关闭'
        ELSE NULL
      END
    ) AS terminal_order_status
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'abnormal-network-warning'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) LIKE 'OMS 订单行右键菜单未找到“手工配货”%'
    AND (
      coalesce(
        work_order.payload#>>'{omsAnalysis,orderStatus}',
        work_order.payload->>'omsOrderStatus',
        instance.payload#>>'{omsAnalysis,orderStatus}',
        instance.payload->>'omsOrderStatus',
        ''
      ) IN ('作废', '已取消', '已关闭')
      OR upper(coalesce(
        work_order.payload#>>'{omsLiveOrderState,status}',
        instance.payload#>>'{omsLiveOrderState,status}',
        ''
      )) IN ('INVALID', 'VOID', 'CANCELLED', 'CANCELED', 'CLOSED')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'oms-manual-allocation'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-terminal-order-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      - 'omsManualAllocation'
      - 'pddResolutionDecision'
    ) || jsonb_build_object(
      'step', 'oms-terminal-order-retry-ready',
      'omsTerminalOrderRecovery', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'skip-impossible-manual-allocation-and-report-terminal-order',
        'terminalOrderStatus', candidate.terminal_order_status,
        'previousReason', candidate.previous_reason,
        'recoveredAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason,
    candidate.terminal_order_status
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-terminal-order-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.previous_reason,
    recovered.terminal_order_status
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-210',
    'terminal-oms-manual-allocation-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'terminalOrderStatus', recovered.terminal_order_status,
      'previousReason', recovered.previous_reason,
      'strategy', 'skip-impossible-manual-allocation-and-report-terminal-order'
    ),
    'migration-210:terminal-oms-manual-allocation:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-210')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code NOT IN (
      'image-upload-failed',
      'pdd-upload-authorization-failed'
    )
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object('reason', 'automatic-safe-recovery-210')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('210_recover_terminal_oms_manual_allocation_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
