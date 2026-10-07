BEGIN;

-- A deleted/recreated shop owner can leave non-terminal refund records frozen
-- under either an old shop id or a rebuilt binding token on the same shop id.
-- Restore only records whose saved PDD mall id or exact shop name resolves to
-- one unique, enabled current binding. Any ambiguous identity, duplicate
-- aftersale, live lease, or uncertain refund effect stays held.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id AS previous_shop_id,
    work_order.external_order_number,
    refund.aftersale_number,
    refund.action_state,
    target.shop_id AS target_shop_id,
    target.binding_token,
    target.mall_id,
    target.actual_shop_name,
    refund.evidence->>'pddIdentityBindingToken' AS previous_binding_token
  FROM work_orders work_order
  JOIN return_refunds refund
    ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  CROSS JOIN LATERAL (
    SELECT coalesce(
        nullif(refund.evidence->>'pddMallId', ''),
        nullif(work_order.payload->>'pddMallId', ''),
        nullif(work_order.payload#>>'{returnRefund,evidence,pddMallId}', '')
      ) AS observed_mall_id,
      coalesce(
        nullif(refund.evidence->>'detectedShopName', ''),
        nullif(refund.evidence->>'shopNameSnapshot', ''),
        nullif(refund.evidence->>'actualShopName', ''),
        nullif(work_order.payload->>'detectedShopName', ''),
        nullif(work_order.payload->>'shopNameSnapshot', '')
      ) AS observed_shop_name
  ) observed
  JOIN pdd_shop_runtime_bindings target
    ON (
      (observed.observed_mall_id IS NOT NULL
        AND target.mall_id = observed.observed_mall_id)
      OR (
        observed.observed_mall_id IS NULL
        AND observed.observed_shop_name IS NOT NULL
        AND target.actual_shop_name = observed.observed_shop_name
      )
    )
  JOIN shops target_shop
    ON target_shop.id = target.shop_id
    AND target_shop.enabled = true
    AND target_shop.onboarding_status = 'ready'
  WHERE work_order.scenario_code = 'return-refund'
    AND work_order.recovery_state = 'held'
    AND work_order.recovery_reason = 'owner-deleted'
    AND work_order.completion_state = 'pending'
    AND refund.action_state IN (
      'discovered',
      'waiting-logistics',
      'ready',
      'manual-review',
      'submitting',
      'verification-required',
      'page-error'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pdd_shop_runtime_bindings other_binding
      WHERE other_binding.shop_id <> target.shop_id
        AND (
          (observed.observed_mall_id IS NOT NULL
            AND other_binding.mall_id = observed.observed_mall_id)
          OR (
            observed.observed_mall_id IS NULL
            AND observed.observed_shop_name IS NOT NULL
            AND other_binding.actual_shop_name = observed.observed_shop_name
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND (
          effect.status IN ('reserved', 'unknown')
          OR (
            effect.effect_type = 'pdd-return-refund'
            AND effect.status = 'succeeded'
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM return_refunds other_refund
      JOIN work_orders other_work_order
        ON other_work_order.id = other_refund.work_order_id
      WHERE other_refund.work_order_id <> refund.work_order_id
        AND other_refund.aftersale_number = refund.aftersale_number
        AND other_work_order.shop_id = target.shop_id
    )
), moved_orders AS (
  UPDATE work_orders work_order
  SET shop_id = candidate.target_shop_id,
    status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'return-refund-identity-relocated-recheck-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    completion_state = 'pending',
    completion_confirmation_method = NULL,
    completion_confirmed_at = NULL,
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'pddIdentityBindingToken', candidate.binding_token,
        'pddMallId', candidate.mall_id,
        'detectedShopName', candidate.actual_shop_name,
        'shopNameSnapshot', candidate.actual_shop_name,
        'step', 'return-refund-identity-relocated-recheck-ready',
        'ownerDeletedReturnRefundRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'previousShopId', candidate.previous_shop_id,
          'targetShopId', candidate.target_shop_id,
          'actualShopName', candidate.actual_shop_name,
          'mallId', candidate.mall_id,
          'strategy', 'unique-current-pdd-identity-rebinding',
          'recoveredAt', now()
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id
), moved_refunds AS (
  UPDATE return_refunds refund
  SET shop_id = candidate.target_shop_id,
    evidence = coalesce(refund.evidence, '{}'::jsonb)
      || jsonb_build_object(
        'pddIdentityBindingToken', candidate.binding_token,
        'pddMallId', candidate.mall_id,
        'detectedShopName', candidate.actual_shop_name,
        'shopNameSnapshot', candidate.actual_shop_name,
        'identityBackfilledAt', now(),
        'ownerDeletedIdentityRecovered', true
      ),
    next_check_at = now(),
    updated_at = now()
  FROM candidates candidate
  JOIN moved_orders moved ON moved.id = candidate.id
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id
), moved_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET shop_id = candidate.target_shop_id,
    updated_at = now()
  FROM candidates candidate
  JOIN moved_refunds moved ON moved.work_order_id = candidate.id
  WHERE instance.work_order_id = candidate.id
  RETURNING instance.id
), cleared_stale_runtime AS (
  UPDATE shop_runtime_state runtime
  SET status = 'idle',
    current_work_order_id = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
  FROM candidates candidate
  JOIN moved_refunds moved ON moved.work_order_id = candidate.id
  WHERE runtime.current_work_order_id = candidate.id
    AND runtime.shop_id = candidate.previous_shop_id
    AND (runtime.lease_token IS NULL OR runtime.lease_expires_at <= now())
  RETURNING runtime.shop_id
), moved_external_effects AS (
  UPDATE external_effects item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_evidence_assets AS (
  UPDATE evidence_assets item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_verifications AS (
  UPDATE verification_locations item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_audits AS (
  UPDATE audit_events item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_events AS (
  UPDATE workflow_events item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_commands AS (
  UPDATE operator_commands item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), moved_interventions AS (
  UPDATE manual_interventions item SET shop_id = candidate.target_shop_id
  FROM candidates candidate WHERE item.work_order_id = candidate.id RETURNING item.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
  SELECT candidate.target_shop_id,
    candidate.id,
    'migration-164',
    'owner-deleted-return-refund-shop-restored',
    jsonb_build_object(
      'orderNumber', candidate.external_order_number,
      'aftersaleNumber', candidate.aftersale_number,
      'actionState', candidate.action_state,
      'previousShopId', candidate.previous_shop_id,
      'targetShopId', candidate.target_shop_id,
      'actualShopName', candidate.actual_shop_name,
      'mallId', candidate.mall_id,
      'previousBindingToken', candidate.previous_binding_token,
      'bindingToken', candidate.binding_token,
      'strategy', 'unique-current-pdd-identity-rebinding'
    ),
    'migration-164:owner-deleted-return-refund:' || candidate.id::text
  FROM candidates candidate
  JOIN moved_refunds moved ON moved.work_order_id = candidate.id
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING shop_id
)
UPDATE shop_schedule_state schedule
SET schedule_state = 'queued',
  queue_entered_at = now(),
  retry_at = NULL,
  next_refund_scan_at = least(schedule.next_refund_scan_at, now()),
  metadata = coalesce(schedule.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'ownerDeletedReturnRefundRecoveryQueuedAt', now(),
      'recoverySource', 'migration-164'
    ),
  updated_at = now(),
  version = version + 1
WHERE schedule.shop_id IN (SELECT DISTINCT audited.shop_id FROM audited);

INSERT INTO schema_migrations (version)
VALUES ('164_restore_owner_deleted_return_refund_identity.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
