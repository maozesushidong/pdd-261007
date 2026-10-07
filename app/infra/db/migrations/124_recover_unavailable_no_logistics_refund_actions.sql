BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, refund.first_discovered_at,
    work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status = 'paused'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND refund.action_state = 'manual-review'
    AND refund.action_button_visible = false
    AND refund.first_discovered_at <= now() - interval '72 hours'
    AND refund.earliest_logistics_at IS NULL
    AND refund.latest_logistics_at IS NULL
    AND refund.detail_url IS NOT NULL
    AND work_order.manual_review_reason = '首次发现超过72小时仍未产生有效退货物流'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered_refunds AS (
  UPDATE return_refunds refund
  SET action_state = 'waiting-logistics',
    decision = 'wait-logistics',
    risk_level = NULL,
    next_check_at = now() + interval '30 minutes',
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'unavailableActionRecovery', jsonb_build_object(
        'strategy', 'periodic-read-only-recheck',
        'intervalMinutes', 30,
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id, candidate.shop_id,
    candidate.external_order_number, candidate.aftersale_number,
    candidate.first_discovered_at, candidate.previous_reason
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'waiting',
    current_step = 'return-refund-waiting-logistics',
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'periodic-read-only-refund-recheck',
    classification_updated_at = now(),
    manual_review_reason = NULL,
    next_attempt_at = now() + interval '30 minutes',
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-waiting-logistics',
        'unavailableActionRecovery', jsonb_build_object(
          'aftersaleNumber', recovered_refund.aftersale_number,
          'firstDiscoveredAt', recovered_refund.first_discovered_at,
          'previousReason', recovered_refund.previous_reason,
          'strategy', 'periodic-read-only-recheck',
          'intervalMinutes', 30,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered_refunds recovered_refund
  WHERE work_order.id = recovered_refund.work_order_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    recovered_refund.aftersale_number, recovered_refund.first_discovered_at,
    recovered_refund.previous_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-124',
  'return-refund-unavailable-action-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'firstDiscoveredAt', recovered.first_discovered_at,
    'previousReason', recovered.previous_reason,
    'strategy', 'periodic-read-only-recheck',
    'intervalMinutes', 30
  ),
  'migration-124:return-refund-unavailable-action:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-124')
  FROM work_orders work_order
  WHERE intervention.work_order_id = work_order.id
    AND intervention.status IN ('open', 'acknowledged')
    AND work_order.current_step = 'return-refund-waiting-logistics'
    AND work_order.payload ? 'unavailableActionRecovery'
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

COMMIT;
