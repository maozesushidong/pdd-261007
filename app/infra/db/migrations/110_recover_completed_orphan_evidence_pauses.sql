BEGIN;

-- Requeue completion recoveries that have strong PDD completion evidence but
-- were blocked by stale PDD screenshot metadata. No TMS artifact, upload, or
-- unresolved external effect may exist for the current ordinary instance.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, work_order.manual_review_reason
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      LIKE '%evidence-not-consumed'
    AND work_order.completion_state = 'confirmed'
    AND work_order.completion_confirmation_method IN (
      'detail-completed',
      'handover-detail-completed',
      'absent-from-pending-list',
      'handover-absent-from-pending-list'
    )
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'succeeded'
    AND work_order.payload#>>'{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{pddEvidenceScreenshot,status}' = 'ready'
    AND work_order.payload#>>'{pddEvidenceScreenshot,orderNumber}' =
      work_order.external_order_number
    AND coalesce(work_order.payload->'tmsWorkOrder', 'null'::jsonb) = 'null'::jsonb
    AND coalesce(work_order.payload->'tmsEvidenceScreenshot', 'null'::jsonb) = 'null'::jsonb
    AND coalesce(work_order.payload->'tmsEvidenceDisposition', 'null'::jsonb) = 'null'::jsonb
    AND coalesce(work_order.payload->'pddEvidenceUpload', 'null'::jsonb) = 'null'::jsonb
    AND (
      work_order.completion_confirmation_method IN (
        'detail-completed',
        'handover-detail-completed'
      )
      OR (
        work_order.payload#>>'{pddResolutionPendingListPresence,orderNumber}' =
          work_order.external_order_number
        AND work_order.payload#>>'{pddResolutionPendingListPresence,present}' = 'false'
        AND work_order.payload#>>'{pddResolutionPendingListPresence,refreshed}' = 'true'
        AND work_order.payload#>>'{pddResolutionPendingListPresence,confirmationMethod}'
          IN ('two-pass-exact-order-query', 'exact-order-zero-result')
      )
    )
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.mall_id = coalesce(
      nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
      nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
      nullif(work_order.payload->>'pddMallId', '')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'completed-orphan-evidence-cleanup-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'completed-orphan-evidence-cleanup-retry-ready',
        'recoveredCompletionEvidenceCleanup', jsonb_build_object(
          'previousReason', candidate.manual_review_reason,
          'strategy', 'discard-orphan-metadata-after-confirmed-platform-completion',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.manual_review_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'completed-orphan-evidence-cleanup-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.manual_review_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-110', 'completed-orphan-evidence-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.manual_review_reason,
    'strategy', 'discard-orphan-metadata-after-confirmed-platform-completion'
  ),
  'migration-110:completed-orphan-evidence:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-110')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'completed-orphan-evidence-cleanup-retry-ready'
    AND work_order.payload ? 'recoveredCompletionEvidenceCleanup'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
