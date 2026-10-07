SELECT current_database() AS database_name,
  pg_size_pretty(pg_database_size(current_database())) AS database_size;

SELECT status, runtime_status, count(*) AS work_order_count
FROM work_orders
GROUP BY status, runtime_status
ORDER BY status, runtime_status;

SELECT status, count(*) AS external_effect_count
FROM external_effects
WHERE status IN ('reserved', 'unknown')
GROUP BY status
ORDER BY status;

WITH source AS (
  SELECT id,
    coalesce(
      nullif(payload ->> 'detailUrl', ''),
      nullif(payload #>> '{latestDiscovery,detailUrl}', ''),
      nullif(payload #>> '{checkpoint,detailUrl}', '')
    ) AS detail_url
  FROM work_orders
  WHERE scenario_code IS DISTINCT FROM 'return-refund'
), parsed AS (
  SELECT id, detail_url,
    CASE WHEN detail_url ~* '^https://mms[.]pinduoduo[.]com/aftersales/work_order/tododetail/?[?]'
      THEN substring(detail_url FROM '[?&]id=([0-9]{6,30})(&|$)')
      ELSE NULL
    END AS platform_case_id
  FROM source
)
SELECT count(*) AS ordinary_work_orders,
  count(*) FILTER (WHERE platform_case_id IS NOT NULL) AS verified_detail_ids,
  count(*) FILTER (WHERE platform_case_id IS NULL) AS legacy_unverified
FROM parsed;

WITH source AS (
  SELECT external_order_number,
    substring(
      coalesce(
        nullif(payload ->> 'detailUrl', ''),
        nullif(payload #>> '{latestDiscovery,detailUrl}', ''),
        nullif(payload #>> '{checkpoint,detailUrl}', '')
      )
      FROM '[?&]id=([0-9]{6,30})(&|$)'
    ) AS platform_case_id
  FROM work_orders
  WHERE scenario_code IS DISTINCT FROM 'return-refund'
)
SELECT platform_case_id,
  count(*) AS duplicate_count,
  count(DISTINCT external_order_number) AS distinct_orders
FROM source
WHERE platform_case_id IS NOT NULL
GROUP BY platform_case_id
HAVING count(*) > 1
ORDER BY duplicate_count DESC, platform_case_id;
