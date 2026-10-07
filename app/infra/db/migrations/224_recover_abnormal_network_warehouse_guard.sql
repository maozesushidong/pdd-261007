BEGIN;

-- Abnormal-network orders that were still unshipped used to persist the OMS
-- warehouse as not-applicable and then immediately hit the mutation guard.
-- Re-run the read-only OMS analysis so a warehouse is required only when an
-- OMS allocation will actually be performed. Never resume a row with any
-- potentially applied external effect.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    work_order.payload#>>'{omsAnalysis,orderStatus}' AS previous_order_status
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'abnormal-network-warning'
    AND work_order.status = 'paused'
    AND coalesce(work_order.runtime_status, work_order.status) = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'flow-paused'
    AND work_order.payload->>'orderNumber' = work_order.external_order_number
    AND work_order.payload#>>'{omsAnalysis,orderNumber}' = work_order.external_order_number
    AND work_order.payload#>>'{omsAnalysis,warehouseStatus}' = 'not-applicable'
    AND nullif(btrim(work_order.payload#>>'{omsAnalysis,shippingWarehouse}'), '') IS NULL
    AND work_order.payload#>>'{logisticsAnalysis,abnormalNetworkShipmentState}' = 'unshipped'
    AND work_order.payload#>>'{transientWorkflowFailure,code}' =
      'OMS_WAREHOUSE_TEMPORARILY_UNAVAILABLE'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) LIKE 'OMS_WAREHOUSE_TEMPORARILY_UNAVAILABLE:%禁止执行OMS 配货操作%'
    AND coalesce(work_order.payload#>>'{omsAnalysis,orderStatus}', '') NOT IN (
      '', '已配货', '已发货', '已完成', '作废', '已取消', '已关闭'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type IN ('oms-manual-allocation', 'tms-create', 'pdd-submit')
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-warehouse-analysis-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = work_order.recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview'
        - 'error'
        - 'omsAnalysis'
        - 'omsWarehouseParse'
        - 'omsManualAllocation'
        - 'omsOrderStatus'
        - 'omsGridCells'
        - 'omsLiveOrderState'
        - 'transientWorkflowFailure'
        - 'transientWorkflowRecovery'
        - 'pddResolutionDecision'
      ) || jsonb_build_object(
        'step', 'oms-warehouse-analysis-retry-ready',
        'abnormalNetworkWarehouseRecovery224', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', 're-read-warehouse-before-oms-allocation',
          'previousOrderStatus', candidate.previous_order_status,
          'previousReason', candidate.previous_reason,
          'externalActionsReplayed', false,
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
    candidate.previous_order_status,
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-warehouse-analysis-retry-ready',
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
    recovered.previous_order_status,
    recovered.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-224',
    'abnormal-network-warehouse-analysis-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousOrderStatus', recovered.previous_order_status,
      'previousReason', recovered.previous_reason,
      'strategy', 're-read-warehouse-before-oms-allocation',
      'externalActionsReplayed', false
    ),
    'migration-224:abnormal-network-warehouse-analysis:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-224')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.reason_code = 'external-system-error'
    AND intervention.reason LIKE 'OMS_WAREHOUSE_TEMPORARILY_UNAVAILABLE:%禁止执行OMS 配货操作%'
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
    'reason', 'abnormal-network-warehouse-analysis-retry-ready',
    'migration', '224'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('224_recover_abnormal_network_warehouse_guard.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
