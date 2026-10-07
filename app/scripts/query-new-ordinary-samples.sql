SELECT
  s.id AS shop_id,
  s.name AS shop_name,
  w.external_order_number,
  w.work_order_type,
  w.scenario_code,
  w.status,
  w.runtime_status,
  w.current_step,
  COALESCE(
    w.payload ->> 'detailUrl',
    w.payload #>> '{latestDiscovery,detailUrl}',
    ''
  ) AS detail_url,
  w.updated_at
FROM work_orders AS w
JOIN shops AS s ON s.id = w.shop_id
WHERE w.work_order_type ~ '(物流异常主动服务|消费者申请退款后提示拦截|好人好事)'
   OR w.scenario_code IN (
     'proactive-logistics-service',
     'intercept-recall',
     'good-deed-expedited-shipping'
   )
ORDER BY w.updated_at DESC
LIMIT 100;
