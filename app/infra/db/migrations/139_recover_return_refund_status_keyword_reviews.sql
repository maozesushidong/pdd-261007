BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    refund.aftersale_number, refund.aftersale_status,
    work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready')
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND refund.action_state = 'manual-review'
    AND refund.detail_url IS NOT NULL
    AND (
      coalesce(work_order.manual_review_reason, '') LIKE '%售后状态不包含%待商家%'
      OR coalesce(refund.decision, '') LIKE '%售后状态不包含%待商家%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered_refunds AS (
  UPDATE return_refunds refund
  SET action_state = 'page-error',
    decision = 'policy-recheck-required',
    risk_level = NULL,
    next_check_at = now(),
    evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
      'statusKeywordRecovery139', jsonb_build_object(
        'strategy', 'live-page-policy-recheck',
        'previousStatus', candidate.aftersale_status,
        'recoveredAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id, candidate.shop_id,
    candidate.external_order_number, candidate.aftersale_number,
    candidate.aftersale_status, candidate.previous_reason
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'waiting',
    current_step = 'return-refund-page-error',
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'live-page-policy-recheck',
    classification_updated_at = now(),
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'return-refund-page-error',
        'statusKeywordRecovery139', jsonb_build_object(
          'aftersaleNumber', recovered_refund.aftersale_number,
          'previousStatus', recovered_refund.aftersale_status,
          'previousReason', recovered_refund.previous_reason,
          'strategy', 'live-page-policy-recheck',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM recovered_refunds recovered_refund
  WHERE work_order.id = recovered_refund.work_order_id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    recovered_refund.aftersale_number, recovered_refund.aftersale_status,
    recovered_refund.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
  SELECT recovered.shop_id, recovered.id, 'migration-139',
    'return-refund-status-keyword-review-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'aftersaleNumber', recovered.aftersale_number,
      'previousStatus', recovered.aftersale_status,
      'previousReason', recovered.previous_reason,
      'strategy', 'live-page-policy-recheck'
    ),
    'migration-139:return-refund-status-keyword-review:' || recovered.id::text
  FROM recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-139')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

UPDATE scenario_definitions
SET policy_version = greatest(policy_version, 5),
  config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
    'aftersaleStatusKeywordRequired', false,
    'statusKeywordPolicy', 'evidence-only'
  ),
  updated_at = now()
WHERE code = 'return-refund';

COMMIT;
