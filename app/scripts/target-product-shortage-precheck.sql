\encoding UTF8

SELECT
  'work_order' AS record_type,
  work_order.id::text AS value_1,
  work_order.status AS value_2,
  work_order.runtime_status AS value_3,
  work_order.current_step AS value_4,
  coalesce(work_order.manual_review_reason, '') AS value_5,
  coalesce(work_order.current_ordinary_instance_id::text, '') AS value_6
FROM work_orders work_order
WHERE work_order.shop_id = 'shop-mt9vci3e-20eedf'
  AND work_order.external_order_number = '260803-676037998961915';

SELECT
  'effect' AS record_type,
  effect.effect_type AS value_1,
  effect.status AS value_2,
  effect.idempotency_key AS value_3,
  coalesce(effect.receipt->>'clickAttempted', '') AS value_4,
  coalesce(effect.receipt#>>'{notAppliedProof,state}', '') AS value_5,
  coalesce(effect.receipt#>>'{notAppliedProof,exactPendingEditableDetail}', '') AS value_6,
  coalesce(effect.receipt#>>'{notAppliedProof,observedOrderNumber}', '') AS value_7,
  coalesce(effect.receipt#>>'{notAppliedProof,editableControlCount}', '') AS value_8
FROM external_effects effect
JOIN work_orders work_order ON work_order.id = effect.work_order_id
WHERE work_order.shop_id = 'shop-mt9vci3e-20eedf'
  AND work_order.external_order_number = '260803-676037998961915'
ORDER BY effect.effect_type, effect.updated_at;

SELECT
  'active_lease' AS record_type,
  count(*)::text AS value_1
FROM shop_runtime_state runtime
JOIN work_orders work_order ON work_order.id = runtime.current_work_order_id
WHERE work_order.shop_id = 'shop-mt9vci3e-20eedf'
  AND work_order.external_order_number = '260803-676037998961915'
  AND runtime.lease_token IS NOT NULL
  AND runtime.lease_expires_at > now();

SELECT
  'unresolved_effects' AS record_type,
  count(*)::text AS value_1
FROM external_effects effect
JOIN work_orders work_order ON work_order.id = effect.work_order_id
WHERE work_order.shop_id = 'shop-mt9vci3e-20eedf'
  AND work_order.external_order_number = '260803-676037998961915'
  AND effect.status IN ('reserved', 'unknown');

SELECT
  'succeeded_submit' AS record_type,
  count(*)::text AS value_1
FROM external_effects effect
JOIN work_orders work_order ON work_order.id = effect.work_order_id
WHERE work_order.shop_id = 'shop-mt9vci3e-20eedf'
  AND work_order.external_order_number = '260803-676037998961915'
  AND effect.effect_type = 'pdd-submit'
  AND effect.status = 'succeeded';

SELECT
  'other_product_shortage' AS record_type,
  work_order.id::text AS value_1,
  work_order.status AS value_2,
  work_order.runtime_status AS value_3,
  work_order.current_step AS value_4,
  coalesce(work_order.manual_review_reason, '') AS value_5,
  coalesce(work_order.payload->>'step', '') AS value_6,
  coalesce(work_order.payload->>'reasonCode', '') AS value_7,
  coalesce(work_order.payload->>'error', '') AS value_8
FROM work_orders work_order
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952';

SELECT
  'other_intervention' AS record_type,
  intervention.status AS value_1,
  intervention.reason_code AS value_2,
  intervention.reason AS value_3,
  intervention.risk_level AS value_4,
  intervention.created_at::text AS value_5,
  coalesce(intervention.resolved_at::text, '') AS value_6
FROM manual_interventions intervention
JOIN work_orders work_order ON work_order.id = intervention.work_order_id
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952'
ORDER BY intervention.created_at DESC;

SELECT
  'other_effect' AS record_type,
  effect.effect_type AS value_1,
  effect.status AS value_2,
  effect.idempotency_key AS value_3,
  coalesce(effect.error::text, '') AS value_4,
  coalesce(effect.receipt::text, '') AS value_5,
  effect.updated_at::text AS value_6
FROM external_effects effect
JOIN work_orders work_order ON work_order.id = effect.work_order_id
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952'
ORDER BY effect.updated_at DESC;

SELECT
  'other_audit' AS record_type,
  audit.event_type AS value_1,
  audit.actor_id AS value_2,
  audit.payload::text AS value_3,
  audit.created_at::text AS value_4
FROM audit_events audit
JOIN work_orders work_order ON work_order.id = audit.work_order_id
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952'
ORDER BY audit.created_at DESC
LIMIT 20;

SELECT
  'other_recovery_identity' AS record_type,
  work_order.id::text AS work_order_id,
  work_order.current_ordinary_instance_id::text AS instance_id,
  instance.platform_case_id,
  instance.platform_case_key,
  instance.identity_status,
  instance.status AS instance_status,
  instance.runtime_status AS instance_runtime_status,
  binding.binding_token::text AS binding_token,
  coalesce(work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}', '') AS payload_binding_token,
  coalesce(work_order.payload#>>'{ordinaryScenarioExecution,omsTmsFlowCompleted}', '') AS oms_tms_completed,
  coalesce(work_order.payload#>>'{ordinaryScenarioExecution,tmsLookupCompleted}', '') AS tms_lookup_completed,
  coalesce(work_order.payload#>>'{tmsWorkOrder,ticketId}', '') AS saved_ticket_id,
  coalesce(work_order.payload#>>'{tmsWorkOrder,ticketNo}', '') AS saved_ticket_no,
  coalesce(work_order.payload#>>'{omsAnalysis,shippingWarehouse}', '') AS shipping_warehouse,
  coalesce(work_order.payload#>>'{omsAnalysis,orderStatus}', '') AS oms_order_status,
  coalesce(work_order.payload#>>'{ordinaryScenarioExecution,orderNumber}', '') AS execution_order,
  coalesce(work_order.payload#>>'{ordinaryScenarioExecution,scenarioCode}', '') AS execution_scenario,
  coalesce(work_order.payload#>>'{ordinaryScenarioExecution,platformCaseKey}', '') AS execution_case_key
FROM work_orders work_order
JOIN ordinary_work_order_instances instance
  ON instance.id = work_order.current_ordinary_instance_id
JOIN shops shop
  ON shop.id = work_order.shop_id
JOIN pdd_shop_runtime_bindings binding
  ON binding.shop_id = work_order.shop_id
  AND binding.actual_shop_name = shop.expected_shop_name
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952';

SELECT
  'other_active_lease' AS record_type,
  count(*)::text AS active_count,
  coalesce(max(runtime.lease_expires_at)::text, '') AS latest_expiry
FROM shop_runtime_state runtime
JOIN work_orders work_order
  ON work_order.id = runtime.current_work_order_id
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952'
  AND runtime.lease_token IS NOT NULL
  AND runtime.lease_expires_at > now();

SELECT
  'other_unresolved_effects' AS record_type,
  count(*)::text AS unresolved_count
FROM external_effects effect
JOIN work_orders work_order ON work_order.id = effect.work_order_id
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952'
  AND effect.status IN ('reserved', 'unknown');

SELECT
  'other_tms_rows' AS record_type,
  count(*)::text AS row_count,
  coalesce(string_agg(tms.external_ticket_id, ',' ORDER BY tms.created_at), '') AS ticket_ids,
  coalesce(string_agg(tms.payload->>'ticketNo', ',' ORDER BY tms.created_at), '') AS ticket_numbers
FROM tms_work_orders tms
JOIN work_orders work_order ON work_order.id = tms.work_order_id
WHERE work_order.shop_id = 'songteng-yazc-overseas'
  AND work_order.external_order_number = '260823-522285269393952';
