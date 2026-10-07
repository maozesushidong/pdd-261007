BEGIN;

-- Cross-process error serialization used to erase HumanVerificationRequiredError
-- and store an explicit PDD login/captcha wait as a generic page error. Move
-- only read-only attempts with no possible refund effect into the verification
-- queue so the plugin/operator recovery path can resume them immediately.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    coalesce(
      work_order.manual_review_reason,
      work_order.payload->>'error',
      work_order.payload#>>'{returnRefundResult,error}',
      work_order.payload#>>'{verificationLocation,stage}',
      ''
    )
      AS previous_reason
  FROM work_orders work_order
  JOIN return_refunds refund
    ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE refund.action_state = 'page-error'
    AND refund.completed_at IS NULL
    AND (
      work_order.status IN ('paused', 'retry-ready')
      OR (
        work_order.status = 'processing'
        AND work_order.current_step IN (
          'human-verification-required',
          'manual-login-required'
        )
      )
    )
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND (
      coalesce(
        work_order.manual_review_reason,
        work_order.payload->>'error',
        work_order.payload#>>'{returnRefundResult,error}',
        ''
      ) ~* '(检测到人工验证|人工验证|验证码|pdd-manual-login|human verification)'
      OR work_order.current_step IN (
        'human-verification-required',
        'manual-login-required'
      )
      OR work_order.payload#>>'{verificationLocation,status}'
        IN ('detected', 'waiting-human', 'verification-required')
      OR work_order.payload#>>'{verificationLocation,stage}' = 'pdd-manual-login'
      OR work_order.payload#>>'{authHealth,pdd,status}'
        IN ('expired', 'verification-required')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, refund
), reclassified_refunds AS (
  UPDATE return_refunds refund
  SET action_state = 'verification-required',
    decision = 'verification-required',
    next_check_at = now(),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
    AND refund.action_state = 'page-error'
  RETURNING candidate.*
), reclassified_orders AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'verification',
    current_step = 'human-verification-required',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'human-verification-required',
        'returnRefundVerificationRecovery183', jsonb_build_object(
          'status', 'retry-ready',
          'previousReason', candidate.previous_reason,
          'reclassifiedAt', now(),
          'recoverySource', 'migration-183'
        )
      ),
    updated_at = now()
  FROM reclassified_refunds candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    candidate.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
  SELECT candidate.shop_id,
    candidate.id,
    'migration-183',
    'return-refund-login-page-error-reclassified',
    jsonb_build_object(
      'orderNumber', candidate.external_order_number,
      'previousReason', candidate.previous_reason,
      'nextState', 'verification-required'
    ),
    'migration-183:return-refund-login-verification:' || candidate.id::text
  FROM reclassified_orders candidate
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-183')
  FROM reclassified_orders candidate
  WHERE intervention.work_order_id = candidate.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code <> 'image-upload-failed'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'return-refund-verification-reclassification-183'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('183_reclassify_return_refund_login_page_errors.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
