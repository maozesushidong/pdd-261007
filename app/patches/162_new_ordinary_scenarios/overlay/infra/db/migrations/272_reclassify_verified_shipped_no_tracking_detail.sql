\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:reclassify-verified-shipped-no-tracking-detail-272')
);

-- The exact PDD detail now identifies this legacy row as the already-supported
-- shipped-no-tracking scenario. Correct the stale list classification without
-- replaying its successful note/TMS work or applying the old in-transit rule.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  platform_case_id
) AS (
  VALUES (
    '4f89b35d-d198-480c-83ab-d1ab63cb9ddd'::uuid,
    'panapopo-medical-device'::text,
    '260827-059915671053202'::text,
    '500013065540013'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.work_order_type AS previous_work_order_type,
    work_order.scenario_code AS previous_scenario_code,
    work_order.manual_review_reason AS previous_reason,
    expected.platform_case_id
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_step = 'flow-paused'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.scenario_code = 'in-transit-refund'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'in-transit-refund'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE work_order.manual_review_reason =
      'PDD_ORDINARY_DETAIL_TYPE_MISMATCH: 拼多多详情页真实工单类型“已发货无轨迹退款处理”与当前队列类型“在途无理由退款处理”不一致，已禁止沿用原业务流程'
    AND work_order.payload#>>'{tmsWorkOrder,status}' = 'created'
    AND work_order.payload#>>'{pddResolutionDetailRevalidation,orderNumber}' =
      work_order.external_order_number
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id = instance.id
        AND effect.effect_type = 'pdd-note'
        AND effect.status = 'succeeded'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), corrected AS (
  UPDATE work_orders work_order
  SET work_order_type = '已发货无轨迹退款处理',
    scenario_code = 'shipped-no-tracking-refund',
    status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'detail-classification-corrected-retry-ready',
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
      - 'transientWorkflowRecovery'
      - 'pddResolutionDecision'
      - 'pddResolutionFlow'
      - 'pddResolutionSubmission'
      - 'pddCoreOptionLookupFailure'
      - 'pddSubmitButtonLookupFailure'
      - 'pddResolutionDetailReuse'
      - 'pddResolutionDetailRevalidation'
    ) || jsonb_build_object(
      'step', 'detail-classification-corrected-retry-ready',
      'workOrderType', '已发货无轨迹退款处理',
      'scenarioCode', 'shipped-no-tracking-refund',
      'pddDetailIdentityCorrection', jsonb_build_object(
        'listWorkOrderType', candidate.previous_work_order_type,
        'listScenarioCode', candidate.previous_scenario_code,
        'detailWorkOrderType', '已发货无轨迹退款处理',
        'detailScenarioCode', 'shipped-no-tracking-refund',
        'source', 'migration-272-exact-detail-revalidation',
        'correctedAt', now()
      ),
      'shippedNoTrackingDetailRecovery272', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-272',
        'previousReason', candidate.previous_reason,
        'platformCaseId', candidate.platform_case_id,
        'successfulPriorEffectsPreserved', true,
        'externalActionsReplayedByMigration', false,
        'correctedAt', now()
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
    candidate.platform_case_id,
    candidate.previous_work_order_type,
    candidate.previous_scenario_code,
    candidate.previous_reason
), corrected_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET work_order_type = '已发货无轨迹退款处理',
    scenario_code = 'shipped-no-tracking-refund',
    status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'detail-classification-corrected-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = corrected.payload,
    updated_at = now()
  FROM corrected
  WHERE instance.id = corrected.current_ordinary_instance_id
    AND instance.work_order_id = corrected.id
    AND instance.shop_id = corrected.shop_id
  RETURNING corrected.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    corrected.shop_id,
    corrected.id,
    corrected.current_ordinary_instance_id,
    'migration-272',
    'ordinary-detail-classification-corrected',
    jsonb_build_object(
      'orderNumber', corrected.external_order_number,
      'platformCaseId', corrected.platform_case_id,
      'previousWorkOrderType', corrected.previous_work_order_type,
      'previousScenarioCode', corrected.previous_scenario_code,
      'detailWorkOrderType', '已发货无轨迹退款处理',
      'detailScenarioCode', 'shipped-no-tracking-refund',
      'successfulPriorEffectsPreserved', true,
      'externalActionsReplayedByMigration', false
    ),
    'migration-272:shipped-no-tracking-detail:' || corrected.id::text
  FROM corrected_instances corrected
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-272')
  FROM corrected
  WHERE intervention.work_order_id = corrected.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      corrected.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-safe-reclassification-272'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS corrected_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS corrected_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('272_reclassify_verified_shipped_no_tracking_detail.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
