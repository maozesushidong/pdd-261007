BEGIN;

CREATE TEMP TABLE duplicate_work_order_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT work_order.id,
    first_value(work_order.id) OVER (
      PARTITION BY work_order.external_order_number
      ORDER BY
        CASE WHEN work_order.current_step IN ('cross-shop-conflict', 'superseded-duplicate') THEN 1 ELSE 0 END,
        CASE WHEN work_order.idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END,
        CASE WHEN work_order.completion_state = 'confirmed' THEN 0 ELSE 1 END,
        work_order.created_at,
        work_order.id
    ) AS authoritative_id,
    row_number() OVER (
      PARTITION BY work_order.external_order_number
      ORDER BY
        CASE WHEN work_order.current_step IN ('cross-shop-conflict', 'superseded-duplicate') THEN 1 ELSE 0 END,
        CASE WHEN work_order.idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END,
        CASE WHEN work_order.completion_state = 'confirmed' THEN 0 ELSE 1 END,
        work_order.created_at,
        work_order.id
    ) AS duplicate_rank
  FROM work_orders work_order
  WHERE work_order.frontend_visibility = 'operational'
)
SELECT ranked.id AS duplicate_id, ranked.authoritative_id
FROM ranked
WHERE ranked.duplicate_rank > 1;

UPDATE shop_runtime_state runtime
SET status = 'idle', lease_token = NULL, lease_expires_at = NULL,
  current_work_order_id = NULL, updated_at = now()
FROM duplicate_work_order_map duplicate
WHERE runtime.current_work_order_id = duplicate.duplicate_id;

UPDATE manual_interventions intervention
SET status = 'resolved', resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'global-work-order-deduplication')
FROM duplicate_work_order_map duplicate
WHERE intervention.work_order_id = duplicate.duplicate_id
  AND intervention.status IN ('open', 'acknowledged');

UPDATE cross_shop_order_conflicts conflict
SET status = 'resolved',
  resolved_shop_id = authoritative.shop_id,
  resolved_by = coalesce(conflict.resolved_by, 'global-work-order-deduplication'),
  resolved_at = coalesce(conflict.resolved_at, now()),
  details = conflict.details || jsonb_build_object(
    'resolution', 'original-work-order-reused',
    'authoritativeWorkOrderId', authoritative.id,
    'resolvedAt', now()
  )
FROM work_orders authoritative
WHERE conflict.external_order_number = authoritative.external_order_number
  AND authoritative.id IN (
    SELECT DISTINCT duplicate.authoritative_id FROM duplicate_work_order_map duplicate
  )
  AND conflict.status = 'open';

WITH superseded AS (
  UPDATE work_orders work_order
  SET status = 'archived', runtime_status = 'archived',
    current_step = 'superseded-duplicate',
    manual_review_reason = NULL,
    frontend_visibility = 'recovery-audit',
    recovery_state = 'held',
    recovery_reason = 'global-order-deduplication',
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'duplicateReconciliation', jsonb_build_object(
        'status', 'superseded',
        'authoritativeWorkOrderId', duplicate.authoritative_id,
        'previousCurrentStep', work_order.current_step,
        'reconciledAt', now()
      )
    ),
    updated_at = now()
  FROM duplicate_work_order_map duplicate
  WHERE work_order.id = duplicate.duplicate_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    duplicate.authoritative_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT superseded.shop_id, superseded.id, 'migration-033',
  'duplicate-work-order-superseded',
  jsonb_build_object(
    'orderNumber', superseded.external_order_number,
    'authoritativeWorkOrderId', superseded.authoritative_id,
    'reason', 'global-order-number-uniqueness'
  ),
  'migration-033:duplicate:' || superseded.id::text
FROM superseded
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_operational_order_number
  ON work_orders (external_order_number)
  WHERE frontend_visibility = 'operational';

COMMIT;
