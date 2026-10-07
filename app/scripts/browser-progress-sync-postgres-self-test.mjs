import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createPostgresPool,
  PostgresWorkflowRepository,
} from '../packages/adapters/src/postgres/index.mjs';

const pool = await createPostgresPool(undefined, {
  applicationName: 'browser-progress-sync-self-test',
});
const repository = new PostgresWorkflowRepository(pool);
const suffix = crypto.randomUUID().slice(0, 8);
const shopId = `progress-sync-test-${suffix}`;
const workOrderId = crypto.randomUUID();
const leaseToken = crypto.randomUUID();
const orderNumber = `progress-sync-${suffix}`;

try {
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,slot,false,'disabled'
    FROM generate_series(0, 999) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [shopId, `Progress sync self-test ${suffix}`]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code,
       status, runtime_status, idempotency_key, current_step, payload)
    VALUES ($1,$2,$3,'self-test','self-test','processing','processing',$4,$5,$6::jsonb)`, [
    workOrderId,
    shopId,
    orderNumber,
    `progress-sync:${suffix}`,
    'browser-step-old',
    JSON.stringify({
      shopId,
      orderNumber,
      step: 'browser-step-old',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }),
  ]);
  await pool.query(`
    INSERT INTO shop_runtime_state
      (shop_id, worker_id, status, lease_token, lease_expires_at, current_work_order_id)
    VALUES ($1,$2,'processing',$3,now() + interval '5 minutes',$4)`, [
    shopId,
    `progress-sync-worker-${suffix}`,
    leaseToken,
    workOrderId,
  ]);

  const newer = {
    shopId,
    orderNumber,
    step: 'browser-step-new',
    updatedAt: '2026-08-20T00:00:02.000Z',
  };
  assert.equal(await repository.checkpointClaimed({
    shopId,
    workOrderId,
    leaseToken,
    currentStep: newer.step,
    payload: newer,
  }), true);

  const lateOlder = {
    shopId,
    orderNumber,
    step: 'browser-step-late-old',
    updatedAt: '2026-08-20T00:00:01.000Z',
  };
  assert.equal(await repository.checkpointClaimed({
    shopId,
    workOrderId,
    leaseToken,
    currentStep: lateOlder.step,
    payload: lateOlder,
  }), false);

  const state = await pool.query(`
    SELECT work_order.current_step, work_order.payload->>'updatedAt' AS payload_updated_at,
      checkpoint.current_step AS checkpoint_step,
      checkpoint.source_updated_at AS checkpoint_updated_at
    FROM work_orders work_order
    LEFT JOIN workflow_checkpoints checkpoint
      ON checkpoint.shop_id = work_order.shop_id
    WHERE work_order.id = $1`, [workOrderId]);
  assert.equal(state.rows[0]?.current_step, newer.step);
  assert.equal(state.rows[0]?.payload_updated_at, newer.updatedAt);
  assert.equal(state.rows[0]?.checkpoint_step, newer.step);
  assert.equal(new Date(state.rows[0]?.checkpoint_updated_at).toISOString(), newer.updatedAt);

  console.log('browser progress PostgreSQL monotonic sync self-test passed');
} finally {
  await pool.query('DELETE FROM workflow_checkpoints WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM shop_runtime_state WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM work_orders WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
  await pool.end().catch(() => {});
}
