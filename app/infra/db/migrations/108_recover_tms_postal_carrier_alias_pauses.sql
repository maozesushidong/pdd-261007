BEGIN;

-- Cainiao labels China Post shipments as "菜鸟邮政" in TMS. Recover only
-- pauses whose order identity, linked OMS order, tracking number, and
-- warehouse already agree, leaving every other TMS conflict protected.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason,
    work_order.payload->'tmsAutofillVerification' AS previous_verification,
    work_order.payload->'tmsFormDecision' AS previous_form_decision,
    work_order.payload->'tmsRoutingDecision' AS previous_routing_decision
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'manual-review-blocked'
    AND work_order.payload#>>'{manualReview,stage}' = 'tms-autofill-verification'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      LIKE '%责任快递不一致%'
    AND work_order.payload#>'{tmsAutofillVerification,conflicts}' =
      '["责任快递不一致"]'::jsonb
    AND btrim(work_order.payload#>>'{tmsAutofillVerification,sourceOrderNumber}') =
      btrim(work_order.external_order_number)
    AND work_order.payload#>>'{tmsAutofillVerification,linkedOmsOrder}' = 'true'
    AND btrim(work_order.payload#>>'{tmsAutofillVerification,actual,orderNumber}')
      ~ '^SO[0-9A-Za-z-]+$'
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{tmsAutofillVerification,actual,warehouse}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    ) = regexp_replace(
      lower(coalesce(
        work_order.payload#>>'{tmsAutofillVerification,warehouseVerification,expectedWarehouse}',
        ''
      )),
      '[[:space:][:punct:]]+', '', 'g'
    )
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{tmsAutofillVerification,actual,warehouse}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    ) <> ''
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{tmsAutofillVerification,actual,trackingNumber}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    ) = regexp_replace(
      lower(coalesce(work_order.payload#>>'{logisticsAnalysis,trackingNumber}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    )
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{tmsAutofillVerification,actual,trackingNumber}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    ) <> ''
    AND coalesce(work_order.payload#>>'{tmsAutofillVerification,actual,carrier}', '')
      ~* '菜鸟'
    AND coalesce(work_order.payload#>>'{tmsAutofillVerification,actual,carrier}', '')
      ~* '(邮政|ems)'
    AND coalesce(work_order.payload#>>'{logisticsAnalysis,carrier}', '')
      ~* '(邮政|ems|china[[:space:]]*post)'
    AND instance.identity_status IN ('verified', 'legacy-unverified')
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
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
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
    current_step = 'tms-postal-carrier-alias-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'tmsAutofillVerification'
        - 'tmsAutofillCandidateSelection' - 'tmsFormDecision'
        - 'tmsRoutingDecision' - 'tmsDuplicateCheck' - 'tmsWorkOrder'
        - 'tmsEvidenceScreenshot' - 'tmsEvidenceDisposition'
        - 'tmsAttachmentTransfer')
      || jsonb_build_object(
        'step', 'tms-postal-carrier-alias-retry-ready',
        'updatedAt', now(),
        'tmsPostalCarrierAliasRecovery', jsonb_build_object(
          'previousReason', candidate.reason,
          'previousVerification', candidate.previous_verification,
          'previousFormDecision', candidate.previous_form_decision,
          'previousRoutingDecision', candidate.previous_routing_decision,
          'strategy', 'prefer-explicit-postal-semantics-over-cainiao-prefix',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason,
    candidate.previous_verification
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-postal-carrier-alias-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.reason,
    recovered.previous_verification
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-108', 'tms-postal-carrier-alias-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'previousVerification', recovered.previous_verification,
    'strategy', 'prefer-explicit-postal-semantics-over-cainiao-prefix'
  ),
  'migration-108:tms-postal-carrier-alias:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-108')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'tms-postal-carrier-alias-retry-ready'
    AND work_order.payload ? 'tmsPostalCarrierAliasRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
