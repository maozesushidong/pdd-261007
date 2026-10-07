import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

// A single outer transaction owns every fixture; repository transactions use
// savepoints so even successful paths are rolled back, with no live shop edits.
const line = fs.readFileSync(new URL('../.env.native', import.meta.url), 'utf8')
  .split(/\r?\n/u).find(value => value.startsWith('DATABASE_URL='));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || line.slice(13).trim(),
  application_name: 'ordinary-list-proof-rollback-self-test' });
const client = await pool.connect();
await client.query('BEGIN');
let serial = 0, checks = 0;
const nested = [];
const query = async (sql, values) => {
  const command = String(sql).trim().toUpperCase();
  if (command === 'BEGIN') {
    const name = `list_proof_${++serial}`; nested.push(name);
    return client.query(`SAVEPOINT ${name}`);
  }
  if (command === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${nested.pop()}`);
  if (command === 'ROLLBACK') {
    const name = nested.pop(); await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return client.query(`RELEASE SAVEPOINT ${name}`);
  }
  return client.query(sql, values);
};
const repository = new PostgresWorkflowRepository({ query,
  connect: async () => ({ query, release() {} }) });
const suffix = crypto.randomUUID().slice(0, 8), shopId = `list-proof-${suffix}`;
const shopName = `List proof fixture ${suffix}`, mallId = `98${Date.now().toString().slice(-7)}`;
const token = crypto.randomUUID(), fingerprint = `fixture-${suffix}`;
const workOrderId = crypto.randomUUID(), ordinaryInstanceId = crypto.randomUUID();
const orderNumber = `260929-0000000${Date.now().toString().slice(-8)}`;
const caseId = `50001${Date.now().toString().slice(-10)}`;
const initialPayload = { shopId, orderNumber,
  latestDiscovery: { pddIdentityBindingToken: token } };
const claim = () => repository.claimNextExternalStateReconciliation({ shopId });
const state = async () => (await client.query('SELECT * FROM work_orders WHERE id=$1', [workOrderId])).rows[0];
const reset = () => client.query('ROLLBACK TO SAVEPOINT fixture_baseline');
try {
  await client.query(`INSERT INTO shops(id,name,expected_shop_name,display_slot,enabled,onboarding_status)
    SELECT $1,$2,$2,slot,true,'ready' FROM generate_series(0,999) slot
    WHERE NOT EXISTS(SELECT 1 FROM shops WHERE display_slot=slot) ORDER BY slot LIMIT 1`, [shopId, shopName]);
  await client.query(`INSERT INTO pdd_shop_runtime_bindings
    (identity_key,shop_id,actual_shop_name,mall_id,binding_token,profile_fingerprint,last_seen_at)
    VALUES($1,$2,$3,$4,$5,$6,now())`, [`mall:${mallId}`,shopId,shopName,mallId,token,fingerprint]);
  await client.query(`INSERT INTO shop_identity_bindings
    (shop_id,expected_shop_name,mall_id,profile_fingerprint,status,confirmed_by)
    VALUES($1,$2,$3,$4,'confirmed','self-test')`, [shopId,shopName,mallId,fingerprint]);
  await client.query(`INSERT INTO work_orders
    (id,shop_id,external_order_number,work_order_type,scenario_code,status,runtime_status,
    idempotency_key,current_step,payload,completion_state,completion_confirmation_method,recovery_state)
    VALUES($1,$2,$3,'异常网点预警','abnormal-network-warning','archived','archived',$3,
      'requested-order-complete',$4::jsonb,'reconciliation-required','exact-order-completed','ready')`,
  [workOrderId,shopId,orderNumber,JSON.stringify(initialPayload)]);
  await client.query(`INSERT INTO ordinary_work_order_instances
    (id,work_order_id,shop_id,platform_case_id,platform_case_key,detail_url,work_order_type,
    scenario_code,identity_status,status,runtime_status,current_step,payload,completed_at,completion_method)
    VALUES($1,$2,$3,$4,$5,$6,'异常网点预警','abnormal-network-warning','verified','archived',
      'archived','requested-order-complete',$7::jsonb,now(),'exact-order-completed')`,
  [ordinaryInstanceId,workOrderId,shopId,caseId,`pdd-work-order:${caseId}`,
    `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${caseId}`,JSON.stringify(initialPayload)]);
  await client.query('UPDATE work_orders SET current_ordinary_instance_id=$2 WHERE id=$1', [workOrderId,ordinaryInstanceId]);
  await client.query(`INSERT INTO external_effects
    (id,shop_id,work_order_id,ordinary_instance_id,effect_type,idempotency_key,status,request_hash,receipt)
    VALUES($1,$2,$3,$4,'oms-manual-allocation',$5,'succeeded','fixture','{"result":"unchanged"}')`,
  [crypto.randomUUID(),shopId,workOrderId,ordinaryInstanceId,`fixture:${workOrderId}`]);
  await client.query('SAVEPOINT fixture_baseline');
  const blockCases = [
    ["UPDATE pdd_shop_runtime_bindings SET last_seen_at=now()-interval '3 minutes' WHERE shop_id=$1", [shopId]],
    ["UPDATE shop_identity_bindings SET profile_fingerprint='other' WHERE shop_id=$1", [shopId]],
    ["UPDATE pdd_shop_runtime_bindings SET binding_token=$2 WHERE shop_id=$1", [shopId,crypto.randomUUID()]],
    ["UPDATE ordinary_work_order_instances SET identity_status='legacy-unverified',platform_case_id=NULL,platform_case_key=NULL WHERE id=$1", [ordinaryInstanceId]],
    ["UPDATE external_effects SET status='failed' WHERE work_order_id=$1", [workOrderId]],
    ["UPDATE external_effects SET status='reserved' WHERE work_order_id=$1", [workOrderId]],
    ["UPDATE external_effects SET effect_type='pdd-submit' WHERE work_order_id=$1", [workOrderId]],
    ["UPDATE work_orders SET completion_state='confirmed' WHERE id=$1", [workOrderId]],
    ["UPDATE work_orders SET completion_confirmation_method='absent-from-pending-list' WHERE id=$1", [workOrderId]],
    ["UPDATE work_orders SET scenario_code='consumer-address-change-in-transit' WHERE id=$1", [workOrderId]],
    ["UPDATE work_orders SET payload=payload || '{\"pddResolutionOutcomeMismatch\":{\"status\":\"manual-review-blocked\"}}'::jsonb WHERE id=$1", [workOrderId]],
  ];
  for (const [sql, values] of blockCases) {
    await client.query(sql, values);
    assert.equal(await claim(), null, sql); checks++;
    await reset();
  }
  const beforeEffects = (await client.query('SELECT * FROM external_effects WHERE work_order_id=$1', [workOrderId])).rows;
  const claimed = await claim();
  assert.equal(claimed.id, workOrderId);
  assert.equal(claimed.status, 'paused');
  assert.equal(claimed.runtime_status, 'processing');
  assert.equal(claimed.payload.ordinaryListCompletionReadOnlyRecovery.attempts, 1);
  const instance = (await client.query('SELECT status,runtime_status FROM ordinary_work_order_instances WHERE id=$1', [ordinaryInstanceId])).rows[0];
  assert.equal(instance.status,'paused');
  assert.equal(instance.runtime_status,'processing');
  checks++;
  const payload = { ...claimed.payload, ordinaryListCompletionDetailProof: {
    confirmed: true, orderNumber, observedPlatformWorkOrderId: caseId,
    platformCompletionObservation: { isCompleted:true,orderMatches:true,platformCaseMatches:true },
  } };
  const observation = { state: 'confirmed', effectType:'pdd-list-completion-proof',
    orderNumber, ordinaryInstanceId, observedPlatformWorkOrderId: caseId, observedMallId: mallId,
    confirmationMethod:'detail-completed', readOnly:true, externalActionsReplayed:false,
    observedAt:new Date().toISOString() };
  for (const patch of [{state:'not-applied'},{observedPlatformWorkOrderId:'999999999'},
    {observedMallId:'999999'},{orderNumber:'wrong'}, {ordinaryInstanceId:crypto.randomUUID()},
    {readOnly:false},{externalActionsReplayed:true},{confirmationMethod:'exact-order-completed'},
    {observedAt:'2026-01-01T00:00:00.000Z'}]) {
    await assert.rejects(repository.completeExternalStateReconciliation({
      workOrderId,shopId,ordinaryInstanceId,payload,observation:{...observation,...patch},
    }), /list-completion-read-only-exact-proof-required/u);
    assert.equal((await state()).recovery_state,'reconciling'); checks++;
  }
  await assert.rejects(repository.completeExternalStateReconciliation({workOrderId,shopId,
    ordinaryInstanceId,payload,observation:{...observation,state:'not-applied',effectType:'pdd-state'}}),
  /list-completion-reconciliation-effect-type-mismatch/u); checks++;
  await repository.checkpointExternalStateReconciliation({workOrderId,shopId,ordinaryInstanceId,
    currentStep:'external-state-confirmed',payload:{...payload,ordinaryListCompletionReadOnlyRecovery:null}});
  assert.equal((await state()).payload.ordinaryListCompletionReadOnlyRecovery.protectedReadOnly,true); checks++;
  const complete = await repository.completeExternalStateReconciliation({workOrderId,shopId,
    ordinaryInstanceId,payload,observation});
  assert.equal(complete.completion_state,'confirmed');
  assert.equal(complete.status,'archived');
  assert.equal(complete.completion_confirmation_method,'detail-completed');
  assert.deepEqual((await client.query('SELECT * FROM external_effects WHERE work_order_id=$1',[workOrderId])).rows,beforeEffects);
  assert.equal(await claim(),null); checks++;
  await reset();
  for (let attempt=1;attempt<=2;attempt++) {
    assert.equal((await claim()).payload.ordinaryListCompletionReadOnlyRecovery.attempts,attempt);
    await repository.failExternalStateReconciliation({workOrderId,shopId,ordinaryInstanceId,error:Error('unconfirmed')});
    assert.equal(await claim(),null,'respect 5 minute cooldown');
    await client.query("UPDATE work_orders SET recovery_updated_at=now()-interval '6 minutes' WHERE id=$1",[workOrderId]);
    checks++;
  }
  assert.equal(await claim(),null,'two reads maximum; never place back in normal submission queue'); checks++;
  console.log(`普通工单完结证明数据库 ${checks} 项通过；全部测试事务回滚，无外部操作`);
} finally {
  await client.query('ROLLBACK'); client.release(); await pool.end();
}
