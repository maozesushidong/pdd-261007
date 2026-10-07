BEGIN;

-- A read-only PDD reconciliation used to become permanently ineligible when
-- its browser exited, login expired, or a verification page interrupted the
-- observation. Requeue only recent, instance-bound reconciliations that have
-- a prior PDD submit effect and no active reservation or worker lease.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason,
    CASE
      WHEN coalesce(work_order.payload #>>
        '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
      THEN (work_order.payload #>>
        '{externalStateReconciliationRetry,attempts}')::int
      ELSE 0
    END AS previous_attempts,
    coalesce(work_order.manual_review_reason, '') ~
      'HumanVerificationRequired|人工验证|需要人工验证' AS verification_failure
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.status = 'paused'
  WHERE work_order.status = 'paused'
    AND work_order.current_step = 'external-state-reconciliation-failed'
    AND work_order.recovery_state = 'held'
    AND work_order.created_at >= now() - interval '30 days'
    AND coalesce(work_order.manual_review_reason, '') ~
      'external-state-reconciliation-failed:0|HumanVerificationRequired|人工验证|需要人工验证'
    AND CASE
      WHEN coalesce(work_order.payload #>>
        '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
      THEN (work_order.payload #>>
        '{externalStateReconciliationRetry,attempts}')::int
      ELSE 0
    END < 6
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'failed', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND effect.status = 'reserved'
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
  SET runtime_status = 'paused',
    current_step = 'external-state-unresolved',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
    recovery_state = 'held',
    recovery_reason = 'external-state-reconciliation-retry-pending',
    recovery_version = recovery_version + 1,
    recovery_updated_at = now() - interval '10 minutes',
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error') || jsonb_build_object(
      'step', 'external-state-unresolved',
      'externalStateReconciliationRetry',
        coalesce(work_order.payload->'externalStateReconciliationRetry', '{}'::jsonb)
          || jsonb_build_object(
            'attempts', CASE
              WHEN candidate.verification_failure
                THEN greatest(0, candidate.previous_attempts - 1)
              ELSE candidate.previous_attempts
            END,
            'maxAttempts', 6,
            'legacyFailureRecoveredAt', now(),
            'verificationAttemptRefunded', candidate.verification_failure
          ),
      'externalStateFailureRecovery184', jsonb_build_object(
        'status', 'read-only-retry-ready',
        'strategy', 'resume-read-only-reconciliation-no-resubmit',
        'previousReason', candidate.manual_review_reason,
        'previousAttempts', candidate.previous_attempts,
        'verificationAttemptRefunded', candidate.verification_failure,
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
    candidate.manual_review_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-unresolved',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
     payload, deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-184',
    'failed-read-only-reconciliation-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.manual_review_reason,
      'strategy', 'resume-read-only-reconciliation-no-resubmit'
    ),
    'migration-184:read-only-reconciliation:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-184')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code IN (
      'external-system-error',
      'verification-required',
      'login-required'
    )
    AND intervention.reason ~
      'external-state-reconciliation-failed:0|Target page, context or browser has been closed|HumanVerificationRequired|人工验证|需要人工验证'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-read-only-reconciliation-recovery-184'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('184_recover_failed_read_only_reconciliations.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
