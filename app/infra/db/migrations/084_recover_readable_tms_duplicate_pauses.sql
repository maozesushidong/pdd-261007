BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason,
    work_order.payload#>>'{tmsDuplicateCheck,selectionStrategy}' AS selection_strategy,
    work_order.payload#>>'{tmsDuplicateCheck,candidateCount}' AS candidate_count
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state = 'ready'
    AND work_order.current_step = 'manual-review-blocked'
    AND work_order.payload#>>'{manualReview,stage}' = 'tms-duplicate-check'
    AND work_order.payload#>>'{tmsDuplicateCheck,selectionStrategy}' IN ('only-row', 'first-row')
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
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
    current_step = 'readable-tms-existing-ticket-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'tmsDuplicateCheck')
      || jsonb_build_object(
        'step', 'readable-tms-existing-ticket-retry-ready',
        'readableTmsExistingTicketRecovery', jsonb_build_object(
          'previousReason', candidate.reason,
          'previousSelectionStrategy', candidate.selection_strategy,
          'previousCandidateCount', candidate.candidate_count,
          'strategy', 're-read-first-existing-ticket-and-verify-readable-fields',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason,
    candidate.selection_strategy, candidate.candidate_count
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-084', 'readable-tms-existing-ticket-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'previousSelectionStrategy', recovered.selection_strategy,
    'previousCandidateCount', recovered.candidate_count,
    'strategy', 're-read-first-existing-ticket-and-verify-readable-fields'
  ),
  'migration-084:readable-tms-existing-ticket:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'readable-tms-existing-ticket-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'tmsDuplicateCheck')
    || jsonb_build_object(
      'step', 'readable-tms-existing-ticket-retry-ready',
      'readableTmsExistingTicketRecovery',
        work_order.payload->'readableTmsExistingTicketRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'readable-tms-existing-ticket-retry-ready'
  AND work_order.payload ? 'readableTmsExistingTicketRecovery';

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-084')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'readable-tms-existing-ticket-retry-ready'
    AND work_order.payload ? 'readableTmsExistingTicketRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'failed');

COMMIT;
