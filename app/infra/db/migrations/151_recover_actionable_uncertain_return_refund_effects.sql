BEGIN;

-- Old workers could leave a refund effect in unknown/reserved after a page
-- failure. Wake only exact, actionable pending refunds for a read-only check;
-- the runtime still requires either explicit non-dispatch evidence or two
-- stable observations before it releases the effect.
CREATE TEMP TABLE migration_151_uncertain_refunds ON COMMIT DROP AS
SELECT work_order.id AS work_order_id,
  work_order.shop_id,
  work_order.external_order_number,
  refund.aftersale_number,
  refund.aftersale_status,
  effect.id AS effect_id,
  effect.status AS effect_status,
  effect.reserved_at,
  coalesce(effect.receipt#>>'{submission,confirmationDispatchStarted}', 'false') = 'true'
    OR coalesce(effect.receipt#>>'{submission,confirmationClicked}', 'false') = 'true'
    AS confirmation_dispatched
FROM work_orders work_order
JOIN return_refunds refund ON refund.work_order_id = work_order.id
  AND refund.shop_id = work_order.shop_id
JOIN LATERAL (
  SELECT candidate_effect.id, candidate_effect.status,
    candidate_effect.receipt, candidate_effect.reserved_at
  FROM external_effects candidate_effect
  WHERE candidate_effect.work_order_id = work_order.id
    AND candidate_effect.effect_type = 'pdd-return-refund'
    AND candidate_effect.status IN ('unknown', 'reserved')
  ORDER BY candidate_effect.reserved_at DESC
  LIMIT 1
) effect ON true
WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
  AND work_order.scenario_code = 'return-refund'
  AND work_order.status IN ('retry-ready', 'paused')
  AND work_order.runtime_status IN ('waiting', 'retry-ready', 'manual-review')
  AND work_order.completion_state <> 'confirmed'
  AND work_order.recovery_state <> 'held'
  AND refund.action_state IN ('page-error', 'verification-required')
  AND refund.detail_url IS NOT NULL
  AND refund.external_order_number = work_order.external_order_number
  AND refund.aftersale_number IS NOT NULL
  AND refund.action_button_visible = true
  AND coalesce(refund.aftersale_status, '') ~
    '(待商家(处理|确认收货)|待消费者(寄出退货|寄货)|待买家(处理|寄出退货|发货)|买家已发货|商家处理中|待快递退回后退款|退款中)'
  AND coalesce(refund.aftersale_status, '') !~
    '(退款成功|退款完成|退款失败|售后完成|售后关闭|平台已退款|交易关闭)'
  AND refund.evidence#>>'{fieldSources,orderNumber,value}' = refund.external_order_number
  AND refund.evidence#>>'{fieldSources,aftersaleNumber,value}' = refund.aftersale_number
  AND refund.evidence#>>'{fieldSources,aftersaleStatus,source}' IN (
    'label-inline', 'label-following-line', 'inline-body-fallback'
  )
  AND effect.reserved_at <= now() - interval '30 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM shop_runtime_state runtime
    WHERE runtime.current_work_order_id = work_order.id
      AND runtime.lease_token IS NOT NULL
      AND runtime.lease_expires_at > now()
  );

UPDATE return_refunds refund
SET action_state = 'page-error',
  decision = 'submission-reconciliation-required',
  risk_level = NULL,
  next_check_at = now(),
  evidence = coalesce(refund.evidence, '{}'::jsonb) || jsonb_build_object(
    'uncertainEffectRecovery151', jsonb_build_object(
      'strategy', 'exact-read-only-detail-reconciliation',
      'effectStatus', candidate.effect_status,
      'confirmationDispatched', candidate.confirmation_dispatched,
      'effectPreserved', true,
      'recoveredAt', now()
    )
  ),
  updated_at = now()
FROM migration_151_uncertain_refunds candidate
WHERE refund.work_order_id = candidate.work_order_id;

UPDATE work_orders work_order
SET status = 'retry-ready',
  runtime_status = 'waiting',
  current_step = 'return-refund-page-error',
  handling_classification = 'automated',
  classification_source = 'system',
  classification_reason = 'exact-read-only-uncertain-effect-reconciliation',
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
      'uncertainEffectRecovery151', jsonb_build_object(
        'aftersaleNumber', candidate.aftersale_number,
        'previousStatus', candidate.aftersale_status,
        'effectStatus', candidate.effect_status,
        'confirmationDispatched', candidate.confirmation_dispatched,
        'effectPreserved', true,
        'recoveredAt', now()
      )
    ),
  updated_at = now()
FROM migration_151_uncertain_refunds candidate
WHERE work_order.id = candidate.work_order_id;

INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT candidate.shop_id, candidate.work_order_id, 'migration-151',
  'return-refund-uncertain-effect-reconciliation-recovered',
  jsonb_build_object(
    'orderNumber', candidate.external_order_number,
    'aftersaleNumber', candidate.aftersale_number,
    'previousStatus', candidate.aftersale_status,
    'effectId', candidate.effect_id,
    'effectStatus', candidate.effect_status,
    'confirmationDispatched', candidate.confirmation_dispatched,
    'effectPreserved', true,
    'strategy', 'exact-read-only-detail-reconciliation'
  ),
  'migration-151:return-refund-uncertain-effect:' || candidate.effect_id::text
FROM migration_151_uncertain_refunds candidate
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('151_recover_actionable_uncertain_return_refund_effects.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
