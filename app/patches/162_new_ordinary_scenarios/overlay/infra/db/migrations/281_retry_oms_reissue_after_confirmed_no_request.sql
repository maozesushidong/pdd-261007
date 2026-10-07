BEGIN;

-- Retry the flat OMS reissue form only after the previous footer click was
-- observed to produce no request, response, confirmation, or dialog close.
-- The failed effect and succeeded TMS effect remain as immutable evidence.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    effect.id AS effect_id,
    effect.request_hash,
    effect.receipt AS previous_receipt
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
    ON effect.id = 'a9821ce9-d209-4254-8fdf-10ae2335fd80'::uuid
    AND effect.work_order_id = work_order.id
    AND effect.shop_id = work_order.shop_id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND effect.effect_type = 'oms-reissue-create'
    AND effect.status = 'failed'
    AND effect.request_hash =
      'fdee4a5301def8c31036779b5c2b2425808322a1d712e8485accc0cf357cc7e1'
  WHERE work_order.id = 'f0f3e232-b7e5-4e89-b103-56713cee5141'::uuid
    AND work_order.shop_id = 'shop-mt9vci3e-20eedf'
    AND work_order.external_order_number = '260822-371762153000016'
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND work_order.recovery_state = 'ready'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) = 'OMS 批量补发点击后弹窗仍存在且未触发提交请求，已确认本次未提交'
    AND effect.receipt->>'strategy' = 'footer-submit-request-observed-v2'
    AND effect.receipt->>'clickAttempted' = 'true'
    AND effect.receipt->>'outerDialogVisible' = 'true'
    AND effect.receipt->>'confirmationObserved' = 'false'
    AND effect.receipt->>'confirmationClicked' = 'false'
    AND effect.receipt->'nativeDialog' = 'null'::jsonb
    AND jsonb_typeof(effect.receipt->'requests') = 'array'
    AND jsonb_array_length(effect.receipt->'requests') = 0
    AND jsonb_typeof(effect.receipt->'responses') = 'array'
    AND jsonb_array_length(effect.receipt->'responses') = 0
    AND coalesce(effect.error->>'message', '') =
      'OMS 批量补发点击后弹窗仍存在且未触发提交请求，已确认本次未提交'
    AND EXISTS (
      SELECT 1
      FROM external_effects tms_effect
      WHERE tms_effect.id = '41eeeaa6-26de-4b41-8e2b-48b0adc5125f'::uuid
        AND tms_effect.work_order_id = work_order.id
        AND tms_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND tms_effect.effect_type = 'tms-create'
        AND tms_effect.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects unsafe_effect
      WHERE unsafe_effect.shop_id = work_order.shop_id
        AND unsafe_effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects succeeded_reissue
      WHERE succeeded_reissue.work_order_id = work_order.id
        AND succeeded_reissue.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND succeeded_reissue.effect_type = 'oms-reissue-create'
        AND succeeded_reissue.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, effect
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-reissue-form-diagnostic-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-reissue-form-diagnostic-retry-ready',
        'ordinaryReissueCreation',
          coalesce(work_order.payload->'ordinaryReissueCreation', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'retry-authorized',
            'retryAuthorization', 'confirmed-footer-click-produced-no-request',
            'formStrategy', 'required-field-preflight-and-post-click-diagnostic-v1',
            'authorizedAt', now()
          ),
        'omsReissueNoRequestRetry', jsonb_build_object(
          'effectId', candidate.effect_id,
          'requestHash', candidate.request_hash,
          'previousReceipt', candidate.previous_receipt,
          'authorizedAt', now(),
          'recoverySource', 'migration-281'
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
    candidate.request_hash
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-reissue-form-diagnostic-retry-ready',
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
    'migration-281',
    'oms-reissue-confirmed-no-request-retry-scheduled',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'effectId', recovered.effect_id,
      'requestHash', recovered.request_hash,
      'authorization', 'confirmed-footer-click-produced-no-request',
      'formStrategy', 'required-field-preflight-and-post-click-diagnostic-v1'
    ),
    'migration-281:oms-reissue-confirmed-no-request:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-281')
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
  last_error = jsonb_build_object('reason', 'automatic-safe-recovery-281')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
      AND instance.work_order_id = work_order.id
      AND instance.shop_id = work_order.shop_id
    JOIN audit_events event
      ON event.work_order_id = work_order.id
      AND event.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND event.deduplication_key =
        'migration-281:oms-reissue-confirmed-no-request:' || work_order.id::text
    WHERE work_order.id = 'f0f3e232-b7e5-4e89-b103-56713cee5141'::uuid
      AND work_order.status = 'retry-ready'
      AND work_order.runtime_status = 'retry-ready'
      AND work_order.current_step = 'oms-reissue-form-diagnostic-retry-ready'
      AND instance.status = 'retry-ready'
      AND instance.runtime_status = 'retry-ready'
      AND instance.current_step = 'oms-reissue-form-diagnostic-retry-ready'
  ) THEN
    RAISE EXCEPTION 'migration-281 recovery precondition did not match exactly one target';
  END IF;
END
$$;

INSERT INTO schema_migrations (version)
VALUES ('281_retry_oms_reissue_after_confirmed_no_request.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
