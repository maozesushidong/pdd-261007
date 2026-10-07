BEGIN;

-- PDD can abort a controlled remark-page reload when its SPA replaces the
-- current frame. Requeue only identity-bound ordinary instances whose external
-- effects are fully known and whose PDD remark/submit has not already run.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason,
    coalesce((work_order.payload#>>'{transientWorkflowRecovery,count}')::integer, 0)
      AS retry_count
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
    AND work_order.current_step IN ('flow-paused', 'manual-review-blocked')
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      LIKE '%pdd-order-remark%'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      LIKE '%page.reload: net::ERR_ABORTED%'
    AND coalesce((work_order.payload#>>'{transientWorkflowRecovery,count}')::integer, 0) < 3
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
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type IN ('pdd-note', 'pdd-submit')
        AND effect.status = 'succeeded'
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
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'transient-workflow-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'transient-workflow-retry-ready',
        'transientWorkflowRecovery', jsonb_build_object(
          'count', candidate.retry_count + 1,
          'maxAttempts', 3,
          'lastReason', candidate.reason,
          'retryAt', now(),
          'recoveredAt', now(),
          'recoverySource', 'migration-167'
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
    candidate.reason,
    candidate.retry_count + 1 AS retry_count
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'transient-workflow-retry-ready',
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
    recovered.reason,
    recovered.retry_count
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-167',
    'pdd-order-remark-reload-abort-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.reason,
      'recoveryAttempt', recovered.retry_count,
      'maxAttempts', 3,
      'strategy', 'inspect-after-aborted-spa-reload'
    ),
    'migration-167:pdd-order-remark-reload-abort:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-167')
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
SET status = 'cancelled',
  updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('167_recover_pdd_order_remark_reload_abort.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
