BEGIN;

-- The live OMS picker can paint the selected label into the input while its
-- Vue model remains empty. Retry exactly the observed target after deploying
-- the double-click commit fix. The existing successful TMS ticket is reused.
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
    ON instance.id = 'bb3b6e11-c9b7-4ff3-b52a-ed92963f0bd5'::uuid
    AND instance.id = work_order.current_ordinary_instance_id
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
    AND shop.enabled = false
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
    ) = coalesce(effect.error->>'message', '')
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
    AND effect.receipt#>>'{formDiagnostic,blockingItems,0,controlStates,0,vueBoundValueObserved}' = 'false'
    AND effect.receipt#>>'{formDiagnostic,blockingItems,0,controlStates,0,componentModelValueObserved}' = 'false'
    AND coalesce(effect.error->>'name', '') = 'Error'
    AND effect.error->>'message' IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM schema_migrations migration
      WHERE migration.version = '282_retry_oms_reissue_with_validated_second_confirm.sql'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects tms_effect
      WHERE tms_effect.id = '41eeeaa6-26de-4b41-8e2b-48b0adc5125f'::uuid
        AND tms_effect.work_order_id = work_order.id
        AND tms_effect.shop_id = work_order.shop_id
        AND tms_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND tms_effect.effect_type = 'tms-create'
        AND tms_effect.status = 'succeeded'
        AND tms_effect.receipt#>>'{result,data,ticketId}' = '39843'
        AND tms_effect.receipt#>>'{result,data,ticketNo}' = 'L00039760'
    )
    AND 1 = (
      SELECT count(DISTINCT tms.external_ticket_id)
      FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.external_ticket_id = '39843'
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
    current_step = 'oms-reissue-vue-model-commit-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'oms-reissue-vue-model-commit-retry-ready',
        'ordinaryReissueCreation',
          coalesce(work_order.payload->'ordinaryReissueCreation', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'retry-authorized',
            'retryAuthorization', 'dom-value-present-vue-model-empty-no-submit',
            'formStrategy', 'vue-picker-double-click-commit-v1',
            'authorizedAt', now()
          ),
        'omsReissueVueModelCommitRetry', jsonb_build_object(
          'effectId', candidate.effect_id,
          'requestHash', candidate.request_hash,
          'previousReceipt', candidate.previous_receipt,
          'authorizedAt', now(),
          'recoverySource', 'migration-283'
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
    current_step = 'oms-reissue-vue-model-commit-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), reenabled_shop AS (
  UPDATE shops shop
  SET enabled = true,
    config_version = shop.config_version + 1,
    updated_at = now()
  FROM recovered_instances recovered
  WHERE shop.id = recovered.shop_id
    AND shop.enabled = false
  RETURNING shop.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-283',
    'oms-reissue-vue-model-commit-retry-scheduled',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'effectId', recovered.effect_id,
      'requestHash', recovered.request_hash,
      'authorization', 'dom-value-present-vue-model-empty-no-submit',
      'formStrategy', 'vue-picker-double-click-commit-v1',
      'tmsTicketId', '39843',
      'tmsTicketNo', 'L00039760'
    ),
    'migration-283:oms-reissue-vue-model-commit:' || recovered.id::text
  FROM recovered_instances recovered
  JOIN reenabled_shop reenabled ON reenabled.id = recovered.shop_id
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-283')
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
  last_error = jsonb_build_object('reason', 'automatic-safe-recovery-283')
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
        'migration-283:oms-reissue-vue-model-commit:' || work_order.id::text
    WHERE work_order.id = 'f0f3e232-b7e5-4e89-b103-56713cee5141'::uuid
      AND EXISTS (
        SELECT 1 FROM shops shop
        WHERE shop.id = work_order.shop_id AND shop.enabled = true
      )
      AND work_order.status = 'retry-ready'
      AND work_order.runtime_status = 'retry-ready'
      AND work_order.current_step = 'oms-reissue-vue-model-commit-retry-ready'
      AND instance.id = 'bb3b6e11-c9b7-4ff3-b52a-ed92963f0bd5'::uuid
      AND instance.status = 'retry-ready'
      AND instance.runtime_status = 'retry-ready'
      AND instance.current_step = 'oms-reissue-vue-model-commit-retry-ready'
  ) THEN
    RAISE EXCEPTION 'migration-283 recovery precondition did not match exactly one target';
  END IF;
END
$$;

INSERT INTO schema_migrations (version)
VALUES ('283_retry_oms_reissue_after_vue_model_commit_fix.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
