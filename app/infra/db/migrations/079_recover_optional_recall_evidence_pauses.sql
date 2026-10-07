BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'intercept-recall'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.payload#>>'{ordinaryScenarioDecision,pdd,option}' = '已进行召回'
    AND coalesce(work_order.payload#>>'{ordinaryEvidenceUploadRecovery,status}', 'exhausted') = 'exhausted'
    AND coalesce((work_order.payload#>>'{ordinaryEvidenceUploadRecovery,attempt}')::integer, 0) >= 2
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') =
      '拼多多凭证上传授权失败（48143）：非法请求'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,authorizationFailure,errorCode}' = '48143'
    AND work_order.payload#>>'{ordinaryScenarioExecution,commonFlowTicket,status}' = 'created'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
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
    current_step = 'ordinary-evidence-optional-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = jsonb_set(
      (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error'
        - 'ordinaryEvidenceUpload' - 'ordinaryEvidenceUploadRecovery'),
      '{ordinaryScenarioExecution}',
      (coalesce(work_order.payload->'ordinaryScenarioExecution', '{}'::jsonb)
        - 'evidenceUpload')
        || jsonb_build_object(
          'pddEvidenceUploadFailed', false,
          'optionalEvidenceRecovery', jsonb_build_object(
            'previousReason', candidate.reason,
            'strategy', 'omit-rejected-recall-evidence-only-when-submit-remains-enabled',
            'recoveredAt', now()
          )
        ),
      true
    ) || jsonb_build_object(
      'step', 'ordinary-evidence-optional-retry-ready',
      'ordinaryEvidenceOptionalRecovery', jsonb_build_object(
        'previousReason', candidate.reason,
        'strategy', 'omit-rejected-recall-evidence-only-when-submit-remains-enabled',
        'recoveredAt', now()
      )
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
  'migration-079', 'optional-recall-evidence-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'strategy', 'omit-rejected-recall-evidence-only-when-submit-remains-enabled'
  ),
  'migration-079:optional-recall-evidence:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'ordinary-evidence-optional-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
    - 'manualReview' - 'error'
    - 'ordinaryEvidenceUpload' - 'ordinaryEvidenceUploadRecovery')
    || jsonb_build_object(
      'step', 'ordinary-evidence-optional-retry-ready',
      'ordinaryScenarioExecution', work_order.payload->'ordinaryScenarioExecution',
      'ordinaryEvidenceOptionalRecovery', work_order.payload->'ordinaryEvidenceOptionalRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'ordinary-evidence-optional-retry-ready'
  AND work_order.payload ? 'ordinaryEvidenceOptionalRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-079')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN (
    'external-system-error',
    'ordinary-manual-review',
    'pdd-upload-authorization-failed',
    'image-upload-failed'
  )
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'ordinary-evidence-optional-retry-ready'
  AND work_order.payload ? 'ordinaryEvidenceOptionalRecovery';

COMMIT;
