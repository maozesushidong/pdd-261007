BEGIN;

-- Older workers could finish OMS/TMS dependencies, encounter a PDD challenge,
-- then persist a permanent pause after the plugin cleared it. Preserve all
-- succeeded dependency effects and requeue only when PDD has never succeeded,
-- no effect is unresolved, and the last challenge happened after the latest
-- succeeded dependency.
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
    dependency.latest_success_at,
    verification.latest_verification_at
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
    AND binding.actual_shop_name = shop.expected_shop_name
  LEFT JOIN LATERAL (
    SELECT max(effect.updated_at) AS latest_success_at
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.status = 'succeeded'
      AND effect.effect_type <> 'pdd-submit'
  ) dependency ON true
  JOIN LATERAL (
    SELECT max(event.occurred_at) AS latest_verification_at
    FROM workflow_events event
    WHERE event.work_order_id = work_order.id
      AND event.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND event.stage = 'human-verification-required'
  ) verification ON verification.latest_verification_at IS NOT NULL
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND (
      coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%检测到人工验证，请在可视化浏览器中完成后重新运行流程%'
      OR coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) = '工作流已进入人工复核暂停状态'
    )
    AND verification.latest_verification_at >= coalesce(
      dependency.latest_success_at,
      instance.first_discovered_at
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'post-dependency-verification-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'verificationStage'
      - 'verificationLocation' - 'verificationFocus')
      || jsonb_build_object(
        'step', 'post-dependency-verification-retry-ready',
        'verificationRecovery',
          coalesce(work_order.payload->'verificationRecovery', '{}'::jsonb)
            || jsonb_build_object(
              'count', 0,
              'retryDelayMs', 0,
              'retryAt', now(),
              'lastReason', candidate.previous_reason,
              'requestedAt', now(),
              'recoverySource', 'migration-195'
            ),
        'verificationRecheck', jsonb_build_object(
          'trigger', 'migration-post-dependency-verification-recovery',
          'status', 'retry-ready',
          'requestedAt', now()
        ),
        'postDependencyVerificationRecovery195', jsonb_build_object(
          'status', 'retry-ready',
          'previousReason', candidate.previous_reason,
          'latestDependencySuccessAt', candidate.latest_success_at,
          'latestVerificationAt', candidate.latest_verification_at,
          'strategy', 'reuse-succeeded-dependencies-and-recheck-pdd',
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
    candidate.latest_success_at,
    candidate.latest_verification_at
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'post-dependency-verification-retry-ready',
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
    recovered.latest_success_at,
    recovered.latest_verification_at
), expired_verifications AS (
  UPDATE verification_locations location
  SET status = 'expired',
    resolved_at = coalesce(location.resolved_at, now())
  FROM recovered
  WHERE location.work_order_id = recovered.id
    AND location.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND location.status IN ('detected', 'waiting-human', 'verification-required')
  RETURNING location.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-195',
    'ordinary-post-dependency-verification-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'latestDependencySuccessAt', recovered.latest_success_at,
      'latestVerificationAt', recovered.latest_verification_at,
      'strategy', 'reuse-succeeded-dependencies-and-recheck-pdd'
    ),
    'migration-195:post-dependency-verification:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-195')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code NOT IN (
      'image-upload-failed',
      'pdd-upload-authorization-failed'
    )
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-post-dependency-verification-recovery-195'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('195_recover_post_dependency_verification_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
