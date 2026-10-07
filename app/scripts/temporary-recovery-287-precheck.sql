\encoding UTF8
\pset pager off

SELECT
  work_order.id AS work_order_id,
  work_order.shop_id,
  work_order.external_order_number,
  work_order.scenario_code,
  work_order.status AS work_order_status,
  work_order.runtime_status AS work_order_runtime_status,
  work_order.current_step AS work_order_step,
  work_order.completion_state,
  work_order.recovery_state,
  work_order.manual_review_reason,
  work_order.current_ordinary_instance_id,
  instance.platform_case_id,
  instance.platform_case_key,
  instance.identity_status,
  instance.scenario_code AS instance_scenario_code,
  instance.status AS instance_status,
  instance.runtime_status AS instance_runtime_status,
  instance.current_step AS instance_step,
  work_order.payload#>>'{pddResolutionSubmission,status}' AS submission_status,
  work_order.payload#>>'{pddResolutionSubmission,orderNumber}' AS submission_order,
  work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' AS submission_scenario,
  work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' AS submit_attempt_count,
  work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' AS last_click_attempted_at,
  work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS payload_binding_token,
  shop.expected_shop_name,
  (
    SELECT count(*)
    FROM pdd_shop_runtime_bindings binding
    WHERE binding.shop_id = work_order.shop_id
      AND binding.actual_shop_name = shop.expected_shop_name
      AND binding.binding_token::text =
        work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  ) AS matching_binding_count,
  (
    SELECT count(*)
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id = instance.id
      AND effect.effect_type = 'pdd-submit'
      AND effect.status = 'succeeded'
      AND effect.idempotency_key =
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-evidence-v1'
  ) AS succeeded_evidence_effect_count,
  (
    SELECT count(*)
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id = instance.id
      AND effect.effect_type = 'pdd-submit'
      AND effect.status = 'failed'
      AND effect.idempotency_key =
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-delivered-not-received-result-ready'
      AND effect.receipt->>'clickAttempted' = 'false'
      AND effect.receipt#>>'{notAppliedProof,state}' = 'not-applied'
      AND effect.receipt#>>'{notAppliedProof,exactPendingEditableDetail}' = 'true'
      AND effect.receipt#>>'{notAppliedProof,observedOrderNumber}' =
        work_order.external_order_number
  ) AS failed_not_applied_effect_count,
  (
    SELECT count(*)
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.status IN ('reserved', 'unknown')
  ) AS unsafe_effect_count,
  (
    SELECT count(*)
    FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.effect_type = 'pdd-submit'
      AND effect.status = 'succeeded'
      AND effect.idempotency_key <>
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-evidence-v1'
  ) AS other_succeeded_submit_count,
  (
    SELECT count(*)
    FROM shop_runtime_state runtime
    WHERE runtime.shop_id = work_order.shop_id
      AND runtime.current_work_order_id = work_order.id
      AND runtime.lease_token IS NOT NULL
      AND runtime.lease_expires_at > now()
  ) AS active_lease_count
FROM work_orders work_order
JOIN shops shop ON shop.id = work_order.shop_id
LEFT JOIN ordinary_work_order_instances instance
  ON instance.id = work_order.current_ordinary_instance_id
WHERE work_order.shop_id = 'shop-mt9vdd44-99aa93'
  AND work_order.external_order_number = '260826-494408907193372';

SELECT
  effect.effect_type,
  effect.status,
  effect.idempotency_key,
  effect.receipt->>'selectedPddOutcome' AS selected_pdd_outcome,
  effect.receipt->>'clickAttempted' AS click_attempted,
  effect.receipt->>'transitionConfirmed' AS transition_confirmed,
  effect.receipt#>>'{notAppliedProof,state}' AS not_applied_state,
  effect.reserved_at,
  effect.updated_at
FROM external_effects effect
JOIN work_orders work_order ON work_order.id = effect.work_order_id
WHERE work_order.shop_id = 'shop-mt9vdd44-99aa93'
  AND work_order.external_order_number = '260826-494408907193372'
  AND effect.ordinary_instance_id = work_order.current_ordinary_instance_id
  AND effect.effect_type = 'pdd-submit'
ORDER BY effect.reserved_at;

SELECT
  work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AS base_work_order_match,
  shop.enabled = true AND shop.onboarding_status = 'ready'
    AS shop_ready_match,
  instance.platform_case_id = '500013092953576'
    AND instance.platform_case_key = 'pdd-work-order:500013092953576'
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'delivered-not-received'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
    AS instance_match,
  coalesce(work_order.recovery_state, 'ready') IN ('ready', 'retry-authorized')
    AS recovery_state_match,
  work_order.manual_review_reason LIKE
    'PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE:%'
    AS reason_prefix_match,
  work_order.manual_review_reason LIKE
    '%拼多多自动话术未包含必需内容: 济南历下区刚子百货商店%'
    AS reason_detail_match,
  work_order.payload#>>'{pddResolutionSubmission,status}' = 'form-retry'
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
      'delivered-not-received'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '0'
    AND nullif(
      work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}', ''
    ) IS NULL
    AS submission_match,
  EXISTS (
    SELECT 1 FROM pdd_shop_runtime_bindings binding
    WHERE binding.shop_id = work_order.shop_id
      AND binding.actual_shop_name = shop.expected_shop_name
      AND binding.binding_token::text =
        work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  ) AS binding_match,
  EXISTS (
    SELECT 1 FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id = instance.id
      AND effect.effect_type = 'pdd-submit'
      AND effect.status = 'succeeded'
      AND effect.idempotency_key =
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-confirmation-v1'
  ) AS confirmation_effect_match,
  EXISTS (
    SELECT 1 FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id = instance.id
      AND effect.effect_type = 'pdd-submit'
      AND effect.status = 'succeeded'
      AND effect.idempotency_key =
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-evidence-v1'
  ) AS evidence_effect_match,
  EXISTS (
    SELECT 1 FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id = instance.id
      AND effect.effect_type = 'pdd-submit'
      AND effect.status = 'failed'
      AND effect.idempotency_key =
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-delivered-not-received-result-ready'
      AND effect.receipt->>'clickAttempted' = 'false'
      AND effect.receipt#>>'{notAppliedProof,state}' = 'not-applied'
      AND effect.receipt#>>'{notAppliedProof,exactPendingEditableDetail}' = 'true'
      AND effect.receipt#>>'{notAppliedProof,observedOrderNumber}' =
        work_order.external_order_number
  ) AS failed_effect_match,
  NOT EXISTS (
    SELECT 1 FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.status IN ('reserved', 'unknown')
  ) AS no_unsafe_effects,
  NOT EXISTS (
    SELECT 1 FROM external_effects effect
    WHERE effect.work_order_id = work_order.id
      AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND effect.effect_type = 'pdd-submit'
      AND effect.status = 'succeeded'
      AND effect.idempotency_key NOT IN (
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-confirmation-v1',
        'pdd-submit:' || work_order.shop_id
          || ':pdd-work-order:500013092953576:'
          || 'ordinary-delivered-not-received-evidence-v1'
      )
  ) AS no_unexpected_successes,
  NOT EXISTS (
    SELECT 1 FROM shop_runtime_state runtime
    WHERE runtime.shop_id = work_order.shop_id
      AND runtime.current_work_order_id = work_order.id
      AND runtime.lease_token IS NOT NULL
      AND runtime.lease_expires_at > now()
  ) AS no_active_lease
FROM work_orders work_order
JOIN shops shop ON shop.id = work_order.shop_id
JOIN ordinary_work_order_instances instance
  ON instance.id = work_order.current_ordinary_instance_id
WHERE work_order.shop_id = 'shop-mt9vdd44-99aa93'
  AND work_order.external_order_number = '260826-494408907193372';
