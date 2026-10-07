BEGIN;

-- Requeue deterministic ordinary pauses fixed by the current browser policy.
-- A matching completed PDD detail is authoritative and will be archived without
-- another submit. Render/login failures are read-only failures and are safe to
-- retry when no external effect remains reserved or unknown.
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
      WHEN coalesce(work_order.manual_review_reason, '')
        LIKE '%阶段: pdd-resolution-outcome-mismatch%'
        THEN 'accept-matching-platform-terminal-state'
      WHEN coalesce(work_order.manual_review_reason, '') = '拼多多登录后仍返回登录页'
        THEN 'recheck-confirmed-browser-authentication'
      ELSE 'retry-bounded-pdd-detail-render'
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
    AND work_order.current_step IN (
      'flow-paused',
      'manual-review-blocked',
      'pdd-resolution-outcome-mismatch'
    )
    AND (
      coalesce(work_order.manual_review_reason, '')
        ~ '^locator\.innerText: Timeout [0-9]+ms exceeded\.[\s\S]*(订单编号|订单号)'
      OR coalesce(work_order.manual_review_reason, '')
        ~ '^拼多多普通工单详情订单号渲染刷新后等待 [0-9]+ 毫秒仍未出现有效结果$'
      OR coalesce(work_order.manual_review_reason, '') = '拼多多登录后仍返回登录页'
      OR coalesce(work_order.manual_review_reason, '')
        LIKE '%阶段: pdd-resolution-outcome-mismatch%'
    )
    AND coalesce(work_order.manual_review_reason, '') NOT LIKE '%48143%'
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
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
    current_step = 'ordinary-policy-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'ordinary-policy-retry-ready',
        'transientWorkflowRecovery', jsonb_build_object(
          'count', 0,
          'maxAttempts', 5,
          'lastReason', candidate.previous_reason,
          'retryAt', now(),
          'recoveredAt', now(),
          'recoverySource', 'migration-175'
        ),
        'ordinaryPolicyRecovery175', jsonb_build_object(
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
    current_step = 'ordinary-policy-retry-ready',
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
    'migration-175',
    'ordinary-terminal-or-transient-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', recovered.strategy
    ),
    'migration-175:ordinary-terminal-or-transient:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-175')
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
  last_error = jsonb_build_object('reason', 'automatic-policy-recovery-175')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('175_recover_terminal_and_transient_ordinary_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
