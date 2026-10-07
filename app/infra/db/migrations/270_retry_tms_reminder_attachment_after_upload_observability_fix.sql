BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:retry-tms-reminder-attachment-after-upload-observability-fix-270')
);

-- The first lost-package TMS ticket has a durable success receipt. The PDD
-- work order then advanced to the reminder-result stage, where a second,
-- independently idempotent TMS ticket was blocked by the old attachment
-- response timeout. Resume only that later stage after the upload observer and
-- dirty-dialog cleanup fix has been deployed. No external action is replayed by
-- this migration.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  first_ticket_id,
  first_ticket_no
) AS (
  VALUES (
    '7d97c05f-4b5d-468a-a9c3-a8fcf93ea79c'::uuid,
    'panapopo-healthcare'::text,
    '260820-515794594221709'::text,
    '1d837449-117e-4468-8267-315794712420'::uuid,
    '500013063439783'::text,
    '39119'::text,
    'L00039036'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    work_order.payload->'tmsAttachmentTransfer' AS previous_transfer,
    CASE
      WHEN coalesce(
        work_order.payload#>>'{transientWorkflowRecovery,count}',
        ''
      ) ~ '^[0-9]+$'
      THEN (
        work_order.payload#>>'{transientWorkflowRecovery,count}'
      )::integer
      ELSE 0
    END AS previous_transient_count
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = 'delivery-risk-concern'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') IN (
      'ready', 'retry-authorized'
    )
    AND work_order.payload#>>'{ordinaryScenarioDecision,actionCode}' =
      'tms-reminder'
    AND work_order.payload#>>'{ordinaryScenarioDecision,reasonCode}' =
      'platform-reminder-result-requires-tms-confirmation'
    AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
    AND work_order.payload#>>'{tmsWorkOrder,effectStage}' =
      'ordinary-delivery-risk-lost-v1'
    AND work_order.payload#>>'{tmsWorkOrder,ticketId}' =
      expected.first_ticket_id
    AND work_order.payload#>>'{tmsWorkOrder,ticketNo}' =
      expected.first_ticket_no
    AND work_order.payload#>>'{tmsAttachmentTransfer,status}' = 'failed'
    AND work_order.payload#>>'{tmsAttachmentTransfer,orderNumber}' =
      work_order.external_order_number
    AND coalesce(
      work_order.payload#>>'{tmsAttachmentTransfer,error}',
      work_order.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) ~ 'page[.]waitForResponse: Timeout [0-9]+ms exceeded while waiting for event ["'']response["'']'
    AND CASE
      WHEN coalesce(
        work_order.payload#>>'{transientWorkflowRecovery,count}',
        ''
      ) ~ '^[0-9]+$'
      THEN (
        work_order.payload#>>'{transientWorkflowRecovery,count}'
      )::integer
      ELSE 0
    END >= 5
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.idempotency_key =
          'tms-create:' || work_order.shop_id || ':'
          || instance.platform_case_key
          || ':ordinary-delivery-risk-lost-v1'
        AND effect.receipt#>>'{result,data,ticketId}' =
          expected.first_ticket_id
        AND effect.receipt#>>'{result,data,ticketNo}' =
          expected.first_ticket_no
    )
    AND EXISTS (
      SELECT 1
      FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.ordinary_instance_id = instance.id
        AND tms.external_ticket_id = expected.first_ticket_id
        AND tms.status = 'created'
        AND tms.payload->>'ticketNo' = expected.first_ticket_no
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.idempotency_key =
          'tms-create:' || work_order.shop_id || ':'
          || instance.platform_case_key
          || ':ordinary-delivery-risk-reminder-v1'
        AND effect.status IN ('reserved', 'succeeded', 'unknown')
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
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-reminder-attachment-retry-ready',
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
    ) || jsonb_build_object(
      'step', 'tms-reminder-attachment-retry-ready',
      'tmsAttachmentTransfer', jsonb_build_object(
        'orderNumber', work_order.external_order_number,
        'mode', 'file-upload',
        'status', 'retry-ready',
        'previousFailure', candidate.previous_transfer,
        'recoverySource', 'migration-270',
        'retryAt', now()
      ),
      'transientWorkflowRecovery', jsonb_build_object(
        'count', 0,
        'maxAttempts', 5,
        'lastReason', candidate.previous_reason,
        'previousCount', candidate.previous_transient_count,
        'recoverySource', 'migration-270',
        'retryAt', now(),
        'recoveredAt', now()
      ),
      'tmsReminderAttachmentRecovery270', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'fresh-clean-dialog-upload-with-request-observability',
        'firstTicketPreserved', true,
        'firstTicketId',
          work_order.payload#>>'{tmsWorkOrder,ticketId}',
        'firstTicketNo',
          work_order.payload#>>'{tmsWorkOrder,ticketNo}',
        'targetEffectStage', 'ordinary-delivery-risk-reminder-v1',
        'externalActionsReplayed', false,
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
    candidate.previous_reason,
    candidate.previous_transient_count
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-reminder-attachment-retry-ready',
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
    'migration-270',
    'tms-reminder-attachment-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'previousTransientCount', recovered.previous_transient_count,
      'firstTicketId',
        recovered.payload#>>'{tmsWorkOrder,ticketId}',
      'firstTicketNo',
        recovered.payload#>>'{tmsWorkOrder,ticketNo}',
      'targetEffectStage', 'ordinary-delivery-risk-reminder-v1',
      'strategy', 'fresh-clean-dialog-upload-with-request-observability',
      'externalActionsReplayed', false
    ),
    'migration-270:tms-reminder-attachment:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('270_retry_tms_reminder_attachment_after_upload_observability_fix.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
