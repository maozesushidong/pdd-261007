BEGIN;

CREATE TEMP TABLE migration_218_out_of_scope_orders
ON COMMIT DROP
AS
SELECT
  work_order.id,
  work_order.shop_id,
  work_order.external_order_number,
  work_order.current_ordinary_instance_id,
  coalesce(
    work_order.payload#>>'{omsAnalysis,shippingWarehouse}',
    work_order.payload#>>'{omsWarehouseParse,parsedValue}',
    ''
  ) AS warehouse
FROM work_orders work_order
WHERE work_order.status NOT IN ('archived', 'completed', 'resolved')
  AND coalesce(work_order.completion_state, 'pending') <> 'confirmed'
  AND coalesce(
    work_order.payload#>>'{omsAnalysis,shippingWarehouse}',
    work_order.payload#>>'{omsWarehouseParse,parsedValue}',
    ''
  ) LIKE '代发聚水潭-%'
  AND coalesce(
    work_order.payload#>>'{omsAnalysis,shippingWarehouse}',
    work_order.payload#>>'{omsWarehouseParse,parsedValue}',
    ''
  ) !~ '(筑越|简卓|众邦|铭如|瞳琪|捷佑|亿哈)';

UPDATE work_orders work_order
SET status = 'paused',
  runtime_status = 'paused',
  current_step = 'oms-warehouse-out-of-scope',
  manual_review_reason = format(
    'OMS 发货仓库“%s”不在业务处理范围，已禁止进入 TMS、OMS 写操作和拼多多提交',
    candidate.warehouse
  ),
  next_attempt_at = NULL,
  recovery_state = 'held',
  recovery_reason = 'oms-warehouse-out-of-scope-hard-stop',
  recovery_version = work_order.recovery_version + 1,
  recovery_updated_at = now(),
  payload = (coalesce(work_order.payload, '{}'::jsonb) - 'error')
    || jsonb_build_object(
      'step', 'oms-warehouse-out-of-scope',
      'omsAnalysis', coalesce(work_order.payload->'omsAnalysis', '{}'::jsonb)
        || jsonb_build_object('warehouseStatus', 'out-of-scope'),
      'omsWarehouseParse', coalesce(work_order.payload->'omsWarehouseParse', '{}'::jsonb)
        || jsonb_build_object(
          'status', 'out-of-scope',
          'orderNumber', work_order.external_order_number,
          'parsedValue', candidate.warehouse,
          'checkedAt', now(),
          'source', 'migration-218-hard-scope-guard'
        ),
      'manualReview', jsonb_build_object(
        'status', 'waiting',
        'stage', 'oms-warehouse-out-of-scope',
        'reason', format(
          'OMS 发货仓库“%s”不在业务处理范围，已禁止进入 TMS、OMS 写操作和拼多多提交',
          candidate.warehouse
        ),
        'detectedAt', now()
      ),
      'warehouseScopeGuard', jsonb_build_object(
        'status', 'blocked',
        'warehouse', candidate.warehouse,
        'policy', 'explicit-business-scope-only',
        'blockedOperations', jsonb_build_array(
          'tms-create', 'oms-manual-allocation', 'oms-reissue-create', 'pdd-submit'
        ),
        'enforcedAt', now()
      ),
      'updatedAt', now()
    ),
  updated_at = now()
FROM migration_218_out_of_scope_orders candidate
WHERE work_order.id = candidate.id;

WITH closed AS (
  UPDATE manual_interventions intervention
  SET status = 'cancelled',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-218')
  FROM migration_218_out_of_scope_orders candidate
  WHERE intervention.work_order_id = candidate.id
    AND intervention.reason_code <> 'warehouse-out-of-scope'
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'superseded-by-warehouse-scope-hard-stop',
    'migration', '218'
  )
FROM closed
WHERE outbox.intervention_id = closed.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO manual_interventions
  (id, shop_id, work_order_id, ordinary_instance_id, channel, reason_code,
   reason, risk_level, status, deduplication_key)
SELECT
  gen_random_uuid(),
  candidate.shop_id,
  candidate.id,
  candidate.current_ordinary_instance_id,
  'dashboard',
  'warehouse-out-of-scope',
  format(
    'OMS 发货仓库“%s”不在业务处理范围，已禁止进入 TMS、OMS 写操作和拼多多提交',
    candidate.warehouse
  ),
  'high',
  'open',
  'warehouse-out-of-scope:' || candidate.shop_id || ':' || candidate.external_order_number
FROM migration_218_out_of_scope_orders candidate
ON CONFLICT (deduplication_key) DO UPDATE SET
  reason = EXCLUDED.reason,
  risk_level = EXCLUDED.risk_level,
  status = 'open',
  acknowledged_at = NULL,
  resolved_at = NULL,
  resolved_by = NULL;

INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT
  candidate.shop_id,
  candidate.id,
  candidate.current_ordinary_instance_id,
  'migration-218',
  'oms-warehouse-out-of-scope-hard-stop',
  jsonb_build_object(
    'orderNumber', candidate.external_order_number,
    'warehouse', candidate.warehouse,
    'policy', 'explicit-business-scope-only',
    'externalActionsReplayed', false
  ),
  'migration-218:warehouse-scope:' || candidate.id::text
FROM migration_218_out_of_scope_orders candidate
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('218_enforce_oms_warehouse_scope.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
