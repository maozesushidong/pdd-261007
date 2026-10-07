BEGIN;

CREATE TEMP TABLE migration_056_target ON COMMIT DROP AS
SELECT work_order.id
FROM work_orders work_order
WHERE work_order.id = 'eed3aa2b-a19d-4745-b632-b8ae24d76818'::uuid
  AND work_order.shop_id = 'panapopo-healthcare'
  AND work_order.external_order_number = '260803-212965865810749'
  AND work_order.payload->>'shopNameSnapshot' = 'PANAPOPO医疗器械官方旗舰店'
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
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE external_effects child
SET shop_id = 'panapopo-medical-device',
  idempotency_key = replace(
    child.idempotency_key,
    ':panapopo-healthcare:',
    ':panapopo-medical-device:'
  )
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE manual_interventions child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE operator_commands child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE return_refunds child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE verification_locations child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE workflow_checkpoints child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE workflow_events child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

UPDATE audit_events child SET shop_id = 'panapopo-medical-device'
WHERE child.work_order_id IN (SELECT id FROM migration_056_target);

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
WHERE work_order.id IN (SELECT id FROM migration_056_target);

INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT 'panapopo-medical-device', target.id, 'migration-056',
  'legacy-misbound-work-order-reassigned',
  jsonb_build_object(
    'orderNumber', '260803-212965865810749',
    'fromShopId', 'panapopo-healthcare',
    'toShopId', 'panapopo-medical-device',
    'reason', 'saved-shop-name-matched-medical-device-profile',
    'preservedSucceededEffects', true
  ),
  'migration-056:reassign-legacy-medical-device-order:' || target.id::text
FROM migration_056_target target
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
