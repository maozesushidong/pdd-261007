BEGIN;

-- Recovered old work orders count toward total completed volume, but must not
-- be reported as new-order first-pass automation after the completion payload
-- is compacted into lastCompletedOrder.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id
  FROM work_orders work_order
  WHERE work_order.status = 'archived'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.completion_state = 'confirmed'
    AND work_order.payload#>>'{lastCompletedOrder,orderNumber}' =
      work_order.external_order_number
    AND coalesce(
      (work_order.payload#>>'{lastCompletedOrder,recoveredFromCompletedPage}')::boolean,
      false
    ) = false
    AND EXISTS (
      SELECT 1 FROM audit_events audit
      WHERE audit.work_order_id = work_order.id
        AND audit.event_type IN (
          'tms-postal-carrier-alias-pause-recovered',
          'refreshed-exact-empty-completion-pause-recovered',
          'completed-orphan-evidence-pause-recovered'
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = work_order.current_ordinary_instance_id
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
  SET payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb),
      '{lastCompletedOrder,recoveredFromCompletedPage}',
      'true'::jsonb,
      true
    ) || jsonb_build_object(
      'recoveredCompletionMetricMarker', jsonb_build_object(
        'classification', 'recovered-old-work-order',
        'backfilledAt', now()
      )
    )
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET payload = coalesce(work_order.payload, '{}'::jsonb)
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-111', 'recovered-completion-metric-marker-backfilled',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'classification', 'recovered-old-work-order'
  ),
  'migration-111:recovered-completion-metric:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
