import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const apiBaseUrl = String(process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const visualHoldMs = Math.max(0, Number(process.env.RETURN_REFUND_VISUAL_HOLD_MS || 0));
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const workOrderIds = [
  '00000000-0000-4000-8000-000000000481',
  '00000000-0000-4000-8000-000000000482',
  '00000000-0000-4000-8000-000000000483',
  '00000000-0000-4000-8000-000000000484',
  '00000000-0000-4000-8000-000000000485',
  '00000000-0000-4000-8000-000000000486',
];
const orderNumber = '__rr_api_group_test__';
const waitingOrderNumber = '__rr_api_waiting_test__';
const skippedOrderNumber = '__rr_api_skipped_test__';
const readOnlyOrderNumber = '__rr_api_readonly_test__';
const cancelledOrderNumber = '__rr_api_cancelled_test__';

const fetchJson = async (path) => {
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
};

try {
  await pool.query('DELETE FROM work_orders WHERE id = ANY($1::uuid[])', [workOrderIds]);
  const shop = (await pool.query(`SELECT id FROM shops
    WHERE id IN ('panapopo-healthcare', 'panapopo-medical-device') ORDER BY id LIMIT 1`)).rows[0];
  if (!shop) throw new Error('No return-refund test shop exists');

  const beforeMetrics = (await fetchJson('/api/v1/metrics/summary?scenarioCode=return-refund')).data;
  await pool.query(`INSERT INTO work_orders
    (id, shop_id, external_order_number, work_order_type, scenario_code, status,
     runtime_status, handling_classification, classification_source, idempotency_key,
     current_step, completion_state)
    VALUES
      ($1,$3,$4,'退货退款','return-refund','completed','completed','automated','system',$5,'return-refund-auto-complete','confirmed'),
      ($2,$3,$4,'退货退款','return-refund','waiting','waiting','automated','system',$6,'return-refund-waiting-logistics','pending'),
      ($7,$3,$8,'退货退款','return-refund','waiting','waiting','automated','system',$9,'return-refund-waiting-logistics','pending'),
      ($10,$3,$11,'退货退款','return-refund','archived','archived','automated','system',$12,'return-refund-skipped-not-found','not-applicable')`, [
    workOrderIds[0], workOrderIds[1], shop.id, orderNumber,
    '__rr_api_group_test_1__', '__rr_api_group_test_2__', workOrderIds[2], waitingOrderNumber,
    '__rr_api_waiting_test_1__', workOrderIds[3], skippedOrderNumber,
    '__rr_api_skipped_test_1__',
  ]);
  await pool.query(`INSERT INTO return_refunds
    (work_order_id, shop_id, external_order_number, aftersale_number, refund_amount,
     aftersale_status, logistics_timeline, latest_logistics_at, logistics_contains_changsha,
     rule_results, evidence, decision, action_state)
    VALUES
      ($1,$3,$4,'__rr_api_aftersale_1__',99.00,'商家同意退款,本单退款成功','[]'::jsonb,now(),true,'{}'::jsonb,'{}'::jsonb,'auto-refunded','auto-refunded'),
      ($2,$3,$4,'__rr_api_aftersale_2__',109.00,NULL,'[]'::jsonb,NULL,false,'{}'::jsonb,'{}'::jsonb,'wait-logistics','waiting-logistics'),
      ($5,$3,$6,'__rr_api_aftersale_3__',119.00,NULL,'[]'::jsonb,NULL,false,'{}'::jsonb,'{}'::jsonb,'wait-logistics','waiting-logistics'),
      ($7,$3,$8,'__rr_api_aftersale_4__',129.00,NULL,'[]'::jsonb,NULL,false,'{}'::jsonb,'{}'::jsonb,'not-applicable','skipped-not-found')`, [
    workOrderIds[0], workOrderIds[1], shop.id, orderNumber, workOrderIds[2], waitingOrderNumber,
    workOrderIds[3], skippedOrderNumber,
  ]);
  await pool.query(`INSERT INTO work_orders
    (id, shop_id, external_order_number, work_order_type, scenario_code, status,
     runtime_status, handling_classification, classification_source, idempotency_key,
     current_step, completion_state, completion_confirmation_method, completion_confirmed_at)
    VALUES
      ($1,$2,$3,'退货退款','return-refund','completed','completed','automated','system',$4,
       'return-refund-read-only-complete','confirmed','return-refund-read-only-page-completed',now())`, [
    workOrderIds[5], shop.id, cancelledOrderNumber, '__rr_api_cancelled_test_1__',
  ]);
  await pool.query(`INSERT INTO return_refunds
    (work_order_id, shop_id, external_order_number, aftersale_number, aftersale_status,
     refund_amount, logistics_timeline, rule_results, evidence, decision, action_state,
     completed_at, completion_method)
    VALUES
      ($1,$2,$3,'__rr_api_aftersale_6__','买家已经撤销申请,退款关闭',149.00,
       '[]'::jsonb,'{}'::jsonb,
       '{"fieldSources":{"aftersaleStatus":{"value":"买家已经撤销申请,退款关闭"}}}'::jsonb,
       'manual-completed','manual-completed',now(),
       'return-refund-read-only-page-completed')`, [
    workOrderIds[5], shop.id, cancelledOrderNumber,
  ]);
  await pool.query(`INSERT INTO work_orders
    (id, shop_id, external_order_number, work_order_type, scenario_code, status,
     runtime_status, handling_classification, classification_source, idempotency_key,
     current_step, completion_state, completion_confirmation_method, completion_confirmed_at)
    VALUES
      ($1,$2,$3,'退货退款','return-refund','completed','completed','automated','system',$4,
       'return-refund-read-only-complete','confirmed','return-refund-read-only-page-completed',now())`, [
    workOrderIds[4], shop.id, readOnlyOrderNumber, '__rr_api_readonly_test_1__',
  ]);
  await pool.query(`INSERT INTO return_refunds
    (work_order_id, shop_id, external_order_number, aftersale_number, refund_amount,
     aftersale_status, logistics_timeline, latest_logistics_at, logistics_contains_changsha,
     rule_results, evidence, decision, action_state, completed_at, completion_method)
    VALUES
      ($1,$2,$3,'__rr_api_aftersale_5__',139.00,'商家同意退款,本单退款成功','[]'::jsonb,now(),true,
       '{}'::jsonb,'{}'::jsonb,'manual-completed','manual-completed',now(),
       'return-refund-read-only-page-completed')`, [
    workOrderIds[4], shop.id, readOnlyOrderNumber,
  ]);

  const grouped = await fetchJson(`/api/v1/work-orders?scenarioCode=return-refund&q=${encodeURIComponent(orderNumber)}&page=1&pageSize=20`);
  assert.equal(grouped.total, 1, 'the same order must appear once in the work-order list');
  assert.equal(grouped.data.length, 1);
  assert.equal(grouped.data[0].aftersaleCount, 2);
  assert.equal(grouped.data[0].returnRefunds.length, 2);
  assert.deepEqual(
    new Set(grouped.data[0].returnRefunds.map((item) => item.aftersaleNumber)),
    new Set(['__rr_api_aftersale_1__', '__rr_api_aftersale_2__']),
  );

  const detail = (await fetchJson(`/api/v1/work-orders/${grouped.data[0].id}`)).data;
  assert.equal(detail.returnRefunds.length, 2, 'detail must retain both aftersale numbers');

  // The running API caches summary queries briefly. Wait for the fixture to
  // appear instead of treating a cached pre-insert snapshot as a regression.
  let afterMetrics;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    afterMetrics = (await fetchJson('/api/v1/metrics/summary?scenarioCode=return-refund')).data;
    if (Number(afterMetrics.total || 0) >= Number(beforeMetrics.total || 0) + 3) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.equal(afterMetrics.total, Number(beforeMetrics.total || 0) + 3, 'metrics must count each order once');
  assert.equal(afterMetrics.autoSuccess, Number(beforeMetrics.autoSuccess || 0) + 3, 'terminal aftersales remain handled without a repeat submission');
  assert.equal(afterMetrics.refundAutoSuccess, Number(beforeMetrics.refundAutoSuccess || 0) + 2,
    'only platform-confirmed refunds count as automated refunds; buyer cancellation must not');
  assert.equal(afterMetrics.refundManualCompleted, Number(beforeMetrics.refundManualCompleted || 0),
    'waiting, automatic, and system read-only completions must not count as manual completion');
  assert.equal(afterMetrics.returnRefundWaiting, Number(beforeMetrics.returnRefundWaiting || 0) + 1, 'waiting-only orders must be reported separately');
  assert.equal(afterMetrics.returnRefundSkipped, Number(beforeMetrics.returnRefundSkipped || 0) + 1, 'missing aftersales must be excluded and reported separately');
  const beforeRefundScenario = (beforeMetrics.byScenario || []).find((item) => item.scenarioCode === 'return-refund') || {};
  const afterRefundScenario = (afterMetrics.byScenario || []).find((item) => item.scenarioCode === 'return-refund') || {};
  assert.equal(afterRefundScenario.excludedWaiting, Number(beforeRefundScenario.excludedWaiting || 0) + 1);
  assert.equal(afterRefundScenario.excludedSkipped, Number(beforeRefundScenario.excludedSkipped || 0) + 1);
  assert.equal(afterRefundScenario.refundAutoSuccess, Number(beforeRefundScenario.refundAutoSuccess || 0) + 2);
  assert.equal(afterRefundScenario.refundManualCompleted, Number(beforeRefundScenario.refundManualCompleted || 0));
  if (visualHoldMs > 0) {
    console.log(`return-refund visual fixture available for ${visualHoldMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, visualHoldMs));
  }
  console.log('return-refund API grouping self-test passed');
} finally {
  await pool.query('DELETE FROM work_orders WHERE id = ANY($1::uuid[])', [workOrderIds]).catch(() => {});
  await pool.end();
}
