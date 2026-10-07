BEGIN;

-- Requeue only deterministic ordinary-work-order pauses fixed by the current
-- policy/runtime upgrade. Shop identity, current instance ownership and
-- external-effect guards prevent a stale or already-submitted case from being
-- executed again.
WITH candidates AS MATERIALIZED (
  SELECT work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
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
      ) LIKE '%evidence-not-consumed'
        THEN 'completed-without-evidence-artifacts'
      WHEN work_order.scenario_code = 'intercept-recall'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%发货物流不足以判断消费者是否已签收%'
        THEN 'intercept-unknown-sign-status'
      WHEN work_order.scenario_code = 'abnormal-network-warning'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) = 'OMS 当前订单行未找到“标记”单元格'
        THEN 'abnormal-network-oms-marker'
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
      ) LIKE '%拼多多未找到必选处理结果: 已同意退货退款%'
        THEN 'primary-refund-option-alias'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%Chromium context is unavailable before creating a background tab%'
        THEN 'browser-context-unavailable'
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
      ) LIKE '%检测到人工验证，请在可视化浏览器中完成后重新运行流程%'
        THEN 'verification-recheck'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE 'Playwright workflow exited with code %'
        THEN 'browser-process-exit'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%拼多多未找到“发货物流”标签，已停止读取物流%'
        THEN 'pdd-shipping-logistics-tab-render'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) ~ '(EBUSY|EPERM): .*verification-focus[.]lock'
        THEN 'verification-focus-lock-contention'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%"className":"mms-header__open-item"%'
        THEN 'pdd-header-marketing-menu'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%OMS 已有物流信息，但未能读取发货仓库%'
        THEN 'oms-recommended-warehouse'
      WHEN coalesce(
        work_order.manual_review_reason,
        instance.manual_review_reason,
        work_order.payload->>'error',
        ''
      ) LIKE '%已有 TMS 工单无法同时核对订单、运单号、仓库和快递%'
        THEN 'tms-visible-identity-fields'
      WHEN work_order.scenario_code = 'delivery-risk-concern'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ '存在发货物流节点但缺少节点时间|两天复查时缺少工单剩余时长|最新物流时间晚于当前时间'
        THEN 'delivery-risk-soft-field-fallback'
      WHEN work_order.scenario_code = 'proactive-logistics-service'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ '未查到退货物流且缺少工单发起时间|工单首次发现时间晚于当前时间|工单发起时间晚于当前时间，不能据此选择无退货物流话术'
        THEN 'proactive-no-return-logistics-time-fallback'
      WHEN work_order.scenario_code = 'good-deed-expedited-shipping'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%未检测到已揽件，同时缺少工单剩余时长%'
        THEN 'good-deed-unreadable-deadline-feedback'
      WHEN work_order.scenario_code = 'abnormal-network-warning'
        THEN 'abnormal-network-carrier-fallback'
      ELSE 'pdd-order-number-innertext-timeout'
    END AS recovery_class
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  JOIN ordinary_work_order_instances instance
    ON instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
  JOIN pdd_shop_runtime_bindings binding
    ON binding.shop_id = work_order.shop_id
    AND binding.binding_token::text =
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
    AND (
      (work_order.status = 'paused' AND instance.status = 'paused')
      OR (
        work_order.status = 'failed'
        AND instance.status = 'failed'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE 'Playwright workflow exited with code %'
      )
    )
    AND (
      coalesce(work_order.completion_state, 'pending') = 'pending'
      OR (
        work_order.completion_state = 'confirmed'
        AND work_order.completion_confirmation_method IN (
          'detail-completed',
          'handover-detail-completed'
        )
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%evidence-not-consumed'
      )
    )
    AND coalesce(work_order.recovery_state, 'ready') <> 'held'
    AND work_order.current_step IN (
      'flow-paused',
      'manual-review-blocked',
      'human-verification-required'
    )
    AND instance.identity_status IN ('verified', 'legacy-unverified')
    AND binding.actual_shop_name = shop.expected_shop_name
    AND (
      coalesce(
        nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
        nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
        nullif(work_order.payload->>'pddMallId', '')
      ) IS NULL
      OR binding.mall_id = coalesce(
        nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
        nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
        nullif(work_order.payload->>'pddMallId', '')
      )
    )
    AND (
      (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%evidence-not-consumed'
        AND work_order.completion_state = 'confirmed'
        AND work_order.completion_confirmation_method IN (
          'detail-completed',
          'handover-detail-completed'
        )
        AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'succeeded'
        AND work_order.payload#>>'{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
        AND work_order.payload#>>'{pddResolutionSubmission,orderNumber}' =
          work_order.external_order_number
        AND coalesce(work_order.payload->'pddEvidenceScreenshot', 'null'::jsonb) = 'null'::jsonb
        AND coalesce(work_order.payload->'tmsEvidenceScreenshot', 'null'::jsonb) = 'null'::jsonb
        AND coalesce(work_order.payload->'tmsEvidenceDisposition', 'null'::jsonb) = 'null'::jsonb
      )
      OR (
        work_order.scenario_code = 'intercept-recall'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%发货物流不足以判断消费者是否已签收%'
      )
      OR (
        work_order.scenario_code = 'abnormal-network-warning'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) = 'OMS 当前订单行未找到“标记”单元格'
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
      OR (
        work_order.scenario_code = 'in-transit-refund'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%拼多多发货城市范围判断缺失%'
      )
      OR (
        work_order.scenario_code = 'in-transit-refund'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%拼多多未找到必选处理结果: 已同意退货退款%'
      )
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
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%Chromium context is unavailable before creating a background tab%'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%拼多多%渲染刷新后等待 % 毫秒仍未出现有效结果%'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%检测到人工验证，请在可视化浏览器中完成后重新运行流程%'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE 'Playwright workflow exited with code %'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%拼多多未找到“发货物流”标签，已停止读取物流%'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ '(EBUSY|EPERM): .*verification-focus[.]lock'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%"className":"mms-header__open-item"%'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%TEMU%'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%网格仓/服务站招募%'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%OMS 已有物流信息，但未能读取发货仓库%'
        AND coalesce(work_order.payload#>>'{omsWarehouseParse,rawShippingText}', '')
          ~ '推荐仓库[：:]?\s*\S+'
      )
      OR (
        coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%已有 TMS 工单无法同时核对订单、运单号、仓库和快递%'
        AND work_order.payload#>>'{tmsDuplicateCheck,candidateCount}' = '1'
        AND work_order.payload#>>'{tmsDuplicateCheck,decisionComparison,matches}' = 'true'
        AND nullif(work_order.payload#>>'{tmsDuplicateCheck,identity,values,运单号}', '') IS NOT NULL
        AND nullif(work_order.payload#>>'{tmsDuplicateCheck,identity,values,责任快递}', '') IS NOT NULL
        AND nullif(work_order.payload#>>'{tmsDuplicateCheck,identity,values,发货仓库}', '') IS NOT NULL
        AND coalesce(work_order.payload#>>'{tmsDuplicateCheck,identity,text}', '')
          LIKE '%' || work_order.external_order_number || '%'
      )
      OR (
        work_order.scenario_code = 'delivery-risk-concern'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ '存在发货物流节点但缺少节点时间|两天复查时缺少工单剩余时长|最新物流时间晚于当前时间'
      )
      OR (
        work_order.scenario_code = 'proactive-logistics-service'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) ~ '未查到退货物流且缺少工单发起时间|工单首次发现时间晚于当前时间|工单发起时间晚于当前时间，不能据此选择无退货物流话术'
      )
      OR (
        work_order.scenario_code = 'good-deed-expedited-shipping'
        AND coalesce(
          work_order.manual_review_reason,
          instance.manual_review_reason,
          work_order.payload->>'error',
          ''
        ) LIKE '%未检测到已揽件，同时缺少工单剩余时长%'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.status IN ('reserved', 'unknown')
        AND (
          effect.ordinary_instance_id IS NULL
          OR effect.ordinary_instance_id = instance.id
        )
    )
    AND (
      (
        work_order.completion_state = 'confirmed'
        AND work_order.payload#>>'{pddResolutionSubmission,status}' = 'succeeded'
        AND work_order.payload#>>'{pddResolutionSubmission,recoveredFromCompletedPage}' = 'true'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.effect_type = 'pdd-submit'
          AND effect.status IN ('succeeded', 'unknown')
          AND (
            effect.ordinary_instance_id IS NULL
            OR effect.ordinary_instance_id = instance.id
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
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-policy-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = recovery_version + 1,
    recovery_updated_at = now(),
    payload = (coalesce(work_order.payload, '{}'::jsonb) - 'manualReview' - 'error')
      || jsonb_build_object(
        'step', 'ordinary-policy-retry-ready',
        'deterministicOrdinaryRecovery163', jsonb_build_object(
          'previousReason', candidate.previous_reason,
          'recoveryClass', candidate.recovery_class,
          'strategy', CASE candidate.recovery_class
            WHEN 'completed-without-evidence-artifacts' THEN 'archive-confirmed-completion-without-artifacts'
            WHEN 'intercept-unknown-sign-status' THEN 'unknown-treated-as-unsigned'
            WHEN 'abnormal-network-oms-marker' THEN 'skip-non-applicable-oms-marker'
            WHEN 'abnormal-network-carrier-fallback' THEN 'choose-visible-carrier-or-explain-missing-recommendation'
            WHEN 'in-transit-missing-city' THEN 'unknown-treated-as-within-origin-city'
            WHEN 'primary-refund-option-alias' THEN 'choose-visible-equivalent-refund-option'
            WHEN 'browser-context-unavailable' THEN 'bounded-browser-context-retry'
            WHEN 'pdd-render-timeout' THEN 'bounded-pdd-render-retry'
            WHEN 'verification-recheck' THEN 'browser-truth-verification-recheck'
            WHEN 'browser-process-exit' THEN 'bounded-browser-process-retry'
            WHEN 'pdd-shipping-logistics-tab-render' THEN 'wait-refresh-and-recheck-logistics-tab'
            WHEN 'verification-focus-lock-contention' THEN 'quarantine-or-expire-busy-focus-lock'
            WHEN 'pdd-header-marketing-menu' THEN 'dismiss-whitelisted-marketing-menu'
            WHEN 'oms-recommended-warehouse' THEN 'read-recommended-warehouse-label'
            WHEN 'tms-visible-identity-fields' THEN 'reuse-unique-visible-tms-ticket'
            WHEN 'delivery-risk-soft-field-fallback' THEN 'repeat-reminder-or-use-first-observed-time'
            WHEN 'proactive-no-return-logistics-time-fallback' THEN 'submit-no-return-logistics-without-time-block'
            WHEN 'good-deed-unreadable-deadline-feedback' THEN 'open-feedback-and-submit-immediately'
            ELSE 'bounded-transient-page-retry'
          END,
          'recoveredAt', now()
        ),
        'updatedAt', now()
      ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    candidate.previous_reason,
    candidate.recovery_class
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'ordinary-policy-retry-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = coalesce(work_order.payload, '{}'::jsonb),
    updated_at = now()
  FROM recovered
  JOIN work_orders work_order ON work_order.id = recovered.id
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
  RETURNING recovered.id,
    recovered.shop_id,
    recovered.external_order_number,
    recovered.current_ordinary_instance_id,
    recovered.previous_reason,
    recovered.recovery_class
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-163',
    'deterministic-ordinary-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'previousReason', recovered.previous_reason,
      'recoveryClass', recovered.recovery_class
    ),
    'migration-163:deterministic-ordinary-pause:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-163')
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
VALUES ('163_recover_deterministic_ordinary_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
