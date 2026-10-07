BEGIN;

-- Some ordinary work orders reused an existing TMS row after matching the
-- trade, tracking number, warehouse, and carrier, but before checking that
-- row's logistics problem and customer remark. Requeue only recovered rows
-- that still have their source evidence and never created a TMS ticket.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload->'tmsWorkOrder' AS previous_tms_work_order,
    work_order.payload->'tmsDuplicateCheck' AS previous_duplicate_check,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND work_order.recovery_state <> 'held'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
      'TMS 截图克隆区域的物流问题或客服备注与本次要求不匹配:%'
    AND work_order.payload->'tmsWorkOrder'->>'status' = 'created'
    AND work_order.payload->'tmsWorkOrder'->>'recovered' = 'true'
    AND work_order.payload->'pddEvidenceScreenshot'->>'status' = 'ready'
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'tms-create'
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
    current_step = 'tms-existing-decision-mismatch-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'tmsWorkOrder' - 'tmsDuplicateCheck'
        - 'tmsEvidenceScreenshot' - 'tmsEvidenceDisposition' - 'tmsAttachmentTransfer')
      || jsonb_build_object(
        'step', 'tms-existing-decision-mismatch-retry-ready',
        'mismatchedExistingTmsDecisionRecovery', jsonb_build_object(
          'previousReason', candidate.reason,
          'previousTmsWorkOrder', candidate.previous_tms_work_order,
          'previousDuplicateCheck', candidate.previous_duplicate_check,
          'strategy', 'create-new-ticket-after-business-decision-mismatch',
          'recoveredAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-102', 'mismatched-existing-tms-decision-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'strategy', 'create-new-ticket-after-business-decision-mismatch'
  ),
  'migration-102:tms-decision-mismatch:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'tms-existing-decision-mismatch-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = coalesce(work_order.payload, '{}'::jsonb),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'tms-existing-decision-mismatch-retry-ready'
  AND work_order.payload ? 'mismatchedExistingTmsDecisionRecovery';

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-102')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'tms-existing-decision-mismatch-retry-ready'
    AND work_order.payload ? 'mismatchedExistingTmsDecisionRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'failed');

COMMIT;
