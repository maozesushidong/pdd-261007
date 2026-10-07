BEGIN;

-- The fifth browser profile was never assigned a unique PDD account, while the
-- defence-supplies account's pending refunds remained under a profile that was
-- later used for a different mall. Keep the observed business identity and
-- move only records carrying the exact historical shop-name evidence.
UPDATE shops
SET name = 'PANAPOPO防护用品官方旗舰店',
  expected_shop_name = 'PANAPOPO防护用品官方旗舰店',
  onboarding_status = 'waiting-login',
  onboarding_error = '请登录 PANAPOPO防护用品官方旗舰店；系统会校验店名和 mall_id，错误账号不会处理工单',
  login_requested_at = now(),
  onboarding_completed_at = NULL,
  updated_at = now(),
  config_version = config_version + 1
WHERE id = 'panapopo-healthcare'
  AND NOT EXISTS (
    SELECT 1 FROM pdd_shop_runtime_bindings binding
    WHERE binding.shop_id = 'panapopo-healthcare'
  );

UPDATE shop_identity_bindings
SET expected_shop_name = 'PANAPOPO防护用品官方旗舰店',
  mall_id = NULL,
  status = 'revoked',
  updated_at = now()
WHERE shop_id = 'panapopo-healthcare';

CREATE TEMP TABLE defence_refund_recovery_candidates ON COMMIT DROP AS
SELECT work_order.id, work_order.shop_id AS previous_shop_id,
  work_order.external_order_number, refund.aftersale_number,
  refund.evidence->>'pddIdentityBindingToken' AS previous_binding_token
FROM work_orders work_order
JOIN return_refunds refund ON refund.work_order_id = work_order.id
  AND refund.shop_id = work_order.shop_id
WHERE work_order.shop_id <> 'panapopo-healthcare'
  AND work_order.scenario_code = 'return-refund'
  AND work_order.status IN ('queued','retry-ready','paused')
  AND work_order.recovery_state <> 'held'
  AND coalesce(
    nullif(refund.evidence->>'detectedShopName', ''),
    nullif(refund.evidence->>'shopNameSnapshot', ''),
    nullif(refund.evidence->>'actualShopName', ''),
    nullif(work_order.payload->>'detectedShopName', ''),
    nullif(work_order.payload->>'shopNameSnapshot', '')
  ) = 'PANAPOPO防护用品官方旗舰店'
  AND coalesce(
    nullif(refund.evidence->>'pddMallId', ''),
    nullif(work_order.payload->>'pddMallId', ''),
    nullif(work_order.payload->'returnRefund'->'evidence'->>'pddMallId', '')
  ) IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.status IN ('reserved','unknown')
  )
  AND NOT EXISTS (
    SELECT 1 FROM shop_runtime_state runtime
    WHERE runtime.current_work_order_id = work_order.id
      AND runtime.lease_token IS NOT NULL
      AND runtime.lease_expires_at > now()
  )
  AND NOT EXISTS (
    SELECT 1
    FROM return_refunds other_refund
    JOIN work_orders other ON other.id = other_refund.work_order_id
    WHERE other_refund.work_order_id <> refund.work_order_id
      AND other_refund.aftersale_number = refund.aftersale_number
      AND other.shop_id = 'panapopo-healthcare'
      AND other.status IN ('processing','queued','retry-ready')
      AND other.recovery_state <> 'held'
  );

UPDATE work_orders work_order
SET shop_id = 'panapopo-healthcare',
  payload = (coalesce(work_order.payload, '{}'::jsonb) - 'pddMallId')
    || jsonb_build_object(
      'detectedShopName', 'PANAPOPO防护用品官方旗舰店',
      'shopNameSnapshot', 'PANAPOPO防护用品官方旗舰店'
    ),
  updated_at = now()
FROM defence_refund_recovery_candidates candidate
WHERE work_order.id = candidate.id;

UPDATE return_refunds refund
SET shop_id = 'panapopo-healthcare',
  evidence = (coalesce(refund.evidence, '{}'::jsonb) - 'pddMallId')
    || jsonb_build_object(
      'detectedShopName', 'PANAPOPO防护用品官方旗舰店',
      'shopNameSnapshot', 'PANAPOPO防护用品官方旗舰店',
      'identityRelocatedAt', now()
    ),
  updated_at = now()
FROM defence_refund_recovery_candidates candidate
WHERE refund.work_order_id = candidate.id;

UPDATE external_effects item SET shop_id = 'panapopo-healthcare'
FROM defence_refund_recovery_candidates candidate WHERE item.work_order_id = candidate.id;
UPDATE evidence_assets item SET shop_id = 'panapopo-healthcare'
FROM defence_refund_recovery_candidates candidate WHERE item.work_order_id = candidate.id;
UPDATE verification_locations item SET shop_id = 'panapopo-healthcare'
FROM defence_refund_recovery_candidates candidate WHERE item.work_order_id = candidate.id;
UPDATE audit_events item SET shop_id = 'panapopo-healthcare'
FROM defence_refund_recovery_candidates candidate WHERE item.work_order_id = candidate.id;
UPDATE workflow_events item SET shop_id = 'panapopo-healthcare'
FROM defence_refund_recovery_candidates candidate WHERE item.work_order_id = candidate.id;
UPDATE operator_commands item SET shop_id = 'panapopo-healthcare'
FROM defence_refund_recovery_candidates candidate WHERE item.work_order_id = candidate.id;
UPDATE manual_interventions item SET shop_id = 'panapopo-healthcare'
FROM defence_refund_recovery_candidates candidate WHERE item.work_order_id = candidate.id;

INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT 'panapopo-healthcare', candidate.id, 'migration-096',
  'pending-return-refund-shop-corrected',
  jsonb_build_object(
    'orderNumber', candidate.external_order_number,
    'aftersaleNumber', candidate.aftersale_number,
    'actualShopName', 'PANAPOPO防护用品官方旗舰店',
    'previousShopId', candidate.previous_shop_id,
    'previousBindingToken', candidate.previous_binding_token,
    'reason', 'restore-unique-fifth-shop-identity'
  ),
  'migration-096:defence-shop-refund:' || candidate.id::text
FROM defence_refund_recovery_candidates candidate
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE shop_schedule_state
SET schedule_state = 'queued',
  queue_entered_at = now(),
  retry_at = NULL,
  next_ordinary_scan_at = least(next_ordinary_scan_at, now()),
  next_refund_scan_at = least(next_refund_scan_at, now()),
  metadata = coalesce(metadata, '{}'::jsonb)
    || jsonb_build_object('manualSessionKind', 'login', 'manualSessionRequestedAt', now()),
  updated_at = now(),
  version = version + 1
WHERE shop_id = 'panapopo-healthcare';

COMMIT;
