import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databaseLine = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8')
  .split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const shopId = `maintenance-drain-test-${crypto.randomUUID().slice(0, 8)}`;
const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'maintenance-drain-self-test' });
const runDrain = (mode) => spawnSync(process.execPath, [
  path.join(appRoot, 'scripts', 'worker-maintenance-drain.mjs'),
  mode, `--shop-id=${shopId}`,
], { cwd: appRoot, encoding: 'utf8', timeout: 15_000 });

await client.connect();
try {
  const inserted = await client.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1, $2, $2, slot, false, 'disabled'
    FROM generate_series(0, 99) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1 RETURNING id`, [shopId, shopId]);
  assert.equal(inserted.rowCount, 1);
  await client.query(`
    INSERT INTO shop_runtime_state (shop_id, status, metadata)
    VALUES ($1, 'operator-paused', jsonb_build_object(
      'operatorPaused', true,
      'maintenanceDrain', jsonb_build_object(
        'active', true, 'previousOperatorPaused', false,
        'reloadFromProcessId', $2::int
      )
    ))`, [shopId, process.pid]);

  const refused = runDrain('--disable');
  assert.notEqual(refused.status, 0,
    'drain release must be refused while the old Worker PID is still alive');
  assert.match(refused.stderr, /Cannot release maintenance drain/u);
  const held = await client.query(`
    SELECT status, metadata->'maintenanceDrain'->>'active' AS active
    FROM shop_runtime_state WHERE shop_id = $1`, [shopId]);
  assert.equal(held.rows[0].status, 'operator-paused');
  assert.equal(held.rows[0].active, 'true');

  await client.query(`
    UPDATE shop_runtime_state
    SET metadata = jsonb_set(metadata,
      '{maintenanceDrain,reloadFromProcessId}', '99999999'::jsonb)
    WHERE shop_id = $1`, [shopId]);
  const released = runDrain('--disable');
  assert.equal(released.status, 0, released.stderr);
  const idle = await client.query(`
    SELECT status, metadata->>'operatorPaused' AS paused,
      metadata ? 'maintenanceDrain' AS "hasDrain"
    FROM shop_runtime_state WHERE shop_id = $1`, [shopId]);
  assert.equal(idle.rows[0].status, 'idle');
  assert.equal(idle.rows[0].paused, 'false');
  assert.equal(idle.rows[0].hasDrain, false);
  console.log('maintenance drain process-exit guard self-test passed');
} finally {
  await client.query('DELETE FROM shop_runtime_state WHERE shop_id = $1', [shopId])
    .catch(() => {});
  await client.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
  await client.end();
}
