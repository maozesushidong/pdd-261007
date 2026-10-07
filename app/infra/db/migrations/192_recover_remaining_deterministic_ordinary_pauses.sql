BEGIN;

-- Requeue only legacy pauses whose current browser policy is deterministic.
-- Confirmed terminal pages may be archived without another submit. Every
-- other candidate is a pre-submit/read-only failure and must have no possibly
-- applied PDD submit or unresolved external effect. Upload failures stay held.
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
      WHEN work_order.completion_state = 'confirmed'
        AND work_order.completion_confirmation_method = 'detail-completed'
        AND work_order.payload #>> '{pddResolutionSubmission,status}' = 'succeeded'
        AND work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
        THEN 'archive-confirmed-platform-terminal-state'
      WHEN coalesce(work_order.manual_review_reason, '')
        ~ 'OMS 发货快递没有平台建议选项|异常网点预警未读取到平台建议快递'
        THEN 'retry-abnormal-network-first-available-carrier'
      WHEN coalesce(work_order.manual_review_reason, '')
        ~ '异常网点预警未找到(唯一)?平台建议快递'
        THEN 'retry-abnormal-network-without-platform-recommendation'
      WHEN coalesce(work_order.manual_review_reason, '') = '外部操作已存在 succeeded 记录，禁止重复执行'
        THEN 'reconcile-idempotent-succeeded-effect'
      WHEN coalesce(work_order.manual_review_reason, '') LIKE '平台仍提示操作太过频繁%'
        THEN 'retry-expired-platform-rate-limit'
      WHEN coalesce(work_order.manual_review_reason, '')
        LIKE '%已有 TMS 工单无法同时核对订单、运单号、仓库和快递%'
        THEN 'retry-authorized-first-existing-tms-ticket'
      WHEN coalesce(work_order.manual_review_reason, '')
        LIKE '%拼多多发货城市范围判断缺失或订单不一致%'
        THEN 'retry-origin-city-fallback-policy'
      WHEN coalesce(work_order.manual_review_reason, '')
        LIKE '%拼多多页面存在未识别的遮挡弹窗%'
        THEN 'retry-transient-pdd-header-overlay'
      WHEN coalesce(work_order.manual_review_reason, '')
        LIKE '%EBUSY: resource busy or locked%verification-focus.lock%'
        THEN 'retry-transient-verification-lock'
      WHEN coalesce(work_order.manual_review_reason, '')
        ~ '^locator\.click: Timeout [0-9]+ms exceeded\.[\s\S]*salesOrderCode'
        THEN 'retry-transient-oms-order-row-click'
      ELSE 'retry-read-only-page-render'
    END AS strategy,
    work_order.completion_state = 'confirmed'
      AND work_order.completion_confirmation_method = 'detail-completed'
      AND work_order.payload #>> '{pddResolutionSubmission,status}' = 'succeeded'
      AND work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
      AND work_order.payload #>> '{pddResolutionSubmission,orderNumber}' =
        work_order.external_order_number
      AND work_order.payload #>> '{pddEvidenceScreenshot,status}' = 'deleted'
      AND work_order.payload #>> '{tmsEvidenceScreenshot,status}' = 'deleted'
      AND work_order.payload #>> '{tmsEvidenceDisposition,status}' = 'deleted'
      AS confirmed_terminal
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND (
      (
        work_order.completion_state = 'confirmed'
        AND work_order.completion_confirmation_method = 'detail-completed'
        AND work_order.payload #>> '{pddResolutionSubmission,status}' = 'succeeded'
        AND work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
        AND work_order.payload #>> '{pddResolutionSubmission,orderNumber}' =
          work_order.external_order_number
        AND work_order.payload #>> '{pddEvidenceScreenshot,status}' = 'deleted'
        AND work_order.payload #>> '{tmsEvidenceScreenshot,status}' = 'deleted'
        AND work_order.payload #>> '{tmsEvidenceDisposition,status}' = 'deleted'
      )
      OR (
        work_order.recovery_state <> 'held'
        AND (
          coalesce(work_order.manual_review_reason, '')
            ~ 'OMS 发货快递没有平台建议选项|异常网点预警未读取到平台建议快递'
          OR coalesce(work_order.manual_review_reason, '')
            ~ '异常网点预警未找到(唯一)?平台建议快递'
          OR coalesce(work_order.manual_review_reason, '') =
            '外部操作已存在 succeeded 记录，禁止重复执行'
          OR coalesce(work_order.manual_review_reason, '') LIKE '平台仍提示操作太过频繁%'
          OR coalesce(work_order.manual_review_reason, '')
            LIKE '%已有 TMS 工单无法同时核对订单、运单号、仓库和快递%'
          OR coalesce(work_order.manual_review_reason, '')
            LIKE '%拼多多发货城市范围判断缺失或订单不一致%'
          OR coalesce(work_order.manual_review_reason, '')
            LIKE '%拼多多页面存在未识别的遮挡弹窗%'
          OR coalesce(work_order.manual_review_reason, '')
            LIKE '%EBUSY: resource busy or locked%verification-focus.lock%'
          OR coalesce(work_order.manual_review_reason, '')
            ~ '^locator\.click: Timeout [0-9]+ms exceeded\.[\s\S]*salesOrderCode'
          OR coalesce(work_order.manual_review_reason, '') = 'read-only page render failed'
        )
      )
    )
    AND coalesce(work_order.manual_review_reason, '') NOT LIKE '%48143%'
    AND coalesce(work_order.manual_review_reason, '') NOT LIKE '%上传失败%'
    AND coalesce(work_order.manual_review_reason, '') NOT LIKE '%未确认凭证上传成功%'
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'evidence-upload'
        AND effect.status IN ('failed', 'unknown', 'reserved')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND (
      (
        work_order.completion_state = 'confirmed'
        AND work_order.completion_confirmation_method = 'detail-completed'
        AND work_order.payload #>> '{pddResolutionSubmission,status}' = 'succeeded'
        AND work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.effect_type = 'pdd-submit'
          AND (
            effect.status IN ('reserved', 'unknown', 'succeeded')
            OR (
              effect.status = 'failed'
              AND coalesce(effect.receipt->>'clickAttempted', 'unknown') <> 'false'
            )
          )
          AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
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
    current_step = CASE
      WHEN candidate.confirmed_terminal THEN 'confirmed-terminal-archive-retry-ready'
      ELSE 'deterministic-ordinary-policy-retry-ready'
    END,
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', CASE
          WHEN candidate.confirmed_terminal THEN 'confirmed-terminal-archive-retry-ready'
          ELSE 'deterministic-ordinary-policy-retry-ready'
        END,
        'transientWorkflowRecovery', CASE
          WHEN candidate.confirmed_terminal THEN
            coalesce(work_order.payload->'transientWorkflowRecovery', '{}'::jsonb)
          ELSE jsonb_build_object(
            'count', 0,
            'maxAttempts', 5,
            'lastReason', candidate.previous_reason,
            'retryAt', now(),
            'recoveredAt', now(),
            'recoverySource', 'migration-192'
          )
        END,
        'deterministicOrdinaryRecovery192', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', candidate.strategy,
          'previousReason', candidate.previous_reason,
          'confirmedTerminal', candidate.confirmed_terminal,
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
    work_order.current_step,
    candidate.previous_reason,
    candidate.strategy,
    candidate.confirmed_terminal
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = recovered.current_step,
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
    recovered.strategy,
    recovered.confirmed_terminal
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-192',
    'deterministic-ordinary-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', recovered.strategy,
      'confirmedTerminal', recovered.confirmed_terminal
    ),
    'migration-192:deterministic-ordinary:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-192')
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
  last_error = jsonb_build_object('reason', 'automatic-deterministic-recovery-192')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('192_recover_remaining_deterministic_ordinary_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
