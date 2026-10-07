BEGIN;

-- Reuse an existing TMS intervention only when one exact row proves that the
-- parcel was already intercepted and the current decision is the standard
-- low-value refund path. The final PDD submit must never have started.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.external_order_number = '260808-222277168790487'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.current_step = 'manual-review-blocked'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) LIKE '%tms-ticket-recovery%'
    AND work_order.payload#>>'{tmsDuplicateCheck,candidateCount}' = '1'
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,expectedProblemType}' = '丢件'
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,expectedRemark}' = '低值品，按丢件处理'
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,actualProblemType}' = '拦截退回'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,任务状态}' = '已完成'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,快递回复结果}' = '已拦截'
    AND work_order.payload#>>'{tmsFormDecision,isLowValue}' = 'true'
    AND work_order.payload#>>'{tmsFormDecision,precedence}' = 'low-value'
    AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
        AND (
          effect.status IN ('reserved', 'unknown')
          OR effect.effect_type = 'pdd-submit'
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'completed-intercept-low-value-refund-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'completed-intercept-low-value-refund-retry-ready',
        'completedInterceptLowValueRefundRecovery160', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'strategy', 'reuse-unique-completed-intercept-before-low-value-refund',
          'recoveredAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'completed-intercept-low-value-refund-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-160', 'completed-intercept-low-value-refund-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', 'reuse-unique-completed-intercept-before-low-value-refund',
      'finalPddSubmitStarted', false
    ),
    'migration-160:completed-intercept-low-value-refund:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-160')
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
VALUES ('160_recover_completed_intercept_low_value_refund.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
