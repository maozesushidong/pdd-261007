BEGIN;

ALTER TABLE return_refunds
  ADD COLUMN IF NOT EXISTS earliest_logistics_at timestamptz,
  ADD COLUMN IF NOT EXISTS logistics_transit_span_hours numeric,
  ADD COLUMN IF NOT EXISTS logistics_contains_hengshui_jizhou boolean,
  ADD COLUMN IF NOT EXISTS logistics_direction_matched boolean;

WITH timeline_events AS (
  SELECT refund.work_order_id,
    element->>'text' AS event_text,
    CASE
      WHEN coalesce(element->>'occurredAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        THEN (element->>'occurredAt')::timestamptz
      ELSE NULL
    END AS occurred_at
  FROM return_refunds refund
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(refund.logistics_timeline) = 'array'
      THEN refund.logistics_timeline ELSE '[]'::jsonb END
  ) element
  WHERE coalesce(element->>'text', '') !~
    '(消费者已填写物流单号|待快递公司返回物流信息|暂无物流信息)'
), timeline_facts AS (
  SELECT work_order_id,
    min(occurred_at) FILTER (WHERE occurred_at IS NOT NULL) AS earliest_at,
    max(occurred_at) FILTER (WHERE occurred_at IS NOT NULL) AS latest_at,
    bool_or(position('长沙' IN event_text) > 0) AS contains_changsha,
    bool_or(position('衡水' IN event_text) > 0 AND position('冀州' IN event_text) > 0)
      AS contains_hengshui_jizhou
  FROM timeline_events
  GROUP BY work_order_id
)
UPDATE return_refunds refund SET
  earliest_logistics_at = facts.earliest_at,
  latest_logistics_at = facts.latest_at,
  logistics_transit_span_hours = CASE
    WHEN facts.earliest_at IS NOT NULL AND facts.latest_at IS NOT NULL
      THEN extract(epoch FROM (facts.latest_at - facts.earliest_at)) / 3600
    ELSE NULL
  END,
  logistics_contains_changsha = coalesce(facts.contains_changsha, false),
  logistics_contains_hengshui_jizhou = coalesce(facts.contains_hengshui_jizhou, false),
  logistics_direction_matched = coalesce(facts.contains_changsha, false)
    OR coalesce(facts.contains_hengshui_jizhou, false),
  updated_at = now()
FROM timeline_facts facts
WHERE facts.work_order_id = refund.work_order_id;

UPDATE return_refunds SET
  earliest_logistics_at = NULL,
  latest_logistics_at = NULL,
  logistics_transit_span_hours = NULL,
  logistics_contains_changsha = false,
  logistics_contains_hengshui_jizhou = false,
  logistics_direction_matched = false,
  updated_at = now()
WHERE NOT EXISTS (
  SELECT 1
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(return_refunds.logistics_timeline) = 'array'
      THEN return_refunds.logistics_timeline ELSE '[]'::jsonb END
  ) element
  WHERE coalesce(element->>'text', '') !~
    '(消费者已填写物流单号|待快递公司返回物流信息|暂无物流信息)'
    AND coalesce(element->>'occurredAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
);

CREATE TEMP TABLE return_refund_policy_reclassification ON COMMIT DROP AS
SELECT refund.work_order_id,
  refund.shop_id,
  refund.aftersale_number,
  CASE
    WHEN refund.earliest_logistics_at IS NULL THEN
      CASE WHEN now() - refund.first_discovered_at > interval '72 hours'
        THEN 'manual-review' ELSE 'waiting-logistics' END
    WHEN now() - refund.latest_logistics_at > interval '72 hours' THEN 'manual-review'
    WHEN refund.logistics_direction_matched THEN
      CASE WHEN refund.aftersale_type = '退货退款'
          AND coalesce(refund.aftersale_status, '') LIKE '%待商家%'
          AND refund.refund_amount >= 0 AND refund.refund_amount < 500
          AND refund.action_button_visible = true
        THEN 'ready' ELSE 'manual-review' END
    WHEN refund.logistics_transit_span_hours > 72 THEN 'manual-review'
    ELSE 'waiting-logistics'
  END AS next_action_state,
  CASE
    WHEN refund.earliest_logistics_at IS NULL
      AND now() - refund.first_discovered_at > interval '72 hours'
      THEN 'return-refund-no-logistics-over-72-hours'
    WHEN refund.earliest_logistics_at IS NOT NULL
      AND now() - refund.latest_logistics_at > interval '72 hours'
      THEN 'return-refund-latest-logistics-stale'
    WHEN refund.logistics_direction_matched
      AND NOT (refund.aftersale_type = '退货退款'
        AND coalesce(refund.aftersale_status, '') LIKE '%待商家%'
        AND refund.refund_amount >= 0 AND refund.refund_amount < 500
        AND refund.action_button_visible = true)
      THEN 'return-refund-core-rule-failed'
    WHEN coalesce(refund.logistics_transit_span_hours, 0) > 72
      THEN 'return-refund-direction-timeout'
    ELSE NULL
  END AS manual_reason_code,
  CASE
    WHEN refund.earliest_logistics_at IS NULL
      AND now() - refund.first_discovered_at > interval '72 hours'
      THEN '首次发现超过72小时仍未产生有效退货物流'
    WHEN refund.earliest_logistics_at IS NOT NULL
      AND now() - refund.latest_logistics_at > interval '72 hours'
      THEN '当前时间距最新物流节点超过72小时'
    WHEN refund.logistics_direction_matched
      AND NOT (refund.aftersale_type = '退货退款'
        AND coalesce(refund.aftersale_status, '') LIKE '%待商家%'
        AND refund.refund_amount >= 0 AND refund.refund_amount < 500
        AND refund.action_button_visible = true)
      THEN '物流方向已命中，但售后类型、状态、金额或退款按钮条件未满足'
    WHEN coalesce(refund.logistics_transit_span_hours, 0) > 72
      THEN '物流首尾时间跨度超过72小时，任一节点仍未出现长沙或衡水冀州'
    WHEN refund.earliest_logistics_at IS NULL
      THEN '尚未产生有效退货物流，等待首次发现满72小时后复查'
    WHEN NOT refund.logistics_direction_matched
      THEN '任一物流节点尚未出现长沙或衡水冀州，首尾物流跨度未超过72小时，等待下一轮检查'
    ELSE NULL
  END AS classification_reason,
  CASE
    WHEN refund.earliest_logistics_at IS NULL
      THEN refund.first_discovered_at + interval '72 hours'
    WHEN NOT refund.logistics_direction_matched
      AND coalesce(refund.logistics_transit_span_hours, 0) <= 72
      THEN now() + interval '30 minutes'
    ELSE NULL
  END AS next_check_at
FROM return_refunds refund
WHERE refund.action_state IN ('discovered', 'waiting-logistics', 'ready', 'manual-review');

UPDATE return_refunds refund SET
  action_state = policy.next_action_state,
  decision = CASE policy.next_action_state
    WHEN 'waiting-logistics' THEN 'wait-logistics'
    WHEN 'ready' THEN 'auto-refund'
    ELSE 'manual-review'
  END,
  risk_level = CASE WHEN policy.next_action_state = 'manual-review' THEN 'high' ELSE NULL END,
  next_check_at = CASE WHEN policy.next_action_state = 'waiting-logistics'
    THEN policy.next_check_at ELSE NULL END,
  rule_results = coalesce(refund.rule_results, '{}'::jsonb) || jsonb_build_object(
    'destination', jsonb_build_object(
      'passed', refund.logistics_direction_matched,
      'actual', jsonb_build_object(
        'containsChangsha', refund.logistics_contains_changsha,
        'containsHengshuiJizhou', refund.logistics_contains_hengshui_jizhou
      ),
      'expected', '长沙或衡水冀州'
    ),
    'logisticsTransitSpan', jsonb_build_object(
      'actualHours', refund.logistics_transit_span_hours,
      'expected', '>72时未命中方向才转人工'
    )
  ),
  updated_at = now()
FROM return_refund_policy_reclassification policy
WHERE policy.work_order_id = refund.work_order_id;

UPDATE work_orders work_order SET
  status = CASE policy.next_action_state
    WHEN 'ready' THEN 'queued'
    WHEN 'manual-review' THEN 'paused'
    ELSE 'retry-ready'
  END,
  runtime_status = CASE policy.next_action_state
    WHEN 'ready' THEN 'queued'
    WHEN 'manual-review' THEN 'manual-review'
    ELSE 'waiting'
  END,
  current_step = CASE policy.next_action_state
    WHEN 'ready' THEN 'return-refund-ready'
    WHEN 'manual-review' THEN 'return-refund-manual-review'
    ELSE 'return-refund-waiting-logistics'
  END,
  handling_classification = CASE policy.next_action_state
    WHEN 'manual-review' THEN 'manual' ELSE 'automated' END,
  classification_reason = policy.classification_reason,
  classification_updated_at = now(),
  manual_review_reason = CASE policy.next_action_state
    WHEN 'manual-review' THEN policy.classification_reason ELSE NULL END,
  next_attempt_at = CASE policy.next_action_state
    WHEN 'ready' THEN now()
    WHEN 'waiting-logistics' THEN policy.next_check_at
    ELSE NULL
  END,
  updated_at = now()
FROM return_refund_policy_reclassification policy
WHERE policy.work_order_id = work_order.id;

WITH closed AS (
  UPDATE manual_interventions intervention SET
    status = 'cancelled',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'return-refund-policy-v2')
  FROM return_refund_policy_reclassification policy
  WHERE intervention.work_order_id = policy.work_order_id
    AND (policy.next_action_state IN ('waiting-logistics', 'ready')
      OR (policy.next_action_state = 'manual-review'
        AND intervention.reason_code <> policy.manual_reason_code))
    AND intervention.status IN ('open', 'acknowledged')
  RETURNING intervention.id
)
UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
FROM closed
WHERE outbox.intervention_id = closed.id
  AND outbox.status IN ('pending', 'sending', 'failed');

INSERT INTO manual_interventions
  (id, shop_id, work_order_id, channel, reason_code, reason, risk_level,
   status, deduplication_key)
SELECT gen_random_uuid(), policy.shop_id, policy.work_order_id, 'dashboard',
  policy.manual_reason_code, policy.classification_reason, 'high', 'open',
  'return-refund:' || policy.shop_id || ':' || policy.aftersale_number
    || ':dashboard:' || policy.manual_reason_code
FROM return_refund_policy_reclassification policy
WHERE policy.next_action_state = 'manual-review'
  AND policy.manual_reason_code IS NOT NULL
ON CONFLICT (deduplication_key) DO UPDATE SET
  reason = EXCLUDED.reason,
  risk_level = EXCLUDED.risk_level,
  status = 'open',
  resolved_at = NULL,
  resolved_by = NULL;

UPDATE scenario_definitions SET
  policy_version = 2,
  config = coalesce(config, '{}'::jsonb)
    - 'requiredLogisticsCity'
    - 'maxLogisticsAgeHoursExclusive'
    - 'missingLogisticsRetryMinutes'
    || jsonb_build_object(
      'scanIntervalMinutes', 30,
      'noLogisticsWaitHours', 72,
      'maxLogisticsAgeHours', 72,
      'maxTransitSpanHours', 72,
      'requiredLogisticsDestinations', jsonb_build_array('长沙', '衡水冀州')
    ),
  updated_at = now()
WHERE code = 'return-refund';

COMMIT;
