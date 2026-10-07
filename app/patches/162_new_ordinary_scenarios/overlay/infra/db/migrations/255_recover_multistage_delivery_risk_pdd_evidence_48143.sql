BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:multistage-delivery-risk-pdd-evidence-48143-255')
);

-- The primary result stage was accepted and its transition was confirmed.
-- The terminal evidence stage then failed before any submit click. Preserve
-- the successful primary effect and release only the unclicked terminal stage
-- for read-only completion reconciliation or pdd_mms upload. This migration
-- replays no OMS, TMS, or PDD action.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  expected_warehouse,
  screenshot_relative_path,
  screenshot_size_bytes,
  screenshot_width,
  screenshot_height,
  screenshot_sha256,
  tms_ticket_id,
  tms_ticket_no
) AS (
  VALUES (
    'a688a556-28f5-4a25-9201-dbcc06837ac6'::uuid,
    'panapopo-medical-device'::text,
    '260816-499562606090189'::text,
    'a0b1fd47-a822-4b36-9ca1-69dd15df5f16'::uuid,
    '500013039106196'::text,
    '代发聚水潭-迅发-共享'::text,
    'tmp/pdd-work-order-replies/260816-499562606090189.png'::text,
    23129::bigint,
    1391::integer,
    64::integer,
    '20AD8E4BEBDA1E2D8B20CBA803AD516025215C87A21FC129CC3C3569C33C65F8'::text,
    '37655'::text,
    'L00037572'::text
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
    expected.screenshot_relative_path,
    expected.screenshot_size_bytes,
    expected.screenshot_width,
    expected.screenshot_height,
    expected.screenshot_sha256,
    primary_submit_effect.id AS primary_submit_effect_id
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
    AND instance.platform_case_key = 'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects initial_submit_effect
    ON initial_submit_effect.work_order_id = work_order.id
    AND initial_submit_effect.shop_id = work_order.shop_id
    AND initial_submit_effect.ordinary_instance_id = instance.id
    AND initial_submit_effect.effect_type = 'pdd-submit'
    AND initial_submit_effect.status = 'failed'
    AND initial_submit_effect.idempotency_key =
      'pdd-submit:' || expected.shop_id || ':pdd-work-order:'
        || expected.platform_case_id
        || ':ordinary-delivery-risk-concern-logistics-updated-within-24-hours'
    AND initial_submit_effect.receipt->>'success' = 'false'
    AND initial_submit_effect.receipt->>'errorCode' = '190001'
    AND initial_submit_effect.receipt->>'clickAttempted' = 'true'
    AND initial_submit_effect.receipt->>'responseCaptured' = 'true'
  JOIN external_effects primary_submit_effect
    ON primary_submit_effect.work_order_id = work_order.id
    AND primary_submit_effect.shop_id = work_order.shop_id
    AND primary_submit_effect.ordinary_instance_id = instance.id
    AND primary_submit_effect.effect_type = 'pdd-submit'
    AND primary_submit_effect.status = 'succeeded'
    AND primary_submit_effect.idempotency_key =
      'pdd-submit:' || expected.shop_id || ':pdd-work-order:'
        || expected.platform_case_id
        || ':ordinary-delivery-risk-concern-platform-rejected-logistics-update-requires-reminder:primary'
    AND primary_submit_effect.receipt#>>'{result,selectedPddOption}' = '需要联系物流核实'
    AND primary_submit_effect.receipt#>>'{result,selectedPddOutcome}' = '需要联系物流核实'
    AND primary_submit_effect.receipt#>>'{result,submitClicked}' = 'true'
    AND primary_submit_effect.receipt#>>'{result,submitReceipt,success}' = 'true'
    AND primary_submit_effect.receipt#>>'{result,submitReceipt,clickAttempted}' = 'true'
    AND primary_submit_effect.receipt#>>'{result,submitReceipt,responseCaptured}' = 'true'
    AND primary_submit_effect.receipt#>>'{result,transitionConfirmed}' = 'true'
  JOIN external_effects result_submit_effect
    ON result_submit_effect.work_order_id = work_order.id
    AND result_submit_effect.shop_id = work_order.shop_id
    AND result_submit_effect.ordinary_instance_id = instance.id
    AND result_submit_effect.effect_type = 'pdd-submit'
    AND result_submit_effect.status = 'failed'
    AND result_submit_effect.idempotency_key =
      'pdd-submit:' || expected.shop_id || ':pdd-work-order:'
        || expected.platform_case_id
        || ':ordinary-delivery-risk-concern-platform-rejected-logistics-update-requires-reminder:result'
  JOIN external_effects upload_effect
    ON upload_effect.work_order_id = work_order.id
    AND upload_effect.shop_id = work_order.shop_id
    AND upload_effect.ordinary_instance_id = instance.id
    AND upload_effect.effect_type = 'evidence-upload'
    AND upload_effect.status = 'failed'
    AND upload_effect.idempotency_key =
      'evidence-upload:' || expected.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':pdd-evidence-upload-ordinary-delivery-risk-concern'
  JOIN external_effects tms_effect
    ON tms_effect.work_order_id = work_order.id
    AND tms_effect.shop_id = work_order.shop_id
    AND tms_effect.ordinary_instance_id = instance.id
    AND tms_effect.effect_type = 'tms-create'
    AND tms_effect.status = 'succeeded'
    AND tms_effect.idempotency_key =
      'tms-create:' || expected.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':ordinary-delivery-risk-reminder-v1'
    AND tms_effect.receipt#>>'{result,data,ticketId}' = expected.tms_ticket_id
    AND tms_effect.receipt#>>'{result,data,ticketNo}' = expected.tms_ticket_no
  JOIN external_effects note_effect
    ON note_effect.work_order_id = work_order.id
    AND note_effect.shop_id = work_order.shop_id
    AND note_effect.ordinary_instance_id = instance.id
    AND note_effect.effect_type = 'pdd-note'
    AND note_effect.status = 'succeeded'
    AND note_effect.receipt#>>'{result,saved}' = 'true'
  WHERE work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') = 'ready'
    AND work_order.payload#>>'{omsWarehouseParse,status}' = 'confirmed'
    AND work_order.payload#>>'{omsAnalysis,shippingWarehouse}' = expected.expected_warehouse
    AND work_order.payload#>>'{ordinaryScenarioExecution,platformLogisticsUpdateRejection,errorCode}' =
      '190001'
    AND work_order.payload#>>'{ordinaryScenarioExecution,platformLogisticsUpdateRejection,errorMessage}' =
      '物流轨迹未更新，请如实填写'
    AND work_order.payload#>>'{ordinaryScenarioExecution,platformLogisticsUpdateRejection,option}' =
      '物流已更新'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,status}' = 'ready'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,relativePath}' =
      expected.screenshot_relative_path
    AND (work_order.payload#>>'{tmsEvidenceScreenshot,sizeBytes}')::bigint =
      expected.screenshot_size_bytes
    AND (work_order.payload#>>'{tmsEvidenceScreenshot,width}')::integer =
      expected.screenshot_width
    AND (work_order.payload#>>'{tmsEvidenceScreenshot,height}')::integer =
      expected.screenshot_height
    AND work_order.payload#>>'{tmsEvidenceScreenshot,ticketId}' = expected.tms_ticket_id
    AND work_order.payload#>>'{tmsEvidenceScreenshot,ticketNo}' = expected.tms_ticket_no
    AND work_order.payload#>>'{pddOrderRemark,status}' = 'saved'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,status}' = 'failed'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,relativePath}' =
      expected.screenshot_relative_path
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,authorizationFailure,errorCode}' =
      '48143'
    AND work_order.payload#>'{ordinaryEvidenceUpload,diagnostics,bucketFallback}' IS NULL
    AND work_order.payload#>>'{ordinaryEvidenceUploadRecovery,status}' = 'exhausted'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'submitting'
    AND coalesce(work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}', '0') = '0'
    AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
    AND upload_effect.error->>'message' =
      '拼多多凭证上传授权失败（48143）：非法请求'
    AND result_submit_effect.error->>'message' =
      '拼多多凭证上传授权失败（48143）：非法请求'
    AND (
      upload_effect.receipt IS NULL
      OR jsonb_typeof(upload_effect.receipt) = 'null'
    )
    AND (
      result_submit_effect.receipt IS NULL
      OR jsonb_typeof(result_submit_effect.receipt) = 'null'
    )
    AND 1 = (
      SELECT count(*) FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'evidence-upload'
    )
    AND 3 = (
      SELECT count(*) FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-submit'
    )
    AND 1 = (
      SELECT count(*) FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
    )
    AND 1 = (
      SELECT count(*) FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
    )
    AND 1 = (
      SELECT count(*) FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF
    work_order,
    instance,
    initial_submit_effect,
    primary_submit_effect,
    result_submit_effect,
    upload_effect
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'multistage-delivery-risk-pdd-evidence-48143-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview'
        - 'error'
        - 'ordinaryScenarioFacts'
        - 'ordinaryScenarioDecision'
        - 'ordinaryEvidenceUpload'
        - 'ordinaryEvidenceUploadRecovery'
        - 'pddResolutionSubmission',
      '{ordinaryScenarioExecution}',
      (coalesce(work_order.payload->'ordinaryScenarioExecution', '{}'::jsonb)
        - 'evidenceUpload')
        || jsonb_build_object('pddEvidenceUploadFailed', false),
      true
    ) || jsonb_build_object(
      'step', 'multistage-delivery-risk-pdd-evidence-48143-retry-ready',
      'multistageDeliveryRiskPddEvidence48143Recovery255', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'preserve-successful-primary-and-reconcile-unclicked-terminal-stage',
        'primarySubmitEffectId', candidate.primary_submit_effect_id,
        'previousReason', candidate.previous_reason,
        'verifiedLocalFile', jsonb_build_object(
          'relativePath', candidate.screenshot_relative_path,
          'sizeBytes', candidate.screenshot_size_bytes,
          'width', candidate.screenshot_width,
          'height', candidate.screenshot_height,
          'sha256', candidate.screenshot_sha256
        ),
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
    candidate.previous_reason,
    candidate.platform_case_id,
    candidate.primary_submit_effect_id,
    candidate.screenshot_relative_path,
    candidate.screenshot_size_bytes,
    candidate.screenshot_width,
    candidate.screenshot_height,
    candidate.screenshot_sha256
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'multistage-delivery-risk-pdd-evidence-48143-retry-ready',
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
    'migration-255',
    'multistage-delivery-risk-pdd-evidence-48143-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'primarySubmitEffectId', recovered.primary_submit_effect_id,
      'previousReason', recovered.previous_reason,
      'strategy', 'preserve-successful-primary-and-reconcile-unclicked-terminal-stage',
      'verifiedLocalFile', jsonb_build_object(
        'relativePath', recovered.screenshot_relative_path,
        'sizeBytes', recovered.screenshot_size_bytes,
        'width', recovered.screenshot_width,
        'height', recovered.screenshot_height,
        'sha256', recovered.screenshot_sha256
      ),
      'proof', 'successful-primary-with-transition-and-unclicked-failed-terminal-stage',
      'externalActionsReplayedByMigration', false
    ),
    'migration-255:multistage-delivery-risk-pdd-evidence-48143:' || recovered.id::text
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
VALUES ('255_recover_multistage_delivery_risk_pdd_evidence_48143.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
