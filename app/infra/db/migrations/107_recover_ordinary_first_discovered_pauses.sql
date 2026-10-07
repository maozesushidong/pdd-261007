BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, instance.first_discovered_at,
    work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'proactive-logistics-service'
    AND work_order.status = 'paused'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'manual-review-blocked'
    AND work_order.payload#>>'{ordinaryScenarioDecision,reasonCode}' =
      'work-order-created-time-missing-without-return-logistics'
    AND instance.first_discovered_at IS NOT NULL
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
        AND effect.effect_type = 'pdd-submit'
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
    current_step = 'ordinary-first-discovered-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'ordinaryScenarioDecision')
      || jsonb_build_object(
        'step', 'ordinary-first-discovered-retry-ready',
        'workOrderFirstDiscoveredAt', candidate.first_discovered_at,
        'ordinaryFirstDiscoveredRecovery', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'strategy', 'database-instance-first-discovered-lower-bound',
          'firstDiscoveredAt', candidate.first_discovered_at,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.first_discovered_at,
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-first-discovered-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = (coalesce(instance.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'ordinaryScenarioDecision')
      || jsonb_build_object(
        'step', 'ordinary-first-discovered-retry-ready',
        'workOrderFirstDiscoveredAt', recovered.first_discovered_at,
        'ordinaryFirstDiscoveredRecovery', jsonb_build_object(
          'previousReason', recovered.previous_reason,
          'strategy', 'database-instance-first-discovered-lower-bound',
          'firstDiscoveredAt', recovered.first_discovered_at,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.first_discovered_at,
    recovered.previous_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-107', 'ordinary-first-discovered-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.previous_reason,
    'strategy', 'database-instance-first-discovered-lower-bound',
    'firstDiscoveredAt', recovered.first_discovered_at
  ),
  'migration-107:ordinary-first-discovered:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-107')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
    )
    AND work_order.current_step = 'ordinary-first-discovered-retry-ready'
    AND work_order.payload ? 'ordinaryFirstDiscoveredRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
