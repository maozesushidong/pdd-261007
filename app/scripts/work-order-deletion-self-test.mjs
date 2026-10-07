import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../packages/adapters/src/postgres/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = String(process.env.OWNER_SELF_TEST_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const passwordFile = path.resolve(process.env.OWNER_INITIAL_PASSWORD_FILE
  || path.join(root, 'secrets', 'staging', 'OWNER_INITIAL_PASSWORD'));
const password = (await fsp.readFile(passwordFile, 'utf8')).trim();
const suffix = crypto.randomUUID().slice(0, 8);
const shopId = `delete-selftest-${suffix}`;
const deletableId = crypto.randomUUID();
const blockedId = crypto.randomUUID();
const effectId = crypto.randomUUID();
const deletableOrderNumber = `delete-ok-${suffix}`;
const blockedOrderNumber = `delete-blocked-${suffix}`;
const pool = await createPostgresPool();

try {
  const displaySlot = Number((await pool.query(`
    SELECT slot FROM generate_series(80, 99) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`)).rows[0]?.slot);
  assert(Number.isInteger(displaySlot), 'no display slot is available for the deletion self-test');
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled)
    VALUES ($1,$2,$2,$3,false)`, [shopId, `Delete self-test ${suffix}`, displaySlot]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload)
    VALUES
      ($1,$3,$4,'self-test','self-test','queued','queued',$6,'queued','{}'::jsonb),
      ($2,$3,$5,'self-test','self-test','queued','queued',$7,'queued','{}'::jsonb)`,
  [deletableId, blockedId, shopId, deletableOrderNumber, blockedOrderNumber,
    `delete-ok:${suffix}`, `delete-blocked:${suffix}`]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,'pdd-submit',$4,'unknown','self-test')`,
  [effectId, shopId, blockedId, `delete-effect:${suffix}`]);

  const unauthorized = await fetch(`${baseUrl}/api/v1/work-orders/bulk-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [deletableId], reason: 'unauthorized self-test' }),
  });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.OWNER_USERNAME || 'owner', password }),
  });
  assert.equal(login.status, 200, 'owner login failed');
  const loginBody = await login.json();
  const cookie = String(login.headers.get('set-cookie') || '').split(';', 1)[0];
  const ownerHeaders = {
    cookie,
    'content-type': 'application/json',
    'x-csrf-token': loginBody.data.csrfToken,
  };

  const deleted = await fetch(`${baseUrl}/api/v1/work-orders/bulk-delete`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ ids: [deletableId], reason: 'automated deletion self-test' }),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).data?.deleted, 1);
  const deletedRow = await pool.query(`
    SELECT status, runtime_status, current_step, recovery_state, recovery_reason,
      frontend_visibility, payload->'ownerDeletion' AS deletion
    FROM work_orders WHERE id = $1`, [deletableId]);
  assert.equal(deletedRow.rows[0].status, 'archived');
  assert.equal(deletedRow.rows[0].runtime_status, 'archived');
  assert.equal(deletedRow.rows[0].current_step, 'owner-deleted');
  assert.equal(deletedRow.rows[0].recovery_state, 'held');
  assert.equal(deletedRow.rows[0].recovery_reason, 'owner-deleted');
  assert.equal(deletedRow.rows[0].frontend_visibility, 'recovery-audit');
  assert.equal(deletedRow.rows[0].deletion.reason, 'automated deletion self-test');
  const hidden = await fetch(`${baseUrl}/api/v1/work-orders?${new URLSearchParams({ q: deletableOrderNumber })}`);
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json()).total, 0);
  assert.equal(Number((await pool.query(`
    SELECT count(*) FROM audit_events
    WHERE work_order_id = $1 AND event_type = 'work-order-owner-deleted'`, [deletableId])).rows[0].count), 1);

  const blocked = await fetch(`${baseUrl}/api/v1/work-orders/bulk-delete`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ ids: [blockedId], reason: 'blocked deletion self-test' }),
  });
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error, 'work-order-delete-blocked');
  assert(blockedBody.blockers.some((item) => item.id === blockedId && item.reason === 'unknown-external-effect'));
  assert.equal((await pool.query('SELECT frontend_visibility FROM work_orders WHERE id = $1', [blockedId])).rows[0].frontend_visibility, 'operational');

  console.log('owner work-order deletion self-test passed');
} finally {
  await pool.query('DELETE FROM external_effects WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM audit_events WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM work_orders WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
  await pool.end();
}
