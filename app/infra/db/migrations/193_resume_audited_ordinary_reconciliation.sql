BEGIN;

-- Old PDD submissions must be observed on the platform before the workflow is
-- allowed to continue. This migration never changes an external-effect result
-- and never resets a PDD submit counter.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    CASE
      WHEN coalesce(work_order.payload #>>
        '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
      THEN (work_order.payload #>>
        '{externalStateReconciliationRetry,attempts}')::int
      ELSE 0
    END AS previous_attempts
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.status = 'paused'
    AND instance.identity_status = 'verified'
    AND instance.platform_case_id IS NOT NULL
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND (
      work_order.current_step = 'external-state-unresolved'
      OR coalesce(work_order.manual_review_reason, '') =
        '只有异常网点预警允许跳过 TMS'
    )
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
        AND (
          effect.status = 'reserved'
          OR (
            effect.effect_type IN ('evidence-upload', 'tms-create')
            AND effect.status IN ('failed', 'unknown')
          )
          OR (
            effect.effect_type NOT IN ('pdd-submit', 'pdd-note',
              'oms-manual-allocation', 'tms-create')
            AND effect.status = 'unknown'
          )
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
  SET runtime_status = 'paused',
    current_step = 'external-state-unresolved',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
    next_attempt_at = NULL,
    recovery_state = 'held',
    recovery_reason = 'external-state-reconciliation-retry-pending',
    recovery_version = recovery_version + 1,
    recovery_updated_at = now() - interval '10 minutes 1 second',
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error') || jsonb_build_object(
      'step', 'external-state-unresolved',
      'externalStateReconciliationRetry',
        coalesce(work_order.payload->'externalStateReconciliationRetry', '{}'::jsonb)
          || jsonb_build_object(
            'attempts', candidate.previous_attempts,
            'maxAttempts', 6,
            'scheduledAt', now(),
            'recoverySource', 'migration-193'
          ),
      'auditedOrdinaryReconciliation193', jsonb_build_object(
        'status', 'read-only-reconciliation-ready',
        'strategy', 'observe-pdd-state-before-any-continuation',
        'previousReason', candidate.previous_reason,
        'pddSubmitAttemptsPreserved', true,
        'scheduledAt', now()
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
    candidate.previous_attempts
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-unresolved',
    manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
    next_attempt_at = NULL,
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
    'migration-193',
    'audited-ordinary-read-only-reconciliation-scheduled',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'previousReconciliationAttempts', recovered.previous_attempts,
      'strategy', 'observe-pdd-state-before-any-continuation'
    ),
    'migration-193:read-only-reconciliation:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
SELECT count(*) AS scheduled_reconciliations FROM audited;

-- These pauses happened before a PDD submit was possible and are deterministic
-- under the current browser policy. Unknown effects, upload failures and rows
-- without an exact platform identity remain held.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    CASE
      WHEN work_order.current_step = 'operator-refreshed-next-order'
        AND coalesce(work_order.manual_review_reason, '') = '12'
        THEN 'retry-operator-refreshed-next-order'
      WHEN coalesce(work_order.manual_review_reason, '') LIKE
        '%异常网点预警未找到唯一建议快递%'
        THEN 'retry-abnormal-network-first-available-carrier'
      ELSE 'retry-tms-evidence-clone-with-current-requirement'
    END AS strategy
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.status = 'paused'
    AND instance.identity_status = 'verified'
    AND instance.platform_case_id IS NOT NULL
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND (
      (
        work_order.current_step = 'operator-refreshed-next-order'
        AND coalesce(work_order.manual_review_reason, '') = '12'
      )
      OR coalesce(work_order.manual_review_reason, '') LIKE
        '%异常网点预警未找到唯一建议快递%'
      OR coalesce(work_order.manual_review_reason, '') LIKE
        '%TMS 截图克隆区域缺少本次催件要求%'
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
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND effect.effect_type = 'evidence-upload'
        AND effect.status IN ('failed', 'unknown', 'reserved')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
          work_order.current_ordinary_instance_id
        AND effect.effect_type = 'pdd-submit'
        AND (
          effect.status IN ('succeeded', 'unknown', 'reserved')
          OR (
            effect.status = 'failed'
            AND coalesce(effect.receipt->>'clickAttempted', 'unknown') <> 'false'
          )
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
    current_step = 'audited-deterministic-ordinary-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error') || jsonb_build_object(
      'step', 'audited-deterministic-ordinary-retry-ready',
      'transientWorkflowRecovery', jsonb_build_object(
        'count', 0,
        'maxAttempts', 5,
        'lastReason', candidate.previous_reason,
        'retryAt', now(),
        'recoveredAt', now(),
        'recoverySource', 'migration-193'
      ),
      'auditedDeterministicOrdinaryRecovery193', jsonb_build_object(
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
    current_step = 'audited-deterministic-ordinary-retry-ready',
    manual_review_reason = NULL,
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
    'migration-193',
    'audited-deterministic-ordinary-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', recovered.strategy
    ),
    'migration-193:deterministic-ordinary:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-193')
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
    'reason', 'automatic-audited-deterministic-recovery-193'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('193_resume_audited_ordinary_reconciliation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
