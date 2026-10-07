BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.current_ordinary_instance_id,
    work_order.external_order_number, work_order.current_step AS previous_step
  FROM work_orders work_order
  JOIN external_effects effect
    ON effect.id = 'ab275ed7-2cda-4918-a3a9-c45847c356b8'::uuid
    AND effect.work_order_id = work_order.id
    AND effect.shop_id = work_order.shop_id
    AND effect.ordinary_instance_id = work_order.current_ordinary_instance_id
    AND effect.effect_type = 'pdd-note'
    AND effect.status = 'unknown'
  WHERE work_order.id = '9d9e15cb-c0b4-4129-96d3-c711f7bef617'::uuid
    AND work_order.shop_id = 'panapopo-healthcare'
    AND work_order.external_order_number = '260818-014009024870794'
    AND work_order.current_ordinary_instance_id =
      'aba2205f-677d-4011-a71a-b0b79911927d'::uuid
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'processing'
    AND work_order.recovery_state = 'reconciling'
    AND work_order.current_step IN ('pinduoduo-page-opened', 'browser-started')
    AND work_order.payload #>> '{externalStateReconciliationRetry,attempts}' = '3'
    AND work_order.payload #>> '{pddNoteListRedirectRecovery,strategy}' =
      'refresh-then-exact-pending-list-query'
    AND work_order.payload #>> '{residentCommand,action}' = 'run-order'
    AND work_order.payload #>> '{residentCommand,status}' = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects submit_effect
      WHERE submit_effect.work_order_id = work_order.id
        AND submit_effect.ordinary_instance_id = work_order.current_ordinary_instance_id
        AND submit_effect.effect_type = 'pdd-submit'
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET runtime_status = 'paused',
    current_step = 'external-state-reconciliation-retry',
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    next_attempt_at = now(),
    payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb)
        || jsonb_build_object(
          'step', 'external-state-reconciliation-retry',
          'rollingReloadReconciliationRecovery', jsonb_build_object(
            'effectType', 'pdd-note',
            'effectId', 'ab275ed7-2cda-4918-a3a9-c45847c356b8',
            'previousAttempts', 3,
            'strategy', 'resume-list-redirect-reconciliation-after-rolling-reload',
            'recoveredAt', now()
          )
        ),
      '{externalStateReconciliationRetry}',
      coalesce(work_order.payload->'externalStateReconciliationRetry', '{}'::jsonb)
        || jsonb_build_object(
          'attempts', 2,
          'interruptedAttemptRefundedAt', now()
        ),
      true
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id,
    work_order.current_ordinary_instance_id, work_order.external_order_number,
    candidate.previous_step
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-135', 'rolling-reload-pdd-note-reconciliation-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousStep', recovered.previous_step,
    'effectId', 'ab275ed7-2cda-4918-a3a9-c45847c356b8',
    'strategy', 'resume-list-redirect-reconciliation-after-rolling-reload'
  ),
  'migration-135:rolling-reload-pdd-note-reconciliation:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET runtime_status = 'paused',
  current_step = 'external-state-reconciliation-retry',
  next_attempt_at = now(),
  payload = coalesce(instance.payload, '{}'::jsonb)
    || jsonb_build_object(
      'step', 'external-state-reconciliation-retry',
      'rollingReloadReconciliationRecovery',
        work_order.payload->'rollingReloadReconciliationRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.id = '9d9e15cb-c0b4-4129-96d3-c711f7bef617'::uuid
  AND work_order.current_step = 'external-state-reconciliation-retry'
  AND work_order.recovery_state = 'ready';

COMMIT;
