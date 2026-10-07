BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-interrupted-per-shop-oms-login-266')
);

-- Recover only a per-shop OMS login wait that exited before any external
-- effect was created. Browser actions are not replayed by this migration.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
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
  WHERE work_order.status = 'failed'
    AND work_order.runtime_status = 'failed'
    AND instance.status = 'failed'
    AND instance.runtime_status = 'failed'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.current_step = 'manual-login-required'
    AND instance.current_step = 'manual-login-required'
    AND work_order.payload#>>'{systemLogin,system}' = 'oms'
    AND work_order.payload#>>'{systemLogin,status}' = 'retry-ready'
    AND work_order.payload#>>'{authHealth,oms,status}' IN (
      'expired', 'verification-required'
    )
    AND coalesce(work_order.recovery_state, 'ready') IN (
      'ready', 'retry-authorized'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
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
    current_step = 'oms-login-required-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now() + interval '2 minutes',
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
    ) || jsonb_build_object(
      'step', 'oms-login-required-retry-ready',
      'omsLoginYieldRecovery', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-266',
        'strategy', 'preserve-per-shop-profile-and-yield-claim',
        'externalActionsReplayed', false,
        'retryAt', now() + interval '2 minutes',
        'recoveredAt', now()
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
    work_order.next_attempt_at
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-login-required-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = recovered.next_attempt_at,
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-266',
    'interrupted-per-shop-oms-login-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'strategy', 'preserve-per-shop-profile-and-yield-claim',
      'externalActionsReplayed', false,
      'retryAt', recovered.next_attempt_at
    ),
    'migration-266:per-shop-oms-login:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('266_recover_interrupted_per_shop_oms_login.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
