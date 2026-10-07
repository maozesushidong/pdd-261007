BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason,
    CASE
      WHEN work_order.current_step = 'manual-review-blocked'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '%阶段: pdd-resolution-outcome-mismatch%'
        AND work_order.payload#>>'{pddResolutionFlow,flowCode}' = 'subjective-intercept'
        AND work_order.payload#>>'{pddResolutionOutcomeMismatch,expectedOutcome}' =
          work_order.payload#>>'{pddResolutionFlow,tertiaryOutcome}'
        AND (
          work_order.payload#>>'{pddResolutionOutcomeMismatch,completedOutcome}' =
            work_order.payload#>>'{pddResolutionDecision,outcome}'
          OR (
            work_order.payload#>>'{pddResolutionOutcomeMismatch,completedOutcome}'
              IN ('同意退款', '已同意退货退款')
            AND work_order.payload#>>'{pddResolutionDecision,outcome}'
              IN ('同意退款', '已同意退货退款')
          )
        )
        THEN 'subjective-intercept-top-level-outcome'
      WHEN work_order.current_step = 'flow-paused'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '%拼多多普通工单完结查询渲染刷新后等待 30000 毫秒仍未出现有效结果%'
        THEN 'completion-query-render-timeout'
      WHEN work_order.current_step = 'flow-paused'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '%locator.fill: Timeout%请输入订单编号%'
        THEN 'completion-query-input-timeout'
      ELSE NULL
    END AS recovery_kind
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.payload ? 'pddEvidenceOptionalRecovery'
    AND (
      (
        work_order.current_step = 'manual-review-blocked'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '%阶段: pdd-resolution-outcome-mismatch%'
        AND work_order.payload#>>'{pddResolutionFlow,flowCode}' = 'subjective-intercept'
        AND work_order.payload#>>'{pddResolutionOutcomeMismatch,expectedOutcome}' =
          work_order.payload#>>'{pddResolutionFlow,tertiaryOutcome}'
        AND (
          work_order.payload#>>'{pddResolutionOutcomeMismatch,completedOutcome}' =
            work_order.payload#>>'{pddResolutionDecision,outcome}'
          OR (
            work_order.payload#>>'{pddResolutionOutcomeMismatch,completedOutcome}'
              IN ('同意退款', '已同意退货退款')
            AND work_order.payload#>>'{pddResolutionDecision,outcome}'
              IN ('同意退款', '已同意退货退款')
          )
        )
      )
      OR (
        work_order.current_step = 'flow-paused'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '%拼多多普通工单完结查询渲染刷新后等待 30000 毫秒仍未出现有效结果%'
      )
      OR (
        work_order.current_step = 'flow-paused'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '%locator.fill: Timeout%请输入订单编号%'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
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
    current_step = 'optional-evidence-followup-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'pddResolutionOutcomeMismatch')
      || jsonb_build_object(
        'step', 'optional-evidence-followup-retry-ready',
        'pddEvidenceFollowupRecovery', jsonb_build_object(
          'previousReason', candidate.reason,
          'recoveryKind', candidate.recovery_kind,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
    AND candidate.recovery_kind IS NOT NULL
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason,
    candidate.recovery_kind
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-081', 'optional-evidence-followup-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'recoveryKind', recovered.recovery_kind
  ),
  'migration-081:optional-evidence-followup:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'optional-evidence-followup-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'pddResolutionOutcomeMismatch')
    || jsonb_build_object(
      'step', 'optional-evidence-followup-retry-ready',
      'pddEvidenceFollowupRecovery', work_order.payload->'pddEvidenceFollowupRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'optional-evidence-followup-retry-ready'
  AND work_order.payload ? 'pddEvidenceFollowupRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-081')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'optional-evidence-followup-retry-ready'
  AND work_order.payload ? 'pddEvidenceFollowupRecovery';

COMMIT;
