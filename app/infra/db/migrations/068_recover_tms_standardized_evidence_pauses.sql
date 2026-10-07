BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason,
    work_order.payload#>>'{tmsWorkOrder,problemType}' AS expected_problem,
    work_order.payload#>>'{tmsWorkOrder,customerRemark}' AS expected_remark,
    work_order.payload#>>'{tmsDuplicateCheck,identity,cells,9}' AS actual_problem,
    work_order.payload#>>'{tmsDuplicateCheck,identity,cells,10}' AS actual_remark
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') =
      'TMS 截图克隆区域缺少本次催件要求'
    AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
    AND (
      (
        work_order.payload#>>'{tmsWorkOrder,problemType}' = '丢件'
        AND work_order.payload#>>'{tmsDuplicateCheck,identity,cells,9}' = '弃件'
        AND work_order.payload#>>'{tmsDuplicateCheck,identity,cells,10}' LIKE '%弃件%'
      )
      OR (
        work_order.payload#>>'{tmsWorkOrder,problemType}' = '拦截退回'
        AND work_order.payload#>>'{tmsDuplicateCheck,identity,cells,9}' = '拦截退回'
        AND work_order.payload#>>'{tmsDuplicateCheck,identity,cells,10}' LIKE '%拦截%'
      )
    )
    AND EXISTS (
      SELECT 1 FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.status = 'created'
        AND tms.external_ticket_id = work_order.payload#>>'{tmsWorkOrder,ticketId}'
        AND tms.payload->>'ticketNo' = work_order.payload#>>'{tmsWorkOrder,ticketNo}'
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
    current_step = 'tms-evidence-semantic-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'tmsEvidenceScreenshot')
      || jsonb_build_object(
        'step', 'tms-evidence-semantic-retry-ready',
        'tmsEvidenceSemanticRecovery', jsonb_build_object(
          'reason', candidate.reason,
          'expectedProblemType', candidate.expected_problem,
          'expectedRemark', candidate.expected_remark,
          'actualProblemType', candidate.actual_problem,
          'actualRemark', candidate.actual_remark,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.expected_problem,
    candidate.actual_problem, candidate.actual_remark
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-068', 'tms-standardized-evidence-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'expectedProblemType', recovered.expected_problem,
    'actualProblemType', recovered.actual_problem,
    'actualRemark', recovered.actual_remark,
    'strategy', 'reuse-persisted-created-tms-ticket-and-recapture-evidence'
  ),
  'migration-068:tms-standardized-evidence:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'tms-evidence-semantic-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
    - 'manualReview' - 'error' - 'tmsEvidenceScreenshot')
    || jsonb_build_object(
      'step', 'tms-evidence-semantic-retry-ready',
      'tmsEvidenceSemanticRecovery', work_order.payload->'tmsEvidenceSemanticRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'tms-evidence-semantic-retry-ready'
  AND work_order.payload ? 'tmsEvidenceSemanticRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-068')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN ('external-system-error', 'ordinary-manual-review')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'tms-evidence-semantic-retry-ready'
  AND work_order.payload ? 'tmsEvidenceSemanticRecovery';

COMMIT;
