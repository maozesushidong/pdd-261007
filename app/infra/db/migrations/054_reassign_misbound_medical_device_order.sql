BEGIN;

CREATE TEMP TABLE migration_054_target ON COMMIT DROP AS
SELECT work_order.id
FROM work_orders work_order
WHERE work_order.id = 'fe5ba83c-1398-4bcd-a7ea-35b581333bce'::uuid
  AND work_order.shop_id = 'panapopo-healthcare'
  AND work_order.external_order_number = '260814-422932672130799'
  AND work_order.payload->'latestDiscovery'->>'actualShopName' = 'PANAPOPO医疗器械官方旗舰店'
  AND EXISTS (
    SELECT 1 FROM shops target_shop
    WHERE target_shop.id = 'panapopo-medical-device'
      AND target_shop.expected_shop_name = 'PANAPOPO医疗器械官方旗舰店'
  )
  AND NOT EXISTS (
    SELECT 1 FROM work_orders duplicate
    WHERE duplicate.shop_id = 'panapopo-medical-device'
      AND duplicate.external_order_number = work_order.external_order_number
      AND duplicate.id <> work_order.id
  );

UPDATE evidence_assets child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE external_effects child
SET shop_id = 'panapopo-medical-device',
  idempotency_key = replace(
    child.idempotency_key,
    ':panapopo-healthcare:',
    ':panapopo-medical-device:'
  )
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE manual_interventions child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE operator_commands child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE return_refunds child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE verification_locations child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE workflow_checkpoints child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE workflow_events child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE audit_events child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_054_target);

UPDATE work_orders work_order
SET shop_id = 'panapopo-medical-device',
  idempotency_key = replace(
    work_order.idempotency_key,
    ':panapopo-healthcare:',
    ':panapopo-medical-device:'
  ),
  payload = jsonb_set(
    jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb)
        - 'pddIdentityBindingToken'
        - 'omsSession',
      '{shopId}',
      to_jsonb('panapopo-medical-device'::text),
      true
    ),
    '{latestDiscovery,shopId}',
    to_jsonb('panapopo-medical-device'::text),
    true
  ) #- '{latestDiscovery,pddIdentityBindingToken}',
  updated_at = now()
WHERE work_order.id IN (SELECT id FROM migration_054_target);

INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT 'panapopo-medical-device', target.id, 'migration-054',
  'misbound-work-order-reassigned',
  jsonb_build_object(
    'orderNumber', '260814-422932672130799',
    'fromShopId', 'panapopo-healthcare',
    'toShopId', 'panapopo-medical-device',
    'reason', 'discovered-shop-name-matched-medical-device-profile'
  ),
  'migration-054:reassign-medical-device-order:' || target.id::text
FROM migration_054_target target
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
