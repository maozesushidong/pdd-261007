BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, work_order.handling_classification AS previous_classification
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.completion_state = 'confirmed'
    AND work_order.completion_confirmation_method =
      'return-refund-read-only-page-completed'
    AND work_order.payload#>>'{returnRefundResult,outcome}' = 'manual-completed'
    AND coalesce(
      (work_order.payload#>>'{returnRefundResult,readOnlyReview}')::boolean,
      false
    ) = true
    AND coalesce(work_order.handling_classification, 'automated') <> 'automated'
    AND coalesce(work_order.classification_source, 'system') = 'system'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'automated-read-only-terminal-reconciliation',
    classification_updated_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'recoveredCompletionMetricMarker', jsonb_build_object(
        'classification', 'recovered-old-return-refund',
        'completionMethod', 'return-refund-read-only-page-completed',
        'backfilledAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    candidate.aftersale_number, candidate.previous_classification
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT recovered.shop_id, recovered.id, 'migration-123',
  'readonly-return-refund-classified-automated',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'previousClassification', recovered.previous_classification,
    'classification', 'recovered-old-return-refund',
    'completionMethod', 'return-refund-read-only-page-completed'
  ),
  'migration-123:readonly-return-refund-classification:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
