BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-oms-mark-virtualized-row-267')
);

-- Recover only the audited consumer-refusal instance whose OMS row snapshot
-- proves that the tags cell existed before AG Grid virtualized the row. Prior
-- instances for the same order are intentionally excluded from effect guards.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason,
    (
      SELECT string_agg(coalesce(cell->>'text', ''), E'\n')
      FROM jsonb_array_elements(
        coalesce(work_order.payload->'omsGridCells', '[]'::jsonb)
      ) cell
      WHERE cell->>'colId' = 'tags'
    ) AS captured_mark_text
  FROM work_orders work_order
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.identity_status = 'verified'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE work_order.id = '11ee9965-0559-4989-8f94-8aa65bb962f4'
    AND work_order.current_ordinary_instance_id =
      'd09edb54-37c3-41d8-8f90-ba743470a60e'
    AND work_order.external_order_number = '260825-153343782483244'
    AND work_order.scenario_code = 'consumer-refusal'
    AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') IN ('ready', 'retry-authorized')
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) = 'OMS 当前订单行未找到“标记”单元格'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        coalesce(work_order.payload->'omsGridCells', '[]'::jsonb)
      ) cell
      WHERE cell->>'colId' = 'tags'
        AND coalesce(cell->>'text', '') LIKE '%拆单可发%'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-mark-row-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
    ) || jsonb_build_object(
      'step', 'oms-mark-row-retry-ready',
      'omsMarkVirtualizedRowRecovery267', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-267',
        'strategy', 'restore-grid-scroll-reacquire-order-row-and-read-captured-tags',
        'capturedMarkText', candidate.captured_mark_text,
        'externalActionsReplayed', false,
        'recoveredAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason,
    candidate.captured_mark_text
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-mark-row-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-267')
  FROM recovered_instances recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
), cancelled AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now()
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-267',
    'oms-mark-virtualized-row-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'capturedMarkText', recovered.captured_mark_text,
      'strategy', 'restore-grid-scroll-reacquire-order-row-and-read-captured-tags',
      'externalActionsReplayed', false
    ),
    'migration-267:oms-mark-virtualized-row:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
SELECT
  count(*) AS recovered_count,
  (SELECT count(*) FROM resolved) AS resolved_interventions,
  (SELECT count(*) FROM cancelled) AS cancelled_notifications,
  (SELECT count(*) FROM audited) AS audit_events
FROM recovered_instances;

INSERT INTO schema_migrations (version)
VALUES ('267_recover_oms_mark_virtualized_row.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
