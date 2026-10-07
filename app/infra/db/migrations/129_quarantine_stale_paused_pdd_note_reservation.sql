BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT effect.id, effect.shop_id, effect.work_order_id,
    effect.ordinary_instance_id, effect.effect_type, effect.idempotency_key,
    work_order.external_order_number, work_order.current_step
  FROM external_effects effect
  JOIN work_orders work_order ON work_order.id = effect.work_order_id
    AND work_order.shop_id = effect.shop_id
  WHERE effect.id = 'ab275ed7-2cda-4918-a3a9-c45847c356b8'
    AND effect.status = 'reserved'
    AND effect.effect_type = 'pdd-note'
    AND effect.updated_at < now() - interval '10 minutes'
    AND work_order.external_order_number = '260818-014009024870794'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'manual-review-blocked'
    AND work_order.completion_state <> 'confirmed'
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), quarantined AS (
  UPDATE external_effects effect
  SET status = 'unknown',
    error = jsonb_build_object(
      'name', 'StalePausedPddNoteReservation',
      'message', '工单已暂停且无活跃租约，但拼多多备注 reservation 未收到终态回执；保留 unknown 且禁止自动重试',
      'quarantinedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE effect.id = candidate.id
    AND effect.status = 'reserved'
  RETURNING effect.id, effect.shop_id, effect.work_order_id,
    effect.ordinary_instance_id, effect.effect_type, effect.idempotency_key
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT quarantined.shop_id, quarantined.work_order_id,
  quarantined.ordinary_instance_id, 'migration-129',
  'stale-paused-pdd-note-reservation-quarantined',
  jsonb_build_object(
    'effectId', quarantined.id,
    'effectType', quarantined.effect_type,
    'idempotencyKey', quarantined.idempotency_key,
    'result', 'unknown-no-retry'
  ),
  'migration-129:stale-paused-pdd-note:' || quarantined.id::text
FROM quarantined
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

COMMIT;
