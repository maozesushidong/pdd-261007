BEGIN;

-- Missing PDD carrier recommendations must not block an abnormal-network order
-- that OMS has already allocated. Requeue only the current, identity-bound,
-- unshipped instance with no ambiguous PDD submission.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.manual_review_reason AS previous_reason,
    work_order.payload#>>'{omsAnalysis,orderStatus}' AS oms_order_status
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'abnormal-network-warning'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'manual-review-blocked'
    AND coalesce(work_order.manual_review_reason, '') LIKE
      '%异常网点预警未读取到平台建议快递，禁止手工配货%'
    AND work_order.payload#>>'{omsAnalysis,orderStatus}' IN ('已配货', '已发货', '已完成')
    AND work_order.payload#>>'{logisticsAnalysis,abnormalNetworkShipmentState}' = 'unshipped'
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.mall_id = coalesce(
      nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
      nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
      nullif(work_order.payload->>'pddMallId', '')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'abnormal-network-allocation-already-complete-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'abnormal-network-allocation-already-complete-retry-ready',
        'abnormalNetworkMissingRecommendationRecovery', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'omsOrderStatus', candidate.oms_order_status,
          'strategy', 'accept-existing-oms-allocation-and-wait-for-shipment',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.previous_reason,
    candidate.oms_order_status
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'abnormal-network-allocation-already-complete-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.previous_reason,
    recovered.oms_order_status
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-142', 'abnormal-network-allocated-without-recommendation-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'omsOrderStatus', recovered.oms_order_status,
      'strategy', 'accept-existing-oms-allocation-and-wait-for-shipment'
    ),
    'migration-142:abnormal-network-allocated-without-recommendation:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-142')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('142_recover_abnormal_network_allocated_without_recommendation.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
