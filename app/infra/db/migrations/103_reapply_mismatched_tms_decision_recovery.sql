BEGIN;

-- Build 102 could be followed by a resident runner hydrating a newer local
-- checkpoint that still contained the rejected TMS row. Reapply the cleanup
-- after the runner is stopped and stamp the PostgreSQL payload as authoritative.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload->'tmsWorkOrder' AS reintroduced_tms_work_order,
    work_order.payload->'tmsDuplicateCheck' AS reintroduced_duplicate_check
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND work_order.payload ? 'mismatchedExistingTmsDecisionRecovery'
    AND (
      work_order.payload ? 'tmsWorkOrder'
      OR work_order.payload ? 'tmsDuplicateCheck'
      OR work_order.payload ? 'tmsEvidenceScreenshot'
    )
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'tms-create'
        AND effect.status = 'succeeded'
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
    current_step = 'tms-existing-decision-mismatch-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'tmsWorkOrder' - 'tmsDuplicateCheck'
        - 'tmsEvidenceScreenshot' - 'tmsEvidenceDisposition' - 'tmsAttachmentTransfer')
      || jsonb_build_object(
        'step', 'tms-existing-decision-mismatch-retry-ready',
        'updatedAt', now(),
        'mismatchedExistingTmsDecisionRecoveryReapplied', jsonb_build_object(
          'reintroducedTmsWorkOrder', candidate.reintroduced_tms_work_order,
          'reintroducedDuplicateCheck', candidate.reintroduced_duplicate_check,
          'strategy', 'postgres-payload-overrides-local-checkpoint',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-103', 'mismatched-tms-decision-recovery-reapplied',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'strategy', 'postgres-payload-overrides-local-checkpoint'
  ),
  'migration-103:tms-decision-recovery-reapplied:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'tms-existing-decision-mismatch-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = coalesce(work_order.payload, '{}'::jsonb),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'tms-existing-decision-mismatch-retry-ready'
  AND work_order.payload ? 'mismatchedExistingTmsDecisionRecoveryReapplied';

COMMIT;
