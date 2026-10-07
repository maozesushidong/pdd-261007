BEGIN;

-- Older workers converted an interrupted verification challenge into a
-- permanent pause while they were only expanding the PDD logistics panel.
-- These stages are before every external action. Requeue only exact pending
-- instances with no click marker, no possibly applied effect, and no live
-- worker lease. Verification that remains visible is handled by the current
-- bounded verification retry loop; this migration never clicks or submits.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason,
    CASE
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%阶段: expand-all-logistics-action-error，URL:%'
        THEN 'retry-logistics-expand-after-interrupted-verification-action'
      ELSE 'retry-logistics-expand-after-interrupted-verification'
    END AS strategy
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) ~ '^检测到人工验证[\s\S]*阶段: expand-all-logistics(-action-error)?，URL:'
    AND nullif(
      work_order.payload #>> '{pddResolutionSubmission,lastClickAttemptedAt}',
      ''
    ) IS NULL
    AND nullif(
      instance.payload #>> '{pddResolutionSubmission,lastClickAttemptedAt}',
      ''
    ) IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
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
    current_step = 'ordinary-pre-submit-verification-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'ordinary-pre-submit-verification-retry-ready',
        'verificationRecovery',
          coalesce(work_order.payload->'verificationRecovery', '{}'::jsonb)
            || jsonb_build_object(
              'count', 0,
              'retryDelayMs', 0,
              'retryAt', now(),
              'lastReason', candidate.previous_reason,
              'requestedAt', now(),
              'recoverySource', 'migration-189'
            ),
        'verificationRecheck', jsonb_build_object(
          'trigger', 'migration-pre-submit-verification-recovery',
          'status', 'retry-ready',
          'requestedAt', now()
        ),
        'ordinaryPreSubmitVerificationRecovery189', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', candidate.strategy,
          'previousReason', candidate.previous_reason,
          'recoveredAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason,
    candidate.strategy
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-pre-submit-verification-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.previous_reason,
    recovered.strategy
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-189',
    'ordinary-pre-submit-verification-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', recovered.strategy
    ),
    'migration-189:ordinary-pre-submit-verification:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-189')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code <> 'image-upload-failed'
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
    'reason', 'automatic-pre-submit-verification-recovery-189'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('189_recover_pre_submit_verification_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
