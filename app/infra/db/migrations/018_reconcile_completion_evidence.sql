BEGIN;

WITH confirmed_records(id, confirmation_method, confirmed_at) AS (
  VALUES
    ('f86eebdc-bbc9-4dee-a3a5-59231b2bfec8'::uuid, 'detail-completed', '2026-07-31T03:54:23.423Z'::timestamptz),
    ('b3e77834-8033-460b-bbdc-a72402be2266'::uuid, 'detail-completed', '2026-07-31T04:37:18.812Z'::timestamptz),
    ('291f018d-d984-478e-bfa3-9dda46077972'::uuid, 'detail-completed', '2026-07-31T06:09:59.019Z'::timestamptz),
    ('be472c2f-88d2-4cfa-bb6f-2baf0d4cdbff'::uuid, 'detail-completed', '2026-07-31T06:13:45.143Z'::timestamptz),
    ('cb09c113-c9cb-420b-a4cd-99e7baa340e8'::uuid, 'detail-completed', '2026-07-31T06:15:16.514Z'::timestamptz),
    ('99e3c7bf-bd0e-4010-99af-6b7e709229eb'::uuid, 'detail-completed', '2026-07-31T06:25:34.952Z'::timestamptz)
), confirmed AS (
  UPDATE work_orders work_order
  SET completion_state = 'confirmed',
    completion_confirmation_method = evidence.confirmation_method,
    completion_confirmed_at = evidence.confirmed_at,
    updated_at = greatest(work_order.updated_at, evidence.confirmed_at)
  FROM confirmed_records evidence
  WHERE work_order.id = evidence.id
    AND work_order.completion_state = 'reconciliation-required'
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.completion_confirmation_method, work_order.completion_confirmed_at
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'completion-evidence-reconciliation', 'completion-evidence-confirmed',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'confirmationMethod', completion_confirmation_method,
    'confirmedAt', completion_confirmed_at,
    'evidenceSource', 'worker-completed-work-order-archive'
  ),
  'migration-018:confirmed:' || id::text
FROM confirmed
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

WITH duplicate_records(id) AS (
  VALUES
    ('bd798045-6554-47a7-abb7-7111b00dfe3f'::uuid),
    ('490ca4ce-eebb-4ef0-9487-1be127fedd95'::uuid),
    ('8a321e36-378f-414d-ad0c-5a21ffac6f4d'::uuid)
), reconciled AS (
  UPDATE work_orders work_order
  SET completion_state = 'not-applicable',
    completion_confirmation_method = 'superseded-duplicate',
    completion_confirmed_at = NULL,
    updated_at = now()
  FROM duplicate_records duplicate
  WHERE work_order.id = duplicate.id
    AND work_order.current_step = 'superseded-duplicate'
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'completion-evidence-reconciliation', 'completion-not-applicable',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', 'superseded-duplicate'
  ),
  'migration-018:not-applicable:' || id::text
FROM reconciled
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
