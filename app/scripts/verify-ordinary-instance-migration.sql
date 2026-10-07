SELECT to_regclass('ordinary_work_order_instances') AS instance_table,
  count(*) AS instance_count,
  count(*) FILTER (WHERE identity_status = 'verified') AS verified_count,
  count(*) FILTER (WHERE identity_status = 'legacy-unverified') AS legacy_count
FROM ordinary_work_order_instances;

SELECT count(*) AS ordinary_without_current_instance
FROM work_orders
WHERE scenario_code IS DISTINCT FROM 'return-refund'
  AND current_ordinary_instance_id IS NULL;

SELECT count(*) AS invalid_current_instance_ownership
FROM work_orders AS work_order
JOIN ordinary_work_order_instances AS instance
  ON instance.id = work_order.current_ordinary_instance_id
WHERE instance.work_order_id <> work_order.id
   OR instance.shop_id <> work_order.shop_id;

SELECT count(*) AS duplicate_verified_platform_keys
FROM (
  SELECT platform_case_key
  FROM ordinary_work_order_instances
  WHERE platform_case_key IS NOT NULL
  GROUP BY platform_case_key
  HAVING count(*) > 1
) AS duplicate;

SELECT code,
  config ->> 'displayName' AS display_name,
  config ->> 'displayOrder' AS display_order,
  config ->> 'requiresOms' AS requires_oms,
  config ->> 'requiresTms' AS requires_tms,
  config ->> 'conditionalOms' AS conditional_oms,
  config ->> 'conditionalTms' AS conditional_tms
FROM scenario_definitions
WHERE code IN (
  'delivery-risk-concern',
  'proactive-logistics-service',
  'intercept-recall',
  'good-deed-expedited-shipping'
)
ORDER BY (config ->> 'displayOrder')::integer;

SELECT status, count(*) AS external_effect_count
FROM external_effects
WHERE status IN ('reserved', 'unknown')
GROUP BY status
ORDER BY status;
