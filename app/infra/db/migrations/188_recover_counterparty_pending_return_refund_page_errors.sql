BEGIN;

-- Some PDD aftersale pages explicitly wait for the buyer/consumer and expose
-- no merchant refund action. Older workers stored those read-only states as a
-- generic page error. Reclassify only identity-complete records without a live
-- lease or any possibly applied refund effect; this migration never clicks or
-- authorizes a refund action.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    refund.aftersale_number,
    refund.aftersale_status,
    coalesce(
      work_order.manual_review_reason,
      work_order.payload->>'error',
      work_order.payload#>>'{returnRefundResult,error}',
      refund.decision,
      ''
    ) AS previous_reason
  FROM work_orders work_order
  JOIN return_refunds refund
    ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready', 'processing')
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND refund.action_state = 'page-error'
    AND refund.completed_at IS NULL
    AND refund.action_button_visible IS DISTINCT FROM true
    AND refund.detail_url IS NOT NULL
    AND nullif(trim(work_order.external_order_number), '') IS NOT NULL
    AND nullif(trim(refund.aftersale_number), '') IS NOT NULL
    AND coalesce(refund.aftersale_status, '') ~
      '(待买家(处理|处理中|寄出退货|发货)|待消费者(处理|寄出退货|寄货))'
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, refund
), recovered_refunds AS (
  UPDATE return_refunds refund
  SET action_state = 'waiting-logistics',
    decision = 'wait-logistics',
    risk_level = NULL,
    next_check_at = now() + interval '4 hours',
    rule_results = coalesce(refund.rule_results, '{}'::jsonb)
      || jsonb_build_object(
        'counterpartyAction', jsonb_build_object(
          'passed', true,
          'actual', candidate.aftersale_status,
          'expected', '等待买家或消费者处理时仅进行定时只读复查'
        )
      ),
    evidence = coalesce(refund.evidence, '{}'::jsonb)
      || jsonb_build_object(
        'counterpartyPendingRecovery188', jsonb_build_object(
          'strategy', 'timed-read-only-recheck',
          'intervalHours', 4,
          'previousStatus', candidate.aftersale_status,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
    AND refund.action_state = 'page-error'
  RETURNING candidate.*
), recovered_orders AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'waiting',
    current_step = 'return-refund-waiting-logistics',
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'counterparty-action-pending',
    classification_updated_at = now(),
    manual_review_reason = NULL,
    next_attempt_at = now() + interval '4 hours',
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-waiting-logistics',
        'counterpartyPendingRecovery188', jsonb_build_object(
          'aftersaleNumber', recovered.aftersale_number,
          'previousStatus', recovered.aftersale_status,
          'previousReason', recovered.previous_reason,
          'strategy', 'timed-read-only-recheck',
          'intervalHours', 4,
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered_refunds recovered
  WHERE work_order.id = recovered.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    recovered.aftersale_number,
    recovered.aftersale_status,
    recovered.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    'migration-188',
    'return-refund-counterparty-pending-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'aftersaleNumber', recovered.aftersale_number,
      'previousStatus', recovered.aftersale_status,
      'previousReason', recovered.previous_reason,
      'nextState', 'waiting-logistics',
      'strategy', 'timed-read-only-recheck',
      'intervalHours', 4
    ),
    'migration-188:return-refund-counterparty-pending:' || recovered.id::text
  FROM recovered_orders recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), workflowed AS (
  INSERT INTO workflow_events
    (id, event_key, shop_id, work_order_id, external_order_number,
     system_name, stage, event_type, severity, reason_code, message,
     payload, source_hash, occurred_at)
  SELECT gen_random_uuid(),
    'migration-188:return-refund-counterparty-pending:' || recovered.id::text,
    recovered.shop_id,
    recovered.id,
    recovered.external_order_number,
    'pdd',
    'return-refund-waiting-logistics',
    'return-refund.counterparty-pending-recovered',
    'info',
    'counterparty-action-pending',
    '售后等待买家或消费者处理，4小时后只读复查',
    jsonb_build_object(
      'aftersaleNumber', recovered.aftersale_number,
      'aftersaleStatus', recovered.aftersale_status,
      'strategy', 'timed-read-only-recheck',
      'intervalHours', 4
    ),
    md5('migration-188:return-refund-counterparty-pending:' || recovered.id::text),
    now()
  FROM recovered_orders recovered
  ON CONFLICT (event_key) DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-188')
  FROM recovered_orders recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'counterparty-action-pending-read-only-reclassification-188'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('188_recover_counterparty_pending_return_refund_page_errors.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
