\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-verified-proactive-frame-submit-pauses-291')
);

-- These exact proactive-logistics instances completed their primary and
-- result stages. The legacy final click targeted a main-document button while
-- the selected option lived in a child frame. Six exact pending-list reads per
-- order prove that click was not applied. Retire only those three unknown
-- effects and authorize one same-frame final-submit retry with a new key.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  unknown_effect_id,
  original_effect_stage
) AS (
  VALUES
    (
      '9b9a4137-a667-431c-8c35-069e3969b25c'::uuid,
      'shop-mse1sff3-b85aa4'::text,
      '260817-532886393133616'::text,
      '9a0daa0d-4cc9-4755-82d7-93f59f548279'::uuid,
      '500013069897892'::text,
      '8ff8abeb-f028-48e5-82d1-e4606c485b33'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics'::text
    ),
    (
      'fb369b64-2051-4c1d-afea-a6ec17afc1d1'::uuid,
      'shop-mse1sff3-b85aa4'::text,
      '260819-136629481001925'::text,
      '953712bf-8053-4e81-a1a2-12f78bea0fa8'::uuid,
      '500013069701652'::text,
      '69188b2a-5bf7-49ce-960b-bcdd457c9750'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics'::text
    ),
    (
      '39af0caa-f355-4246-9706-a8d234c75ad1'::uuid,
      'shop-mt9va8ol-47962e'::text,
      '260820-132561058141738'::text,
      '161bf046-4eed-4e9a-8972-fc0d40b4f677'::uuid,
      '500013070052566'::text,
      'a48ba8e5-8afd-4e48-b226-0d87f8cbf402'::uuid,
      'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics'::text
    )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    binding.binding_token,
    binding.mall_id,
    binding.actual_shop_name,
    binding.binding_token::text IS DISTINCT FROM coalesce(
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}',
      work_order.payload->>'pddIdentityBindingToken'
    ) AS binding_changed,
    work_order.manual_review_reason AS previous_reason,
    expected.platform_case_id,
    expected.unknown_effect_id,
    expected.original_effect_stage,
    expected.original_effect_stage || '-frame-submit-v3' AS retry_effect_stage,
    proof.proof_count
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = 'proactive-logistics-service'
    AND work_order.scenario_code <> 'product-shortage'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'external-state-unresolved'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = 'proactive-logistics-service'
    AND instance.scenario_code <> 'product-shortage'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'external-state-unresolved'
    AND instance.manual_review_reason = work_order.manual_review_reason
    AND instance.detail_url =
      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
        || expected.platform_case_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
    AND nullif(binding.binding_token::text, '') IS NOT NULL
    AND nullif(binding.mall_id, '') IS NOT NULL
    AND (
      binding.binding_token::text = coalesce(
        work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}',
        work_order.payload->>'pddIdentityBindingToken'
      )
      OR (
        binding.mall_id = coalesce(
          nullif(work_order.payload->>'pddMallId', ''),
          nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
          nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
          nullif(instance.payload->>'pddMallId', ''),
          nullif(instance.payload#>>'{latestDiscovery,pddMallId}', ''),
          nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM shops ambiguous_shop
          WHERE ambiguous_shop.enabled
            AND ambiguous_shop.id <> work_order.shop_id
            AND ambiguous_shop.expected_shop_name = binding.actual_shop_name
        )
      )
    )
  JOIN external_effects unknown_effect
    ON unknown_effect.id = expected.unknown_effect_id
    AND unknown_effect.work_order_id = work_order.id
    AND unknown_effect.ordinary_instance_id = instance.id
    AND unknown_effect.effect_type = 'pdd-submit'
    AND unknown_effect.status = 'unknown'
    AND unknown_effect.idempotency_key =
      'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
        || expected.platform_case_id || ':' || expected.original_effect_stage
    AND unknown_effect.receipt->>'clickAttempted' = 'true'
    AND unknown_effect.receipt->>'requestCaptured' = 'false'
    AND unknown_effect.receipt->>'responseCaptured' = 'false'
  JOIN LATERAL (
    SELECT count(*) AS proof_count
    FROM audit_events audit
    WHERE audit.work_order_id = work_order.id
      AND audit.ordinary_instance_id IS NOT DISTINCT FROM instance.id
      AND audit.event_type = 'external-state-reconciled'
      AND audit.payload->>'effectId' = expected.unknown_effect_id::text
      AND audit.payload#>>'{pageState,confirmedNotApplied}' = 'true'
      AND audit.payload#>>'{pageState,isPending}' = 'true'
      AND audit.payload#>>'{pageState,orderMatches}' = 'true'
      AND audit.payload#>>'{pageState,isExpectedWorkOrderType}' = 'true'
      AND audit.payload#>>'{pageState,confirmationMethod}' =
        'present-in-pending-list'
  ) proof ON proof.proof_count = 6
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.recovery_state = 'held'
    AND work_order.recovery_reason = 'external-state-still-uncertain'
    AND work_order.manual_review_reason IS NOT NULL
    AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
      expected.order_number
    AND work_order.payload#>>'{pddResolutionSubmission,scenarioCode}' =
      'proactive-logistics-service'
    AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'submitting'
    AND work_order.payload#>>'{pddResolutionSubmission,effectStage}' =
      expected.original_effect_stage
    AND work_order.payload#>>'{pddResolutionSubmission,submitAttemptCount}' = '2'
    AND nullif(
      work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}',
      ''
    ) IS NOT NULL
    AND work_order.payload#>>'{externalStateReconciliation,effectId}' =
      expected.unknown_effect_id::text
    AND work_order.payload#>>'{externalStateReconciliation,automaticRetryExhausted}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmedNotApplied}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,isPending}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,orderMatches}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,isExpectedWorkOrderType}' =
      'true'
    AND work_order.payload#>>'{externalStateReconciliation,pageState,confirmationMethod}' =
      'present-in-pending-list'
    AND EXISTS (
      SELECT 1
      FROM external_effects primary_effect
      WHERE primary_effect.work_order_id = work_order.id
        AND primary_effect.ordinary_instance_id = instance.id
        AND primary_effect.effect_type = 'pdd-submit'
        AND primary_effect.status = 'succeeded'
        AND primary_effect.idempotency_key =
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-proactive-logistics-service-return-logistics-not-found-within-48-hours:primary'
    )
    AND EXISTS (
      SELECT 1
      FROM external_effects result_effect
      WHERE result_effect.work_order_id = work_order.id
        AND result_effect.ordinary_instance_id = instance.id
        AND result_effect.effect_type = 'pdd-submit'
        AND result_effect.status = 'succeeded'
        AND result_effect.idempotency_key =
          'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
            || expected.platform_case_id
            || ':ordinary-proactive-logistics-service-return-logistics-not-found-within-48-hours:result'
        AND result_effect.receipt#>>'{result,submitReceipt,success}' = 'true'
        AND result_effect.receipt#>>'{result,submitReceipt,requestUrl}' =
          'https://mms.pinduoduo.com/latitude/mallTicket/submitForm'
    )
    AND 1 = (
      SELECT count(*)
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.status = 'unknown'
        AND effect.effect_type = 'pdd-submit'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.id <> expected.unknown_effect_id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.idempotency_key LIKE '%-frame-submit-v3'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance, unknown_effect
), corrected_effects AS (
  UPDATE external_effects effect
  SET status = 'failed',
    receipt = coalesce(effect.receipt, '{}'::jsonb) || jsonb_build_object(
      'correctedBy', 'migration-291',
      'confirmedNotApplied', true,
      'confirmationMethod', 'six-exact-pending-detail-observations',
      'unknownEffectRetried', false,
      'correctedAt', now()
    ),
    error = jsonb_build_object(
      'code', 'PDD_WRONG_DOCUMENT_SUBMIT_CONFIRMED_NOT_APPLIED',
      'message', '旧版未点击所选结果所在子框架的业务提交按钮',
      'confirmedNotApplied', true,
      'correctedBy', 'migration-291'
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE effect.id = candidate.unknown_effect_id
    AND effect.status = 'unknown'
  RETURNING candidate.*
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-frame-submit-retry-ready',
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
      - 'externalStateReconciliation'
      - 'externalStateReconciliationRetry'
      - 'externalStateReconciliationTarget'
    ) || jsonb_build_object(
      'step', 'ordinary-frame-submit-retry-ready',
      'pddIdentityBindingToken', corrected.binding_token,
      'pddMallId', corrected.mall_id,
      'detectedShopName', corrected.actual_shop_name,
      'shopNameSnapshot', corrected.actual_shop_name,
      'latestDiscovery',
        coalesce(work_order.payload->'latestDiscovery', '{}'::jsonb)
          || jsonb_build_object(
            'shopId', work_order.shop_id,
            'actualShopName', corrected.actual_shop_name,
            'pddMallId', corrected.mall_id,
            'pddIdentityBindingToken', corrected.binding_token,
            'identityBackfilledAt', now()
          ),
      'pddResolutionSubmission',
        coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
          - 'externalActionStartedAt'
          - 'lastClickAttemptedAt'
          - 'notAppliedAt'
          - 'notAppliedRetryAuthorizedAt'
          - 'confirmationMethod'
          || jsonb_build_object(
            'status', 'frame-submit-retry-authorized',
            'effectStage', corrected.retry_effect_stage,
            'submitAttemptCount', 2,
            'maximumAutomaticSubmitAttempts', 3,
            'frameSubmitRetryAuthorizedAt', now()
          ),
      'ordinaryPddFrameSubmitRecovery291', jsonb_build_object(
        'status', 'retry-authorized',
        'source', 'migration-291',
        'orderNumber', work_order.external_order_number,
        'platformCaseId', corrected.platform_case_id,
        'originalEffectId', corrected.unknown_effect_id,
        'originalEffectStage', corrected.original_effect_stage,
        'retryEffectStage', corrected.retry_effect_stage,
        'confirmedNotApplied', true,
        'proofCount', corrected.proof_count,
        'bindingRebound', corrected.binding_changed,
        'successfulPriorEffectsPreserved', true,
        'unknownEffectRetried', false,
        'externalActionsReplayedByMigration', false,
        'strategy', 'select-and-submit-in-the-same-pdd-frame',
        'authorizedAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM corrected_effects corrected
  WHERE work_order.id = corrected.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    corrected.platform_case_id,
    corrected.unknown_effect_id,
    corrected.original_effect_stage,
    corrected.retry_effect_stage,
    corrected.proof_count,
    corrected.binding_changed,
    corrected.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-frame-submit-retry-ready',
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
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
     payload, deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-291',
    'verified-proactive-frame-submit-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'originalEffectId', recovered.unknown_effect_id,
      'originalEffectStage', recovered.original_effect_stage,
      'retryEffectStage', recovered.retry_effect_stage,
      'confirmedNotApplied', true,
      'proofCount', recovered.proof_count,
      'bindingRebound', recovered.binding_changed,
      'successfulPriorEffectsPreserved', true,
      'unknownEffectRetried', false,
      'externalActionsReplayedByMigration', false,
      'strategy', 'select-and-submit-in-the-same-pdd-frame'
    ),
    'migration-291:verified-proactive-frame-submit:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id,
    payload->>'orderNumber' AS order_number,
    payload->>'platformCaseId' AS platform_case_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-291')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason = recovered.previous_reason
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-verified-frame-submit-recovery-291'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number,
    'platformCaseId', platform_case_id
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('291_recover_verified_proactive_frame_submit_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
