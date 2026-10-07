BEGIN;

-- Older workers paused ordinary work orders when the TMS query was still
-- loading or the OMS SPA had mounted a temporarily non-editable query input.
-- Both failures happen before an external action. Requeue only pending
-- ordinary instances without a live lease or any possibly applied effect.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason,
    CASE
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~ '^TMS 订单无法唯一自动带出: (查询中|正在查询|加载中|正在加载|请稍候)(\.{3}|…)?$'
        THEN 'retry-tms-query-after-transient-loading-state'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~* '^TMS 订单无法唯一自动带出: [\s\S]*(500|502|503|504)[\s\S]*(internal server error|bad gateway|service unavailable|gateway time-?out)'
        THEN 'retry-tms-query-after-transient-gateway-error'
      ELSE 'retry-oms-query-after-editable-input-reacquisition'
    END AS strategy
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND (
      coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~ '^TMS 订单无法唯一自动带出: (查询中|正在查询|加载中|正在加载|请稍候)(\.{3}|…)?$'
      OR coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~* '^TMS 订单无法唯一自动带出: [\s\S]*(500|502|503|504)[\s\S]*(internal server error|bad gateway|service unavailable|gateway time-?out)'
      OR coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~ '^locator\.fill: Timeout [0-9]+ms exceeded\.[\s\S]*订单编号/交易号/配货单号[\s\S]*waiting for element to be visible, enabled and editable'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
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
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-transient-system-query-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'ordinary-transient-system-query-retry-ready',
        'transientWorkflowRecovery', jsonb_build_object(
          'count', 0,
          'maxAttempts', 5,
          'lastReason', candidate.previous_reason,
          'retryAt', now(),
          'recoveredAt', now(),
          'recoverySource', 'migration-181'
        ),
        'ordinaryTransientSystemQueryRecovery181', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', candidate.strategy,
          'previousReason', candidate.previous_reason,
          'recoveredAt', now()
        )
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
    candidate.strategy
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-transient-system-query-retry-ready',
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
    recovered.strategy
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-181',
    'ordinary-transient-system-query-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', recovered.strategy
    ),
    'migration-181:ordinary-transient-system-query:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-181')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code <> 'image-upload-failed'
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-transient-system-query-recovery-181'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('181_recover_transient_oms_tms_query_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
