BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:archive-abnormal-network-missing-evidence-cleanup-265')
);

-- Abnormal-network orders intentionally skip TMS and therefore do not create
-- the PDD screenshot used only as a TMS attachment. Archive only orders whose
-- PDD completion is already proven. This migration performs no browser action
-- and never replays OMS, TMS, note, upload, or PDD submit effects.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    instance.platform_case_id,
    work_order.payload#>>'{pddResolutionSubmission,outcome}' AS outcome,
    (work_order.payload#>>'{pddResolutionSubmission,completedAt}')::timestamptz
      AS completed_at
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE work_order.scenario_code = 'abnormal-network-warning'
    AND instance.scenario_code = 'abnormal-network-warning'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.current_step = 'flow-paused'
    AND work_order.manual_review_reason = '拼多多截图状态不是 ready'
    AND instance.manual_review_reason = '拼多多截图状态不是 ready'
    AND work_order.payload->>'error' = '拼多多截图状态不是 ready'
    AND (
      work_order.payload->'pddEvidenceScreenshot' IS NULL
      OR work_order.payload->'pddEvidenceScreenshot' = 'null'::jsonb
    )
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'succeeded'
    AND work_order.payload#>>'{pddResolutionSubmission,shopId}' = work_order.shop_id
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddResolutionSubmission,confirmationMethod}' =
      'detail-completed'
    AND nullif(
      work_order.payload#>>'{pddResolutionSubmission,completedAt}', ''
    ) IS NOT NULL
    AND nullif(
      work_order.payload#>>'{pddResolutionSubmission,outcome}', ''
    ) IS NOT NULL
    AND work_order.payload#>>'{pddResolutionSubmission,completionEvidence}' =
      work_order.payload#>>'{pddResolutionSubmission,outcome}'
    AND work_order.payload#>>'{tmsBypass,status}' = 'skipped'
    AND work_order.payload#>>'{tmsBypass,shopId}' = work_order.shop_id
    AND work_order.payload#>>'{tmsBypass,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{tmsBypass,scenarioCode}' =
      'abnormal-network-warning'
    AND work_order.payload#>>'{latestDiscovery,actualShopName}' =
      shop.expected_shop_name
    AND work_order.payload#>>'{latestDiscovery,platformCaseId}' =
      instance.platform_case_id
    AND (
      work_order.payload#>>'{pddResolutionSubmission,recoveredFromCompletedPage}' =
        'true'
      OR EXISTS (
        SELECT 1
        FROM external_effects submit_effect
        WHERE submit_effect.work_order_id = work_order.id
          AND submit_effect.ordinary_instance_id = instance.id
          AND submit_effect.shop_id = work_order.shop_id
          AND submit_effect.effect_type = 'pdd-submit'
          AND submit_effect.status = 'succeeded'
      )
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
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), archived AS (
  UPDATE work_orders work_order
  SET status = 'archived',
    runtime_status = 'archived',
    current_step = 'requested-order-complete',
    manual_review_reason = NULL,
    next_attempt_at = NULL,
    completion_state = 'confirmed',
    completion_confirmation_method = 'detail-completed',
    completion_confirmed_at = candidate.completed_at,
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
    ) || jsonb_build_object(
      'step', 'requested-order-complete',
      'pddEvidenceScreenshot', jsonb_build_object(
        'shopId', work_order.shop_id,
        'orderNumber', work_order.external_order_number,
        'mimeType', 'image/png',
        'purpose', 'tms-logistics-work-order',
        'relativePath', NULL,
        'status', 'deleted',
        'consumedAt', now(),
        'deletedAt', now(),
        'reason', '异常网点预警按规则跳过 TMS，未创建拼多多截图，无需清理文件'
      ),
      'lastCompletedOrder', jsonb_build_object(
        'orderNumber', work_order.external_order_number,
        'ordinaryInstanceId', work_order.current_ordinary_instance_id,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', candidate.outcome,
        'completedAt', candidate.completed_at,
        'confirmationMethod', 'detail-completed',
        'recoveredFromCompletedPage',
          work_order.payload#>>'{pddResolutionSubmission,recoveredFromCompletedPage}' =
            'true',
        'archivedAt', now()
      ),
      'completionArchive', jsonb_build_object(
        'shopId', work_order.shop_id,
        'orderNumber', work_order.external_order_number,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', candidate.outcome,
        'completedAt', candidate.completed_at,
        'confirmationMethod', 'detail-completed',
        'archivedAt', now()
      ),
      'abnormalNetworkMissingEvidenceRecovery265', jsonb_build_object(
        'status', 'archived',
        'source', 'migration-265',
        'businessEffectsReplayed', false,
        'proof', 'confirmed-pdd-completion-with-explicit-tms-bypass',
        'archivedAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.platform_case_id,
    candidate.outcome,
    candidate.completed_at
), archived_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'archived',
    runtime_status = 'archived',
    current_step = 'requested-order-complete',
    manual_review_reason = NULL,
    next_attempt_at = NULL,
    completed_at = archived.completed_at,
    completion_method = 'detail-completed',
    payload = archived.payload,
    updated_at = now()
  FROM archived
  WHERE instance.id = archived.current_ordinary_instance_id
    AND instance.work_order_id = archived.id
    AND instance.shop_id = archived.shop_id
  RETURNING archived.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    archived.shop_id,
    archived.id,
    archived.current_ordinary_instance_id,
    'migration-265',
    'abnormal-network-missing-evidence-cleanup-archived',
    jsonb_build_object(
      'orderNumber', archived.external_order_number,
      'platformCaseId', archived.platform_case_id,
      'outcome', archived.outcome,
      'completedAt', archived.completed_at,
      'businessEffectsReplayed', false
    ),
    'migration-265:abnormal-network-missing-evidence:' || archived.id::text
  FROM archived_instances archived
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-265')
  FROM archived
  WHERE intervention.work_order_id = archived.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      archived.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'external-system-error'
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'confirmed-business-completion-finalized-by-migration-265'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS archived_count,
  jsonb_agg(jsonb_build_object(
    'shopId', archived.shop_id,
    'orderNumber', archived.external_order_number
  ) ORDER BY archived.shop_id, archived.external_order_number) AS archived_orders
FROM archived;

INSERT INTO schema_migrations (version)
VALUES ('265_archive_abnormal_network_missing_evidence_cleanup.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
