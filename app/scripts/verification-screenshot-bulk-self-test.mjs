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
const shopId = `verification-delete-${suffix}`;
const workOrderId = crypto.randomUUID();
const verificationIds = [crypto.randomUUID(), crypto.randomUUID()];
const evidenceIds = [crypto.randomUUID(), crypto.randomUUID()];
const pool = await createPostgresPool();

try {
  const displaySlot = Number((await pool.query(`
    SELECT slot FROM generate_series(80, 99) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`)).rows[0]?.slot);
  assert(Number.isInteger(displaySlot), 'no display slot is available for verification deletion self-test');
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled)
    VALUES ($1,$2,$2,$3,false)`, [shopId, `Verification delete self-test ${suffix}`, displaySlot]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload)
    VALUES ($1,$2,$3,'self-test','self-test','archived','archived',$4,'completed','{}'::jsonb)`,
  [workOrderId, shopId, `verification-delete-${suffix}`, `verification-delete:${suffix}`]);
  await pool.query(`
    INSERT INTO evidence_assets
      (id, shop_id, work_order_id, kind, status, object_key, mime_type, deleted_at)
    VALUES
      ($1,$3,$4,'verification-screenshot','available',$5,'image/png',now()),
      ($2,$3,$4,'verification-screenshot','available',$6,'image/png',now())`,
  [evidenceIds[0], evidenceIds[1], shopId, workOrderId,
    `self-test/${evidenceIds[0]}.png`, `self-test/${evidenceIds[1]}.png`]);
  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url, bounding_box,
       screenshot_file_id, confidence, detected_at, resolved_at)
    VALUES
      ($1,$3,$4,'pdd','self-test','resolved','https://example.invalid',
       '{"x":0,"y":0,"width":10,"height":10}'::jsonb,$5,'high',now(),now()),
      ($2,$3,$4,'pdd','self-test','expired','https://example.invalid',
       '{"x":0,"y":0,"width":10,"height":10}'::jsonb,$6,'high',now(),now())`,
  [verificationIds[0], verificationIds[1], shopId, workOrderId, evidenceIds[0], evidenceIds[1]]);

  const unauthorized = await fetch(`${baseUrl}/api/v1/verifications/screenshots/bulk-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: verificationIds, reason: 'unauthorized self-test' }),
  });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.OWNER_USERNAME || 'owner', password }),
  });
  assert.equal(login.status, 200, 'owner login failed');
  const loginBody = await login.json();
  const ownerHeaders = {
    cookie: String(login.headers.get('set-cookie') || '').split(';', 1)[0],
    'content-type': 'application/json',
    'x-csrf-token': loginBody.data.csrfToken,
  };
  const deleted = await fetch(`${baseUrl}/api/v1/verifications/screenshots/bulk-delete`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ ids: verificationIds, reason: 'bulk deletion self-test' }),
  });
  assert.equal(deleted.status, 200);
  const deletedBody = await deleted.json();
  assert.equal(deletedBody.data?.processed, 2);
  assert.equal(deletedBody.data?.deleted, 2);
  assert.equal(Number((await pool.query(`
    SELECT count(*) FROM verification_locations
    WHERE id = ANY($1::uuid[]) AND screenshot_file_id IS NULL`, [verificationIds])).rows[0].count), 2);
  assert.equal(Number((await pool.query(`
    SELECT count(*) FROM evidence_assets
    WHERE id = ANY($1::uuid[]) AND status = 'deleted'`, [evidenceIds])).rows[0].count), 2);
  assert.equal(Number((await pool.query(`
    SELECT count(*) FROM audit_events
    WHERE work_order_id = $1 AND event_type = 'verification-screenshot-deleted'`, [workOrderId])).rows[0].count), 2);
  console.log('verification screenshot bulk deletion self-test passed');
} finally {
  await pool.query('DELETE FROM audit_events WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM verification_locations WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM evidence_assets WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM work_orders WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
  await pool.end();
}
