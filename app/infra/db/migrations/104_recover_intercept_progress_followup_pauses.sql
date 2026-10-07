BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'manual-review-blocked'
    AND work_order.manual_review_reason LIKE '%拼多多未找到必选处理结果: 同意退款%'
    AND work_order.payload->'pddResolutionRecovery'->>'status' = 'exhausted'
    AND work_order.payload->'pddResolutionDecision'->>'flowCode' = 'primary-refund'
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
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
    current_step = 'pdd-intercept-progress-followup-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'pddResolutionRecovery' - 'pddResolutionFlow')
      || jsonb_build_object(
        'step', 'pdd-intercept-progress-followup-retry-ready',
        'updatedAt', now(),
        'interceptProgressFollowupRecovery', jsonb_build_object(
          'strategy', 'detect-rendered-intercept-progress-options',
          'defaultOutcome', '快递还在拦截中',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-104', 'intercept-progress-followup-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'strategy', 'detect-rendered-intercept-progress-options'
  ),
  'migration-104:intercept-progress-followup:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'pdd-intercept-progress-followup-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = coalesce(work_order.payload, '{}'::jsonb),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'pdd-intercept-progress-followup-retry-ready'
  AND work_order.payload ? 'interceptProgressFollowupRecovery';

COMMIT;
