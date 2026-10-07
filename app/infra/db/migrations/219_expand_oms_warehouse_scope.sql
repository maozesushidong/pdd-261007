BEGIN;

-- Migration 218 deliberately held every readable OMS warehouse outside the
-- old allow-list. Resume only warehouses explicitly approved by the business.
-- Existing TMS state stays in the payload so the Worker reuses or verifies it
-- instead of creating a duplicate ticket.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      nullif(btrim(work_order.payload#>>'{omsAnalysis,shippingWarehouse}'), ''),
      nullif(btrim(work_order.payload#>>'{omsWarehouseParse,parsedValue}'), '')
    ) AS warehouse,
    work_order.payload->'tmsWorkOrder' AS existing_tms_work_order
  FROM work_orders work_order
  LEFT JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.status = 'paused'
    AND coalesce(work_order.runtime_status, work_order.status) = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'oms-warehouse-out-of-scope'
    AND work_order.recovery_state = 'held'
    AND work_order.recovery_reason = 'oms-warehouse-out-of-scope-hard-stop'
    AND regexp_replace(coalesce(
      work_order.payload#>>'{omsAnalysis,shippingWarehouse}',
      work_order.payload#>>'{omsWarehouseParse,parsedValue}',
      ''
    ), '\s+', '', 'g') IN (
      '代发聚水潭-迅发',
      '代发聚水潭-品动工贸',
      '代发聚水潭-祺迦工贸'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-warehouse-scope-expanded-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = work_order.recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'warehouseScopeGuard')
      || jsonb_build_object(
        'step', 'oms-warehouse-scope-expanded-retry-ready',
        'omsAnalysis', coalesce(work_order.payload->'omsAnalysis', '{}'::jsonb)
          || jsonb_build_object('warehouseStatus', 'confirmed'),
        'omsWarehouseParse', coalesce(work_order.payload->'omsWarehouseParse', '{}'::jsonb)
          || jsonb_build_object(
            'status', 'confirmed',
            'orderNumber', work_order.external_order_number,
            'parsedValue', candidate.warehouse,
            'checkedAt', now(),
            'source', 'migration-219-expanded-business-scope'
          ),
        'omsWarehouseScopeExpansion219', jsonb_build_object(
          'status', 'retry-ready',
          'warehouse', candidate.warehouse,
          'strategy', 'resume-with-existing-progress-and-no-external-action-replay',
          'existingTmsWorkOrderPreserved', candidate.existing_tms_work_order IS NOT NULL,
          'recoveredAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.warehouse,
    candidate.existing_tms_work_order
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-warehouse-scope-expanded-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING
    recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.warehouse,
    recovered.existing_tms_work_order
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-219',
    'oms-warehouse-scope-expanded-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'warehouse', recovered.warehouse,
      'strategy', 'resume-with-existing-progress-and-no-external-action-replay',
      'existingTmsWorkOrderPreserved', recovered.existing_tms_work_order IS NOT NULL,
      'externalActionsReplayed', false
    ),
    'migration-219:oms-warehouse-scope-expanded:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-219')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.reason_code = 'warehouse-out-of-scope'
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'oms-warehouse-scope-expanded',
    'migration', '219'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('219_expand_oms_warehouse_scope.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
