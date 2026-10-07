BEGIN;

-- The live proactive-logistics two-level form has no evidence uploader. A
-- failed effect with zero file inputs and zero upload responses proves that no
-- external upload was dispatched, so the current instance can safely continue
-- after the evidence requirement became optional.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.manual_review_reason, work_order.payload->>'error', '') AS reason
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text
      = work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'proactive-logistics-service'
    AND work_order.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.recovery_state <> 'held'
    AND work_order.current_step IN ('flow-paused', 'manual-review-blocked')
    AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
      = '拼多多未找到凭证上传控件'
    AND work_order.payload#>>'{ordinaryScenarioDecision,reasonCode}' IN (
      'return-logistics-not-found-within-48-hours',
      'return-logistics-not-found-over-48-hours'
    )
    AND work_order.payload#>>'{ordinaryEvidenceUpload,status}' = 'failed'
    AND work_order.payload#>>'{ordinaryEvidenceUpload,error}' = '拼多多未找到凭证上传控件'
    AND coalesce(work_order.payload#>'{ordinaryEvidenceUpload,diagnostics,fileInputs}', '[]'::jsonb)
      = '[]'::jsonb
    AND coalesce(work_order.payload#>'{ordinaryEvidenceUpload,diagnostics,network}', '[]'::jsonb)
      = '[]'::jsonb
    AND work_order.payload#>>'{pddProactiveTwoLevelFormRecovery,strategy}'
      = 'required-two-level-radio-form'
    AND EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'evidence-upload'
        AND effect.status = 'failed'
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
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
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-proactive-optional-evidence-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = jsonb_set(
      jsonb_set(
        (coalesce(work_order.payload, '{}'::jsonb)
          - 'manualReview' - 'error' - 'ordinaryEvidenceUpload'
          - 'ordinaryEvidenceUploadRecovery')
          || jsonb_build_object(
            'step', 'pdd-proactive-optional-evidence-retry-ready',
            'pddProactiveOptionalEvidenceRecovery', jsonb_build_object(
              'previousReason', candidate.reason,
              'evidenceSource', 'pdd-return-logistics-screenshot',
              'strategy', 'absent-upload-control',
              'recoveredAt', now()
            )
          ),
        '{ordinaryScenarioExecution}',
        (coalesce(work_order.payload#>'{ordinaryScenarioExecution}', '{}'::jsonb)
          - 'evidenceUpload')
          || jsonb_build_object('pddEvidenceUploadFailed', false),
        true
      ),
      '{ordinaryScenarioDecision,evidence,required}',
      '[{"source":"pdd-return-logistics-screenshot","required":false}]'::jsonb,
      true
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
    current_step = 'pdd-proactive-optional-evidence-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id, recovered.shop_id, recovered.external_order_number,
    recovered.current_ordinary_instance_id, recovered.reason
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
    'migration-158', 'pdd-proactive-absent-evidence-control-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.reason,
      'evidenceSource', 'pdd-return-logistics-screenshot',
      'strategy', 'absent-upload-control'
    ),
    'migration-158:pdd-proactive-absent-evidence-control:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-158')
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
VALUES ('158_recover_absent_proactive_evidence_control_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
