BEGIN;

-- Resume OMS reissue work only when the prior uncertain submission has been
-- disproved by two exact, read-only OMS queries. The failed effect is retained
-- as the authorization evidence; the repository consumes it atomically when
-- the guarded retry is reserved.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    effect.id AS effect_id,
    effect.request_hash AS previous_request_hash,
    effect.error#>'{readOnlyReconciliation}' AS reconciliation
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects effect
    ON effect.work_order_id = work_order.id
    AND effect.shop_id = work_order.shop_id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND effect.effect_type = 'oms-reissue-create'
    AND effect.status = 'failed'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) = '外部操作已存在 failed 记录，禁止重复执行'
    AND effect.error#>>'{readOnlyReconciliation,state}' = 'not-applied'
    AND effect.error#>>'{readOnlyReconciliation,effectType}' = 'oms-reissue-create'
    AND effect.error#>>'{readOnlyReconciliation,readOnly}' = 'true'
    AND effect.error#>>'{readOnlyReconciliation,externalActionsReplayed}' = 'false'
    AND effect.error#>>'{readOnlyReconciliation,confirmationMethod}' =
      'two-pass-exact-oms-order-query-single-original-row'
    AND effect.error#>>'{readOnlyReconciliation,orderNumber}' =
      work_order.external_order_number
    AND coalesce(
      effect.error#>>'{readOnlyReconciliation,originalSalesOrderCode}',
      ''
    ) <> ''
    AND jsonb_typeof(effect.error#>'{readOnlyReconciliation,queryPasses}') = 'array'
    AND jsonb_array_length(effect.error#>'{readOnlyReconciliation,queryPasses}') = 2
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        effect.error#>'{readOnlyReconciliation,queryPasses}'
      ) pass
      WHERE coalesce(pass->>'queryResponseCaptured', '') <> 'true'
        OR coalesce(pass->>'queryResponseOk', '') <> 'true'
        OR coalesce(pass->>'queryInputValue', '') <> work_order.external_order_number
        OR coalesce(pass->>'apiTotal', '') <> '1'
        OR CASE WHEN jsonb_typeof(pass->'apiRows') = 'array'
          THEN jsonb_array_length(pass->'apiRows') ELSE -1 END <> 1
        OR CASE WHEN jsonb_typeof(pass->'reissueRows') = 'array'
          THEN jsonb_array_length(pass->'reissueRows') ELSE -1 END <> 0
        OR coalesce(pass#>>'{apiRows,0,salesOrderCode}', '') <>
          effect.error#>>'{readOnlyReconciliation,originalSalesOrderCode}'
        OR coalesce(pass#>>'{apiRows,0,isReissue}', '') <> 'false'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects tms_effect
      WHERE tms_effect.work_order_id = work_order.id
        AND tms_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND tms_effect.effect_type = 'tms-create'
        AND tms_effect.status = 'succeeded'
    )
    AND NOT EXISTS (
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
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, effect
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-reissue-verified-not-applied-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-reissue-verified-not-applied-retry-ready',
        'ordinaryReissueCreation',
          coalesce(work_order.payload->'ordinaryReissueCreation', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'retry-authorized',
            'retryAuthorization', 'two-pass-exact-oms-order-query-single-original-row',
            'authorizedAt', now()
          ),
        'omsReissueVerifiedRetry', jsonb_build_object(
          'effectId', candidate.effect_id,
          'previousRequestHash', candidate.previous_request_hash,
          'reconciliation', candidate.reconciliation,
          'authorizedAt', now(),
          'recoverySource', 'migration-280'
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.effect_id,
    candidate.previous_request_hash
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-reissue-verified-not-applied-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
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
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-280',
    'oms-reissue-verified-not-applied-retry-scheduled',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'effectId', recovered.effect_id,
      'previousRequestHash', recovered.previous_request_hash,
      'authorization', 'two-pass-exact-oms-order-query-single-original-row'
    ),
    'migration-280:oms-reissue-verified-not-applied:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-280')
  FROM recovered_instances recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code NOT IN (
      'image-upload-failed',
      'pdd-upload-authorization-failed'
    )
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object('reason', 'automatic-safe-recovery-280')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('280_retry_verified_oms_reissue_not_applied.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
