BEGIN;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'stale-processing-recovered',
    manual_review_reason = '历史处理中记录没有有效租约，已恢复为暂停待复核',
    recovery_state = 'held',
    recovery_reason = 'stale-processing-without-live-lease',
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'step', 'stale-processing-recovered',
      'error', '历史处理中记录没有有效租约，已恢复为暂停待复核',
      'staleProcessingRecovery', jsonb_build_object(
        'status', 'recovered',
        'recoveredAt', now(),
        'reason', 'stale-processing-without-live-lease'
      )
    ),
    updated_at = now()
  WHERE work_order.status = 'processing'
    AND coalesce(work_order.handling_classification, 'automated') = 'manual'
    AND work_order.updated_at < now() - interval '30 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.shop_id = work_order.shop_id
        AND runtime.lease_expires_at > now()
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'migration-032', 'stale-processing-recovered',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', 'stale-processing-without-live-lease'
  ),
  'migration-032:stale-processing:' || id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'logistics-waiting-released',
    manual_review_reason = NULL,
    next_attempt_at = now() + interval '10 minutes',
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview') || jsonb_build_object(
      'step', 'logistics-waiting-released',
      'scenarioCode', work_order.scenario_code,
      'workOrderType', work_order.work_order_type,
      'error', NULL,
      'tmsBypass', jsonb_build_object(
        'orderNumber', work_order.external_order_number,
        'status', 'skipped',
        'reason', 'abnormal-network-warning-does-not-use-tms',
        'skippedAt', now()
      ),
      'logisticsWait', jsonb_build_object(
        'orderNumber', work_order.external_order_number,
        'detailUrl', work_order.payload->>'detailUrl',
        'scenarioCode', work_order.scenario_code,
        'workOrderType', work_order.work_order_type,
        'rowFingerprint', work_order.payload->>'rowFingerprint',
        'retryAfterAt', now() + interval '10 minutes',
        'lastCheckedAt', now(),
        'reason', 'OMS 已确认配货，等待拼多多订单实际发货后再提交处理结果'
      ),
      'loopState', coalesce(work_order.payload->'loopState', '{}'::jsonb) || jsonb_build_object(
        'status', 'waiting',
        'currentOrderNumber', NULL,
        'nextPollAt', now() + interval '10 minutes'
      ),
      'legacyRuntimeRecovery', jsonb_build_object(
        'status', 'recovered-to-logistics-wait',
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  WHERE work_order.status = 'paused'
    AND work_order.completion_state = 'pending'
    AND work_order.current_step = 'flow-paused'
    AND work_order.scenario_code = 'abnormal-network-warning'
    AND (
      work_order.payload #>> '{logisticsAnalysis,abnormalNetworkShipmentState}' = 'unshipped'
      OR work_order.payload #>> '{logisticsAnalysis,hasMerchantShippedText}' = 'false'
      OR work_order.payload #>> '{logisticsAnalysis,hasLogisticsInformation}' = 'false'
    )
    AND work_order.payload #>> '{omsAnalysis,orderStatus}' = '已配货'
    AND coalesce(work_order.payload #>> '{pddResolutionSubmission,status}', '') <> 'succeeded'
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'migration-032', 'legacy-unshipped-recovered',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'nextAction', 'wait-for-real-shipment'
  ),
  'migration-032:legacy-unshipped:' || id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-evidence-upload-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'pddResolutionRecovery'
      - 'pddEvidenceUpload'
    ) || jsonb_build_object(
      'step', 'pdd-evidence-upload-retry-ready',
      'error', NULL,
      'legacyRuntimeRecovery', jsonb_build_object(
        'status', 'pdd-upload-authorization-retry-ready',
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  WHERE work_order.status = 'paused'
    AND work_order.completion_state = 'pending'
    AND work_order.current_step = 'manual-review-blocked'
    AND coalesce(work_order.manual_review_reason, '') LIKE '%48143%'
    AND work_order.created_at >= now() - interval '2 days'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'migration-032', 'pdd-upload-authorization-retry-ready',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', '48143-upload-authorization-retry-with-refreshed-detail'
  ),
  'migration-032:pdd-upload-48143:' || id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH corrected AS (
  UPDATE work_orders work_order
  SET manual_review_reason = work_order.payload->>'error',
    updated_at = now()
  WHERE work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.payload->>'error', '') <> ''
    AND coalesce(work_order.manual_review_reason, '') IN (
      '', '工作流已进入人工复核暂停状态'
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.manual_review_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'migration-032', 'flow-pause-reason-restored',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', manual_review_reason
  ),
  'migration-032:flow-pause-reason:' || id::text
FROM corrected
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
