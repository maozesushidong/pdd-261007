BEGIN;

-- Consumer-negotiation follow-ups use the same durable timer as logistics
-- retries, but they are waiting for a consumer response rather than new
-- logistics data. Reclassify only proven 12-hour follow-ups and preserve the
-- original retry deadline and every external-effect guard.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.next_attempt_at,
    work_order.payload #>> '{logisticsWait,reason}' AS wait_reason,
    work_order.payload #>> '{pddResolutionSubmission,consumerResponseWaitStartedAt}'
      AS wait_started_at,
    coalesce(
      nullif(work_order.payload
        #>> '{pddResolutionSubmission,consumerResponseNextAttemptAt}', ''),
      nullif(work_order.payload #>> '{logisticsWait,retryAfterAt}', ''),
      work_order.next_attempt_at::text
    ) AS wait_until
  FROM work_orders work_order
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'in-transit-refund'
    AND work_order.status = 'retry-ready'
    AND coalesce(work_order.runtime_status, work_order.status)
      IN ('retry-ready', 'waiting')
    AND work_order.current_step = 'logistics-waiting-released'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.payload->>'orderNumber' = work_order.external_order_number
    AND work_order.payload #>> '{pddResolutionFlow,flowCode}'
      = 'consumer-negotiation-followup'
    AND work_order.payload #>> '{pddResolutionSubmission,status}'
      IN ('followup-waiting', 'followup-ready')
    AND work_order.payload #>> '{pddResolutionSubmission,interceptProgressOutcome}'
      = '快递还在拦截中'
    AND nullif(work_order.payload
      #>> '{pddResolutionSubmission,consumerResponseWaitStartedAt}', '') IS NOT NULL
    AND coalesce(work_order.payload #>> '{logisticsWait,reason}', '')
      = '拼多多正在等待消费者确认拦截后退款方案，满 12 小时仍无回复后再自动处理'
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), reclassified AS (
  UPDATE work_orders work_order
  SET current_step = 'consumer-response-waiting-released',
    payload = coalesce(work_order.payload, '{}'::jsonb) || jsonb_build_object(
      'step', 'consumer-response-waiting-released',
      'logisticsWait',
        coalesce(work_order.payload->'logisticsWait', '{}'::jsonb)
          || jsonb_build_object('waitKind', 'consumer-response'),
      'consumerResponseWait', jsonb_build_object(
        'status', 'waiting',
        'reason', candidate.wait_reason,
        'startedAt', candidate.wait_started_at,
        'nextAttemptAt', candidate.wait_until,
        'timerPreserved', true,
        'reclassifiedAt', now()
      ),
      'consumerResponseWaitReclassification228', jsonb_build_object(
        'previousStep', 'logistics-waiting-released',
        'currentStep', 'consumer-response-waiting-released',
        'nextAttemptAtPreserved', true,
        'externalActionsReplayed', false,
        'reclassifiedAt', now()
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
    candidate.next_attempt_at,
    candidate.wait_reason,
    candidate.wait_started_at,
    candidate.wait_until
), reclassified_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET current_step = 'consumer-response-waiting-released',
    payload = reclassified.payload,
    updated_at = now()
  FROM reclassified
  WHERE instance.id = reclassified.current_ordinary_instance_id
    AND instance.work_order_id = reclassified.id
    AND instance.shop_id = reclassified.shop_id
  RETURNING
    reclassified.id,
    reclassified.shop_id,
    reclassified.external_order_number,
    reclassified.current_ordinary_instance_id,
    reclassified.next_attempt_at,
    reclassified.wait_reason,
    reclassified.wait_started_at,
    reclassified.wait_until
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT
  reclassified.shop_id,
  reclassified.id,
  reclassified.current_ordinary_instance_id,
  'migration-228',
  'consumer-response-wait-reclassified',
  jsonb_build_object(
    'orderNumber', reclassified.external_order_number,
    'previousStep', 'logistics-waiting-released',
    'currentStep', 'consumer-response-waiting-released',
    'reason', reclassified.wait_reason,
    'startedAt', reclassified.wait_started_at,
    'nextAttemptAt', reclassified.wait_until,
    'databaseNextAttemptAt', reclassified.next_attempt_at,
    'timerPreserved', true,
    'externalActionsReplayed', false
  ),
  'migration-228:consumer-response-wait:' || reclassified.id::text
FROM reclassified_instances reclassified
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('228_reclassify_consumer_response_waits.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
