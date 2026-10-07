BEGIN;

-- Follow migration 220 for rows whose canonical detail URL lives only on the
-- ordinary instance or whose PDD render-wait stage label was previously not
-- enumerated. The same identity, effect, submit and live-lease guards apply.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    binding.binding_token,
    binding.actual_shop_name,
    binding.mall_id,
    coalesce(
      nullif(work_order.payload->>'detailUrl', ''),
      nullif(instance.detail_url, ''),
      nullif(instance.payload->>'detailUrl', '')
    ) AS previous_detail_url,
    binding.binding_token::text IS DISTINCT FROM
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
      AS binding_changed,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason,
    CASE
      WHEN coalesce(work_order.payload#>>'{transientWorkflowRecovery,count}', '')
        ~ '^[0-9]+$'
      THEN (work_order.payload#>>'{transientWorkflowRecovery,count}')::integer
      ELSE 0
    END AS previous_transient_count,
    CASE
      WHEN coalesce(work_order.payload#>>'{safePddDetailRecovery,attempts}', '')
        ~ '^[0-9]+$'
      THEN (work_order.payload#>>'{safePddDetailRecovery,attempts}')::integer
      ELSE 0
    END AS previous_safe_attempts
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.actual_shop_name = shop.expected_shop_name
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.current_step IN ('flow-paused', 'manual-review-blocked')
    AND CASE
      WHEN coalesce(work_order.payload#>>'{safePddDetailRecovery,attempts}', '')
        ~ '^[0-9]+$'
      THEN (work_order.payload#>>'{safePddDetailRecovery,attempts}')::integer
      ELSE 0
    END < 3
    AND (
      binding.binding_token::text =
        work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
      OR (
        instance.identity_status = 'verified'
        AND instance.platform_case_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM shops ambiguous_shop
          WHERE ambiguous_shop.enabled
            AND ambiguous_shop.id <> work_order.shop_id
            AND ambiguous_shop.expected_shop_name = binding.actual_shop_name
        )
        AND (
          binding.mall_id = coalesce(
            nullif(work_order.payload->>'pddMallId', ''),
            nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
            nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
            nullif(instance.payload->>'pddMallId', ''),
            nullif(instance.payload#>>'{latestDiscovery,pddMallId}', ''),
            nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
          )
          OR (
            coalesce(
              nullif(work_order.payload->>'pddMallId', ''),
              nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
              nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
              nullif(instance.payload->>'pddMallId', ''),
              nullif(instance.payload#>>'{latestDiscovery,pddMallId}', ''),
              nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
            ) IS NULL
            AND binding.actual_shop_name = ANY(ARRAY[
              nullif(work_order.payload->>'shopNameSnapshot', ''),
              nullif(work_order.payload->>'detectedShopName', ''),
              nullif(work_order.payload#>>'{latestDiscovery,actualShopName}', ''),
              nullif(work_order.payload#>>'{pddShopIdentity,actualShopName}', ''),
              nullif(instance.payload->>'shopNameSnapshot', ''),
              nullif(instance.payload->>'detectedShopName', ''),
              nullif(instance.payload#>>'{latestDiscovery,actualShopName}', ''),
              nullif(instance.payload#>>'{pddShopIdentity,actualShopName}', '')
            ])
          )
        )
      )
    )
    AND (
      coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~ (
        '^(PDD_DETAIL_TEMPORARILY_UNAVAILABLE:|未找到目标待处理工单（已等待 [0-9]+ 秒）:|'
        || '拼多多[^\r\n]*刷新后等待 [0-9]+ 毫秒仍未出现有效结果$|'
        || '目标工单不在待处理列表，且已验证详情无法确认订单号:)'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ '^page[.](waitForURL|goto|reload): Timeout [0-9]+ms exceeded'
        AND coalesce(
          nullif(work_order.payload->>'detailUrl', ''),
          nullif(instance.detail_url, ''),
          nullif(instance.payload->>'detailUrl', ''),
          ''
        ) ~
          '^https://mms[.]pinduoduo[.]com/aftersales/work_order/tododetail/?[?]id=[0-9]+'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
        AND effect.effect_type = 'pdd-submit'
        AND effect.status = 'succeeded'
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
    current_step = 'ordinary-detail-fresh-query-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_strip_nulls(jsonb_build_object(
        'pddIdentityBindingToken', candidate.binding_token,
        'pddMallId', candidate.mall_id,
        'detectedShopName', candidate.actual_shop_name,
        'shopNameSnapshot', candidate.actual_shop_name
      ))
      || jsonb_build_object(
        'step', 'ordinary-detail-fresh-query-retry-ready',
        'latestDiscovery', coalesce(work_order.payload->'latestDiscovery', '{}'::jsonb)
          || jsonb_strip_nulls(jsonb_build_object(
            'shopId', candidate.shop_id,
            'actualShopName', candidate.actual_shop_name,
            'pddMallId', candidate.mall_id,
            'pddIdentityBindingToken', candidate.binding_token,
            'identityBackfilledAt', now()
          )),
        'transientWorkflowRecovery', jsonb_build_object(
          'count', 0,
          'maxAttempts', 5,
          'lastReason', candidate.previous_reason,
          'retryAt', now(),
          'recoveredAt', now(),
          'recoverySource', 'migration-221',
          'previousCount', candidate.previous_transient_count
        ),
        'pddStaleDetailRecovery', jsonb_build_object(
          'status', 'retry-ready',
          'strategy', 'fresh-exact-order-query',
          'previousDetailUrl', candidate.previous_detail_url,
          'previousReason', candidate.previous_reason,
          'bindingRebound', candidate.binding_changed,
          'recoveredAt', now()
        ),
        'safePddDetailRecovery', jsonb_build_object(
          'attempts', candidate.previous_safe_attempts + 1,
          'maxAttempts', 3,
          'previousReason', candidate.previous_reason,
          'strategy', 'fresh-exact-order-query',
          'recoveredAt', now()
        ),
        'ordinarySparsePddDetailRecovery221', jsonb_build_object(
          'status', 'retry-ready',
          'bindingRebound', candidate.binding_changed,
          'previousReason', candidate.previous_reason,
          'previousTransientCount', candidate.previous_transient_count,
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
    candidate.previous_reason,
    candidate.binding_changed,
    candidate.previous_transient_count
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-detail-fresh-query-retry-ready',
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
    'migration-221',
    'ordinary-safe-pdd-detail-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'bindingRebound', recovered.binding_changed,
      'previousTransientCount', recovered.previous_transient_count,
      'strategy', 'fresh-exact-order-query'
    ),
    'migration-221:sparse-pdd-detail:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-221')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code = 'external-system-error'
    AND intervention.reason ~ (
      '^(PDD_DETAIL_TEMPORARILY_UNAVAILABLE:|未找到目标待处理工单（已等待 [0-9]+ 秒）:|'
      || '拼多多[^\r\n]*刷新后等待 [0-9]+ 毫秒仍未出现有效结果$|'
      || '目标工单不在待处理列表，且已验证详情无法确认订单号:|'
      || 'page[.](waitForURL|goto|reload): Timeout [0-9]+ms exceeded)'
    )
    AND (
      intervention.ordinary_instance_id IS NULL
      OR intervention.ordinary_instance_id = recovered.current_ordinary_instance_id
    )
  RETURNING intervention.id
)
UPDATE notification_outbox outbox
SET status = 'cancelled',
  updated_at = now(),
  last_error = jsonb_build_object(
    'reason', 'automatic-safe-pdd-detail-recovery-221'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('221_recover_sparse_pdd_detail_and_render_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
