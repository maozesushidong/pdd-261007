BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:pdd-evidence-bucket-fallback-canary-v2')
);

-- Retry the exact canary after the first run proved that pdd_mms uploaded the
-- image but the old DOM-only success detector did not recognize the receipt.
-- The PDD submit is independently proven not applied before this row can move.
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
  WHERE work_order.external_order_number = '260820-497664663153578'
    AND work_order.shop_id = 'shop-mse1sff3-b85aa4'
    AND instance.platform_case_id = '500013046044841'
    AND instance.platform_case_key = 'pdd-work-order:500013046044841'
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
    AND work_order.scenario_code = 'intercept-recall'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.payload#>>'{ordinaryScenarioExecution,commonFlowTicket,status}' = 'created'
    AND work_order.payload#>>'{ordinaryScenarioExecution,omsTmsFlowCompleted}' = 'true'
    AND work_order.payload#>>'{tmsEvidenceScreenshot,status}' = 'ready'
    AND work_order.payload#>>'{pddOrderRemark,status}' = 'saved'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,status}' = 'unknown'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,bucketFallback,used}' = 'true'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,bucketFallback,primaryErrorCode}' = '48143'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,bucketFallback,fallbackBucketTag}' = 'pdd_mms'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        coalesce(work_order.payload#>'{ordinaryEvidenceUpload,diagnostics,network}', '[]'::jsonb)
      ) network_item
      WHERE network_item->>'url' = 'https://file.pinduoduo.com/v3/store_image'
        AND network_item->>'status' = '200'
        AND left(network_item->>'response', 1) = '{'
        AND ((network_item->>'response')::jsonb)->>'url' LIKE 'https://img.pddpic.com/%'
        AND coalesce((((network_item->>'response')::jsonb)->>'size')::bigint, 0) > 0
        AND coalesce((((network_item->>'response')::jsonb)->>'width')::integer, 0) > 0
        AND coalesce((((network_item->>'response')::jsonb)->>'height')::integer, 0) > 0
    )
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'retry-authorized'
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '1'
    AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
    AND submit_effect.receipt IS NULL
    AND upload_effect.receipt IS NULL
    AND submit_effect.error#>>'{readOnlyReconciliation,state}' = 'not-applied'
    AND submit_effect.error#>>'{readOnlyReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND submit_effect.error#>>'{readOnlyReconciliation,pageState,orderMatches}' = 'true'
    AND submit_effect.error#>>'{readOnlyReconciliation,pageState,isPending}' = 'true'
    AND upload_effect.error#>>'{parentPddSubmitReconciliation,state}' = 'not-applied'
    AND upload_effect.error#>>'{parentPddSubmitReconciliation,pageState,confirmedNotApplied}' = 'true'
    AND EXISTS (
      SELECT 1
      FROM audit_events audit
      WHERE audit.work_order_id = work_order.id
        AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND audit.actor_id = 'migration-243'
        AND audit.event_type = 'pdd-evidence-bucket-fallback-canary-retry-ready'
        AND audit.deduplication_key =
          'migration-243:pdd-evidence-bucket-fallback-canary:' || work_order.id::text
        AND audit.payload->>'orderNumber' = work_order.external_order_number
        AND audit.payload->>'strategy' = 'work-flow-ticket-48143-to-pdd_mms'
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
    current_step = 'pdd-evidence-receipt-canary-retry-ready',
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
      'step', 'pdd-evidence-receipt-canary-retry-ready',
      'pddEvidenceUploadCanary',
      coalesce(work_order.payload->'pddEvidenceUploadCanary', '{}'::jsonb)
        || jsonb_build_object(
          'status', 'receipt-confirmation-retry-ready',
          'receiptProof', 'pdd-store-image-200-with-pddpic-url',
          'submitProof', 'read-only-confirmed-not-applied',
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
    current_step = 'pdd-evidence-receipt-canary-retry-ready',
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
    'migration-244',
    'pdd-evidence-receipt-canary-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'receiptProof', 'pdd-store-image-200-with-pddpic-url',
      'submitProof', 'read-only-confirmed-not-applied'
    ),
    'migration-244:pdd-evidence-receipt-canary:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
SELECT count(*) AS recovered_count FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('244_retry_pdd_evidence_bucket_fallback_canary.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
