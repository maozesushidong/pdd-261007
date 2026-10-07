BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:pdd-evidence-receipt-confirmation-canary')
);

-- One current PDD pending-list item validates the new pdd_mms upload receipt
-- confirmation. No PDD submit was attempted and no unresolved effect exists.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects upload_effect
    ON upload_effect.work_order_id = work_order.id
    AND upload_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND upload_effect.effect_type = 'evidence-upload'
    AND upload_effect.status = 'failed'
  JOIN external_effects submit_effect
    ON submit_effect.work_order_id = work_order.id
    AND submit_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    AND submit_effect.effect_type = 'pdd-submit'
    AND submit_effect.status = 'failed'
  WHERE work_order.id = 'd789d628-5c9d-40f3-b631-cc2b0eb3a82a'
    AND work_order.external_order_number = '260824-360773138722084'
    AND work_order.shop_id = 'shop-mse1sff3-b85aa4'
    AND work_order.current_ordinary_instance_id = 'dd4e83ee-7bea-4986-9fc3-fda2545b2918'
    AND instance.platform_case_id = '500013045196272'
    AND instance.platform_case_key = 'pdd-work-order:500013045196272'
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
    AND work_order.scenario_code = 'intercept-recall'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.payload#>>'{ordinaryScenarioDecision,pdd,option}' = '已进行召回'
    AND work_order.payload#>>'{ordinaryScenarioDecision,evidence,required,0,source}' =
      'tms-recall-evidence'
    AND work_order.payload#>>'{ordinaryScenarioExecution,commonFlowTicket,status}' = 'created'
    AND work_order.payload#>>'{ordinaryScenarioExecution,omsTmsFlowCompleted}' = 'true'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,status}' = 'ready'
    AND work_order.payload#>>'{pddOrderRemark,status}' = 'saved'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,status}' = 'failed'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,uploadInteraction,method}' =
      'visible-trigger-filechooser'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,authorizationFailure,errorCode}' =
      '48143'
    AND work_order.payload#>>'{ordinaryEvidenceUploadRecovery,status}' = 'exhausted'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'submitting'
    AND coalesce(work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}', '0') = '0'
    AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
    AND upload_effect.error->>'message' =
      '拼多多凭证上传授权失败（48143）：非法请求'
    AND submit_effect.error->>'message' =
      '拼多多凭证上传授权失败（48143）：非法请求'
    AND (
      upload_effect.receipt IS NULL
      OR jsonb_typeof(upload_effect.receipt) = 'null'
    )
    AND (
      submit_effect.receipt IS NULL
      OR jsonb_typeof(submit_effect.receipt) = 'null'
    )
    AND (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'evidence-upload'
    ) = 1
    AND (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
        AND effect.receipt IS NOT NULL
        AND jsonb_typeof(effect.receipt) = 'object'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
        AND effect.receipt IS NOT NULL
        AND jsonb_typeof(effect.receipt) = 'object'
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
    current_step = 'pdd-evidence-receipt-confirmation-canary-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview'
        - 'error'
        - 'ordinaryEvidenceUpload'
        - 'ordinaryEvidenceUploadRecovery'
        - 'pddResolutionSubmission',
      '{ordinaryScenarioExecution}',
      (coalesce(work_order.payload->'ordinaryScenarioExecution', '{}'::jsonb)
        - 'evidenceUpload')
        || jsonb_build_object('pddEvidenceUploadFailed', false),
      true
    ) || jsonb_build_object(
      'step', 'pdd-evidence-receipt-confirmation-canary-retry-ready',
      'pddEvidenceUploadCanary', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'pdd_mms-network-receipt-and-form-confirmation',
        'previousReason', candidate.previous_reason,
        'authorizedAt', now()
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
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-evidence-receipt-confirmation-canary-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-245',
    'pdd-evidence-receipt-confirmation-canary-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', 'pdd_mms-network-receipt-and-form-confirmation',
      'proof', 'failed-upload-and-failed-unclicked-submit-with-no-unresolved-effects'
    ),
    'migration-245:pdd-evidence-receipt-confirmation-canary:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
SELECT count(*) AS recovered_count FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('245_canary_pdd_evidence_receipt_confirmation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
