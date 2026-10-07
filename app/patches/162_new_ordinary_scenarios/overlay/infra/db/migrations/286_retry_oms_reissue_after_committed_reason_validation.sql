BEGIN;

SET client_encoding = 'UTF8';

-- Retry only the observed OMS stage. TMS ticket L00040604 is already
-- succeeded and remains protected by its existing idempotent effect.
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
    ON instance.id = '6e2aaa64-4f8b-4d89-9f0f-fd44e648a44f'::uuid
    AND instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = '500013086736240'
    AND instance.platform_case_key = 'pdd-work-order:500013086736240'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects effect
    ON effect.id = '266bc4f0-477b-4c59-90ff-05c96e6acfde'::uuid
    AND effect.work_order_id = work_order.id
    AND effect.shop_id = work_order.shop_id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND effect.effect_type = 'oms-reissue-create'
    AND effect.status = 'failed'
    AND effect.request_hash =
      '2726bf76b210a02bf69b36b48a2c080f3646ea20be9f2b26e8eff3662755c8be'
  WHERE work_order.id = 'ffdd33e1-dee8-4fdd-a937-3b98a0a957ad'::uuid
    AND work_order.shop_id = 'shop-msrd6wm5-1af283'
    AND work_order.external_order_number = '260818-416567805503036'
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
    AND instance.current_step = 'flow-paused'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) = 'OMS 批量补发表单必填项未满足：补发原因'
    AND coalesce(effect.error->>'name', '') = 'Error'
    AND effect.error->>'message' = 'OMS 批量补发表单必填项未满足：补发原因'
    AND effect.receipt->>'reason' = 'oms-reissue-required-fields-incomplete'
    AND effect.receipt->>'clickAttempted' = 'false'
    AND effect.receipt#>>'{formDiagnostic,valid}' = 'false'
    AND effect.receipt#>>'{formDiagnostic,requiredCount}' = '1'
    AND jsonb_typeof(effect.receipt#>'{formDiagnostic,blockingItems}') = 'array'
    AND jsonb_array_length(effect.receipt#>'{formDiagnostic,blockingItems}') = 1
    AND effect.receipt#>>'{formDiagnostic,blockingItems,0,label}' = '补发原因'
    AND effect.receipt#>>'{formDiagnostic,blockingItems,0,filled}' = 'true'
    AND effect.receipt#>>'{formDiagnostic,blockingItems,0,invalid}' = 'true'
    AND effect.receipt#>'{formDiagnostic,blockingItems,0,errorTexts}' ? '不能为空'
    AND effect.receipt#>>'{formDiagnostic,blockingItems,0,controlStates,0,domValuePresent}' = 'true'
    AND EXISTS (
      SELECT 1
      FROM schema_migrations migration
      WHERE migration.version = '285_pause_product_shortage_automatic_processing.sql'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects tms_effect
      WHERE tms_effect.id = '802ce494-a6d1-432d-bc8a-50f4938ea573'::uuid
        AND tms_effect.work_order_id = work_order.id
        AND tms_effect.shop_id = work_order.shop_id
        AND tms_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND tms_effect.effect_type = 'tms-create'
        AND tms_effect.status = 'succeeded'
        AND tms_effect.receipt#>>'{result,data,ticketId}' = '40687'
        AND tms_effect.receipt#>>'{result,data,ticketNo}' = 'L00040604'
    )
    AND EXISTS (
      SELECT 1
      FROM tms_work_orders tms
      WHERE tms.id = '0d73e805-84cc-4d7a-b749-800df92d2ba4'::uuid
        AND tms.work_order_id = work_order.id
        AND tms.external_ticket_id = '40687'
        AND tms.payload->>'ticketNo' = 'L00040604'
        AND tms.payload->>'effectStage' = 'ordinary-delivery-risk-lost-v1'
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
    current_step = 'oms-reissue-reason-model-commit-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-reissue-reason-model-commit-retry-ready',
        'ordinaryReissueCreation',
          coalesce(work_order.payload->'ordinaryReissueCreation', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'retry-authorized',
            'retryAuthorization', 'visible-value-invalid-vue-model-no-submit',
            'formStrategy', 'validated-reopen-double-click-commit-v2',
            'authorizedAt', now()
          ),
        'omsReissueReasonModelCommitRetry', jsonb_build_object(
          'effectId', candidate.effect_id,
          'requestHash', candidate.request_hash,
          'previousReceipt', candidate.previous_receipt,
          'tmsTicketId', '40687',
          'tmsTicketNo', 'L00040604',
          'authorizedAt', now(),
          'recoverySource', 'migration-286'
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
    current_step = 'oms-reissue-reason-model-commit-retry-ready',
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
    'migration-286',
    'oms-reissue-reason-model-commit-retry-scheduled',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'effectId', recovered.effect_id,
      'requestHash', recovered.request_hash,
      'authorization', 'visible-value-invalid-vue-model-no-submit',
      'formStrategy', 'validated-reopen-double-click-commit-v2',
      'tmsTicketId', '40687',
      'tmsTicketNo', 'L00040604',
      'externalActionsReplayed', false
    ),
    'migration-286:oms-reissue-reason-model-commit:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-286')
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
  last_error = jsonb_build_object('reason', 'automatic-safe-recovery-286')
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

DO $$
BEGIN
  IF 1 <> (
    SELECT count(*)
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
      AND instance.work_order_id = work_order.id
      AND instance.shop_id = work_order.shop_id
    JOIN audit_events event
      ON event.work_order_id = work_order.id
      AND event.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND event.deduplication_key =
        'migration-286:oms-reissue-reason-model-commit:' || work_order.id::text
    WHERE work_order.id = 'ffdd33e1-dee8-4fdd-a937-3b98a0a957ad'::uuid
      AND work_order.status = 'retry-ready'
      AND work_order.runtime_status = 'retry-ready'
      AND work_order.current_step = 'oms-reissue-reason-model-commit-retry-ready'
      AND instance.id = '6e2aaa64-4f8b-4d89-9f0f-fd44e648a44f'::uuid
      AND instance.status = 'retry-ready'
      AND instance.runtime_status = 'retry-ready'
      AND instance.current_step = 'oms-reissue-reason-model-commit-retry-ready'
  ) THEN
    RAISE EXCEPTION 'migration-286 recovery precondition did not match exactly one target';
  END IF;
END
$$;

INSERT INTO schema_migrations (version)
VALUES ('286_retry_oms_reissue_after_committed_reason_validation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
