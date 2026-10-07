BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-in-transit-outcome-precondition-remaining-249')
);

-- Migration 248 intentionally required the transient submission snapshot. An
-- older Worker can clear that snapshot while releasing a logistics wait. This
-- remaining pass uses the durable, response-captured external effect instead.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    submit_effect.id AS rejected_effect_id,
    submit_effect.receipt AS rejected_receipt,
    submit_effect.updated_at AS rejected_at
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
    AND instance.platform_case_id IS NOT NULL
    AND instance.platform_case_key =
      'pdd-work-order:' || instance.platform_case_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects submit_effect
    ON submit_effect.work_order_id = work_order.id
    AND submit_effect.shop_id = work_order.shop_id
    AND submit_effect.ordinary_instance_id = instance.id
    AND submit_effect.effect_type = 'pdd-submit'
    AND submit_effect.status = 'failed'
    AND submit_effect.idempotency_key =
      'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
        || instance.platform_case_id || ':resolution'
    AND submit_effect.receipt->>'success' = 'false'
    AND submit_effect.receipt->>'responseCaptured' = 'true'
    AND submit_effect.receipt->>'errorCode' = '190001'
    AND submit_effect.receipt->>'errorMsg' =
      '您未同意退货退款或当前订单售后类型非退货退款'
  WHERE work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'retry-ready'
    AND work_order.runtime_status = 'retry-ready'
    AND instance.status = 'retry-ready'
    AND instance.runtime_status = 'retry-ready'
    AND work_order.current_step = 'logistics-waiting-released'
    AND instance.current_step = 'logistics-waiting-released'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.payload#>>'{logisticsWait,reason}' =
      '拼多多仍显示未发货，等待实际发货后再提交异常网点处理结果'
    AND 1 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND (
          effect.status IN ('reserved', 'unknown')
          OR (effect.effect_type = 'pdd-submit' AND effect.status = 'succeeded')
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, submit_effect
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'in-transit-refund-outcome-fallback-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'logisticsWait'
      - 'manualReview'
      - 'error'
    ) || jsonb_build_object(
      'step', 'in-transit-refund-outcome-fallback-retry-ready',
      'pddResolutionSubmission', jsonb_build_object(
        'shopId', work_order.shop_id,
        'orderNumber', work_order.external_order_number,
        'flowCode', 'primary-refund',
        'status', 'outcome-rejected-fallback-ready',
        'outcome', '已同意退货退款',
        'submitAttemptCount', 1,
        'lastRejectedAt', candidate.rejected_at,
        'lastRejectedResponse', candidate.rejected_receipt,
        'rejectedOutcomeLabels', jsonb_build_array('已同意退货退款'),
        'rejectedOutcomeReceipts', jsonb_build_array(jsonb_build_object(
          'outcome', '已同意退货退款',
          'rejectedAt', candidate.rejected_at,
          'receipt', candidate.rejected_receipt
        )),
        'nextOutcome', '同意退款',
        'outcomeFallbackAuthorizedAt', now()
      ),
      'inTransitOutcomeRecovery249', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-249',
        'rejectedEffectId', candidate.rejected_effect_id,
        'rejectedOutcome', '已同意退货退款',
        'nextOutcome', '同意退款',
        'proof', 'single-response-captured-failed-submit-and-no-success-or-unknown-submit',
        'externalActionsReplayedByMigration', false,
        'authorizedAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.rejected_effect_id
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'in-transit-refund-outcome-fallback-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.rejected_effect_id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-249',
    'in-transit-refund-outcome-fallback-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'rejectedEffectId', recovered.rejected_effect_id,
      'rejectedOutcome', '已同意退货退款',
      'nextOutcome', '同意退款',
      'externalActionsReplayedByMigration', false
    ),
    'migration-249:in-transit-outcome-fallback:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('249_recover_in_transit_outcome_precondition_remaining.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
