BEGIN;

UPDATE work_orders
SET completion_state = 'confirmed',
  completion_confirmation_method = payload->'lastCompletedOrder'->>'confirmationMethod',
  completion_confirmed_at = (payload->'lastCompletedOrder'->>'completedAt')::timestamptz,
  updated_at = now()
WHERE status IN ('archived', 'completed')
  AND completion_state <> 'confirmed'
  AND payload->'lastCompletedOrder'->>'orderNumber' = external_order_number
  AND payload->'lastCompletedOrder'->>'confirmationMethod' IN (
    'detail-completed',
    'absent-from-pending-list',
    'recovery-delayed-detail-check',
    'handover-detail-completed',
    'handover-absent-from-pending-list'
  )
  AND nullif(payload->'lastCompletedOrder'->>'completedAt', '') IS NOT NULL;

COMMIT;
