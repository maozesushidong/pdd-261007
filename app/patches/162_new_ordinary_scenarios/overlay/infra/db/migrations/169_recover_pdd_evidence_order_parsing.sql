BEGIN;

-- The evidence capture guard previously required the order label and number
-- in one DOM text node. Recover only the inspected order that failed before
-- any guarded external operation was created.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
    AND binding.actual_shop_name = shop.expected_shop_name
  WHERE work_order.external_order_number = '260809-319396309370679'
    AND work_order.shop_id = 'panapopo-medical-device'
    AND work_order.scenario_code = 'shipped-no-tracking-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.current_step = 'flow-paused'
    AND work_order.payload#>>'{pddEvidenceScreenshot,status}' = 'failed'
    AND work_order.payload#>>'{pddEvidenceScreenshot,orderNumber}' =
      work_order.external_order_number
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) LIKE 'locator.innerText: Timeout 10000ms exceeded.%订单编号%订单号%'
    AND work_order.payload#>>'{logisticsAnalysis,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{omsAnalysis,orderNumber}' =
      work_order.external_order_number
    AND work_order.payload#>>'{tmsWorkOrder,status}' IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown', 'succeeded')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-evidence-order-parsing-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      - 'pddEvidenceScreenshot'
      - 'pageCrashRecovery'
    ) || jsonb_build_object(
      'step', 'pdd-evidence-order-parsing-retry-ready',
      'transientWorkflowRecovery', jsonb_build_object(
        'count', 0,
        'maxAttempts', 5,
        'lastReason', candidate.previous_reason,
        'retryAt', now(),
        'recoveredAt', now(),
        'recoverySource', 'migration-169'
      ),
      'pddEvidenceOrderParsingRecovery', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'whole-page-detail-order-validation',
        'previousReason', candidate.previous_reason,
        'recoveredAt', now(),
        'recoverySource', 'migration-169'
      )
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason
), recovered_instance AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-evidence-order-parsing-retry-ready',
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
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-169',
    'pdd-evidence-order-parsing-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', 'whole-page-detail-order-validation'
    ),
    'migration-169:pdd-evidence-order-parsing:' || recovered.id::text
  FROM recovered_instance recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-169')
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
SET status = 'cancelled',
  updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('169_recover_pdd_evidence_order_parsing.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
