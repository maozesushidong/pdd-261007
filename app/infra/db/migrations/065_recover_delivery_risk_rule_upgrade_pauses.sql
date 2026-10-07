BEGIN;

WITH candidates AS (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND work_order.status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND (
      coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
        '拼多多提交被平台拒绝（阶段: ordinary-delivery-risk-concern-logistics-updated-within-24-hours）：物流轨迹未更新，请如实填写%'
      OR (
        coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '拼多多未找到场景选项（已等待 30 秒）:%'
        AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
          '%联系物流核实%'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-rule-upgrade-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'logisticsWait'
      - 'ordinaryPddOptionLookupFailure' - 'ordinaryPddOptionRecovery')
      || jsonb_build_object(
        'step', 'ordinary-rule-upgrade-retry-ready',
        'ordinaryRuleUpgradeRecovery', jsonb_build_object(
          'reason', candidate.reason,
          'strategy', 'rerun-delivery-risk-page-facts',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    candidate.reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-065', 'delivery-risk-rule-upgrade-pause-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'previousReason', recovered.reason,
    'strategy', 'rerun-delivery-risk-page-facts'
  ),
  'migration-065:delivery-risk-rule-upgrade:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'ordinary-rule-upgrade-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = (coalesce(instance.payload, '{}'::jsonb)
    - 'manualReview' - 'error' - 'logisticsWait'
    - 'ordinaryPddOptionLookupFailure' - 'ordinaryPddOptionRecovery')
    || jsonb_build_object(
      'step', 'ordinary-rule-upgrade-retry-ready',
      'ordinaryRuleUpgradeRecovery', work_order.payload->'ordinaryRuleUpgradeRecovery'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'ordinary-rule-upgrade-retry-ready'
  AND work_order.payload ? 'ordinaryRuleUpgradeRecovery';

UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-065')
FROM work_orders work_order
WHERE intervention.work_order_id = work_order.id
  AND intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code IN ('external-system-error', 'ordinary-manual-review')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = work_order.current_ordinary_instance_id
  )
  AND work_order.current_step = 'ordinary-rule-upgrade-retry-ready'
  AND work_order.payload ? 'ordinaryRuleUpgradeRecovery';

COMMIT;
