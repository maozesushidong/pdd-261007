BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'delivery-risk-concern'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
      'OMS 补发页面未找到“快递责任补发”对应字段%'
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
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
        AND effect.effect_type IN ('oms-reissue-create', 'pdd-submit')
        AND effect.status IN ('succeeded', 'unknown', 'reserved')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-reissue-reason-label-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview' - 'error' - 'logisticsWait')
      || jsonb_build_object(
        'step', 'oms-reissue-reason-label-retry-ready',
        'omsReissueReasonLabelRecovery152', jsonb_build_object(
          'previousReason', candidate.reason,
          'strategy', 'recognize-live-reissue-reason-field-and-reuse-tms-effect',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, candidate.reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'oms-reissue-reason-label-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-152', 'oms-reissue-reason-label-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.reason,
      'preserveSucceededTmsEffect', true
    ),
    'migration-152:oms-reissue-reason:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-152')
FROM recovered
WHERE intervention.work_order_id = recovered.id
  AND intervention.status IN ('open', 'acknowledged')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
  );

WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason,
    coalesce(
      work_order.payload#>>'{pddResolutionSubmission,outcome}',
      work_order.payload#>>'{ordinaryScenarioDecision,pdd,option}',
      '物流已更新'
    ) AS rejected_option,
    coalesce(
      work_order.payload#>>'{pddResolutionSubmission,effectStage}',
      'ordinary-delivery-risk-concern-logistics-updated-within-24-hours'
    ) AS rejected_effect_stage,
    work_order.payload#>>'{ordinaryScenarioDecision,evidence,logistics,latestLogisticsAt}'
      AS rejected_latest_logistics_at,
    effect.receipt AS rejection_receipt,
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
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') LIKE
      '拼多多提交被平台拒绝%物流轨迹未更新，请如实填写%'
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown', 'reserved')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
), prepared AS (
  SELECT candidate.*,
    jsonb_build_object(
      'errorCode', 190001,
      'errorMessage', '物流轨迹未更新，请如实填写',
      'option', candidate.rejected_option,
      'effectStage', candidate.rejected_effect_stage,
      'latestLogisticsAt', candidate.rejected_latest_logistics_at,
      'responseCaptured', coalesce(
        (candidate.rejection_receipt->>'responseCaptured')::boolean, false
      ),
      'rejectedAt', candidate.rejected_at
    ) AS rejection
  FROM candidates candidate
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-logistics-update-rejected-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = jsonb_set(
      ((coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'logisticsWait')
        || jsonb_build_object(
          'step', 'pdd-logistics-update-rejected-retry-ready',
          'platformLogisticsUpdateRejection', prepared.rejection,
          'pddLogisticsUpdateRejectionRecovery152', jsonb_build_object(
            'previousReason', prepared.reason,
            'strategy', 'reevaluate-as-carrier-reminder-after-definitive-rejection',
            'recoveredAt', now()
          )
        )),
      '{ordinaryScenarioExecution}',
      coalesce(work_order.payload->'ordinaryScenarioExecution', '{}'::jsonb)
        || jsonb_build_object('platformLogisticsUpdateRejection', prepared.rejection),
      true
    ),
    updated_at = now()
  FROM prepared
  WHERE work_order.id = prepared.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id, prepared.reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-logistics-update-rejected-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-152', 'pdd-logistics-update-rejection-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.reason,
      'failedSubmitPreserved', true,
      'nextStrategy', 'oms-warehouse-and-tms-reminder'
    ),
    'migration-152:pdd-logistics-update-rejection:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
)
UPDATE manual_interventions intervention
SET status = 'resolved',
  resolved_at = coalesce(intervention.resolved_at, now()),
  resolved_by = coalesce(intervention.resolved_by, 'migration-152')
FROM recovered
WHERE intervention.work_order_id = recovered.id
  AND intervention.status IN ('open', 'acknowledged')
  AND (
    intervention.ordinary_instance_id IS NULL
    OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
  );

UPDATE notification_outbox outbox
SET status = 'cancelled', updated_at = now()
FROM manual_interventions intervention
WHERE outbox.intervention_id = intervention.id
  AND intervention.resolved_by = 'migration-152'
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('152_recover_oms_reissue_reason_and_pdd_190001.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
