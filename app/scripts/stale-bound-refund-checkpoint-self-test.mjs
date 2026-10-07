import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import pg from 'pg';

const temporaryTableMode = process.env.PDD_SAFE_TEMP_TABLE_TEST === '1';
if (!temporaryTableMode) {
  assert.match(new URL(process.env.DATABASE_URL).pathname,
    /^\/pdd_refund_test_[a-f0-9]{12}$/u);
}
const { PostgresWorkflowRepository } = await import(
  '../packages/adapters/src/postgres/index.mjs');
let pool;
if (temporaryTableMode) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
    application_name: 'stale-bound-refund-temp-table-self-test' });
  await client.connect();
  const tableNames = [
    'shops', 'work_orders', 'return_refunds', 'verification_locations',
    'workflow_checkpoints', 'shop_runtime_state', 'external_effects',
    'manual_interventions', 'notification_outbox', 'audit_events',
  ];
  for (const name of tableNames) {
    await client.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
  }
  await client.query('SET search_path TO pg_temp');
  assert.equal((await client.query('SHOW search_path')).rows[0].search_path,
    'pg_temp', 'the fixture must never fall back to production tables');
  for (const name of tableNames) {
    const resolvedSchema = (await client.query(`
      SELECT namespace.nspname AS schema_name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.oid = to_regclass($1)`, [name])).rows[0]?.schema_name;
    assert.match(resolvedSchema || '', /^pg_temp_\d+$/u,
      `test table ${name} must resolve only in the session temp schema`);
  }
  client.release = () => {};
  pool = {
    connect: async () => client,
    query: (...args) => client.query(...args),
    end: () => client.end(),
  };
} else {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}
const repository = new PostgresWorkflowRepository(pool);

const fixture = async () => {
  const shopId = `stale-refund-${crypto.randomUUID().slice(0, 8)}`;
  const workOrderId = crypto.randomUUID();
  const verificationId = crypto.randomUUID();
  const orderNumber = `test-${crypto.randomUUID()}`;
  const detectedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const authenticatedAt = new Date(Date.now() - 60_000).toISOString();
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1, $1, $1, slot, false, 'disabled'
    FROM generate_series(0, 99) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [shopId]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code,
       status, runtime_status, current_step, recovery_state, payload, idempotency_key)
    VALUES ($1, $2, $3, '退货退款', 'return-refund', 'retry-ready', 'waiting',
      'return-refund-verification-required', 'ready', '{}'::jsonb, $4)`, [
    workOrderId, shopId, orderNumber, `stale-refund:${workOrderId}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       action_state, next_check_at)
    VALUES ($1, $2, $3, $4, 'verification-required', now() + interval '10 minutes')`, [
    workOrderId, shopId, orderNumber, String(Date.now()) + crypto.randomInt(1000),
  ]);
  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url,
       bounding_box, confidence, detected_at)
    VALUES ($1, $2, $3, 'pdd', 'return-refund-detail-ready-before',
      'waiting-human', 'https://mms.pinduoduo.com/aftersales-ssr/detail',
      '{}'::jsonb, 'high', $4)`, [
    verificationId, shopId, workOrderId, detectedAt,
  ]);
  await pool.query(`
    INSERT INTO workflow_checkpoints
      (shop_id, work_order_id, current_step, runtime_status, snapshot,
       source_hash, source_updated_at)
    VALUES ($1, $2, 'human-verification-required', 'verification', $3::jsonb,
      'test', now() - interval '30 seconds')`, [
    shopId, workOrderId,
    JSON.stringify({ verificationLocation: { id: verificationId } }),
  ]);
  const reconcile = () => repository.resolveStaleBoundPddVerificationGate({
    shopId, verificationId, workOrderId, detectedAt, authenticatedAt,
    runtimeObservedAt: new Date().toISOString(),
    observedUrl: 'https://mms.pinduoduo.com/aftersales/work_order/list',
  });
  return { shopId, workOrderId, verificationId, authenticatedAt, reconcile };
};

try {
  const stale = await fixture();
  assert.equal(await stale.reconcile(), null,
    'a challenge snapshot newer than the authenticated observation stays blocked');
  await pool.query(`
    UPDATE workflow_checkpoints SET source_updated_at = $2::timestamptz - interval '1 minute'
    WHERE shop_id = $1`, [stale.shopId, stale.authenticatedAt]);
  const resolved = await stale.reconcile();
  assert.equal(resolved?.verificationResolved, true,
    'only the exact challenge snapshot older than authenticated evidence may clear');
  assert.equal(resolved?.requeued, true);
  const cleared = (await pool.query(`
    SELECT v.status AS verification_status, w.current_step, r.action_state,
      r.next_check_at <= now() AS refund_due
    FROM verification_locations v
    JOIN work_orders w ON w.id = v.work_order_id
    JOIN return_refunds r ON r.work_order_id = w.id
    WHERE v.id = $1`, [stale.verificationId])).rows[0];
  assert.deepEqual(cleared, {
    verification_status: 'resolved',
    current_step: 'verification-cleared-retry-ready',
    action_state: 'verification-required',
    refund_due: true,
  });
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM external_effects WHERE work_order_id = $1',
    [stale.workOrderId])).rows[0].count, 0,
  'reconciliation must not create or replay an external refund effect');

  const uncertain = await fixture();
  await pool.query(`
    UPDATE workflow_checkpoints SET source_updated_at = $2::timestamptz - interval '1 minute'
    WHERE shop_id = $1`, [uncertain.shopId, uncertain.authenticatedAt]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
    VALUES ($1, $2, $3, 'pdd-return-refund', $4, 'unknown', 'test')`, [
    crypto.randomUUID(), uncertain.shopId, uncertain.workOrderId,
    `unknown:${uncertain.workOrderId}`,
  ]);
  assert.equal(await uncertain.reconcile(), null,
    'an unknown external refund effect must keep the gate blocked');
  console.log('stale bound refund checkpoint recovery passed');
} finally {
  await pool.end();
}
