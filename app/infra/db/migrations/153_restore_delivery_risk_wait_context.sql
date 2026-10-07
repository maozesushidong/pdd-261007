BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(
      work_order.payload->>'platformCaseKey',
      'pdd-work-order:' || coalesce(work_order.payload->>'platformWorkOrderId', '')
    ) AS platform_case_key,
    effect.receipt,
    effect.updated_at AS rejected_at
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN LATERAL (
    SELECT failed_effect.receipt, failed_effect.updated_at
    FROM external_effects failed_effect
    WHERE failed_effect.work_order_id = work_order.id
      AND failed_effect.effect_type = 'pdd-submit'
      AND failed_effect.status = 'failed'
      AND failed_effect.receipt->>'errorCode' = '190001'
      AND failed_effect.receipt->>'errorMsg' = '物流轨迹未更新，请如实填写'
      AND (
        failed_effect.ordinary_instance_id IS NULL
        OR failed_effect.ordinary_instance_id = instance.id
      )
    ORDER BY failed_effect.updated_at DESC
    LIMIT 1
  ) effect ON true
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND work_order.status = 'retry-ready'
    AND work_order.runtime_status = 'retry-ready'
    AND work_order.current_step = 'logistics-waiting-released'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.payload#>'{ordinaryScenarioExecution,platformLogisticsUpdateRejection}' IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects unsafe_effect
      WHERE unsafe_effect.work_order_id = work_order.id
        AND unsafe_effect.effect_type = 'pdd-submit'
        AND unsafe_effect.status IN ('succeeded', 'unknown', 'reserved')
        AND (
          unsafe_effect.ordinary_instance_id IS NULL
          OR unsafe_effect.ordinary_instance_id = instance.id
        )
    )
), prepared AS (
  SELECT candidate.*,
    jsonb_build_object(
      'errorCode', 190001,
      'errorMessage', '物流轨迹未更新，请如实填写',
      'option', '物流已更新',
      'effectStage', 'ordinary-delivery-risk-concern-logistics-updated-within-24-hours',
      'latestLogisticsAt', NULL,
      'responseCaptured', coalesce((candidate.receipt->>'responseCaptured')::boolean, false),
      'rejectedAt', candidate.rejected_at
    ) AS rejection
  FROM candidates candidate
), recovered AS (
  UPDATE work_orders work_order
  SET payload = jsonb_set(
      coalesce(work_order.payload, '{}'::jsonb)
        || jsonb_build_object(
          'platformLogisticsUpdateRejection', prepared.rejection,
          'deliveryRiskWaitContextRecovery153', jsonb_build_object(
            'strategy', 'restore-order-scoped-execution-context-without-changing-wait',
            'recoveredAt', now()
          )
        ),
      '{ordinaryScenarioExecution}',
      jsonb_build_object(
        'shopId', prepared.shop_id,
        'orderNumber', prepared.external_order_number,
        'scenarioCode', 'delivery-risk-concern',
        'platformCaseKey', nullif(prepared.platform_case_key, 'pdd-work-order:'),
        'platformLogisticsUpdateRejection', prepared.rejection,
        'updatedAt', now()
      ),
      true
    ),
    updated_at = now()
  FROM prepared
  WHERE work_order.id = prepared.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.*
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-153', 'delivery-risk-wait-context-restored',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'waitSchedulePreserved', true,
    'failedSubmitPreserved', true
  ),
  'migration-153:delivery-risk-wait-context:' || recovered.id::text
FROM recovered_instances recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('153_restore_delivery_risk_wait_context.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
