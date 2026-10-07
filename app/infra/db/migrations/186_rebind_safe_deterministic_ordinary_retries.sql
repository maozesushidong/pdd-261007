BEGIN;

-- Deterministic read-only pauses can outlive the browser binding that first
-- discovered them. Rebind and retry only verified ordinary instances whose
-- current shop identity is proven by mall id or an unambiguous exact shop
-- name, and which have no uncertain or completed PDD submit effect.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    binding.binding_token,
    binding.actual_shop_name,
    binding.mall_id,
    coalesce(
      work_order.manual_review_reason,
      instance.manual_review_reason,
      work_order.payload->>'error',
      ''
    ) AS previous_reason,
    CASE
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%检测到人工验证，请在可视化浏览器中完成后重新运行流程%'
        THEN 'verification-recheck'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%拼多多发货城市范围判断缺失%'
        THEN 'in-transit-missing-city'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%拼多多%渲染刷新后等待 % 毫秒仍未出现有效结果%'
        THEN 'pdd-render-timeout'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~ 'locator[.]innerText: Timeout [0-9]+ms exceeded'
        THEN 'pdd-order-number-innertext-timeout'
      ELSE 'abnormal-network-carrier-fallback'
    END AS recovery_class
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
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND work_order.status = 'paused'
    AND instance.status = 'paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.current_step IN (
      'flow-paused',
      'manual-review-blocked',
      'human-verification-required'
    )
    AND instance.identity_status = 'verified'
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
    AND (
      coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%检测到人工验证，请在可视化浏览器中完成后重新运行流程%'
      OR (
        work_order.scenario_code = 'in-transit-refund'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%拼多多发货城市范围判断缺失%'
      )
      OR coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%拼多多%渲染刷新后等待 % 毫秒仍未出现有效结果%'
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ 'locator[.]innerText: Timeout [0-9]+ms exceeded'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ '订单编号|订单号'
      )
      OR (
        work_order.scenario_code = 'abnormal-network-warning'
        AND (
          coalesce(
            work_order.manual_review_reason,
            instance.manual_review_reason,
            work_order.payload->>'error',
            ''
          ) LIKE '%异常网点预警未找到平台建议快递%'
          OR coalesce(
            work_order.manual_review_reason,
            instance.manual_review_reason,
            work_order.payload->>'error',
            ''
          ) LIKE '%异常网点预警未找到唯一建议快递%'
          OR coalesce(
            work_order.manual_review_reason,
            instance.manual_review_reason,
            work_order.payload->>'error',
            ''
          ) LIKE 'OMS 发货快递没有平台建议选项%'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-submit'
        AND effect.status IN ('succeeded', 'unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-identity-rebound-retry-ready',
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
        'step', 'ordinary-identity-rebound-retry-ready',
        'latestDiscovery', coalesce(work_order.payload->'latestDiscovery', '{}'::jsonb)
          || jsonb_strip_nulls(jsonb_build_object(
            'shopId', candidate.shop_id,
            'actualShopName', candidate.actual_shop_name,
            'pddMallId', candidate.mall_id,
            'pddIdentityBindingToken', candidate.binding_token,
            'identityBackfilledAt', now()
          )),
        'ordinaryIdentityRebindRecovery186', jsonb_build_object(
          'status', 'retry-ready',
          'recoveryClass', candidate.recovery_class,
          'previousReason', candidate.previous_reason,
          'reboundAt', now(),
          'recoverySource', 'migration-186'
        )
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.previous_reason,
    candidate.recovery_class
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-identity-rebound-retry-ready',
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
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-186',
    'safe-deterministic-ordinary-identity-rebound',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'recoveryClass', recovered.recovery_class,
      'nextState', 'retry-ready'
    ),
    'migration-186:safe-ordinary-rebind:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-186')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason_code <> 'image-upload-failed'
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
    'reason', 'safe-deterministic-ordinary-identity-rebind-186'
  )
FROM resolved
WHERE outbox.intervention_id = resolved.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO schema_migrations (version)
VALUES ('186_rebind_safe_deterministic_ordinary_retries.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
