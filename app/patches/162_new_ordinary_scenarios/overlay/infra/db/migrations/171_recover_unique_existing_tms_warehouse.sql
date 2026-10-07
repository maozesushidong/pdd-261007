BEGIN;

-- Requeue only the inspected new ordinary instance whose sole existing TMS
-- row matches every core identifier and business decision. The warehouse is
-- intentionally excluded from equality here because the loaded Worker treats
-- that sole TMS row as authoritative and will reuse it instead of creating a
-- duplicate ticket.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    coalesce(work_order.manual_review_reason, instance.manual_review_reason, '') AS previous_reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text = work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
    AND binding.actual_shop_name = shop.expected_shop_name
  WHERE (
      (work_order.external_order_number = '260820-621900020061243'
        AND work_order.shop_id = 'shop-msrd6wm5-1af283'
        AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,订单号}' =
          'SO281430169259504')
      OR
      (work_order.external_order_number = '260820-216279335290827'
        AND work_order.shop_id = 'shop-mse1sff3-b85aa4'
        AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,订单号}' =
          'SO281432237629938')
    )
    AND work_order.scenario_code = 'shipped-no-tracking-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'manual-review-blocked'
    AND instance.current_step = 'manual-review-blocked'
    AND work_order.payload#>>'{manualReview,stage}' = 'tms-duplicate-check'
    AND work_order.payload#>>'{tmsDuplicateCheck,status}' = 'manual'
    AND work_order.payload#>>'{tmsDuplicateCheck,candidateCount}' = '1'
    AND work_order.payload#>>'{tmsDuplicateCheck,selectionStrategy}' = 'only-row'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,交易号}' =
      work_order.external_order_number
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,运单号}' =
      work_order.payload#>>'{logisticsAnalysis,trackingNumber}'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,责任快递}' =
      work_order.payload#>>'{logisticsAnalysis,carrier}'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,物流问题}' =
      work_order.payload#>>'{tmsFormDecision,problemType}'
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,matches}' = 'true'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,ticketId}' <> ''
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,ticketNo}' <> ''
    AND work_order.payload#>>'{tmsWorkOrder,status}' IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
        AND (effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id)
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
    current_step = 'tms-unique-existing-warehouse-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'tms-unique-existing-warehouse-retry-ready',
        'tmsUniqueExistingWarehouseRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', 'reuse-sole-core-identity-matched-tms-ticket',
          'previousReason', candidate.previous_reason,
          'recoveredAt', now(),
          'recoverySource', 'migration-171'
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, work_order.payload, candidate.previous_reason
), recovered_instance AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-unique-existing-warehouse-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-171', 'unique-existing-tms-warehouse-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', 'reuse-sole-core-identity-matched-tms-ticket'
    ),
    'migration-171:unique-existing-tms-warehouse:' || recovered.id::text
  FROM recovered_instance recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-171')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id)
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('171_recover_unique_existing_tms_warehouse.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
