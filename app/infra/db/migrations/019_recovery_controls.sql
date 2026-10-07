BEGIN;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS recovery_state text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS recovery_reason text,
  ADD COLUMN IF NOT EXISTS recovery_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS recovery_updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_orders'::regclass
      AND conname = 'work_orders_recovery_state_check'
  ) THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_recovery_state_check
      CHECK (recovery_state IN ('ready', 'held', 'reconciling', 'retry-authorized'));
  END IF;
END $$;

WITH held AS (
  UPDATE work_orders work_order
  SET status = CASE
      WHEN coalesce(work_order.runtime_status, work_order.status) NOT IN ('archived', 'completed', 'failed', 'paused')
        THEN 'paused'
      ELSE work_order.status
    END,
    runtime_status = CASE
      WHEN coalesce(work_order.runtime_status, work_order.status) NOT IN ('archived', 'completed', 'failed', 'paused')
        THEN 'paused'
      ELSE coalesce(work_order.runtime_status, work_order.status)
    END,
    recovery_state = 'held',
    recovery_reason = CASE
      WHEN EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = work_order.id AND effect.status = 'unknown'
      ) THEN 'unknown-external-effect'
      WHEN work_order.completion_state = 'reconciliation-required' THEN 'completion-evidence-required'
      ELSE 'runtime-recovery-review-required'
    END,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now()
  WHERE work_order.completion_state = 'reconciliation-required'
    OR coalesce(work_order.runtime_status, work_order.status) NOT IN ('archived', 'completed')
    OR EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id AND effect.status = 'unknown'
    )
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.recovery_reason, work_order.recovery_version
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT shop_id, id, 'recovery-migration', 'work-order-recovery-held',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', recovery_reason,
    'recoveryVersion', recovery_version
  ),
  'migration-019:recovery-held:' || id::text
FROM held
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE shop_runtime_state runtime
SET status = 'idle', lease_token = NULL, lease_expires_at = NULL,
  current_work_order_id = NULL, updated_at = now()
WHERE runtime.current_work_order_id IN (
  SELECT id FROM work_orders WHERE recovery_state = 'held'
);

CREATE INDEX IF NOT EXISTS idx_work_orders_recovery_queue
  ON work_orders (shop_id, recovery_state, status, next_attempt_at, created_at);

COMMIT;
