import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

const pool = await createPostgresPool();
const client = await pool.connect();
const sourceShopId = 'shop-mt9va8ol-47962e';
const targetShopId = 'shop-mt9vdd44-99aa93';
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3s'");
  const target = (await client.query(`SELECT b.actual_shop_name, b.binding_token,
    b.mall_id FROM pdd_shop_runtime_bindings b WHERE b.shop_id = $1`,
  [targetShopId])).rows[0];
  assert(target?.actual_shop_name && target.binding_token && target.mall_id);
  const orderId = crypto.randomUUID();
  const instanceId = crypto.randomUUID();
  const orderNumber = `test-${Date.now()}`;
  const caseId = `${Date.now()}`;
  const payload = {
    latestDiscovery: { actualShopName: target.actual_shop_name,
      pddIdentityBindingToken: crypto.randomUUID() },
    pddMallId: target.mall_id,
  };
  await client.query(`INSERT INTO work_orders (id, shop_id,
    external_order_number, work_order_type, scenario_code, status,
    runtime_status, idempotency_key, payload,
    recovery_state) VALUES ($1,$2,$3,'异常网点预警',
      'abnormal-network-warning','retry-ready','retry-ready',$4,$5::jsonb,
      'ready')`, [orderId, sourceShopId, orderNumber,
    `test-relocation:${orderId}`, JSON.stringify(payload)]);
  await client.query(`INSERT INTO ordinary_work_order_instances
    (id, work_order_id, shop_id, platform_case_id, platform_case_key,
      work_order_type, scenario_code, identity_status, status,
      runtime_status, payload)
    VALUES ($1,$2,$3,$4,$5,'异常网点预警','abnormal-network-warning',
      'verified','retry-ready','retry-ready',$6::jsonb)`,
  [instanceId, orderId, sourceShopId, caseId, `pdd-work-order:${caseId}`,
    JSON.stringify(payload)]);
  await client.query(`UPDATE work_orders SET current_ordinary_instance_id = $2
    WHERE id = $1`, [orderId, instanceId]);
  const rediscovery = {
    shopId: targetShopId,
    externalOrderNumber: orderNumber,
    workOrderType: '异常网点预警',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${caseId}`,
      platformCaseId: caseId,
      platformCaseKey: `pdd-work-order:${caseId}`,
      detectedShopName: target.actual_shop_name,
      pddMallId: target.mall_id,
      pddIdentityBindingToken: target.binding_token,
    },
  };
  const testEffect = async (effectStatus) => {
    const effectId = crypto.randomUUID();
    await client.query(`INSERT INTO external_effects (id, shop_id,
      work_order_id, ordinary_instance_id, effect_type, idempotency_key,
      status, request_hash) VALUES ($1,$2,$3,$4,'oms-manual-allocation',
        $5,$6,$7)`, [effectId, sourceShopId, orderId, instanceId,
      `test-effect:${effectId}`, effectStatus, crypto.randomUUID()]);
    const adapter = { release() {}, async query(sql, params) {
      if (sql === 'BEGIN') return client.query('SAVEPOINT relocation_test');
      if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT relocation_test');
      if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT relocation_test');
      return client.query(sql, params);
    } };
    const repository = new PostgresWorkflowRepository({ connect: async () => adapter });
    const rebound = await repository.bindLegacyPendingOrdersToIdentity({ shopId: targetShopId,
      identityBindingToken: target.binding_token,
      actualShopName: target.actual_shop_name, mallId: target.mall_id });
    assert(!rebound.some((order) => order.id === orderId),
      `${effectStatus} effect must not report an order as relocated`);
    await assert.rejects(repository.enqueueDiscovered(rediscovery),
      (error) => error?.code === 'PDD_CROSS_SHOP_REDISCOVERY_UNSAFE',
      `${effectStatus} effect must block rediscovery relocation`);
    const current = (await client.query(`SELECT shop_id FROM work_orders
      WHERE id = $1`, [orderId])).rows[0];
    assert.equal(current.shop_id, sourceShopId,
      `${effectStatus} effect must block cross-shop relocation`);
    await client.query('DELETE FROM external_effects WHERE id = $1', [effectId]);
  };
  for (const status of ['succeeded', 'failed', 'unknown', 'reserved']) {
    await testEffect(status);
  }
  const adapter = { release() {}, async query(sql, params) {
    if (sql === 'BEGIN') return client.query('SAVEPOINT relocation_empty');
    if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT relocation_empty');
    if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT relocation_empty');
    return client.query(sql, params);
  } };
  const repository = new PostgresWorkflowRepository({ connect: async () => adapter });
  const rebound = await repository.bindLegacyPendingOrdersToIdentity({ shopId: targetShopId,
    identityBindingToken: target.binding_token,
    actualShopName: target.actual_shop_name, mallId: target.mall_id });
  assert(rebound.some((order) => order.id === orderId));
  const relocated = (await client.query(`SELECT shop_id FROM work_orders
    WHERE id = $1`, [orderId])).rows[0];
  assert.equal(relocated.shop_id, targetShopId,
    'an untouched order must still relocate when its identity is verified');

  const refundWorkOrderId = crypto.randomUUID();
  const refundEffectId = crypto.randomUUID();
  const aftersaleNumber = `test-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  await client.query(`INSERT INTO work_orders (id, shop_id,
    external_order_number, work_order_type, scenario_code, status,
    runtime_status, idempotency_key, completion_state)
    VALUES ($1,$2,$3,'退货退款','return-refund','retry-ready',
      'waiting',$4,'pending')`, [refundWorkOrderId, sourceShopId,
    `refund-${orderNumber}`, `test-refund:${refundWorkOrderId}`]);
  await client.query(`INSERT INTO return_refunds (work_order_id, shop_id,
    external_order_number, aftersale_number, decision, action_state, evidence)
    VALUES ($1,$2,$3,$4,'auto-refund','ready','{}'::jsonb)`, [
    refundWorkOrderId, sourceShopId, `refund-${orderNumber}`, aftersaleNumber,
  ]);
  await client.query(`INSERT INTO external_effects (id, shop_id, work_order_id,
    effect_type, idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'succeeded',$5)`, [
    refundEffectId, sourceShopId, refundWorkOrderId,
    `test-refund-effect:${refundEffectId}`, crypto.randomUUID(),
  ]);
  const refundAdapter = { release() {}, async query(sql, params) {
    if (sql === 'BEGIN') return client.query('SAVEPOINT refund_relocation_test');
    if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT refund_relocation_test');
    if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT refund_relocation_test');
    return client.query(sql, params);
  } };
  const refundRepository = new PostgresWorkflowRepository({
    connect: async () => refundAdapter,
  });
  const refundDiscovery = {
    shopId: targetShopId,
    items: [{
      orderNumber: `refund-${orderNumber}`,
      aftersaleNumber,
      decision: { outcome: 'skipped-not-found' },
      evidence: { capturedAt: new Date().toISOString() },
    }],
  };
  await assert.rejects(refundRepository.enqueueReturnRefunds(refundDiscovery),
    (error) => error?.code === 'PDD_DUPLICATE_SHOP_ACTIVE_RETURN_REFUND',
    'a successful refund effect must not move an unfinished refund');
  const unsafeRefund = (await client.query(`SELECT shop_id, status
    FROM work_orders WHERE id = $1`, [refundWorkOrderId])).rows[0];
  assert.equal(unsafeRefund.shop_id, sourceShopId);
  assert.equal(unsafeRefund.status, 'retry-ready');

  await client.query(`UPDATE work_orders SET status = 'completed',
    runtime_status = 'completed', completion_state = 'confirmed'
    WHERE id = $1`, [refundWorkOrderId]);
  await client.query(`UPDATE return_refunds SET action_state = 'auto-refunded',
    completed_at = now() WHERE work_order_id = $1`, [refundWorkOrderId]);
  await refundRepository.enqueueReturnRefunds(refundDiscovery);
  const terminalRefund = (await client.query(`SELECT work_order.shop_id,
    work_order.status, refund.action_state, effect.shop_id AS effect_shop_id
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    JOIN external_effects effect ON effect.work_order_id = work_order.id
    WHERE work_order.id = $1`, [refundWorkOrderId])).rows[0];
  assert.equal(terminalRefund.shop_id, targetShopId);
  assert.equal(terminalRefund.effect_shop_id, targetShopId);
  assert.equal(terminalRefund.status, 'completed');
  assert.equal(terminalRefund.action_state, 'auto-refunded');
  console.log('ordinary actions block relocation; unfinished successful refunds stay put while terminal refunds retain historical reassignment');
} finally {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await pool.end();
}
