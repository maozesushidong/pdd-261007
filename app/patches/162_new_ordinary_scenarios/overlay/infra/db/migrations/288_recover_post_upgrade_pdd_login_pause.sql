\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-post-upgrade-pdd-login-pause-288')
);

-- This exact delivery-risk instance completed its OMS/TMS/PDD stages before an
-- old runtime classified a later PDD login wait as a permanent flow pause.
-- Requeue only the read-only detail reconciliation. Existing successful
-- effects remain authoritative and must not be replayed by this migration.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  scenario_code
) AS (
  VALUES (
    '08842946-3654-4bcf-b98d-26e7a59b05f6'::uuid,
    'songteng-yazc-overseas'::text,
    '260820-431300308550394'::text,
    '149b6e1f-a16d-43cc-972e-825056611b66'::uuid,
    '500013073650430'::text,
    'delivery-risk-concern'::text
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
    (
      SELECT count(*)::int
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status = 'succeeded'
    ) AS preserved_successful_effect_count
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = expected.scenario_code
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.manual_review_reason = '拼多多登录后仍返回登录页'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.id = work_order.current_ordinary_instance_id
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
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND coalesce(work_order.recovery_state, 'ready') IN (
      'ready', 'retry-authorized'
    )
    AND work_order.payload#>>'{ordinaryScenarioExecution,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{ordinaryScenarioExecution,scenarioCode}' =
      expected.scenario_code
    AND work_order.payload#>>'{ordinaryScenarioExecution,firstReminderTicket,status}' =
      'created'
    AND work_order.payload#>>'{ordinaryScenarioExecution,evidenceUpload,status}' =
      'uploaded'
    AND work_order.payload#>>'{ordinaryScenarioExecution,lastStageSubmission,actionCode}' =
      'tms-reminder'
    AND work_order.payload#>>'{ordinaryScenarioExecution,lastStageSubmission,reasonCode}' =
      'platform-reminder-result-requires-tms-confirmation'
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'tms-create:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-lost-v1'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'tms-create:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-reminder-v1'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'pdd-note:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id || ':save'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'evidence-upload'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'evidence-upload:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':pdd-evidence-upload-ordinary-delivery-risk-concern'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-concern-platform-rejected-logistics-update-requires-reminder:primary'
        AND effect.receipt#>>'{result,submitReceipt,success}' = 'true'
        AND effect.receipt#>>'{result,transitionConfirmed}' = 'true'
        AND effect.receipt#>>'{result,selectedPddOutcome}' =
          '需要联系物流核实'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-concern-platform-reminder-result-requires-tms-confirmation:result'
        AND effect.receipt#>>'{result,submitReceipt,success}' = 'true'
        AND effect.receipt#>>'{result,transitionConfirmed}' = 'true'
        AND effect.receipt#>>'{result,selectedPddOutcome}' =
          '物流可以更新，能送达'
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
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key NOT IN (
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-concern-platform-rejected-logistics-update-requires-reminder:primary',
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-concern-platform-reminder-result-requires-tms-confirmation:result'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key NOT IN (
          'tms-create:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-lost-v1',
          'tms-create:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-delivery-risk-reminder-v1'
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
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-login-reconciliation-retry-ready',
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
      - 'systemLogin'
      - 'loginRecovery'
      - 'verificationStage'
      - 'verificationLocation'
      - 'verificationFocus'
    ) || jsonb_build_object(
      'step', 'pdd-login-reconciliation-retry-ready',
      'ordinaryPddLoginPauseRecovery288', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-288',
        'strategy', 'pdd-detail-read-only-before-continuation',
        'platformCaseId', candidate.platform_case_id,
        'previousReason', candidate.previous_reason,
        'preservedSuccessfulEffectCount',
          candidate.preserved_successful_effect_count,
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
    candidate.previous_reason,
    candidate.preserved_successful_effect_count
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-login-reconciliation-retry-ready',
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
    'migration-288',
    'pdd-login-pause-read-only-reconciliation-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'previousReason', recovered.previous_reason,
      'preservedSuccessfulEffectCount',
        recovered.preserved_successful_effect_count,
      'strategy', 'pdd-detail-read-only-before-continuation',
      'successfulPriorEffectsPreserved', true,
      'externalActionsReplayedByMigration', false
    ),
    'migration-288:pdd-login-pause:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id,
    payload->>'orderNumber' AS order_number,
    payload->>'platformCaseId' AS platform_case_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-288')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.reason_code = 'login-required'
      OR intervention.reason = recovered.previous_reason
    )
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-safe-recovery-288'
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
    'platformCaseId', platform_case_id
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('288_recover_post_upgrade_pdd_login_pause.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
