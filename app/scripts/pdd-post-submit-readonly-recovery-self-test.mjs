import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

if (process.env.PDD_ROLLBACK_SELF_TEST !== '1') {
  throw new Error('Set PDD_ROLLBACK_SELF_TEST=1 for this rollback-only database test');
}

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
const shopId = `pdd-post-submit-test-${suffix}`;
const shopName = `PDD post-submit fixture ${suffix}`;
const mallId = `9${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
const fingerprint = `fixture-profile-${suffix}`;
const token = crypto.randomUUID();
const orderNumber = `260926-000000${suffix.replace(/[^0-9]/g, '0').padEnd(9, '0')}`;
const caseId = `5000199${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
const submittedOption = '物流可以更新，能送达';
const pool = await createPostgresPool();
const client = await pool.connect();
await client.query('BEGIN');
let savepoint = 0;
const nested = [];
const query = async (sql, values) => {
  const command = String(sql).trim().toUpperCase();
  if (command === 'BEGIN') {
    const name = `pdd_post_submit_readonly_${++savepoint}`;
    nested.push(name);
    return client.query(`SAVEPOINT ${name}`);
  }
  if (command === 'COMMIT') {
    return client.query(`RELEASE SAVEPOINT ${nested.pop()}`);
  }
  if (command === 'ROLLBACK') {
    const name = nested.pop();
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return client.query(`RELEASE SAVEPOINT ${name}`);
  }
  return client.query(sql, values);
};
const repository = new PostgresWorkflowRepository({
  connect: async () => ({ query, release() {} }), query,
});

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
    `mall:${mallId}`, shopId, shopName, mallId, token, fingerprint,
  ]);
  await client.query(`
    INSERT INTO shop_identity_bindings
      (shop_id, expected_shop_name, mall_id, profile_fingerprint, status, confirmed_by)
    VALUES ($1,$2,$3,$4,'confirmed','self-test')`, [
    shopId, shopName, mallId, fingerprint,
  ]);
  const source = { id: crypto.randomUUID(),
    current_ordinary_instance_id: crypto.randomUUID() };
  const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${caseId}`;
  const reason = '拼多多resolution-refresh-ordinary-list-query-controls刷新后等待 30000 毫秒仍未出现有效结果';
  const payload = { detailUrl,
    latestDiscovery: { pddIdentityBindingToken: token },
  };
  await client.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code,
       status, runtime_status, idempotency_key, current_step,
       manual_review_reason, payload, completion_state, recovery_state)
    VALUES ($1,$2,$3,'普通工单','delivery-risk-concern',
      'paused','paused',$3,'flow-paused',$4,$5::jsonb,'pending','ready')`, [
    source.id, shopId, orderNumber, reason, JSON.stringify(payload),
  ]);
  await client.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       detail_url, work_order_type, scenario_code, identity_status,
       status, runtime_status, current_step, manual_review_reason, payload)
    VALUES ($1,$2,$3,$4,$5,$6,'普通工单','delivery-risk-concern','verified',
      'paused','paused','flow-paused',$7,$8::jsonb)`, [
    source.current_ordinary_instance_id, source.id, shopId, caseId,
    `pdd-work-order:${caseId}`, detailUrl, reason, JSON.stringify(payload),
  ]);
  await client.query(`UPDATE work_orders SET current_ordinary_instance_id = $2
    WHERE id = $1`, [source.id, source.current_ordinary_instance_id]);
  await client.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
       idempotency_key, status, request_hash, receipt)
    VALUES ($1,$2,$3,$4,'pdd-submit',$5,'succeeded','fixture',$6::jsonb)`, [
    crypto.randomUUID(), shopId, source.id, source.current_ordinary_instance_id,
    `pdd-submit:${shopId}:pdd-work-order:${caseId}:fixture:result`,
    JSON.stringify({ result: {
      submitReceipt: { success: true, clickAttempted: true,
        requestCaptured: true, responseCaptured: true, httpStatus: 200,
        requestUrl: 'https://mms.pinduoduo.com/latitude/mallTicket/submitForm' },
      selectionProof: { orderNumber, submitContext: { selectedPddOption: submittedOption } },
    } }),
  ]);
  assert.deepEqual(await repository.recoverSafeUnconfirmedPddSubmissions({
    shopId, pddAuthenticated: false,
  }), [], 'unauthenticated PDD cannot enter the protected recovery');
  await client.query(`UPDATE pdd_shop_runtime_bindings
    SET last_seen_at = now() - interval '11 minutes' WHERE shop_id = $1`, [shopId]);
  assert.deepEqual(await repository.recoverSafeUnconfirmedPddSubmissions({
    shopId, pddAuthenticated: true,
  }), [], 'stale shop identity cannot enter the protected recovery');
  await client.query(`UPDATE pdd_shop_runtime_bindings
    SET last_seen_at = now() WHERE shop_id = $1`, [shopId]);
  await client.query(`UPDATE shop_identity_bindings SET profile_fingerprint = 'wrong'
    WHERE shop_id = $1`, [shopId]);
  assert.deepEqual(await repository.recoverSafeUnconfirmedPddSubmissions({
    shopId, pddAuthenticated: true,
  }), [], 'a different confirmed profile cannot recover the order');
  await client.query(`UPDATE shop_identity_bindings SET profile_fingerprint = $2
    WHERE shop_id = $1`, [shopId, fingerprint]);
  await client.query(`UPDATE external_effects SET status = 'unknown'
    WHERE work_order_id = $1`, [source.id]);
  assert.deepEqual(await repository.recoverSafeUnconfirmedPddSubmissions({
    shopId, pddAuthenticated: true,
  }), [], 'unknown submits must remain protected');
  await client.query(`UPDATE external_effects SET status = 'succeeded'
    WHERE work_order_id = $1`, [source.id]);

  const recovered = await repository.recoverSafeUnconfirmedPddSubmissions({
    shopId, pddAuthenticated: true,
  });
  assert.deepEqual(recovered.map((row) => row.id), [source.id]);
  const row = (await client.query(`
    SELECT status, current_step, recovery_state,
      payload #>> '{externalStateReconciliationTarget,protectedReadOnly}' AS protected,
      payload #>> '{externalStateReconciliationTarget,maximumAutomaticSubmitAttempts}' AS max_attempts,
      payload #>> '{externalStateReconciliationTarget,submittedOption}' AS submitted_option,
      payload #>> '{pddResolutionSubmission,submitClicked}' AS clicked
    FROM work_orders WHERE id = $1`, [source.id])).rows[0];
  assert.equal(row.status, 'paused');
  assert.equal(row.current_step, 'external-state-reconciliation-ready');
  assert.equal(row.protected, 'true');
  assert.equal(row.max_attempts, '1');
  assert.equal(row.clicked, 'true');
  assert.ok(row.submitted_option);
  const claim = await repository.getWorkOrderForReconciliation({
    workOrderId: source.id, shopId,
  });
  assert.equal(claim.pdd_submit_reconciliation_target.protectedReadOnly, true);
  assert.equal(claim.pdd_submit_reconciliation_target.maximumAutomaticSubmitAttempts, 1);
  assert.equal(claim.pdd_submit_reconciliation_target.submittedOption, submittedOption);

  await client.query(`UPDATE work_orders SET recovery_state = 'reconciling'
    WHERE id = $1`, [source.id]);
  assert.equal(await repository.checkpointExternalStateReconciliation({
    workOrderId: source.id, shopId,
    ordinaryInstanceId: source.current_ordinary_instance_id,
    currentStep: 'external-state-reconciling',
    payload: { step: 'external-state-reconciling' },
  }), true);
  const afterIncompleteCheckpoint = (await client.query(`
    SELECT payload #>> '{externalStateReconciliationTarget,protectedReadOnly}'
        AS protected,
      payload #>> '{pddResolutionSubmission,maximumAutomaticSubmitAttempts}'
        AS max_attempts
    FROM work_orders WHERE id = $1`, [source.id])).rows[0];
  assert.equal(afterIncompleteCheckpoint.protected, 'true');
  assert.equal(afterIncompleteCheckpoint.max_attempts, '1');
  const base = { effectType: 'pdd-submit', orderNumber, readOnly: true,
    observedAt: new Date().toISOString() };
  for (const observation of [
    { ...base, state: 'not-applied', confirmationMethod: 'present-in-pending-list' },
    { ...base, state: 'confirmed', confirmationMethod: 'absent-from-pending-list' },
    { ...base, state: 'confirmed', confirmationMethod: 'detail-completed',
      completionEvidence: 'different-outcome' },
  ]) {
    await assert.rejects(repository.completeExternalStateReconciliation({
      workOrderId: source.id, shopId,
      ordinaryInstanceId: source.current_ordinary_instance_id,
      observation, payload: {},
    }), /protected-pdd-submit-read-only-proof-insufficient/);
  }
  const unresolved = await repository.completeExternalStateReconciliation({
    workOrderId: source.id, shopId,
    ordinaryInstanceId: source.current_ordinary_instance_id,
    observation: { ...base, state: 'unresolved' }, payload: {},
  });
  assert.equal(unresolved.status, 'paused');
  assert.equal(unresolved.recovery_state, 'held');
  assert.equal(unresolved.payload.externalStateReconciliationTarget.protectedReadOnly, true);
  assert.equal(unresolved.payload.pddResolutionSubmission.maximumAutomaticSubmitAttempts, 1);
  await client.query(`UPDATE work_orders SET recovery_state = 'reconciling'
    WHERE id = $1`, [source.id]);
  const completed = await repository.completeExternalStateReconciliation({
    workOrderId: source.id, shopId,
    ordinaryInstanceId: source.current_ordinary_instance_id,
    observation: { ...base, state: 'confirmed',
      confirmationMethod: 'detail-completed',
      protectedReadOnlyExactDetail: true,
      completionEvidence: row.submitted_option },
    payload: {},
  });
  assert.equal(completed.status, 'archived');
  const effects = (await client.query(`SELECT effect_type, status FROM external_effects
    WHERE work_order_id = $1 AND ordinary_instance_id = $2`,
  [source.id, source.current_ordinary_instance_id])).rows;
  assert(effects.some((effect) => effect.effect_type === 'pdd-submit'
    && effect.status === 'succeeded'));
  assert(!effects.some((effect) => effect.status === 'failed'
    || effect.status === 'reserved' || effect.status === 'unknown'));
  console.log(JSON.stringify({ passed: true, transaction: 'rollback',
    recovered: 1, noResubmitGuards: 3 }));
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
