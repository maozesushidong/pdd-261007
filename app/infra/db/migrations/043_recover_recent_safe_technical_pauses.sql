BEGIN;

WITH normal_target(external_order_number, expected_step) AS (
  VALUES
    ('260810-573759854211829', 'order-number-captured'),
    ('260811-010653560463888', 'workflow-exited'),
    ('260810-441219858833561', 'flow-paused'),
    ('260810-378263386462801', 'flow-paused'),
    ('260810-494477022773679', 'flow-paused'),
    ('260810-359703518870444', 'flow-paused'),
    ('260809-275576286723628', 'flow-paused'),
    ('260810-406365150761165', 'flow-paused'),
    ('260810-351021351203730', 'flow-paused'),
    ('260810-614979356253379', 'flow-paused'),
    ('260810-246792927533349', 'flow-paused')
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'recent-technical-pause-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview'
        - 'error'
        - CASE
            WHEN work_order.external_order_number = '260809-275576286723628' THEN 'detailUrl'
            ELSE '__no_field__'
          END
      ) || jsonb_build_object(
        'step', 'recent-technical-pause-retry-ready',
        'recentTechnicalRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'previousStep', work_order.current_step,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM normal_target target
  WHERE work_order.external_order_number = target.external_order_number
    AND work_order.current_step = target.expected_step
    AND work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.status = 'paused'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status = 'unknown'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
), reconciliation_recovered AS (
  UPDATE work_orders work_order
  SET status = 'paused',
    runtime_status = 'paused',
    current_step = 'external-state-reconciliation-retry',
    manual_review_reason = NULL,
    next_attempt_at = NULL,
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'external-state-reconciliation-retry',
        'recentTechnicalRecovery', jsonb_build_object(
          'status', 'read-only-reconciliation-ready',
          'effectType', 'pdd-note',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  WHERE work_order.external_order_number = '260810-437843422740834'
    AND work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'external-state-reconciliation-failed'
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'unknown'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
), all_recovered AS (
  SELECT *, 'normal-retry'::text AS recovery_mode FROM recovered
  UNION ALL
  SELECT *, 'read-only-pdd-note-reconciliation'::text AS recovery_mode FROM reconciliation_recovered
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT all_recovered.shop_id, all_recovered.id, 'migration-043',
  'recent-safe-technical-pause-recovered',
  jsonb_build_object(
    'orderNumber', all_recovered.external_order_number,
    'recoveryMode', all_recovered.recovery_mode
  ),
  'migration-043:recent-technical-pause:' || all_recovered.id::text
FROM all_recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-043')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND work_order.current_step IN (
    'recent-technical-pause-retry-ready',
    'external-state-reconciliation-retry'
  );

COMMIT;
