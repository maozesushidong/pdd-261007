\encoding UTF8

SELECT
  now() AS checked_at,
  shop.id AS shop_id,
  shop.name,
  shop.enabled,
  shop.config_version,
  runtime.status AS runtime_status,
  runtime.current_work_order_id,
  runtime.lease_expires_at,
  CASE
    WHEN runtime.lease_token IS NOT NULL AND runtime.lease_expires_at > now()
      THEN true
    ELSE false
  END AS active_lease,
  heartbeat.heartbeat_at,
  coalesce(heartbeat.metadata->>'state', '') AS heartbeat_state,
  extract(epoch FROM (now() - heartbeat.heartbeat_at))::int AS heartbeat_age_seconds
FROM shops shop
LEFT JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
LEFT JOIN LATERAL (
  SELECT worker_heartbeat.heartbeat_at, worker_heartbeat.metadata
  FROM worker_heartbeats worker_heartbeat
  WHERE worker_heartbeat.shop_id = shop.id
  ORDER BY worker_heartbeat.heartbeat_at DESC
  LIMIT 1
) heartbeat ON true
WHERE shop.id = 'shop-mt9vci3e-20eedf';

SELECT
  effect.effect_type,
  effect.status,
  count(*)::int AS effect_count
FROM external_effects effect
WHERE effect.shop_id = 'shop-mt9vci3e-20eedf'
  AND effect.status IN ('reserved', 'unknown')
GROUP BY effect.effect_type, effect.status
ORDER BY effect.effect_type, effect.status;

SELECT
  work_order.id AS work_order_id,
  work_order.shop_id,
  work_order.external_order_number,
  work_order.scenario_code,
  work_order.status,
  work_order.runtime_status,
  work_order.current_step,
  work_order.manual_review_reason,
  work_order.next_attempt_at,
  work_order.updated_at,
  instance.id AS instance_id,
  instance.status AS instance_status,
  instance.runtime_status AS instance_runtime_status,
  instance.current_step AS instance_step,
  instance.manual_review_reason AS instance_reason,
  effect.id AS effect_id,
  effect.effect_type,
  effect.status AS effect_status,
  effect.request_hash,
  effect.updated_at AS effect_updated_at,
  effect.error#>>'{readOnlyReconciliation,state}' AS reconciliation_state,
  effect.error#>>'{readOnlyReconciliation,confirmationMethod}' AS confirmation_method
FROM work_orders work_order
LEFT JOIN ordinary_work_order_instances instance
  ON instance.id = work_order.current_ordinary_instance_id
LEFT JOIN external_effects effect
  ON effect.work_order_id = work_order.id
  AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
WHERE work_order.shop_id = 'shop-mt9vci3e-20eedf'
  AND work_order.external_order_number IN (
    '260822-371762153000016',
    '260820-431300308550394'
  )
ORDER BY work_order.external_order_number, effect.updated_at;

SELECT version, applied_at
FROM schema_migrations
WHERE version = '280_retry_verified_oms_reissue_not_applied.sql';

SELECT effect_type, status, count(*)::int AS effect_count
FROM external_effects
WHERE status IN ('reserved', 'unknown')
GROUP BY effect_type, status
ORDER BY effect_type, status;

SELECT
  work_order.id AS work_order_id,
  shop.expected_shop_name,
  binding.actual_shop_name,
  binding.binding_token::text AS current_binding_token,
  work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS order_binding_token,
  binding.actual_shop_name = shop.expected_shop_name AS shop_name_matches,
  binding.binding_token::text =
    work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS binding_token_matches,
  coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AS operational_visibility,
  shop.enabled AS shop_enabled,
  shop.onboarding_status,
  work_order.scenario_code = 'delivery-risk-concern' AS scenario_matches,
  work_order.status = 'paused' AS work_order_paused,
  work_order.runtime_status = 'paused' AS work_order_runtime_paused,
  instance.status = 'paused' AS instance_paused,
  instance.runtime_status = 'paused' AS instance_runtime_paused,
  coalesce(work_order.completion_state, 'pending') AS completion_state,
  work_order.current_step,
  coalesce(
    work_order.manual_review_reason,
    instance.manual_review_reason,
    work_order.payload->>'error',
    ''
  ) AS effective_reason,
  effect.error#>>'{readOnlyReconciliation,state}' AS reconciliation_state,
  effect.error#>>'{readOnlyReconciliation,effectType}' AS reconciliation_effect_type,
  effect.error#>>'{readOnlyReconciliation,readOnly}' AS reconciliation_read_only,
  effect.error#>>'{readOnlyReconciliation,externalActionsReplayed}'
    AS external_actions_replayed,
  effect.error#>>'{readOnlyReconciliation,confirmationMethod}' AS confirmation_method,
  effect.error#>>'{readOnlyReconciliation,orderNumber}' AS reconciliation_order_number,
  effect.error#>>'{readOnlyReconciliation,originalSalesOrderCode}' AS original_sales_order_code,
  jsonb_typeof(effect.error#>'{readOnlyReconciliation,queryPasses}') AS passes_type,
  CASE
    WHEN jsonb_typeof(effect.error#>'{readOnlyReconciliation,queryPasses}') = 'array'
      THEN jsonb_array_length(effect.error#>'{readOnlyReconciliation,queryPasses}')
    ELSE NULL
  END AS pass_count,
  effect.error#>'{readOnlyReconciliation,queryPasses}' AS query_passes,
  EXISTS (
    SELECT 1
    FROM external_effects tms_effect
    WHERE tms_effect.work_order_id = work_order.id
      AND tms_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND tms_effect.effect_type = 'tms-create'
      AND tms_effect.status = 'succeeded'
  ) AS has_succeeded_tms,
  EXISTS (
    SELECT 1
    FROM external_effects unsafe_effect
    WHERE unsafe_effect.work_order_id = work_order.id
      AND unsafe_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND (
        unsafe_effect.status IN ('reserved', 'unknown')
        OR (
          unsafe_effect.effect_type = 'oms-reissue-create'
          AND unsafe_effect.status = 'succeeded'
        )
      )
  ) AS has_unsafe_effect,
  EXISTS (
    SELECT 1
    FROM shop_runtime_state runtime
    WHERE runtime.shop_id = work_order.shop_id
      AND runtime.current_work_order_id = work_order.id
      AND runtime.lease_token IS NOT NULL
      AND runtime.lease_expires_at > now()
  ) AS has_active_lease
FROM work_orders work_order
JOIN shops shop ON shop.id = work_order.shop_id
JOIN ordinary_work_order_instances instance
  ON instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND instance.shop_id = work_order.shop_id
JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = work_order.shop_id
JOIN external_effects effect
  ON effect.work_order_id = work_order.id
  AND effect.shop_id = work_order.shop_id
  AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
  AND effect.effect_type = 'oms-reissue-create'
  AND effect.status = 'failed'
WHERE work_order.external_order_number = '260822-371762153000016';
