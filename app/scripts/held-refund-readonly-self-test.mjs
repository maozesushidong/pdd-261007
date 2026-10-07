import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

if (process.env.PDD_ROLLBACK_SELF_TEST !== '1') {
  throw new Error('Set PDD_ROLLBACK_SELF_TEST=1 to run the rollback-only database test');
}
const actualPool = await createPostgresPool();
const client = await actualPool.connect();
await client.query('BEGIN');
let savepointNumber = 0;
const savepoints = [];
const query = async (sql, values) => {
  const command = String(sql).trim().toUpperCase();
  if (command === 'BEGIN') {
    const name = `held_refund_sp_${++savepointNumber}`;
    savepoints.push(name);
    return client.query(`SAVEPOINT ${name}`);
  }
  if (command === 'COMMIT') {
    const name = savepoints.pop();
    assert.ok(name, 'nested commit requires a savepoint');
    return client.query(`RELEASE SAVEPOINT ${name}`);
  }
  if (command === 'ROLLBACK') {
    const name = savepoints.pop();
    assert.ok(name, 'nested rollback requires a savepoint');
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return client.query(`RELEASE SAVEPOINT ${name}`);
  }
  return client.query(sql, values);
};
const pool = {
  query,
  connect: async () => ({ query, release() {} }),
};
const repository = new PostgresWorkflowRepository(pool);
const suffix = crypto.randomUUID().slice(0, 8);
const shopId = `held-refund-test-${suffix}`;
const shopName = `Held refund test ${suffix}`;
const mallId = '987654321';
const fingerprint = `test-profile-${suffix}`;
const bindingToken = crypto.randomUUID();
const workOrderId = crypto.randomUUID();
const effectId = crypto.randomUUID();
const orderNumber = `260921-${suffix}`;
const aftersaleNumber = `229200${suffix}`;
const detailUrl = `https://mms.pinduoduo.com/aftersales-ssr/detail?id=${aftersaleNumber}&orderSn=${orderNumber}`;

try {
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot,
      enabled, onboarding_status)
    SELECT $1,$2,$2,slot,true,'ready'
    FROM generate_series(0, 999) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [shopId, shopName]);
  await pool.query(`
    INSERT INTO pdd_shop_runtime_bindings
      (identity_key, shop_id, actual_shop_name, mall_id,
       binding_token, profile_fingerprint)
    VALUES ($1,$2,$3,$4,$5,$6)`, [
    `mall:${mallId}`, shopId, shopName, mallId, bindingToken, fingerprint,
  ]);
  await pool.query(`
    INSERT INTO shop_identity_bindings
      (shop_id, expected_shop_name, profile_fingerprint, mall_id,
       status, confirmed_by)
    VALUES ($1,$2,$3,$4,'confirmed','self-test')`, [
    shopId, shopName, fingerprint, mallId,
  ]);
  await pool.query(`
    INSERT INTO shop_runtime_state (shop_id, status, metadata)
    VALUES ($1,'idle','{}'::jsonb)`, [shopId]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code,
       status, runtime_status, idempotency_key, current_step, payload,
       completion_state, recovery_state, recovery_reason)
    VALUES ($1,$2,$3,'退货退款','return-refund',
      'paused','paused',$4,'external-state-unresolved','{}'::jsonb,
      'pending','held','unknown-external-effect')`, [
    workOrderId, shopId, orderNumber, `held-refund:${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       detail_url, decision, action_state, evidence)
    VALUES ($1,$2,$3,$4,$5,'wait-logistics','waiting-logistics',$6::jsonb)`, [
    workOrderId, shopId, orderNumber, aftersaleNumber, detailUrl,
    JSON.stringify({ pddIdentityBindingToken: bindingToken, pddMallId: mallId,
      detectedShopName: shopName }),
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key,
       status, request_hash, reserved_at)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'unknown',$5,
      now() - interval '1 hour')`, [
    effectId, shopId, workOrderId,
    `pdd-return-refund:${aftersaleNumber}`,
    crypto.createHash('sha256').update(orderNumber).digest('hex'),
  ]);

  assert.equal(await repository.claimNext({
    shopId, workerId: 'test-worker',
    scenarioCodes: ['return-refund'], identityBindingToken: bindingToken,
  }), null, 'held unknown effect must be excluded from the normal refund queue');
  assert.equal(await repository.claimHeldReturnRefundReadOnly({
    shopId, workerId: 'test-worker', identityBindingToken: crypto.randomUUID(),
  }), null, 'a different binding token cannot read the held refund');

  const first = await repository.claimHeldReturnRefundReadOnly({
    shopId, workerId: 'test-worker', identityBindingToken: bindingToken,
  });
  assert.equal(first?.id, workOrderId);
  assert.equal(first?.heldRefundReadOnly, true);
  assert.equal(await repository.claimHeldReturnRefundReadOnly({
    shopId, workerId: 'second-worker', identityBindingToken: bindingToken,
  }), null, 'the read-only claim must retain a single active lease');
  await pool.query(`UPDATE work_orders SET current_step = 'return-refund-claim-complete'
    WHERE id = $1`, [workOrderId]);
  assert.equal(await repository.finishHeldReturnRefundReadOnly({
    shopId, workOrderId, leaseToken: first.leaseToken,
    result: {
      outcome: 'ready',
      reasons: ['Old action seems unapplied'],
      facts: { orderNumber, aftersaleNumber, aftersaleStatus: '买家已发货,待商家处理' },
      existingEffectResolution: { effectStatus: 'failed', retryable: true },
    },
  }), true);
  const held = await pool.query(`
    SELECT work_order.status, work_order.recovery_state, work_order.current_step,
      work_order.next_attempt_at > now() AS deferred,
      effect.status AS effect_status,
      runtime.lease_token IS NULL AS lease_released
    FROM work_orders work_order
    JOIN external_effects effect ON effect.work_order_id = work_order.id
    JOIN shop_runtime_state runtime ON runtime.shop_id = work_order.shop_id
    WHERE work_order.id = $1`, [workOrderId]);
  assert.deepEqual(held.rows[0], {
    status: 'paused', recovery_state: 'held',
    current_step: 'external-state-unresolved', deferred: true,
    effect_status: 'unknown', lease_released: true,
  }, 'even a failed/retryable classification must not release the unknown effect');

  await pool.query(`UPDATE work_orders SET next_attempt_at = now() - interval '1 minute'
    WHERE id = $1`, [workOrderId]);
  const second = await repository.claimHeldReturnRefundReadOnly({
    shopId, workerId: 'test-worker', identityBindingToken: bindingToken,
  });
  assert.equal(second?.id, workOrderId);
  assert.equal(await repository.finishHeldReturnRefundReadOnly({
    shopId, workOrderId, leaseToken: second.leaseToken,
    result: {
      outcome: 'manual-completed', readOnlyReview: true,
      facts: {
        orderNumber: `wrong-${orderNumber}`, aftersaleNumber, detailUrl,
        aftersaleStatus: '商家同意退款,本单退款成功',
        actionButtonVisible: false,
        evidence: { fieldSources: {
          aftersaleStatus: { source: 'label-following-line' },
        } },
      },
    },
  }), true);
  const wrongCase = await pool.query(`
    SELECT work_order.status, work_order.recovery_state, effect.status AS effect_status
    FROM work_orders work_order JOIN external_effects effect
      ON effect.work_order_id = work_order.id
    WHERE work_order.id = $1`, [workOrderId]);
  assert.deepEqual(wrongCase.rows[0], {
    status: 'paused', recovery_state: 'held', effect_status: 'unknown',
  }, 'a terminal page for a different order must not close the held effect');

  await pool.query(`UPDATE work_orders SET next_attempt_at = now() - interval '1 minute'
    WHERE id = $1`, [workOrderId]);
  const third = await repository.claimHeldReturnRefundReadOnly({
    shopId, workerId: 'test-worker', identityBindingToken: bindingToken,
  });
  assert.equal(third?.id, workOrderId);
  assert.equal(await repository.finishHeldReturnRefundReadOnly({
    shopId, workOrderId, leaseToken: third.leaseToken,
    result: {
      outcome: 'manual-completed', readOnlyReview: true,
      completionMethod: 'return-refund-read-only-page-completed',
      facts: {
        orderNumber, aftersaleNumber, detailUrl,
        aftersaleStatus: '商家同意退款,本单退款成功',
        actionButtonVisible: false,
        evidence: { fieldSources: {
          aftersaleStatus: { source: 'label-following-line' },
        } },
      },
    },
  }), true);
  const completed = await pool.query(`
    SELECT work_order.status, work_order.completion_state,
      work_order.recovery_state, refund.action_state,
      effect.status AS effect_status,
      runtime.lease_token IS NULL AS lease_released,
      (SELECT count(*)::int FROM external_effects x
        WHERE x.work_order_id = work_order.id) AS effect_count
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    JOIN external_effects effect ON effect.work_order_id = work_order.id
    JOIN shop_runtime_state runtime ON runtime.shop_id = work_order.shop_id
    WHERE work_order.id = $1`, [workOrderId]);
  assert.deepEqual(completed.rows[0], {
    status: 'completed', completion_state: 'confirmed',
    recovery_state: 'ready', action_state: 'auto-refunded',
    effect_status: 'succeeded', lease_released: true, effect_count: 1,
  }, 'exact terminal evidence should close only the original effect');

  const concurrentWorkOrderId = crypto.randomUUID();
  const concurrentEffectId = crypto.randomUUID();
  const concurrentOrderNumber = `260922-${suffix}`;
  const concurrentAftersaleNumber = `229201${suffix}`;
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code,
       status, runtime_status, idempotency_key, current_step, payload,
       completion_state, recovery_state, recovery_reason)
    VALUES ($1,$2,$3,'退货退款','return-refund',
      'paused','paused',$4,'external-state-unresolved','{}'::jsonb,
      'pending','held','unknown-external-effect')`, [
    concurrentWorkOrderId, shopId, concurrentOrderNumber,
    `held-refund-concurrent:${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       detail_url, decision, action_state, evidence)
    VALUES ($1,$2,$3,$4,$5,'wait-logistics','waiting-logistics',$6::jsonb)`, [
    concurrentWorkOrderId, shopId, concurrentOrderNumber,
    concurrentAftersaleNumber,
    `https://mms.pinduoduo.com/aftersales-ssr/detail?id=${concurrentAftersaleNumber}&orderSn=${concurrentOrderNumber}`,
    JSON.stringify({ pddIdentityBindingToken: bindingToken, pddMallId: mallId,
      detectedShopName: shopName }),
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key,
       status, request_hash, reserved_at)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'unknown',$5,
      now() - interval '1 hour')`, [
    concurrentEffectId, shopId, concurrentWorkOrderId,
    `pdd-return-refund:${concurrentAftersaleNumber}`,
    crypto.createHash('sha256').update(concurrentOrderNumber).digest('hex'),
  ]);
  const concurrent = await repository.claimHeldReturnRefundReadOnly({
    shopId, workerId: 'test-worker', identityBindingToken: bindingToken,
  });
  assert.equal(concurrent?.id, concurrentWorkOrderId);
  await pool.query(`
    UPDATE return_refunds SET action_state = 'auto-refunded',
      aftersale_status = '商家同意退款,本单退款成功', completed_at = now()
    WHERE work_order_id = $1`, [concurrentWorkOrderId]);
  await pool.query(`
    UPDATE external_effects SET status = 'succeeded',
      receipt = '{"reconciledFromPdd":true}'::jsonb
    WHERE id = $1`, [concurrentEffectId]);
  assert.equal(await repository.finishHeldReturnRefundReadOnly({
    shopId, workOrderId: concurrentWorkOrderId,
    leaseToken: concurrent.leaseToken,
    result: { outcome: 'page-error', reasons: ['Detail read was interrupted'] },
  }), true, 'an exact concurrent scan terminal proof should close the same held case');
  const concurrentCompleted = await pool.query(`
    SELECT status, completion_state, recovery_state FROM work_orders
    WHERE id = $1`, [concurrentWorkOrderId]);
  assert.deepEqual(concurrentCompleted.rows[0], {
    status: 'completed', completion_state: 'confirmed', recovery_state: 'ready',
  });
  console.log('held refund read-only reconciliation self-test passed');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await actualPool.end();
}
