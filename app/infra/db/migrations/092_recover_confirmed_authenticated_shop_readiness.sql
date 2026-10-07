BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT shop.id, shop.name, runtime_binding.binding_token,
    runtime_binding.actual_shop_name, runtime_binding.profile_fingerprint
  FROM shops shop
  JOIN shop_identity_bindings confirmed
    ON confirmed.shop_id = shop.id
    AND confirmed.status = 'confirmed'
  JOIN pdd_shop_runtime_bindings runtime_binding
    ON runtime_binding.shop_id = shop.id
  JOIN shop_runtime_state runtime
    ON runtime.shop_id = shop.id
  WHERE shop.enabled = true
    AND shop.onboarding_status IN ('waiting-login', 'initializing', 'error')
    AND shop.login_requested_at IS NULL
    AND shop.name = runtime_binding.actual_shop_name
    AND shop.expected_shop_name = runtime_binding.actual_shop_name
    AND confirmed.expected_shop_name = runtime_binding.actual_shop_name
    AND nullif(confirmed.profile_fingerprint, '') IS NOT NULL
    AND confirmed.profile_fingerprint = runtime_binding.profile_fingerprint
    AND runtime.metadata#>>'{pddIdentityBinding,bindingToken}' =
      runtime_binding.binding_token::text
    AND runtime.metadata#>>'{pddIdentityBinding,actualShopName}' =
      runtime_binding.actual_shop_name
    AND NOT EXISTS (
      SELECT 1 FROM pdd_shop_runtime_bindings duplicate
      WHERE duplicate.shop_id <> shop.id
        AND duplicate.actual_shop_name = runtime_binding.actual_shop_name
    )
    AND NOT EXISTS (
      SELECT 1 FROM verification_locations verification
      WHERE verification.shop_id = shop.id
        AND verification.status IN ('detected', 'waiting-human', 'verification-required')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state active_runtime
      WHERE active_runtime.shop_id = shop.id
        AND active_runtime.current_work_order_id IS NOT NULL
        AND active_runtime.lease_token IS NOT NULL
        AND active_runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE shops shop
  SET onboarding_status = 'ready',
    onboarding_error = NULL,
    onboarding_completed_at = coalesce(shop.onboarding_completed_at, now()),
    updated_at = now()
  FROM candidates candidate
  WHERE shop.id = candidate.id
  RETURNING shop.id, shop.name, candidate.binding_token,
    candidate.actual_shop_name, candidate.profile_fingerprint
)
INSERT INTO audit_events
  (shop_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.id, 'migration-092',
  'confirmed-authenticated-shop-readiness-recovered',
  jsonb_build_object(
    'shopName', recovered.name,
    'actualShopName', recovered.actual_shop_name,
    'bindingToken', recovered.binding_token,
    'profileFingerprint', recovered.profile_fingerprint,
    'strategy', 'confirmed-profile-binding-without-active-login-blocker'
  ),
  'migration-092:confirmed-shop-readiness:' || recovered.id
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE shop_schedule_state schedule
SET schedule_state = 'queued',
  queue_entered_at = least(coalesce(schedule.queue_entered_at, now()), now()),
  retry_at = NULL,
  next_ordinary_scan_at = least(schedule.next_ordinary_scan_at, now()),
  ordinary_overdue_reason = NULL,
  updated_at = now(),
  version = version + 1
FROM shops shop
WHERE shop.id = schedule.shop_id
  AND shop.onboarding_status = 'ready'
  AND EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.shop_id = shop.id
      AND audit.deduplication_key = 'migration-092:confirmed-shop-readiness:' || shop.id
  )
  AND schedule.assigned_slot_id IS NULL;

COMMIT;
