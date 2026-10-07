BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  WHERE work_order.external_order_number = '260817-674454618552185'
    AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'intercept-recall'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.manual_review_reason =
      '拼多多未找到场景选项（已等待 30 秒）: 已进行召回 / 已召回 / 已完成召回 / 已拦截成功'
    AND work_order.payload #>> '{ordinaryScenarioDecision,pdd,option}' = '已进行召回'
    AND work_order.payload #>> '{ordinaryPddOptionRecovery,status}' = 'failed'
    AND nullif(work_order.payload #>> '{ordinaryPddOptionRecovery,pendingListReopenedAt}', '')
      IS NOT NULL
    AND work_order.payload::text LIKE '%我已知晓%'
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
    current_step = 'ordinary-pdd-acknowledgement-entry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'ordinary-pdd-acknowledgement-entry-ready',
        'ordinaryPddAcknowledgementEntryRecovery', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'strategy', 'click-unique-acknowledgement-before-option-wait',
          'actionText', '我已知晓',
          'renderWaitMs', 30000,
          'reuseExistingOmsTmsEvidence', true,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.previous_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-130', 'ordinary-pdd-acknowledgement-entry-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.previous_reason,
    'strategy', 'click-unique-acknowledgement-before-option-wait',
    'actionText', '我已知晓',
    'renderWaitMs', 30000,
    'reuseExistingOmsTmsEvidence', true
  ),
  'migration-130:ordinary-pdd-acknowledgement-entry:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'ordinary-pdd-acknowledgement-entry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'manualReview' - 'error')
    || jsonb_build_object(
      'step', 'ordinary-pdd-acknowledgement-entry-ready',
      'ordinaryPddAcknowledgementEntryRecovery',
        work_order.payload->'ordinaryPddAcknowledgementEntryRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'ordinary-pdd-acknowledgement-entry-ready'
  AND work_order.payload ? 'ordinaryPddAcknowledgementEntryRecovery';

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-130')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'ordinary-pdd-acknowledgement-entry-ready'
    AND work_order.payload ? 'ordinaryPddAcknowledgementEntryRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
