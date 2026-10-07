BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS reason,
    work_order.payload#>>'{tmsWorkOrder,ticketId}' AS ticket_id,
    work_order.payload#>>'{tmsWorkOrder,ticketNo}' AS ticket_no,
    work_order.payload#>>'{tmsWorkOrder,problemType}' AS problem_type,
    work_order.payload#>>'{tmsWorkOrder,customerRemark}' AS customer_remark
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND position(
      'TMS 截图克隆区域的物流问题或客服备注与本次要求不匹配'
      IN coalesce(work_order.manual_review_reason, '')
    ) = 1
    AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
    AND EXISTS (
      SELECT 1 FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.status = 'created'
        AND tms.external_ticket_id = work_order.payload#>>'{tmsWorkOrder,ticketId}'
        AND tms.payload->>'ticketNo' = work_order.payload#>>'{tmsWorkOrder,ticketNo}'
        AND tms.payload->>'problemType' = work_order.payload#>>'{tmsWorkOrder,problemType}'
        AND tms.payload->>'customerRemark' = work_order.payload#>>'{tmsWorkOrder,customerRemark}'
    )
    AND 1 = (
      SELECT count(DISTINCT (tms.external_ticket_id, tms.payload->>'ticketNo'))
      FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.status = 'created'
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
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-copy-label-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'tmsEvidenceScreenshot')
      || jsonb_build_object(
        'step', 'tms-copy-label-retry-ready',
        'tmsCopyLabelRecovery', jsonb_build_object(
          'reason', candidate.reason,
          'ticketId', candidate.ticket_id,
          'ticketNo', candidate.ticket_no,
          'problemType', candidate.problem_type,
          'customerRemark', candidate.customer_remark,
          'strategy', 'ignore-trailing-copy-button-label-and-recapture-evidence',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.ticket_id, candidate.ticket_no
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-070', 'tms-copy-label-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'ticketId', recovered.ticket_id,
    'ticketNo', recovered.ticket_no,
    'strategy', 'ignore-trailing-copy-button-label-and-recapture-evidence'
  ),
  'migration-070:tms-copy-label:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'tms-copy-label-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
    - 'manualReview' - 'error' - 'tmsEvidenceScreenshot')
    || jsonb_build_object(
      'step', 'tms-copy-label-retry-ready',
      'tmsCopyLabelRecovery', work_order.payload->'tmsCopyLabelRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'tms-copy-label-retry-ready'
  AND work_order.payload ? 'tmsCopyLabelRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-070')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN ('external-system-error', 'ordinary-manual-review')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'tms-copy-label-retry-ready'
  AND work_order.payload ? 'tmsCopyLabelRecovery';

COMMIT;
