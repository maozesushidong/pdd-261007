\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-submit-complete-button-pause-290')
);

-- This exact instance reached the final PDD resolution after TMS creation,
-- the PDD order note, and the handover stage had all succeeded. The legacy
-- button locator did not recognize the rendered "提交并完结" button, and the
-- failed resolution effect proves that no click was attempted. Preserve all
-- successful effects and reset only the stale final-render retry state.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  scenario_code,
  tms_ticket_id
) AS (
  VALUES (
    'ffa7c2df-c4bf-4e98-8511-9e2bb6dcce9c'::uuid,
    'shop-mt9va8ol-47962e'::text,
    '260901-089422579342570'::text,
    'fb6bb018-49b7-447b-82e4-d9b88fbc5df4'::uuid,
    '500013140478952'::text,
    'shipped-no-tracking-refund'::text,
    '43946'::text
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
    expected.tms_ticket_id
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = expected.scenario_code
    AND work_order.scenario_code <> 'product-shortage'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.manual_review_reason LIKE
      'PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE:%'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
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
    AND instance.scenario_code <> 'product-shortage'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
    AND instance.manual_review_reason = work_order.manual_review_reason
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text = coalesce(
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}',
      work_order.payload->>'pddIdentityBindingToken'
    )
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND coalesce(work_order.recovery_state, 'ready') IN (
      'ready', 'retry-authorized'
    )
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{pddResolutionSubmission,status}' =
      'render-retry'
    AND work_order.payload#>>'{pddResolutionSubmission,flowCode}' =
      expected.scenario_code
    AND work_order.payload#>>'{pddResolutionSubmission,submitEffectStage}' =
      'resolution'
    AND coalesce(
      nullif(
        work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}',
        ''
      )::int,
      0
    ) = 0
    AND nullif(
      work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}',
      ''
    ) IS NULL
    AND work_order.payload#>>'{pddResolutionRecovery,status}' = 'retry-ready'
    AND work_order.payload#>>'{pddResolutionRecovery,transientCode}' =
      'PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE'
    AND EXISTS (
      SELECT 1
      FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.ordinary_instance_id = instance.id
        AND tms.status = 'created'
        AND tms.external_ticket_id = expected.tms_ticket_id
        AND tms.payload->>'orderNumber' = expected.order_number
    )
    AND 1 = (
      SELECT count(*)
      FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'tms-create:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id || ':create-ticket'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
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
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id || ':handover'
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
            || expected.platform_case_id || ':resolution'
        AND effect.receipt->>'clickAttempted' = 'false'
        AND effect.receipt->>'stage' = 'resolution'
        AND effect.receipt->>'reason' =
          'submit-button-not-rendered'
        AND effect.error->>'name' = 'PddSubmitButtonRenderError'
        AND work_order.manual_review_reason =
          'PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE: '
            || (effect.error->>'message')
    )
    AND 4 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
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
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-submit-complete-button-recovery-ready',
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
      - 'pddResolutionRecovery'
      - 'ordinarySubmitRenderRecovery'
      - 'pddSubmitButtonLookupFailure'
      - 'pddSubmitButtonContext'
      - 'pddResolutionSubmission'
    ) || jsonb_build_object(
      'step', 'pdd-submit-complete-button-recovery-ready',
      'pddSubmitCompleteButtonRecovery290', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-290',
        'strategy', 'retry-final-resolution-with-submit-complete-button-alias',
        'platformCaseId', candidate.platform_case_id,
        'tmsTicketId', candidate.tms_ticket_id,
        'previousReason', candidate.previous_reason,
        'successfulPriorEffectsPreserved', true,
        'failedResolutionClickAttempted', false,
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
    candidate.tms_ticket_id,
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-submit-complete-button-recovery-ready',
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
    'migration-290',
    'pdd-submit-complete-button-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'tmsTicketId', recovered.tms_ticket_id,
      'previousReason', recovered.previous_reason,
      'successfulPriorEffectsPreserved', true,
      'failedResolutionClickAttempted', false,
      'externalActionsReplayedByMigration', false
    ),
    'migration-290:pdd-submit-complete-button:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id,
    payload->>'orderNumber' AS order_number,
    payload->>'platformCaseId' AS platform_case_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-290')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason = recovered.previous_reason
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-submit-complete-button-recovery-290'
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
VALUES ('290_recover_submit_complete_button_pause.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
