import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

if (process.env.PDD_ROLLBACK_SELF_TEST !== '1') {
  throw new Error('Set PDD_ROLLBACK_SELF_TEST=1 for this rollback-only database test');
}

const actualPool = await createPostgresPool();
const client = await actualPool.connect();
await client.query('BEGIN');
let savepoint = 0;
const nested = [];
const query = async (sql, values) => {
  const command = String(sql).trim().toUpperCase();
  if (command === 'BEGIN') {
    const name = `logistics_recovery_${++savepoint}`;
    nested.push(name);
    return client.query(`SAVEPOINT ${name}`);
  }
  if (command === 'COMMIT') {
    const name = nested.pop();
    assert.ok(name);
    return client.query(`RELEASE SAVEPOINT ${name}`);
  }
  if (command === 'ROLLBACK') {
    const name = nested.pop();
    assert.ok(name);
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return client.query(`RELEASE SAVEPOINT ${name}`);
  }
  return client.query(sql, values);
};
const repository = new PostgresWorkflowRepository({
  connect: async () => ({ query, release() {} }),
});
const suffix = crypto.randomUUID().slice(0, 8);
const shopId = `logistics-recovery-test-${suffix}`;
const shopName = `Logistics recovery fixture ${suffix}`;
const mallId = `9${Math.floor(Math.random() * 100_000_000).toString().padStart(8, '0')}`;
const fingerprint = `fixture-profile-${suffix}`;
const currentToken = crypto.randomUUID();
const reason = 'PDD_LOGISTICS_ANALYSIS_TEMPORARILY_UNAVAILABLE: 拼多多物流时间线或阶段分析不完整';
let fixtureIndex = 0;

const fixture = async ({ effect = null, ticket = false, badMall = false,
  unverified = false, attemptedClick = false, attempts = 0,
  otherReason = false } = {}) => {
  const index = ++fixtureIndex;
  const id = crypto.randomUUID();
  const instanceId = crypto.randomUUID();
  const caseId = `5000198${String(index).padStart(8, '0')}`;
  const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${caseId}`;
  const orderNumber = `260926-00000000${String(index).padStart(7, '0')}`;
  const payload = {
    pddMallId: badMall ? '123456789' : mallId,
    shopNameSnapshot: shopName,
    detailUrl,
    latestDiscovery: {
      pddIdentityBindingToken: crypto.randomUUID(),
      pddMallId: mallId,
      actualShopName: shopName,
    },
    safePddDetailRecovery: { attempts },
    ...(attemptedClick ? { pddResolutionSubmission: {
      lastClickAttemptedAt: new Date().toISOString(),
    } } : {}),
  };
  const caseReason = otherReason ? 'locator.click: Timeout 8000ms exceeded' : reason;
  await client.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code,
       status, runtime_status, idempotency_key, current_step,
       manual_review_reason, payload, completion_state, recovery_state)
    VALUES ($1,$2,$3,'退货退款','in-transit-refund',
      'paused','paused',$3,'flow-paused',$4,$5::jsonb,'pending','ready')`, [
    id, shopId, orderNumber, caseReason, JSON.stringify(payload),
  ]);
  await client.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       detail_url, work_order_type, scenario_code, identity_status,
       status, runtime_status, current_step, manual_review_reason, payload)
    VALUES ($1,$2,$3,$4,$5,$6,'退货退款','in-transit-refund',$9,
      'paused','paused','flow-paused',$7,$8::jsonb)`, [
    instanceId, id, shopId, unverified ? null : caseId,
    unverified ? null : `pdd-work-order:${caseId}`,
    detailUrl, caseReason, JSON.stringify(payload),
    unverified ? 'legacy-unverified' : 'verified',
  ]);
  await client.query('UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1', [
    id, instanceId,
  ]);
  if (effect) {
    await client.query(`
      INSERT INTO external_effects
        (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
         idempotency_key, status, request_hash)
      VALUES ($1,$2,$3,$4,'pdd-note',$5,$6,'fixture')`, [
      crypto.randomUUID(), shopId, id, instanceId, `fixture-effect-${index}`, effect,
    ]);
  }
  if (ticket) {
    await client.query(`
      INSERT INTO tms_work_orders
        (id, work_order_id, ordinary_instance_id, scenario_code, status, request_hash)
      VALUES ($1,$2,$3,'in-transit-refund','created','fixture')`, [
      crypto.randomUUID(), id, instanceId,
    ]);
  }
  return id;
};

try {
  await client.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,slot,true,'ready'
    FROM generate_series(0,999) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [shopId, shopName]);
  await client.query(`
    INSERT INTO pdd_shop_runtime_bindings
      (identity_key, shop_id, actual_shop_name, mall_id, binding_token,
       profile_fingerprint, last_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,now())`, [
    `mall:${mallId}`, shopId, shopName, mallId, currentToken, fingerprint,
  ]);
  await client.query(`
    INSERT INTO shop_identity_bindings
      (shop_id, expected_shop_name, mall_id, profile_fingerprint, status, confirmed_by)
    VALUES ($1,$2,$3,$4,'confirmed','self-test')`, [
    shopId, shopName, mallId, fingerprint,
  ]);

  const eligibleId = await fixture();
  const protectedIds = [];
  for (const effect of ['reserved', 'unknown', 'succeeded', 'failed']) {
    protectedIds.push(await fixture({ effect }));
  }
  for (const options of [
    { ticket: true }, { badMall: true }, { unverified: true },
    { attemptedClick: true },
    { attempts: 3 }, { otherReason: true },
  ]) protectedIds.push(await fixture(options));

  assert.deepEqual(await repository.recoverSafePddDetailPauses({
    shopId, pddAuthenticated: false,
  }), [], 'PDD authentication must be fresh');
  await client.query(`UPDATE shop_identity_bindings SET profile_fingerprint = 'wrong'
    WHERE shop_id = $1`, [shopId]);
  assert.deepEqual(await repository.recoverSafePddDetailPauses({
    shopId, pddAuthenticated: true,
  }), [], 'a mismatched confirmed profile cannot recover');
  await client.query(`UPDATE shop_identity_bindings SET profile_fingerprint = $2
    WHERE shop_id = $1`, [shopId, fingerprint]);
  await client.query(`UPDATE pdd_shop_runtime_bindings
    SET last_seen_at = now() - interval '11 minutes' WHERE shop_id = $1`, [shopId]);
  assert.deepEqual(await repository.recoverSafePddDetailPauses({
    shopId, pddAuthenticated: true,
  }), [], 'stale observed identity cannot recover');
  await client.query(`UPDATE pdd_shop_runtime_bindings
    SET last_seen_at = now() WHERE shop_id = $1`, [shopId]);

  const recovered = await repository.recoverSafePddDetailPauses({
    shopId, pddAuthenticated: true,
  });
  assert.deepEqual(recovered.map((row) => row.id), [eligibleId]);
  assert.equal(recovered[0].binding_changed, true);
  const rows = await client.query(`
    SELECT work_order.id, work_order.status,
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS token,
      instance.status AS instance_status,
      instance.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS instance_token
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = ANY($1::uuid[])`, [[eligibleId, ...protectedIds]]);
  assert.equal(rows.rows.find((row) => row.id === eligibleId)?.status, 'retry-ready');
  assert.equal(rows.rows.find((row) => row.id === eligibleId)?.token, currentToken);
  assert.equal(rows.rows.find((row) => row.id === eligibleId)?.instance_status, 'retry-ready');
  assert.equal(rows.rows.find((row) => row.id === eligibleId)?.instance_token, currentToken);
  assert.equal(rows.rows.filter((row) => protectedIds.includes(row.id)
    && row.status === 'paused').length, protectedIds.length);
  assert.deepEqual(await repository.recoverSafePddDetailPauses({
    shopId, pddAuthenticated: true,
  }), [], 'recovered orders cannot be enqueued twice');
  console.log(JSON.stringify({ passed: true, recovered: 1,
    protected: protectedIds.length, transaction: 'rollback' }));
} finally {
  await client.query('ROLLBACK');
  client.release();
  await actualPool.end();
}
