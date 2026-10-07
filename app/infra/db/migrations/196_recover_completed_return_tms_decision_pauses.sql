BEGIN;

-- A later logistics refresh can choose the loss path even though the unique
-- matching TMS ticket has already completed an intercept or return. Requeue
-- only when the saved row proves the full shipment identity and a positive
-- terminal courier result. The Worker will re-read the live row before reuse.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason,
    work_order.payload->'tmsDuplicateCheck' AS previous_duplicate_check,
    work_order.payload->'tmsFormDecision' AS previous_form_decision
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND work_order.current_step = 'manual-review-blocked'
    AND instance.current_step = 'manual-review-blocked'
    AND instance.identity_status = 'verified'
    AND instance.platform_case_key IS NOT NULL
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.payload#>>'{manualReview,stage}' = 'tms-ticket-recovery'
    AND coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) LIKE '%已有 TMS 工单的物流问题或客服备注与本次处理要求不一致%'
    AND work_order.payload#>>'{tmsDuplicateCheck,status}' = 'unrelated'
    AND (work_order.payload#>>'{tmsDuplicateCheck,candidateCount}')::integer = 1
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,expectedProblemType}' = '丢件'
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,actualProblemType}' =
      work_order.payload#>>'{tmsDuplicateCheck,identity,values,物流问题}'
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,actualTaskStatus}' =
      work_order.payload#>>'{tmsDuplicateCheck,identity,values,任务状态}'
    AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,actualCourierReplyResult}' =
      work_order.payload#>>'{tmsDuplicateCheck,identity,values,快递回复结果}'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,交易号}' =
      work_order.external_order_number
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,店铺名称}' IN (
      shop.expected_shop_name,
      '拼多多-' || shop.expected_shop_name
    )
    AND nullif(btrim(work_order.payload#>>'{tmsDuplicateCheck,identity,values,工单号}'), '')
      IS NOT NULL
    AND coalesce(
      nullif(btrim(work_order.payload#>>'{tmsWorkOrder,ticketNo}'), ''),
      work_order.payload#>>'{tmsDuplicateCheck,identity,values,工单号}'
    ) = work_order.payload#>>'{tmsDuplicateCheck,identity,values,工单号}'
    AND btrim(work_order.payload#>>'{tmsDuplicateCheck,identity,values,订单号}') =
      btrim(coalesce(
        nullif(work_order.payload#>>'{tmsAutofillVerification,actual,orderNumber}', ''),
        (
          SELECT cell->>'text'
          FROM jsonb_array_elements(
            coalesce(work_order.payload->'omsGridCells', '[]'::jsonb)
          ) cell
          WHERE cell->>'colId' = 'salesOrderCode'
          LIMIT 1
        )
      ))
    AND nullif(btrim(work_order.payload#>>'{tmsDuplicateCheck,identity,values,订单号}'), '')
      IS NOT NULL
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{tmsDuplicateCheck,identity,values,运单号}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    ) = regexp_replace(
      lower(coalesce(work_order.payload#>>'{logisticsAnalysis,trackingNumber}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    )
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{logisticsAnalysis,trackingNumber}', '')),
      '[[:space:][:punct:]]+', '', 'g'
    ) <> ''
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{tmsDuplicateCheck,identity,values,发货仓库}', '')),
      '[[:space:][:punct:]（）]+', '', 'g'
    ) = regexp_replace(
      lower(coalesce(work_order.payload#>>'{omsAnalysis,shippingWarehouse}', '')),
      '[[:space:][:punct:]（）]+', '', 'g'
    )
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{omsAnalysis,shippingWarehouse}', '')),
      '[[:space:][:punct:]（）]+', '', 'g'
    ) <> ''
    AND (
      regexp_replace(
        lower(coalesce(work_order.payload#>>'{tmsDuplicateCheck,identity,values,责任快递}', '')),
        '(外部|[[:space:][:punct:]（）])+', '', 'g'
      ) LIKE '%' || regexp_replace(
        lower(coalesce(work_order.payload#>>'{logisticsAnalysis,carrier}', '')),
        '(外部|[[:space:][:punct:]（）])+', '', 'g'
      ) || '%'
      OR regexp_replace(
        lower(coalesce(work_order.payload#>>'{logisticsAnalysis,carrier}', '')),
        '(外部|[[:space:][:punct:]（）])+', '', 'g'
      ) LIKE '%' || regexp_replace(
        lower(coalesce(work_order.payload#>>'{tmsDuplicateCheck,identity,values,责任快递}', '')),
        '(外部|[[:space:][:punct:]（）])+', '', 'g'
      ) || '%'
    )
    AND regexp_replace(
      lower(coalesce(work_order.payload#>>'{logisticsAnalysis,carrier}', '')),
      '(外部|[[:space:][:punct:]（）])+', '', 'g'
    ) <> ''
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,物流问题}'
      IN ('拦截退回', '拒收')
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,客服备注}'
      ~ '(拦截|拒收|召回|退回|退件)'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,任务状态}' = '已完成'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,快递回复结果}'
      ~ '(已拦截|拦截成功|已在退回(的)?路上|已是退回件|已经退回|已退回|退回途中|正在退回|已拒收|拒收成功)'
    AND work_order.payload#>>'{tmsDuplicateCheck,identity,values,快递回复结果}'
      !~ '((拦截|召回|退回|拒收)(失败|未成功)|(未|无法)(拦截|召回|退回|拒收))'
    AND NOT EXISTS (
      SELECT 1
      FROM shops ambiguous_shop
      WHERE ambiguous_shop.enabled
        AND ambiguous_shop.id <> work_order.shop_id
        AND ambiguous_shop.expected_shop_name = binding.actual_shop_name
    )
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
        AND (
          effect.status = 'succeeded'
          OR (
            effect.status = 'failed'
            AND coalesce(effect.receipt->>'clickAttempted', 'unknown') <> 'false'
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'evidence-upload'
        AND effect.status IN ('failed', 'reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM manual_interventions intervention
      WHERE intervention.work_order_id = work_order.id
        AND intervention.status IN ('open', 'acknowledged')
        AND intervention.reason_code = 'image-upload-failed'
        AND intervention.ordinary_instance_id IS NOT DISTINCT FROM instance.id
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
    current_step = 'completed-return-tms-decision-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'completed-return-tms-decision-retry-ready',
        'completedReturnTmsDecisionRecovery196', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', 'recheck-unique-completed-return-before-reusing-tms-ticket',
          'previousReason', candidate.previous_reason,
          'previousDuplicateCheck', candidate.previous_duplicate_check,
          'previousFormDecision', candidate.previous_form_decision,
          'recoveredAt', now()
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
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'completed-return-tms-decision-retry-ready',
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
    recovered.previous_reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-196',
    'completed-return-tms-decision-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'strategy', 'recheck-unique-completed-return-before-reusing-tms-ticket',
      'finalPddSubmitStarted', false
    ),
    'migration-196:completed-return-tms-decision:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-196')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code <> 'image-upload-failed'
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now()
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('196_recover_completed_return_tms_decision_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
