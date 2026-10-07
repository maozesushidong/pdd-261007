BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.current_ordinary_instance_id,
    work_order.external_order_number,
    work_order.manual_review_reason AS previous_reason
  FROM work_orders work_order
  WHERE work_order.id = '0b8f0ec9-5881-4d8f-9151-d6284f470bf5'::uuid
    AND work_order.external_order_number = '260817-674454618552185'
    AND work_order.current_ordinary_instance_id =
      '9abd787f-1bf0-4df6-b50a-1bd27dd34b35'::uuid
    AND work_order.status = 'paused'
    AND work_order.completion_state <> 'confirmed'
    AND work_order.current_step = 'external-state-unresolved'
    AND work_order.payload #>> '{externalStateReconciliation,effectType}' = 'pdd-submit'
    AND work_order.payload #>> '{externalStateReconciliation,state}' = 'unresolved'
    AND work_order.payload #>>
      '{externalStateReconciliation,automaticRetryExhausted}' = 'true'
    AND work_order.payload #>>
      '{externalStateReconciliation,submitAttemptCount}' = '1'
    AND work_order.payload #>>
      '{externalStateReconciliation,maximumAutomaticSubmitAttempts}' = '1'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = work_order.current_ordinary_instance_id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), updated AS (
  UPDATE work_orders work_order
  SET runtime_status = 'manual-review',
    manual_review_reason =
      '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对',
    payload = coalesce(work_order.payload, '{}'::jsonb)
      || jsonb_build_object(
        'manualReview', jsonb_build_object(
          'status', 'blocked',
          'stage', 'pdd-submit-reconciliation-exhausted',
          'reasonCode', 'pdd-submit-reconciliation-exhausted',
          'reason',
            '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对',
          'blockedAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id,
    work_order.current_ordinary_instance_id, work_order.external_order_number,
    candidate.previous_reason
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT updated.shop_id, updated.id, updated.current_ordinary_instance_id,
  'migration-132', 'exhausted-submit-reconciliation-marked-manual',
  jsonb_build_object(
    'orderNumber', updated.external_order_number,
    'previousReason', updated.previous_reason,
    'reasonCode', 'pdd-submit-reconciliation-exhausted',
    'submitAttemptCount', 1,
    'maximumAutomaticSubmitAttempts', 1,
    'result', 'manual-review-no-resubmit'
  ),
  'migration-132:exhausted-submit-manual:' || updated.id::text
FROM updated
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET runtime_status = 'manual-review',
  manual_review_reason = work_order.manual_review_reason,
  payload = coalesce(instance.payload, '{}'::jsonb)
    || jsonb_build_object(
      'manualReview', work_order.payload->'manualReview',
      'externalStateReconciliation',
        work_order.payload->'externalStateReconciliation'
    ),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.id = '0b8f0ec9-5881-4d8f-9151-d6284f470bf5'::uuid
  AND work_order.payload #>> '{manualReview,reasonCode}' =
    'pdd-submit-reconciliation-exhausted';

COMMIT;
