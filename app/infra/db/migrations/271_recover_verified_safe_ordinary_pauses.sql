\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-verified-safe-ordinary-pauses-271')
);

-- These three exact instances were inspected after deployment. The first two
-- never produced a PDD submit effect. The third completed only the independent
-- evidence stage; its final-result attempt was rejected before any click or
-- business request. Preserve all successful prior effects and resume only the
-- unfinished PDD stage.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  platform_case_id,
  scenario_code,
  recovery_kind
) AS (
  VALUES
    (
      '4f89b35d-d198-480c-83ab-d1ab63cb9ddd'::uuid,
      'panapopo-medical-device'::text,
      '260827-059915671053202'::text,
      '500013065540013'::text,
      'in-transit-refund'::text,
      'in-transit-handover'::text
    ),
    (
      '1188c9b9-1aca-4e31-a2f1-45df23e1651e'::uuid,
      'shop-mt9vdd44-99aa93'::text,
      '260815-309466315071690'::text,
      '500013063470291'::text,
      'in-transit-refund'::text,
      'resolution-submit-render'::text
    ),
    (
      '5a3ae861-6d45-4d32-bd7c-ff17ace8228f'::uuid,
      'songteng-yazc-overseas'::text,
      '260823-419283617410194'::text,
      '500013068442907'::text,
      'delivered-not-received'::text,
      'delivered-result-message'::text
    )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    expected.platform_case_id,
    expected.scenario_code,
    expected.recovery_kind
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.scenario_code = expected.scenario_code
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = expected.scenario_code
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.recovery_state, 'ready') IN (
      'ready', 'retry-authorized'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND (
      (
        expected.recovery_kind = 'in-transit-handover'
        AND work_order.manual_review_reason LIKE
          'PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE:%'
        AND work_order.payload#>>'{pddCoreOptionLookupFailure,stage}' =
          'in-transit-refund'
        AND work_order.payload#>'{pddCoreOptionLookupFailure,visibleOptions}'
          @> '["已交给快递", "未交给快递"]'::jsonb
        AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
        AND NOT EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
            AND effect.effect_type = 'pdd-submit'
        )
      )
      OR (
        expected.recovery_kind = 'resolution-submit-render'
        AND work_order.manual_review_reason LIKE
          'PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE:%'
        AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
        AND EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.effect_type = 'tms-create'
            AND effect.status = 'succeeded'
        )
        AND EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.effect_type = 'pdd-note'
            AND effect.status = 'succeeded'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
            AND effect.effect_type = 'pdd-submit'
        )
      )
      OR (
        expected.recovery_kind = 'delivered-result-message'
        AND work_order.manual_review_reason LIKE
          'PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE:%'
        AND work_order.payload#>>'{pddResolutionSubmission,status}' =
          'form-retry'
        AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
          work_order.external_order_number
        AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
          'delivered-not-received'
        AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' =
          '0'
        AND nullif(
          work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}',
          ''
        ) IS NULL
        AND EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.effect_type = 'pdd-submit'
            AND effect.status = 'succeeded'
            AND effect.idempotency_key =
              'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
                || expected.platform_case_id
                || ':ordinary-delivered-not-received-evidence-v1'
        )
        AND EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id = instance.id
            AND effect.effect_type = 'pdd-submit'
            AND effect.status = 'failed'
            AND effect.idempotency_key =
              'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
                || expected.platform_case_id
                || ':ordinary-delivered-not-received-delivered-not-received-result-ready'
            AND effect.receipt->>'clickAttempted' = 'false'
            AND effect.receipt#>>'{notAppliedProof,state}' = 'not-applied'
            AND effect.receipt#>>'{notAppliedProof,exactPendingEditableDetail}' =
              'true'
            AND effect.receipt#>>'{notAppliedProof,observedOrderNumber}' =
              work_order.external_order_number
        )
        AND NOT EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
            AND effect.effect_type = 'pdd-submit'
            AND effect.status = 'succeeded'
            AND effect.idempotency_key <>
              'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
                || expected.platform_case_id
                || ':ordinary-delivered-not-received-evidence-v1'
        )
      )
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'verified-safe-ordinary-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      - 'transientWorkflowRecovery'
      - 'ordinarySubmitRenderRecovery'
      - 'ordinaryPddFormTransientRecovery'
      - 'pddCoreOptionLookupFailure'
    ) || jsonb_build_object(
      'step', 'verified-safe-ordinary-retry-ready',
      'ordinaryVerifiedSafeRecovery271', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-271',
        'recoveryKind', candidate.recovery_kind,
        'previousReason', candidate.previous_reason,
        'platformCaseId', candidate.platform_case_id,
        'successfulPriorEffectsPreserved', true,
        'externalActionsReplayedByMigration', false,
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
    candidate.platform_case_id,
    candidate.recovery_kind,
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'verified-safe-ordinary-retry-ready',
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
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-271',
    'verified-safe-ordinary-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'recoveryKind', recovered.recovery_kind,
      'previousReason', recovered.previous_reason,
      'successfulPriorEffectsPreserved', true,
      'externalActionsReplayedByMigration', false
    ),
    'migration-271:verified-safe-ordinary:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number,
    payload->>'recoveryKind' AS recovery_kind
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-271')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-safe-recovery-271'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number,
    'recoveryKind', recovery_kind
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('271_recover_verified_safe_ordinary_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
