BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT DISTINCT ON (work_order.id)
    work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, effect.id AS effect_id,
    effect.updated_at AS effect_confirmed_at
  FROM work_orders work_order
  JOIN external_effects effect ON effect.work_order_id = work_order.id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'succeeded'
    AND effect.idempotency_key LIKE '%:ordinary-%-send-script-v1'
    AND effect.receipt#>>'{result,orderCompleted}' = 'true'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.status IN ('queued', 'retry-ready')
    AND NOT EXISTS (
      SELECT 1 FROM external_effects unresolved
      WHERE unresolved.work_order_id = work_order.id
        AND unresolved.status IN ('reserved', 'unknown')
    )
  ORDER BY work_order.id, effect.updated_at DESC
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-message-completion-reconcile-ready',
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'logisticsWait' - 'error')
      || jsonb_build_object(
        'step', 'ordinary-message-completion-reconcile-ready',
        'ordinaryMessageCompletionRecovery120', jsonb_build_object(
          'externalEffectId', candidate.effect_id,
          'effectConfirmedAt', candidate.effect_confirmed_at,
          'strategy', 'read-only-confirm-completed-message-stage',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    candidate.effect_id, candidate.effect_confirmed_at
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-120', 'ordinary-message-stage-completion-reconcile-ready',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'externalEffectId', recovered.effect_id,
    'effectConfirmedAt', recovered.effect_confirmed_at,
    'strategy', 'read-only-confirm-completed-message-stage'
  ),
  'migration-120:ordinary-message-completion:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'ordinary-message-completion-reconcile-ready',
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb) - 'logisticsWait' - 'error')
    || jsonb_build_object(
      'step', 'ordinary-message-completion-reconcile-ready',
      'ordinaryMessageCompletionRecovery120',
        work_order.payload->'ordinaryMessageCompletionRecovery120'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'ordinary-message-completion-reconcile-ready'
  AND work_order.payload ? 'ordinaryMessageCompletionRecovery120';

COMMIT;
