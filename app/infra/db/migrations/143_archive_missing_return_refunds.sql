BEGIN;

ALTER TABLE return_refunds
  DROP CONSTRAINT IF EXISTS return_refunds_action_state_check;

ALTER TABLE return_refunds
  ADD CONSTRAINT return_refunds_action_state_check CHECK (action_state IN (
    'discovered',
    'waiting-logistics',
    'ready',
    'manual-review',
    'submitting',
    'verification-required',
    'auto-refunded',
    'manual-completed',
    'page-error',
    'skipped-not-found'
  ));

CREATE TEMP TABLE migration_143_missing_return_refunds ON COMMIT DROP AS
SELECT refund.work_order_id, refund.shop_id, refund.external_order_number,
  refund.aftersale_number
FROM return_refunds refund
JOIN work_orders work_order ON work_order.id = refund.work_order_id
WHERE refund.action_state = 'page-error'
  AND (
    refund.aftersale_number = '22156161804202'
    OR concat_ws(' ', refund.evidence::text, work_order.payload::text,
      work_order.manual_review_reason, work_order.classification_reason)
      ~ '(未查询到相关订单信息|订单不存在|售后单不存在)'
  )
  AND NOT EXISTS (
    SELECT 1 FROM external_effects effect
    WHERE effect.work_order_id = refund.work_order_id
      AND effect.status IN ('reserved', 'unknown')
  );

UPDATE return_refunds refund
SET decision = 'skipped-not-found',
  risk_level = NULL,
  action_state = 'skipped-not-found',
  action_button_visible = false,
  next_check_at = NULL,
  completed_at = coalesce(refund.completed_at, now()),
  completion_method = 'return-refund-not-found',
  evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
    'terminalClassification', 'pdd-explicit-not-found',
    'terminalClassifiedAt', now()
  ),
  updated_at = now()
FROM migration_143_missing_return_refunds missing
WHERE refund.work_order_id = missing.work_order_id;

UPDATE work_orders work_order
SET status = 'archived',
  runtime_status = 'archived',
  current_step = 'return-refund-skipped-not-found',
  handling_classification = 'automated',
  classification_source = 'system',
  classification_reason = '拼多多明确提示订单或售后单不存在，已永久跳过',
  classification_updated_at = now(),
  manual_review_reason = NULL,
  next_attempt_at = NULL,
  completion_state = 'not-applicable',
  completion_confirmation_method = 'return-refund-not-found',
  completion_confirmed_at = NULL,
  payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
    'returnRefundResult', jsonb_build_object(
      'outcome', 'skipped-not-found',
      'completionMethod', 'return-refund-not-found',
      'reasons', jsonb_build_array('拼多多明确提示订单或售后单不存在，已永久跳过')
    )
  ),
  updated_at = now()
FROM migration_143_missing_return_refunds missing
WHERE work_order.id = missing.work_order_id;

WITH closed AS (
  UPDATE manual_interventions intervention
  SET status = 'cancelled',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-143')
  FROM migration_143_missing_return_refunds missing
  WHERE intervention.work_order_id = missing.work_order_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM closed
WHERE outbox.intervention_id = closed.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT missing.shop_id, missing.work_order_id, 'migration-143',
  'return-refund-skipped-not-found',
  jsonb_build_object(
    'orderNumber', missing.external_order_number,
    'aftersaleNumber', missing.aftersale_number,
    'reason', 'pdd-explicit-not-found',
    'countedAsSuccess', false
  ),
  'migration-143:return-refund-not-found:' || missing.work_order_id::text
FROM migration_143_missing_return_refunds missing
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('143_archive_missing_return_refunds.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
