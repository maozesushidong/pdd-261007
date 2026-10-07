BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, work_order.manual_review_reason
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND work_order.manual_review_reason =
      '当前订单禁止归档和清空进度: completion-outcome-mismatch'
    AND work_order.completion_state = 'confirmed'
    AND work_order.completion_confirmation_method IN (
      'detail-completed',
      'handover-detail-completed'
    )
    AND work_order.payload #>> '{pddResolutionSubmission,status}' = 'succeeded'
    AND work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
    AND work_order.payload #>> '{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload #>> '{pddEvidenceScreenshot,status}' = 'deleted'
    AND work_order.payload #>> '{tmsEvidenceScreenshot,status}' = 'deleted'
    AND work_order.payload #>> '{tmsEvidenceDisposition,status}' = 'deleted'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'completed-page-archive-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'completed-page-archive-retry-ready',
        'completedPageArchiveRecovery', jsonb_build_object(
          'strategy', 'trusted-completed-detail-bypasses-outcome-label-comparison',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.manual_review_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-073', 'completed-page-outcome-mismatch-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.manual_review_reason,
    'strategy', 'trusted-completed-detail-bypasses-outcome-label-comparison'
  ),
  'migration-073:completed-page-outcome-mismatch:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'completed-page-archive-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'manualReview' - 'error')
    || jsonb_build_object(
      'step', 'completed-page-archive-retry-ready',
      'completedPageArchiveRecovery', work_order.payload->'completedPageArchiveRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'completed-page-archive-retry-ready'
  AND work_order.payload ? 'completedPageArchiveRecovery';

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-073')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'completed-page-archive-retry-ready'
    AND work_order.payload ? 'completedPageArchiveRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'failed');

COMMIT;
