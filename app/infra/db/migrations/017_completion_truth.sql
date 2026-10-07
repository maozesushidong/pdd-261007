BEGIN;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS completion_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS completion_confirmation_method text,
  ADD COLUMN IF NOT EXISTS completion_confirmed_at timestamptz;

WITH completion_facts AS (
  SELECT id,
    coalesce(
      payload->'pddResolutionSubmission'->>'confirmationMethod',
      payload->'completionArchive'->>'confirmationMethod'
    ) AS confirmation_method,
    coalesce(
      payload->'pddResolutionSubmission'->>'completedAt',
      payload->'completionArchive'->>'completedAt'
    ) AS confirmed_at,
    payload->'pddResolutionSubmission'->>'status' AS submission_status,
    payload->'completionArchive'->>'orderNumber' AS archived_order_number,
    coalesce(runtime_status, status) AS effective_status
  FROM work_orders
)
UPDATE work_orders w
SET completion_state = CASE
      WHEN (facts.submission_status = 'succeeded' OR nullif(facts.archived_order_number, '') IS NOT NULL)
        AND facts.confirmation_method IN (
          'detail-completed',
          'absent-from-pending-list',
          'recovery-delayed-detail-check',
          'handover-detail-completed',
          'handover-absent-from-pending-list'
        ) THEN 'confirmed'
      WHEN facts.effective_status IN ('completed', 'archived') THEN 'reconciliation-required'
      ELSE 'pending'
    END,
    completion_confirmation_method = facts.confirmation_method,
    completion_confirmed_at = CASE
      WHEN facts.confirmed_at ~ '^\d{4}-\d{2}-\d{2}T' THEN facts.confirmed_at::timestamptz
      ELSE NULL
    END
FROM completion_facts facts
WHERE facts.id = w.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_orders'::regclass
      AND conname = 'work_orders_completion_state_check'
  ) THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_completion_state_check
      CHECK (completion_state IN ('pending', 'confirmed', 'reconciliation-required', 'not-applicable'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_work_orders_completion_state
  ON work_orders (completion_state, updated_at DESC);

COMMIT;
