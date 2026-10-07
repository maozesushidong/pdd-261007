\encoding UTF8

SELECT
  now() AS checked_at,
  work_order.id AS work_order_id,
  work_order.shop_id,
  work_order.external_order_number,
  work_order.status,
  work_order.runtime_status,
  work_order.current_step,
  work_order.manual_review_reason,
  work_order.next_attempt_at,
  work_order.recovery_state,
  work_order.recovery_reason,
  work_order.recovery_updated_at,
  work_order.payload#>>'{externalStateReconciliationRetry,attempts}' AS reconciliation_attempts,
  work_order.updated_at,
  work_order.payload#>>'{ordinaryReissueCreation,status}' AS reissue_status,
  work_order.payload#>>'{ordinaryReissueCreation,salesOrderCode}' AS reissue_sales_order_code,
  work_order.payload#>>'{ordinaryReissueCreation,retryAuthorization}' AS retry_authorization,
  instance.status AS instance_status,
  instance.runtime_status AS instance_runtime_status,
  instance.current_step AS instance_step,
  runtime.status AS shop_runtime_status,
  runtime.lease_expires_at,
  runtime.lease_token IS NOT NULL AND runtime.lease_expires_at > now() AS active_lease
FROM work_orders work_order
LEFT JOIN ordinary_work_order_instances instance
  ON instance.id = work_order.current_ordinary_instance_id
LEFT JOIN shop_runtime_state runtime ON runtime.shop_id = work_order.shop_id
WHERE work_order.external_order_number = '260822-371762153000016';

SELECT
  effect.id,
  effect.effect_type,
  effect.status,
  effect.request_hash,
  effect.reserved_at,
  effect.updated_at,
  effect.receipt,
  effect.error
FROM external_effects effect
JOIN work_orders work_order ON work_order.id = effect.work_order_id
WHERE work_order.external_order_number = '260822-371762153000016'
ORDER BY effect.updated_at;

SELECT
  event_type,
  actor_id,
  event.created_at,
  event.payload
FROM audit_events event
JOIN work_orders work_order ON work_order.id = event.work_order_id
WHERE work_order.external_order_number = '260822-371762153000016'
ORDER BY event.created_at DESC
LIMIT 15;

SELECT
  work_order.id,
  work_order.shop_id,
  shop.name AS shop_name,
  work_order.external_order_number,
  work_order.scenario_code,
  work_order.status,
  work_order.runtime_status,
  work_order.current_step,
  work_order.manual_review_reason,
  work_order.updated_at
FROM work_orders work_order
JOIN shops shop ON shop.id = work_order.shop_id
WHERE work_order.external_order_number = '260820-431300308550394';
