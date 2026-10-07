BEGIN;

WITH applied_evidence AS MATERIALIZED (
  SELECT DISTINCT ON (audit.work_order_id)
    audit.work_order_id,
    audit.payload AS observation
  FROM audit_events audit
  WHERE audit.event_type = 'external-state-reconciled'
    AND audit.payload->'pageState'->>'completedOutcome' = '快递还在拦截中'
    AND audit.payload->'pageState'->>'isPending' = 'true'
    AND audit.payload->'pageState'->>'orderMatches' = 'true'
    AND audit.payload->'pageState'->>'bodyText' LIKE '%请填写和消费者协商处理结果%'
  ORDER BY audit.work_order_id, audit.created_at DESC
), first_stage_effects AS MATERIALIZED (
  SELECT DISTINCT ON (effect.work_order_id)
    effect.work_order_id,
    coalesce(
      effect.receipt->>'completedAt',
      effect.reserved_at::text
    ) AS completed_at
  FROM external_effects effect
  WHERE effect.effect_type = 'pdd-submit'
    AND effect.status = 'succeeded'
    AND effect.idempotency_key LIKE '%:resolution'
    AND effect.receipt->'result'->>'completedOutcome' = '快递还在拦截中'
    AND effect.receipt->'result'->>'isPending' = 'true'
  ORDER BY effect.work_order_id, effect.updated_at DESC
), candidates AS MATERIALIZED (
  SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
      AS previous_submission,
    applied_evidence.observation AS applied_observation,
    first_stage_effects.completed_at AS first_stage_completed_at
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  LEFT JOIN applied_evidence ON applied_evidence.work_order_id = work_order.id
  LEFT JOIN first_stage_effects ON first_stage_effects.work_order_id = work_order.id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code <> 'return-refund'
    AND work_order.status IN ('paused', 'retry-ready')
    AND work_order.completion_state <> 'confirmed'
    AND work_order.recovery_state <> 'held'
    AND (
      (
        coalesce(
          work_order.payload->'pddResolutionSubmission'->>'flowCode',
          work_order.payload->'pddResolutionFlow'->>'flowCode'
        ) IN ('intercept-progress', 'consumer-negotiation-followup')
        AND work_order.payload->'pddResolutionSubmission'->>'outcome' = '快递还在拦截中'
        AND work_order.payload->'pddResolutionSubmission'->>'status' IN (
          'submitting', 'manual-review-blocked', 'retry-authorized', 'followup-waiting'
        )
      )
      OR (
        work_order.current_step = 'logistics-waiting-released'
        AND applied_evidence.work_order_id IS NOT NULL
        AND first_stage_effects.work_order_id IS NOT NULL
      )
      OR (
        coalesce(work_order.payload, '{}'::jsonb) ? 'consumerNegotiationFollowupRecovery'
        AND work_order.payload->'pddResolutionSubmission'->>'orderNumber' IS NULL
        AND applied_evidence.work_order_id IS NOT NULL
        AND first_stage_effects.work_order_id IS NOT NULL
      )
    )
    AND (
      NOT (coalesce(work_order.payload, '{}'::jsonb) ? 'consumerNegotiationFollowupRecovery')
      OR work_order.payload->'pddResolutionSubmission'->>'orderNumber' IS NULL
    )
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND (
      applied_evidence.work_order_id IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.effect_type = 'pdd-submit'
          AND effect.status = 'succeeded'
          AND effect.receipt->'result'->>'completedOutcome' = '快递还在拦截中'
          AND effect.receipt->'result'->>'isPending' = 'true'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), corrected_effects AS (
  UPDATE external_effects effect
  SET status = 'succeeded',
    receipt = coalesce(effect.receipt, '{}'::jsonb) || jsonb_build_object(
      'result', jsonb_build_object(
        'completedOutcome', '快递还在拦截中',
        'isPending', true,
        'followupRequired', true,
        'confirmationMethod', 'service-progress-and-consumer-negotiation-rendered'
      ),
      'completedAt', coalesce(
        candidate.previous_submission->>'lastClickAttemptedAt',
        candidate.previous_submission->>'startedAt',
        now()::text
      ),
      'readOnlyReconciliation', candidate.applied_observation
    ),
    error = NULL,
    updated_at = now()
  FROM candidates candidate
  WHERE effect.work_order_id = candidate.id
    AND effect.ordinary_instance_id IS NOT DISTINCT FROM candidate.current_ordinary_instance_id
    AND effect.effect_type = 'pdd-submit'
    AND effect.status = 'failed'
    AND effect.idempotency_key LIKE '%:resolution'
    AND candidate.applied_observation IS NOT NULL
  RETURNING effect.id
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'pdd-consumer-negotiation-followup-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb)
        - 'manualReview' - 'error' - 'pddResolutionRecovery'
        - 'externalStateReconciliation' - 'pddResolutionFlow')
      || jsonb_build_object(
        'step', 'pdd-consumer-negotiation-followup-retry-ready',
        'updatedAt', now(),
        'pddResolutionFlow', jsonb_build_object(
          'flowCode', 'consumer-negotiation-followup',
          'detectedAt', now(),
          'primaryOutcome', NULL,
          'secondaryReason', NULL,
          'tertiaryOutcome', NULL,
          'interceptProgressOutcome', '快递还在拦截中',
          'consumerNegotiationOutcome', NULL
        ),
        'pddResolutionSubmission', candidate.previous_submission
          || jsonb_build_object(
            'shopId', candidate.shop_id,
            'orderNumber', candidate.external_order_number,
            'status', 'followup-waiting',
            'outcome', '快递还在拦截中',
            'flowCode', 'intercept-progress',
            'interceptProgressOutcome', '快递还在拦截中',
            'interceptProgressSubmittedAt', coalesce(
              candidate.previous_submission->>'lastClickAttemptedAt',
              candidate.previous_submission->>'startedAt',
              candidate.first_stage_completed_at,
              now()::text
            ),
            'consumerResponseWaitStartedAt', coalesce(
              candidate.previous_submission->>'lastClickAttemptedAt',
              candidate.previous_submission->>'startedAt',
              candidate.first_stage_completed_at,
              now()::text
            )
          ),
        'consumerNegotiationFollowupRecovery', jsonb_build_object(
          'strategy', 'preserve-confirmed-intercept-progress-and-wait-for-consumer',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id, work_order.shop_id, work_order.external_order_number,
    work_order.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT recovered.shop_id, recovered.id, recovered.current_ordinary_instance_id,
  'migration-105', 'consumer-negotiation-followup-recovered',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'strategy', 'preserve-confirmed-intercept-progress-and-wait-for-consumer'
  ),
  'migration-105:consumer-negotiation-followup:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE ordinary_work_order_instances instance
SET status = 'retry-ready',
  runtime_status = 'retry-ready',
  current_step = 'pdd-consumer-negotiation-followup-retry-ready',
  manual_review_reason = NULL,
  next_attempt_at = now(),
  payload = coalesce(work_order.payload, '{}'::jsonb),
  updated_at = now()
FROM work_orders work_order
WHERE instance.id = work_order.current_ordinary_instance_id
  AND instance.work_order_id = work_order.id
  AND work_order.current_step = 'pdd-consumer-negotiation-followup-retry-ready'
  AND work_order.payload ? 'consumerNegotiationFollowupRecovery';

COMMIT;
