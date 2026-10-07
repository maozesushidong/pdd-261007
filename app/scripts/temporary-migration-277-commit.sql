\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:rehydrate-product-shortage-tms-effect-277')
);

-- The Worker remains disabled throughout the maintenance window. This
-- uncommitted value is visible only to this transaction so migration 277 can
-- retain its production invariant that recovery targets an enabled shop.
UPDATE shops
SET enabled = true
WHERE id = 'songteng-yazc-overseas'
  AND enabled = false;

-- The TMS API and durable tables prove that this exact product-shortage
-- ticket was created, but the worker stopped before tmsWorkOrder reached the
-- workflow payload. Rehydrate only that committed result, then force a fresh
-- read-only row verification and fresh evidence captures. This migration does
-- not replay TMS, OMS, PDD note, evidence upload, or PDD submit actions.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  binding_token,
  effect_stage,
  ticket_id,
  ticket_no
) AS (
  VALUES (
    '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid,
    'songteng-yazc-overseas'::text,
    '260823-522285269393952'::text,
    '5f710fc0-f8ac-4070-8eff-2e0387df87f1'::uuid,
    '500013071007728'::text,
    'c4c803fb-fe04-4907-9911-b487ad86fbec'::uuid,
    'ordinary-product-shortage-verification-v1'::text,
    '39820'::text,
    'L00039737'::text
  )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.current_step AS previous_step,
    work_order.payload->>'reasonCode' AS previous_reason_code,
    expected.platform_case_id,
    expected.effect_stage,
    expected.ticket_id,
    expected.ticket_no,
    effect.receipt->>'completedAt' AS effect_completed_at,
    effect.updated_at AS effect_updated_at
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = 'product-shortage'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'product-shortage'
    AND (
      (
        instance.status IN ('processing', 'paused')
        AND instance.runtime_status IN ('processing', 'paused')
        AND instance.current_step IN (
          'ordinary-scenario-starting', 'manual-review-waiting', 'flow-paused'
        )
      )
      OR (
        instance.status = 'retry-ready'
        AND instance.runtime_status = 'retry-ready'
        AND instance.current_step = 'system-shutdown-drained'
        AND instance.manual_review_reason =
          '系统安全停止 (supervisor-ipc)'
        AND instance.payload->>'step' = 'system-shutdown-drained'
        AND instance.payload#>>'{operatorHandoff,commandType}' =
          'system-shutdown'
        AND instance.payload#>>'{loopState,status}' = 'shutdown-drained'
      )
    )
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token = expected.binding_token
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  JOIN external_effects effect
    ON effect.work_order_id = work_order.id
    AND effect.ordinary_instance_id = instance.id
    AND effect.effect_type = 'tms-create'
    AND effect.status = 'succeeded'
    AND effect.idempotency_key =
      'tms-create:' || work_order.shop_id || ':' || instance.platform_case_key
        || ':' || expected.effect_stage
    AND effect.receipt#>>'{result,success}' = 'true'
    AND effect.receipt#>>'{result,data,ticketId}' = expected.ticket_id
    AND effect.receipt#>>'{result,data,ticketNo}' = expected.ticket_no
  JOIN tms_work_orders tms
    ON tms.work_order_id = work_order.id
    AND tms.ordinary_instance_id = instance.id
    AND tms.external_ticket_id = expected.ticket_id
    AND tms.status = 'created'
    AND tms.payload->>'ticketNo' = expected.ticket_no
  WHERE (
      (
        work_order.status IN ('processing', 'paused')
        AND work_order.runtime_status IN ('processing', 'paused')
        AND work_order.current_step IN (
          'ordinary-scenario-starting', 'manual-review-waiting', 'flow-paused'
        )
        AND coalesce(work_order.manual_review_reason, '') = ''
      )
      OR (
        work_order.status = 'retry-ready'
        AND work_order.runtime_status = 'retry-ready'
        AND work_order.current_step = 'system-shutdown-drained'
        AND work_order.manual_review_reason =
          '系统安全停止 (supervisor-ipc)'
        AND work_order.payload#>>'{operatorHandoff,commandType}' =
          'system-shutdown'
        AND work_order.payload#>>'{loopState,status}' = 'shutdown-drained'
      )
    )
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.payload->>'step' = work_order.current_step
    AND work_order.payload->>'reasonCode' =
      'product-shortage-tms-result-recheck-required'
    AND work_order.payload#>>'{ordinaryScenarioExecution,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{ordinaryScenarioExecution,scenarioCode}' =
      'product-shortage'
    AND work_order.payload#>>'{ordinaryScenarioExecution,platformCaseKey}' =
      'pdd-work-order:' || expected.platform_case_id
    AND work_order.payload#>>'{ordinaryScenarioExecution,omsTmsFlowCompleted}' =
      'true'
    AND work_order.payload#>>'{ordinaryScenarioExecution,tmsLookupCompleted}' =
      'true'
    AND nullif(work_order.payload#>>'{tmsWorkOrder,ticketId}', '') IS NULL
    AND nullif(work_order.payload#>>'{tmsWorkOrder,ticketNo}', '') IS NULL
    AND work_order.payload#>>'{omsAnalysis,orderNumber}' = expected.order_number
    AND work_order.payload#>>'{omsAnalysis,shippingWarehouse}' ~
      '(简卓|众邦|铭如|瞳琪|捷佑|亿哈|筑越仓|迅发|品动工贸|祺迦工贸)'
    AND work_order.payload#>>'{omsAnalysis,shippingWarehouse}' !~ '久伴体育'
    AND 1 = (
      SELECT count(*)
      FROM external_effects exact_effect
      WHERE exact_effect.work_order_id = work_order.id
        AND exact_effect.ordinary_instance_id = instance.id
        AND exact_effect.effect_type = 'tms-create'
        AND exact_effect.idempotency_key = effect.idempotency_key
        AND exact_effect.status = 'succeeded'
        AND exact_effect.receipt#>>'{result,data,ticketId}' = expected.ticket_id
        AND exact_effect.receipt#>>'{result,data,ticketNo}' = expected.ticket_no
    )
    AND 1 = (
      SELECT count(*)
      FROM tms_work_orders exact_tms
      WHERE exact_tms.work_order_id = work_order.id
        AND exact_tms.ordinary_instance_id = instance.id
        AND exact_tms.external_ticket_id = expected.ticket_id
        AND exact_tms.status = 'created'
        AND exact_tms.payload->>'ticketNo' = expected.ticket_no
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects other_effect
      WHERE other_effect.work_order_id = work_order.id
        AND other_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND other_effect.id <> effect.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects unresolved_effect
      WHERE unresolved_effect.work_order_id = work_order.id
        AND unresolved_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND unresolved_effect.status IN ('reserved', 'unknown')
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
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'product-shortage-tms-effect-rehydrated-retry-ready',
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
        - 'reasonCode'
        - 'pddEvidenceScreenshot'
        - 'tmsEvidenceScreenshot'
        - 'tmsEvidenceDisposition'
        - 'tmsDuplicateCheck'
        - 'tmsAttachmentTransfer'
    ) || jsonb_build_object(
      'step', 'product-shortage-tms-effect-rehydrated-retry-ready',
      'tmsWorkOrder', jsonb_build_object(
        'shopId', work_order.shop_id,
        'orderNumber', work_order.external_order_number,
        'status', 'created',
        'effectStage', candidate.effect_stage,
        'ticketId', candidate.ticket_id,
        'ticketNo', candidate.ticket_no,
        'problemType', '签收未收到',
        'customerRemark',
          '消费者反馈商品少发，请核实包裹发出重量、签收重量及是否存在仓库漏发，核实结果请明确回复',
        'createdAt', coalesce(
          nullif(candidate.effect_completed_at, ''),
          candidate.effect_updated_at::text
        ),
        'recovered', true,
        'recoverySource', 'migration-277',
        'error', NULL
      ),
      'ordinaryScenarioExecution', (
        coalesce(work_order.payload->'ordinaryScenarioExecution', '{}'::jsonb)
          - 'commonFlowTicket'
          - 'productShortageTmsResultText'
          - 'productShortageTmsTaskStatus'
          - 'productShortageTmsResultCheckedAt'
      ) || jsonb_build_object(
        'omsTmsFlowCompleted', false,
        'tmsLookupCompleted', false,
        'tmsEffectRehydratedAt', now(),
        'tmsEffectRecoverySource', 'migration-277',
        'updatedAt', now()
      ),
      'transientWorkflowRecovery', jsonb_build_object(
        'count', 0,
        'maxAttempts', 6,
        'lastReason', candidate.previous_reason_code,
        'retryAt', now(),
        'recoveredAt', now(),
        'recoverySource', 'migration-277'
      ),
      'ordinaryProductShortageTmsEffectRecovery277', jsonb_build_object(
        'status', 'retry-ready',
        'strategy', 'rehydrate-succeeded-effect-then-verify-visible-row',
        'orderNumber', work_order.external_order_number,
        'platformCaseId', candidate.platform_case_id,
        'effectStage', candidate.effect_stage,
        'ticketId', candidate.ticket_id,
        'ticketNo', candidate.ticket_no,
        'previousStep', candidate.previous_step,
        'previousReasonCode', candidate.previous_reason_code,
        'freshPddEvidenceRequired', true,
        'freshTmsEvidenceRequired', true,
        'existingTmsEffectPreserved', true,
        'externalActionsReplayedByMigration', false,
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
    candidate.platform_case_id,
    candidate.effect_stage,
    candidate.ticket_id,
    candidate.ticket_no,
    candidate.previous_step,
    candidate.previous_reason_code
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'product-shortage-tms-effect-rehydrated-retry-ready',
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
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-277',
    'product-shortage-tms-effect-rehydrated-retry-ready',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'effectStage', recovered.effect_stage,
      'ticketId', recovered.ticket_id,
      'ticketNo', recovered.ticket_no,
      'previousStep', recovered.previous_step,
      'previousReasonCode', recovered.previous_reason_code,
      'strategy', 'rehydrate-succeeded-effect-then-verify-visible-row',
      'existingTmsEffectPreserved', true,
      'externalActionsReplayedByMigration', false
    ),
    'migration-277:product-shortage-tms-effect:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id, payload->>'orderNumber' AS order_number
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-277')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-safe-recovery-277'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('277_rehydrate_product_shortage_tms_effect.sql')
ON CONFLICT (version) DO NOTHING;

UPDATE shops
SET enabled = false
WHERE id = 'songteng-yazc-overseas'
  AND enabled = true;

COMMIT;

