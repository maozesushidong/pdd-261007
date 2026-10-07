BEGIN;

WITH normalized AS (
  UPDATE work_orders work_order
  SET payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb),
      '{pddOrderRemark}',
      coalesce(work_order.payload->'pddOrderRemark', '{}'::jsonb)
        || jsonb_build_object(
          'shopId', work_order.shop_id,
          'orderNumber', work_order.external_order_number,
          'text', work_order.payload #>> '{externalStateReconciliation,remarkText}',
          'color', work_order.payload #>> '{externalStateReconciliation,colorLabel}',
          'status', 'saved',
          'detailMode', coalesce(
            work_order.payload #>> '{externalStateReconciliation,detailMode}',
            'reconciled'
          ),
          'alreadySucceeded', true,
          'savedAt', coalesce(
            work_order.payload #>> '{externalStateReconciliation,observedAt}',
            now()::text
          ),
          'reconciliationMethod', coalesce(
            work_order.payload #>> '{externalStateReconciliation,confirmationMethod}',
            'read-only-reconciliation'
          )
        ),
      true
    ),
    updated_at = now()
  WHERE work_order.frontend_visibility = 'operational'
    AND work_order.created_at >= timestamptz '2026-08-10 00:00:00+08'
    AND work_order.payload #>> '{externalStateReconciliation,state}' = 'confirmed'
    AND work_order.payload #>> '{externalStateReconciliation,effectType}' = 'pdd-note'
    AND coalesce(work_order.payload #>> '{pddOrderRemark,status}', '') <> 'saved'
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_step, work_order.runtime_status
), recovery_commands AS (
  INSERT INTO operator_commands
    (id, shop_id, work_order_id, command_type, payload, requested_by)
  SELECT gen_random_uuid(), normalized.shop_id, normalized.id,
    'force-clear-verification',
    jsonb_build_object(
      'reason', '订单备注已只读核验成功，结束无须继续的备注页验证码并从原工单续跑',
      'reasonCode', 'pdd-order-remark-reconciliation-continuation'
    ),
    'migration-046'
  FROM normalized
  WHERE normalized.current_step = 'human-verification-required'
    AND normalized.runtime_status = 'verification'
    AND NOT EXISTS (
      SELECT 1 FROM operator_commands command
      WHERE command.work_order_id = normalized.id
        AND command.command_type = 'force-clear-verification'
        AND command.status IN ('pending', 'delivered')
        AND command.payload->>'reasonCode' = 'pdd-order-remark-reconciliation-continuation'
    )
  RETURNING work_order_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT normalized.shop_id, normalized.id, 'migration-046',
  'pdd-order-remark-continuation-recovered',
  jsonb_build_object(
    'orderNumber', normalized.external_order_number,
    'forceClearRequested', recovery_commands.work_order_id IS NOT NULL
  ),
  'migration-046:pdd-order-remark-continuation:' || normalized.id::text
FROM normalized
LEFT JOIN recovery_commands ON recovery_commands.work_order_id = normalized.id
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
