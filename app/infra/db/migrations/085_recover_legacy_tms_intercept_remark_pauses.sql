BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason,
    work_order.payload#>>'{tmsEvidenceScreenshot,error}' AS evidence_error
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'flow-paused'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,status}' = 'failed'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,error}' LIKE
      '%"expectedProblemType":"拦截退回","actualProblemType":"拦截退回"%'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,error}' LIKE '%退回包裹%'
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
    current_step = 'legacy-tms-intercept-remark-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'tmsEvidenceScreenshot'
        - 'tmsEvidenceDisposition')
      || jsonb_build_object(
        'step', 'legacy-tms-intercept-remark-retry-ready',
        'legacyTmsInterceptRemarkRecovery', jsonb_build_object(
          'previousReason', candidate.reason,
          'previousEvidenceError', candidate.evidence_error,
          'strategy', 're-capture-existing-tms-intercept-evidence',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason,
    candidate.evidence_error
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-085', 'legacy-tms-intercept-remark-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'previousEvidenceError', recovered.evidence_error,
    'strategy', 're-capture-existing-tms-intercept-evidence'
  ),
  'migration-085:legacy-tms-intercept-remark:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'legacy-tms-intercept-remark-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'tmsEvidenceScreenshot'
      - 'tmsEvidenceDisposition')
    || jsonb_build_object(
      'step', 'legacy-tms-intercept-remark-retry-ready',
      'legacyTmsInterceptRemarkRecovery',
        work_order.payload->'legacyTmsInterceptRemarkRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'legacy-tms-intercept-remark-retry-ready'
  AND work_order.payload ? 'legacyTmsInterceptRemarkRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-085')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'legacy-tms-intercept-remark-retry-ready'
  AND work_order.payload ? 'legacyTmsInterceptRemarkRecovery';

COMMIT;
