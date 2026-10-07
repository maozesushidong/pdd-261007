BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:archive-relocated-abnormal-network-completion-268')
);

-- This work order was completed on the exact PDD detail after its shop record
-- was relocated. Only the temporary screenshot metadata still names the old
-- shop id. Archive from the confirmed completed-page observation without
-- reading or deleting that foreign artifact and without replaying any action.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  legacy_shop_id
) AS (
  VALUES (
    '3377695b-2b28-4b1c-b042-0a2b7787463d'::uuid,
    'shop-mse1sff3-b85aa4'::text,
    '260810-445581965661813'::text,
    '90c4e1c6-ed04-4f35-9285-0b6ff7088582'::uuid,
    '500012923200568'::text,
    'panapopo-medical-device'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    expected.platform_case_id,
    expected.legacy_shop_id,
    coalesce(
      nullif(
        work_order.payload#>>'{pddResolutionSubmission,completedAt}',
        ''
      )::timestamptz,
      work_order.completion_confirmed_at
    ) AS completed_at
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = 'abnormal-network-warning'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.detail_url =
      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
        || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'abnormal-network-warning'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.mall_id =
      work_order.payload#>>'{latestDiscovery,pddMallId}'
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.current_step = 'flow-paused'
    AND work_order.completion_state = 'confirmed'
    AND work_order.completion_confirmation_method = 'detail-completed'
    AND work_order.completion_confirmed_at IS NOT NULL
    AND work_order.manual_review_reason = '拼多多截图属于其他店铺'
    AND instance.manual_review_reason = '拼多多截图属于其他店铺'
    AND work_order.payload->>'error' = '拼多多截图属于其他店铺'
    AND work_order.payload#>>'{latestDiscovery,shopId}' = work_order.shop_id
    AND nullif(
      work_order.payload#>>'{latestDiscovery,identityRelocatedAt}',
      ''
    ) IS NOT NULL
    AND work_order.payload#>>'{latestDiscovery,actualShopName}' =
      shop.expected_shop_name
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'succeeded'
    AND work_order.payload#>>'{pddResolutionSubmission,shopId}' =
      work_order.shop_id
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddResolutionSubmission,confirmationMethod}' =
      'detail-completed'
    AND work_order.payload#>>'{pddResolutionSubmission,recoveredFromCompletedPage}' =
      'true'
    AND nullif(
      work_order.payload#>>'{pddResolutionSubmission,completedAt}',
      ''
    ) IS NOT NULL
    AND work_order.payload#>>'{tmsBypass,status}' = 'skipped'
    AND work_order.payload#>>'{tmsBypass,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{tmsBypass,scenarioCode}' =
      'abnormal-network-warning'
    AND work_order.payload#>>'{tmsBypass,shopId}' =
      expected.legacy_shop_id
    AND work_order.payload#>>'{pddEvidenceScreenshot,status}' = 'ready'
    AND work_order.payload#>>'{pddEvidenceScreenshot,shopId}' =
      expected.legacy_shop_id
    AND work_order.payload#>>'{pddEvidenceScreenshot,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddEvidenceScreenshot,relativePath}' =
      'tmp/tms-logistics-work-orders/260810-445581965661813.png'
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
        'reason',
          '迁店前截图元数据属于旧店铺；未读取或删除旧文件，仅清理当前订单引用'
      ),
      'lastCompletedOrder', jsonb_build_object(
        'orderNumber', work_order.external_order_number,
        'ordinaryInstanceId', work_order.current_ordinary_instance_id,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', work_order.payload#>>'{pddResolutionSubmission,outcome}',
        'completedAt', candidate.completed_at,
        'confirmationMethod', 'detail-completed',
        'recoveredFromCompletedPage', true,
        'archivedAt', now()
      ),
      'completionArchive', jsonb_build_object(
        'shopId', work_order.shop_id,
        'orderNumber', work_order.external_order_number,
        'platformWorkOrderId', candidate.platform_case_id,
        'platformCaseKey', 'pdd-work-order:' || candidate.platform_case_id,
        'outcome', work_order.payload#>>'{pddResolutionSubmission,outcome}',
        'completedAt', candidate.completed_at,
        'confirmationMethod', 'detail-completed',
        'recoveredFromCompletedPage', true,
        'archivedAt', now()
      ),
      'relocatedAbnormalNetworkCompletionRecovery268', jsonb_build_object(
        'status', 'archived',
        'source', 'migration-268',
        'legacyShopId', candidate.legacy_shop_id,
        'legacyEvidenceAccessed', false,
        'legacyEvidenceDeleted', false,
        'businessEffectsReplayed', false,
        'proof',
          'current-shop exact-detail completion plus current identity binding',
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
    candidate.legacy_shop_id,
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
    'migration-268',
    'relocated-abnormal-network-completion-archived',
    jsonb_build_object(
      'orderNumber', archived.external_order_number,
      'platformCaseId', archived.platform_case_id,
      'legacyShopId', archived.legacy_shop_id,
      'completedAt', archived.completed_at,
      'legacyEvidenceAccessed', false,
      'legacyEvidenceDeleted', false,
      'businessEffectsReplayed', false
    ),
    'migration-268:relocated-abnormal-network-completion:' || archived.id::text
  FROM archived_instances archived
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-268')
  FROM archived
  WHERE intervention.work_order_id = archived.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      archived.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'confirmed-completion-finalized-by-migration-268'
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
VALUES ('268_archive_relocated_abnormal_network_completion.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
