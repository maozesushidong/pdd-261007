import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

// Test against the current schema without creating a database or committing
// fixtures. The repository's nested transaction is mapped to a savepoint.
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databaseLine = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8')
  .split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'verification-requeue-rollback-self-test' });
await client.connect();
let transactionOpen = false;
try {
  await client.query('BEGIN');
  transactionOpen = true;
  const shopId = `verification-rollback-${crypto.randomUUID().slice(0, 8)}`;
  const slot = (await client.query(`
    SELECT candidate AS slot FROM generate_series(50, 999) candidate
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = candidate)
    ORDER BY candidate LIMIT 1`)).rows[0]?.slot;
  if (slot == null) throw new Error('No unused shop slot for rollback fixture');
  await client.query(`
    INSERT INTO shops(id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    VALUES($1, $1, $1, $2, false, 'disabled')`, [shopId, slot]);

  const addOrder = async ({ ageSeconds, scanAfterSeconds }) => {
    const id = crypto.randomUUID();
    const verificationId = crypto.randomUUID();
    await client.query(`
      INSERT INTO work_orders
        (id, shop_id, external_order_number, work_order_type, scenario_code,
         status, runtime_status, current_step, next_attempt_at, payload, idempotency_key)
      VALUES($1::uuid, $2, ($1::uuid)::text, '退货退款', 'return-refund',
        'retry-ready', 'waiting', 'return-refund-verification-required',
        now() + interval '10 minutes', '{}', 'verification-rollback:' || ($1::uuid)::text)`,
    [id, shopId]);
    await client.query(`
      INSERT INTO verification_locations
        (id, shop_id, work_order_id, system_name, stage, status, url,
         bounding_box, confidence, detected_at, resolved_at)
      VALUES($1::uuid, $2, $3::uuid, 'pdd', 'return-refund-detail-load-initial',
        'resolved', 'https://mms.pinduoduo.com/aftersales-ssr/detail',
        '{}', 'high', now() - interval '2 minutes',
        now() - ($4::int * interval '1 second'))`,
    [verificationId, shopId, id, ageSeconds]);
    await client.query(`
      INSERT INTO return_refunds
        (work_order_id, shop_id, external_order_number, aftersale_number,
         decision, action_state, next_check_at, last_scanned_at)
      VALUES($1::uuid, $2, ($1::uuid)::text, ($1::uuid)::text,
        'verification-required', 'verification-required',
        now() + interval '10 minutes',
        now() - ($3::int * interval '1 second') + ($4::int * interval '1 second'))`,
    [id, shopId, ageSeconds, scanAfterSeconds]);
    return id;
  };

  const sameAttempt = await addOrder({ ageSeconds: 20, scanAfterSeconds: 20 });
  const laterCheck = await addOrder({ ageSeconds: 60, scanAfterSeconds: 60 });
  const other = await addOrder({ ageSeconds: 1, scanAfterSeconds: 1 });
  const dryPool = { connect: async () => ({
    query: (sql, ...args) => {
      const statement = String(sql).trim();
      if (statement === 'BEGIN') return client.query('SAVEPOINT repository_call');
      if (statement === 'COMMIT') return client.query('RELEASE SAVEPOINT repository_call');
      if (statement === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT repository_call');
      return client.query(sql, ...args);
    },
    release: () => {},
  }) };
  const repository = new PostgresWorkflowRepository(dryPool);
  const requeued = await repository.requeueResolvedVerificationWorkOrders({
    shopId, workOrderId: sameAttempt, limit: 1,
  });
  assert.deepEqual(requeued.map((row) => row.workOrderId), [sameAttempt]);
  assert.equal((await repository.requeueResolvedVerificationWorkOrders({
    shopId, workOrderId: sameAttempt, limit: 1,
  })).length, 0, 'one resolved gate can only requeue once');
  assert.equal((await repository.requeueResolvedVerificationWorkOrders({
    shopId, workOrderId: laterCheck, limit: 1,
  })).length, 0, 'a later refund check invalidates the old clear');
  assert.equal((await client.query('SELECT current_step FROM work_orders WHERE id=$1', [other]))
    .rows[0].current_step, 'return-refund-verification-required',
  'targeted recovery does not change another order');
  console.log('verification rollback test passed: same attempt, one-shot, later check, exact order');
} finally {
  if (transactionOpen) await client.query('ROLLBACK');
  await client.end();
}
