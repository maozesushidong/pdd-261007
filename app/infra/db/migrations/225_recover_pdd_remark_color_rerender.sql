BEGIN;

-- A PDD remark color click can be lost while the editor re-renders. Resume
-- only the exact pre-save failure and only when no PDD mutation was ever
-- reserved. Existing read-only analysis and a successful TMS ticket remain
-- authoritative and must not be replayed by this migration.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    work_order.payload#>>'{pddOrderRemark,reason}' AS previous_remark_reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.status = 'paused'
    AND coalesce(work_order.runtime_status, work_order.status) = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step IN ('manual-review-blocked', 'flow-paused')
    AND work_order.payload->>'orderNumber' = work_order.external_order_number
    AND work_order.payload#>>'{pddOrderRemark,orderNumber}' = work_order.external_order_number
    AND work_order.payload#>>'{pddOrderRemark,status}' = 'failed'
    AND work_order.payload#>>'{pddOrderRemark,reason}' =
      '拼多多备注红色标记选择后未保持选中'
    AND coalesce(work_order.manual_review_reason, '') LIKE
      '%阶段: pdd-order-remark%拼多多备注红色标记选择后未保持选中'
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type IN ('pdd-note', 'pdd-submit')
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
    current_step = 'pdd-order-remark-color-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = work_order.recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview'
        - 'error'
      ) || jsonb_build_object(
        'step', 'pdd-order-remark-color-retry-ready',
        'pddOrderRemark',
          coalesce(work_order.payload->'pddOrderRemark', '{}'::jsonb) || jsonb_build_object(
            'status', 'retry-ready',
            'reasonCode', 'transient-color-rerender',
            'reason', '拼多多备注颜色选择时页面发生重渲染，已安排自动重试',
            'retryAfterMs', 0,
            'recoveredAt', now()
          ),
        'pddRemarkColorRecovery225', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', 're-resolve-color-after-pdd-rerender',
          'previousReason', candidate.previous_reason,
          'previousRemarkReason', candidate.previous_remark_reason,
          'existingTmsEffectPreserved', true,
          'externalActionsReplayed', false,
          'recoveredAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason,
    candidate.previous_remark_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-order-remark-color-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING
    recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.previous_reason,
    recovered.previous_remark_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-225',
    'pdd-order-remark-color-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'previousRemarkReason', recovered.previous_remark_reason,
      'strategy', 're-resolve-color-after-pdd-rerender',
      'existingTmsEffectPreserved', true,
      'externalActionsReplayed', false
    ),
    'migration-225:pdd-order-remark-color:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-225')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.reason_code = 'manual-review-required'
    AND intervention.reason LIKE '%拼多多备注红色标记选择后未保持选中'
    AND intervention.status IN ('open', 'acknowledged')
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
    'reason', 'pdd-order-remark-color-retry-ready',
    'migration', '225'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('225_recover_pdd_remark_color_rerender.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
