BEGIN;

-- A plugin-resolved challenge is durable browser evidence. Earlier workers
-- could leave the matching order on a 30/60-minute verification backoff even
-- after every challenge for the current instance had been resolved.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.next_attempt_at AS previous_next_attempt_at,
    resolved_verification.resolved_at AS verification_resolved_at
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN LATERAL (
    SELECT max(verification.resolved_at) AS resolved_at
    FROM verification_locations verification
    WHERE verification.shop_id = work_order.shop_id
      AND verification.work_order_id = work_order.id
      AND verification.ordinary_instance_id IS NOT DISTINCT FROM
        work_order.current_ordinary_instance_id
      AND verification.status IN ('resolved', 'expired')
      AND verification.resolved_at IS NOT NULL
  ) resolved_verification ON resolved_verification.resolved_at IS NOT NULL
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
    AND work_order.status IN ('retry-ready', 'paused', 'failed')
    AND work_order.current_step = 'human-verification-required'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND NOT EXISTS (
      SELECT 1
      FROM verification_locations verification
      WHERE verification.shop_id = work_order.shop_id
        AND verification.work_order_id = work_order.id
        AND verification.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND verification.status IN ('detected', 'waiting-human', 'verification-required')
        AND verification.resolved_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'verification-cleared-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
        - 'verificationLocation'
        - 'verificationStage'
        - 'verificationFocus'
        - 'verificationRecovery'
        - 'manualReview'
        - 'error'
    ) || jsonb_build_object(
      'step', 'verification-cleared-retry-ready',
      'verificationRecheck',
        coalesce(work_order.payload->'verificationRecheck', '{}'::jsonb)
          || jsonb_build_object(
            'trigger', 'migration-resolved-verification-recovery',
            'status', 'retry-ready',
            'verificationState', 'resolved',
            'completedAt', candidate.verification_resolved_at
          ),
      'verificationBackoffRecovery', jsonb_build_object(
        'status', 'retry-ready',
        'previousNextAttemptAt', candidate.previous_next_attempt_at,
        'verificationResolvedAt', candidate.verification_resolved_at,
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
    candidate.previous_next_attempt_at,
    candidate.verification_resolved_at
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'verification-cleared-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING instance.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-211',
    'resolved-verification-backoff-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousNextAttemptAt', recovered.previous_next_attempt_at,
      'verificationResolvedAt', recovered.verification_resolved_at,
      'strategy', 'resume-immediately-after-durable-verification-resolution'
    ),
    'migration-211:resolved-verification:' || recovered.id::text
  FROM recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved_interventions AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-211')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'verification-required'
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object('reason', 'verification-resolved-auto-resume-211')
FROM resolved_interventions intervention
WHERE outbox.intervention_id = intervention.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('211_resume_resolved_verification_backoffs.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
