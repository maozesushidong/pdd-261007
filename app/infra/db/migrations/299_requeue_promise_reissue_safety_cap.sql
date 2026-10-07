\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:requeue-promise-reissue-safety-cap-299')
);

WITH eligible AS MATERIALIZED (
  SELECT w.id, w.shop_id, w.current_ordinary_instance_id,
    w.external_order_number, w.manual_review_reason
  FROM work_orders w
  JOIN ordinary_work_order_instances i
    ON i.id = w.current_ordinary_instance_id
   AND i.work_order_id = w.id
   AND i.shop_id = w.shop_id
   AND i.scenario_code = 'promise-reissue'
   AND i.status = 'paused'
   AND i.runtime_status = 'paused'
   AND i.current_step = 'flow-paused'
  WHERE w.scenario_code = 'promise-reissue'
    AND w.status = 'paused'
    AND w.runtime_status = 'paused'
    AND w.current_step = 'flow-paused'
    AND w.recovery_state = 'ready'
    AND w.manual_review_reason LIKE '普通工单场景在单次会话内超过安全推进次数:%'
    AND coalesce(w.completion_state, 'pending') = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM external_effects e
      WHERE e.work_order_id = w.id
        AND e.ordinary_instance_id IS NOT DISTINCT FROM i.id
        AND e.status IN ('reserved', 'unknown', 'succeeded')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.shop_id = w.shop_id
        AND runtime.current_work_order_id = w.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF w, i
), resumed AS (
  UPDATE work_orders w
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'promise-reissue-oms-wait-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(w.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = coalesce(w.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
      || jsonb_build_object(
        'promiseReissueSafetyCapRecovery', jsonb_build_object(
          'source', 'migration-299',
          'externalActionsReplayed', false,
          'resumedAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM eligible
  WHERE w.id = eligible.id
  RETURNING w.id, w.shop_id, w.current_ordinary_instance_id,
    w.external_order_number, w.payload
), resumed_instances AS (
  UPDATE ordinary_work_order_instances i
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'promise-reissue-oms-wait-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = resumed.payload,
    updated_at = now()
  FROM resumed
  WHERE i.id = resumed.current_ordinary_instance_id
    AND i.work_order_id = resumed.id
    AND i.shop_id = resumed.shop_id
  RETURNING resumed.id, resumed.shop_id, resumed.external_order_number,
    resumed.current_ordinary_instance_id
)
INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
   deduplication_key)
SELECT shop_id, id, current_ordinary_instance_id, 'system',
  'promise-reissue-safety-cap-resumed',
  jsonb_build_object(
    'orderNumber', external_order_number,
    'reason', 'oms-not-found-is-wait-condition',
    'externalActionsReplayed', false,
    'resumedAt', now()
  ),
  'promise-reissue-safety-cap-resumed:' || id::text
FROM resumed_instances
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('299_requeue_promise_reissue_safety_cap.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
