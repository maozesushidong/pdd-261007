BEGIN TRANSACTION READ ONLY;

WITH candidates AS MATERIALIZED (
  SELECT
    intervention.id,
    intervention.shop_id,
    intervention.reason_code,
    intervention.reason,
    intervention.created_at,
    recovery.last_success_at
  FROM manual_interventions intervention
  JOIN shops shop
    ON shop.id = intervention.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN LATERAL (
    SELECT max(cursor.last_success_at) AS last_success_at
    FROM sync_cursors cursor
    WHERE cursor.shop_id = intervention.shop_id
      AND cursor.last_success_at > intervention.created_at
      AND coalesce(cursor.backlog_count, 0) = 0
      AND cursor.last_error IS NULL
  ) recovery ON recovery.last_success_at IS NOT NULL
  WHERE intervention.status IN ('open', 'acknowledged')
    AND intervention.channel = 'dashboard'
    AND intervention.work_order_id IS NULL
    AND intervention.ordinary_instance_id IS NULL
    AND intervention.created_at <= now() - interval '48 hours'
    AND (
      intervention.reason_code IN (
        'external-system-error',
        'page-crashed',
        'tms-query-miss',
        'oms-query-miss',
        'unknown-scenario'
      )
      OR (
        intervention.reason_code = 'warehouse-out-of-scope'
        AND regexp_replace(intervention.reason, '\s+', '', 'g') ~
          'OMS发货仓库[“"]代发聚水潭-(迅发|品动工贸|祺迦工贸)[”"]不在业务处理范围'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM work_orders work_order
      LEFT JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
        AND instance.work_order_id = work_order.id
        AND instance.shop_id = work_order.shop_id
      WHERE work_order.shop_id = intervention.shop_id
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND coalesce(work_order.completion_state, 'pending') = 'pending'
        AND work_order.status NOT IN ('completed', 'archived')
        AND (
          work_order.manual_review_reason = intervention.reason
          OR instance.manual_review_reason = intervention.reason
        )
    )
)
SELECT
  count(*) AS candidate_count,
  count(*) FILTER (
    WHERE reason_code = 'warehouse-out-of-scope'
  ) AS expanded_warehouse_count,
  count(*) FILTER (
    WHERE reason_code <> 'warehouse-out-of-scope'
  ) AS transient_count,
  min(created_at) AS oldest_candidate_at,
  max(created_at) AS newest_candidate_at
FROM candidates;

SELECT
  intervention.reason_code,
  count(*) AS open_count,
  count(*) FILTER (WHERE intervention.work_order_id IS NOT NULL) AS linked_count,
  count(*) FILTER (WHERE intervention.work_order_id IS NULL) AS shop_level_count
FROM manual_interventions intervention
WHERE intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code NOT IN (
    'verification-required',
    'login-required',
    'return-refund-verification-required',
    'waiting-logistics',
    'waiting-consumer-response',
    'page-render-deferred',
    'rate-limited'
  )
GROUP BY intervention.reason_code
ORDER BY open_count DESC, intervention.reason_code;

SELECT
  intervention.id,
  intervention.shop_id,
  work_order.external_order_number AS order_number,
  intervention.reason_code,
  intervention.reason,
  intervention.created_at
FROM manual_interventions intervention
LEFT JOIN work_orders work_order ON work_order.id = intervention.work_order_id
WHERE intervention.status IN ('open', 'acknowledged')
  AND intervention.reason_code = 'warehouse-out-of-scope'
  AND (
    intervention.work_order_id IS NOT NULL
    OR regexp_replace(intervention.reason, '\s+', '', 'g') !~
      'OMS发货仓库[“"]代发聚水潭-(迅发|品动工贸|祺迦工贸)[”"]不在业务处理范围'
  )
ORDER BY intervention.created_at;

ROLLBACK;
