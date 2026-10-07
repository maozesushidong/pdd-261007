BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:pdd-evidence-48143-remaining-safe')
);

-- Release the remaining fully reconciled rows after the ten-order canary. The
-- per-shop limit is a defensive ceiling, not a throughput target. The migration does not
-- alter external effects; the Worker must obtain fresh upload and submit
-- receipts through the validated work-flow-ticket -> pdd_mms fallback.
WITH candidates AS MATERIALIZED (
  SELECT selected.*
  FROM shops shop
  CROSS JOIN LATERAL (
    SELECT work_order.id,
      work_order.shop_id,
      work_order.external_order_number,
      work_order.current_ordinary_instance_id,
      work_order.payload,
      work_order.manual_review_reason AS previous_reason
    FROM work_orders work_order
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
    WHERE work_order.shop_id = shop.id
      AND instance.identity_status = 'verified'
      AND instance.platform_case_id IS NOT NULL
      AND instance.platform_case_key =
        'pdd-work-order:' || instance.platform_case_id
      AND work_order.status = 'paused'
      AND work_order.runtime_status = 'paused'
      AND instance.status = 'paused'
      AND instance.runtime_status = 'paused'
      AND coalesce(work_order.completion_state, 'pending') = 'pending'
      AND coalesce(work_order.recovery_state, 'ready') <> 'held'
      AND work_order.payload#>>'{ordinaryEvidenceUpload,status}' = 'failed'
      AND work_order.payload#>>'{ordinaryEvidenceUpload,diagnostics,authorizationFailure,errorCode}' =
        '48143'
      AND work_order.payload#>>'{ordinaryEvidenceUploadRecovery,status}' = 'exhausted'
      AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
      AND work_order.payload#>>'{ordinaryScenarioDecision,evidence,required,0,source}' IN (
        'tms-recall-evidence',
        'tms-reminder-evidence',
        'tms-delivery-contact-evidence'
      )
      AND work_order.payload#>>'{tmsEvidenceScreenshot,status}' = 'ready'
      AND work_order.payload#>>'{tmsEvidenceScreenshot,relativePath}' =
        'tmp/pdd-work-order-replies/' || work_order.external_order_number || '.png'
      AND work_order.payload#>>'{pddOrderRemark,status}' = 'saved'
      AND work_order.payload#>>'{omsWarehouseParse,status}' = 'confirmed'
      AND work_order.payload#>>'{omsAnalysis,shippingWarehouse}' ~
        '(简卓|众邦|铭如|瞳琪|捷佑|亿哈|筑越仓|迅发|品动工贸|祺迦工贸)'
      AND upload_effect.error->>'message' LIKE '%48143%'
      AND submit_effect.error->>'message' LIKE '%48143%'
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
    ORDER BY instance.last_discovered_at DESC NULLS LAST,
      work_order.updated_at DESC,
      work_order.id
    LIMIT 1000
    FOR UPDATE OF work_order, instance SKIP LOCKED
  ) selected
  WHERE shop.enabled = true
    AND shop.onboarding_status = 'ready'
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-evidence-48143-remaining-safe-retry-ready',
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
      'step', 'pdd-evidence-48143-remaining-safe-retry-ready',
      'pddEvidence48143Recovery', jsonb_build_object(
        'status', 'retry-ready',
        'batch', 'remaining-safe',
        'strategy', 'work-flow-ticket-48143-to-pdd_mms',
        'previousReason', candidate.previous_reason,
        'externalActionsReplayedByMigration', false,
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
    current_step = 'pdd-evidence-48143-remaining-safe-retry-ready',
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
    'migration-247',
    'pdd-evidence-48143-remaining-safe-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'batch', 'remaining-safe',
      'strategy', 'work-flow-ticket-48143-to-pdd_mms',
      'externalActionsReplayedByMigration', false
    ),
    'migration-247:pdd-evidence-48143-remaining-safe:' || recovered.id::text
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
VALUES ('247_recover_pdd_evidence_48143_remaining_safe.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
