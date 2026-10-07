BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:remaining-stale-pdd-evidence-48143-257')
);

-- Requeue every remaining stale 48143 order that has no submit click and no
-- successful, reserved, or unknown external effect. The committed TMS ticket
-- is preserved. Expired local evidence metadata is removed so the Worker must
-- reopen the exact PDD case and recapture a fresh image before any submission.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.scenario_code,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    instance.platform_case_id,
    binding.binding_token::text AS current_binding_token,
    work_order.payload#>>'{tmsEvidenceScreenshot,relativePath}'
      AS expired_screenshot_relative_path,
    work_order.payload#>>'{tmsWorkOrder,ticketId}' AS tms_ticket_id,
    work_order.payload#>>'{tmsWorkOrder,ticketNo}' AS tms_ticket_no
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND nullif(binding.binding_token::text, '') IS NOT NULL
    AND nullif(binding.mall_id, '') IS NOT NULL
  WHERE work_order.scenario_code IN (
      'intercept-recall',
      'delivery-risk-concern',
      'delivered-not-received'
    )
    AND instance.identity_status = 'verified'
    AND instance.platform_case_id IS NOT NULL
    AND instance.platform_case_key =
      'pdd-work-order:' || instance.platform_case_id
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') = 'ready'
    AND work_order.manual_review_reason =
      '拼多多凭证上传授权失败（48143）：非法请求'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,status}' = 'failed'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,authorizationFailure,errorCode}' =
      '48143'
    AND work_order.payload#>>'{ordinaryEvidenceUploadRecovery,status}' = 'exhausted'
    AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
    AND coalesce(
      work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}',
      '0'
    ) ~ '^[0-9]+$'
    AND (coalesce(
      work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}',
      '0'
    ))::int <= 1
    AND work_order.payload#>>'{ordinaryScenarioDecision,evidence,required,0,source}' IN (
      'tms-recall-evidence',
      'tms-reminder-evidence',
      'tms-delivery-contact-evidence',
      'pdd-shipping-logistics-screenshot'
    )
    AND work_order.payload#>>'{tmsEvidenceScreenshot,status}' = 'ready'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,relativePath}' =
      'tmp/pdd-work-order-replies/' || work_order.external_order_number || '.png'
    AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
    AND nullif(work_order.payload#>>'{tmsWorkOrder,ticketId}', '') IS NOT NULL
    AND nullif(work_order.payload#>>'{tmsWorkOrder,ticketNo}', '') IS NOT NULL
    AND (
      work_order.scenario_code = 'delivery-risk-concern'
      OR (
        work_order.payload#>>'{ordinaryScenarioExecution,commonFlowTicket,status}' = 'created'
        AND work_order.payload#>>'{ordinaryScenarioExecution,omsTmsFlowCompleted}' = 'true'
      )
    )
    AND (
      work_order.scenario_code <> 'intercept-recall'
      OR work_order.payload#>>'{ordinaryScenarioDecision,evidence,required,0,source}' <>
        'tms-recall-evidence'
      OR work_order.payload#>>'{ordinaryScenarioExecution,tmsRecallCompleted}' = 'true'
    )
    AND work_order.payload#>>'{omsWarehouseParse,status}' = 'confirmed'
    AND work_order.payload#>>'{omsAnalysis,shippingWarehouse}' ~
      '(简卓|众邦|铭如|瞳琪|捷佑|亿哈|筑越仓|迅发|品动工贸|祺迦工贸)'
    AND 1 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'evidence-upload'
        AND effect.status = 'failed'
        AND effect.error->>'message' LIKE '%48143%'
        AND (effect.receipt IS NULL OR jsonb_typeof(effect.receipt) = 'null')
    )
    AND 1 >= (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND NOT (
          effect.status = 'failed'
          AND effect.error->>'message' LIKE '%48143%'
          AND (effect.receipt IS NULL OR jsonb_typeof(effect.receipt) = 'null')
        )
    )
    AND 1 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.receipt#>>'{result,data,ticketId}' =
          work_order.payload#>>'{tmsWorkOrder,ticketId}'
        AND effect.receipt#>>'{result,data,ticketNo}' =
          work_order.payload#>>'{tmsWorkOrder,ticketNo}'
    )
    AND (
      EXISTS (
        SELECT 1
        FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
          AND effect.effect_type = 'pdd-note'
          AND effect.status = 'succeeded'
          AND effect.receipt IS NOT NULL
          AND jsonb_typeof(effect.receipt) = 'object'
      )
      OR (
        work_order.payload#>>'{pddOrderRemark,status}' = 'skipped-verification'
        AND work_order.payload#>>'{pddOrderRemark,reason}' =
          'Optional PDD order remark triggered verification; core work-order handling continued after the challenge cleared.'
        AND NOT EXISTS (
          SELECT 1
          FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
            AND effect.effect_type = 'pdd-note'
        )
      )
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
        AND (
          effect.status = 'succeeded'
          OR effect.receipt->>'clickAttempted' = 'true'
          OR effect.receipt#>>'{result,submitReceipt,clickAttempted}' = 'true'
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
  ORDER BY instance.last_discovered_at DESC NULLS LAST,
    work_order.updated_at DESC,
    work_order.id
  FOR UPDATE OF work_order, instance SKIP LOCKED
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'remaining-stale-pdd-evidence-48143-recapture-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = jsonb_set(
      jsonb_set(
        coalesce(work_order.payload, '{}'::jsonb)
          - 'manualReview'
          - 'error'
          - 'ordinaryScenarioFacts'
          - 'ordinaryScenarioDecision'
          - 'ordinaryEvidenceUpload'
          - 'ordinaryEvidenceUploadRecovery'
          - 'pddResolutionSubmission'
          - 'pddEvidenceScreenshot'
          - 'tmsEvidenceScreenshot'
          - 'tmsEvidenceDisposition',
        '{latestDiscovery}',
        coalesce(work_order.payload->'latestDiscovery', '{}'::jsonb)
          || jsonb_build_object(
            'pddIdentityBindingToken', candidate.current_binding_token,
            'identityReboundAt', now()
          ),
        true
      ),
      '{ordinaryScenarioExecution}',
      (coalesce(work_order.payload->'ordinaryScenarioExecution', '{}'::jsonb)
        - 'evidenceUpload')
        || jsonb_build_object('pddEvidenceUploadFailed', false),
      true
    ) || jsonb_build_object(
      'step', 'remaining-stale-pdd-evidence-48143-recapture-retry-ready',
      'remainingStalePddEvidence48143Recapture257', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'rebind-recapture-and-upload-with-pdd_mms-fallback',
        'previousReason', candidate.previous_reason,
        'expiredScreenshotRelativePath', candidate.expired_screenshot_relative_path,
        'tmsTicketId', candidate.tms_ticket_id,
        'tmsTicketNo', candidate.tms_ticket_no,
        'externalActionsReplayedByMigration', false,
        'authorizedAt', now()
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
    candidate.scenario_code,
    candidate.previous_reason,
    candidate.expired_screenshot_relative_path,
    candidate.tms_ticket_id,
    candidate.tms_ticket_no
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'remaining-stale-pdd-evidence-48143-recapture-retry-ready',
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
    'migration-257',
    'remaining-stale-pdd-evidence-48143-recapture-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'scenarioCode', recovered.scenario_code,
      'previousReason', recovered.previous_reason,
      'expiredScreenshotRelativePath', recovered.expired_screenshot_relative_path,
      'tmsTicketId', recovered.tms_ticket_id,
      'tmsTicketNo', recovered.tms_ticket_no,
      'strategy', 'rebind-recapture-and-upload-with-pdd_mms-fallback',
      'proof', 'unclicked-failed-upload-with-committed-tms-ticket-and-no-unresolved-effect',
      'externalActionsReplayedByMigration', false
    ),
    'migration-257:remaining-stale-pdd-evidence-48143-recapture:'
      || recovered.id::text
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
VALUES ('257_recover_remaining_stale_pdd_evidence_48143.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
