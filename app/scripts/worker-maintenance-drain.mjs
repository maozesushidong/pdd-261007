import fs from 'node:fs';

import pg from 'pg';

const mode = process.argv.includes('--enable')
  ? 'enable'
  : process.argv.includes('--disable')
    ? 'disable'
    : null;
const shopIdArgument = process.argv.find((value) => value.startsWith('--shop-id='));
const shopId = String(shopIdArgument?.slice('--shop-id='.length) || '').trim() || null;

if (!mode) {
  throw new Error(
    'Usage: node scripts/worker-maintenance-drain.mjs --enable|--disable [--shop-id=<id>]',
  );
}

const env = Object.fromEntries(fs.readFileSync('.env.native', 'utf8')
  .split(/\r?\n/u)
  .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/u))
  .filter(Boolean)
  .map((match) => [match[1], match[2].trim().replace(/^(['"])(.*)\1$/u, '$2')]));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || env.DATABASE_URL,
  max: 1,
  application_name: 'worker-maintenance-drain',
});

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");

  if (mode === 'enable') {
    await client.query(`
      INSERT INTO shop_runtime_state (shop_id, status, metadata)
      SELECT shop.id, 'operator-paused', jsonb_build_object(
        'operatorPaused', true,
        'maintenanceDrain', jsonb_build_object(
          'active', true,
          'previousOperatorPaused', false,
          'requestedAt', now()
        )
      )
      FROM shops shop
      WHERE shop.enabled = true
        AND ($1::text IS NULL OR shop.id = $1)
      ON CONFLICT (shop_id) DO UPDATE SET
        status = CASE
          WHEN shop_runtime_state.status IN ('idle', 'operator-paused')
            AND shop_runtime_state.lease_token IS NULL
            AND shop_runtime_state.current_work_order_id IS NULL
          THEN 'operator-paused'
          ELSE shop_runtime_state.status
        END,
        metadata = coalesce(shop_runtime_state.metadata, '{}'::jsonb)
          || jsonb_build_object(
            'operatorPaused', true,
            'maintenanceDrain', coalesce(
              shop_runtime_state.metadata->'maintenanceDrain', '{}'::jsonb
            ) || jsonb_build_object(
              'active', true,
              'previousOperatorPaused', CASE
                WHEN coalesce(
                  (shop_runtime_state.metadata->'maintenanceDrain'->>'active')::boolean,
                  false
                ) THEN coalesce(
                  (shop_runtime_state.metadata->'maintenanceDrain'->>'previousOperatorPaused')::boolean,
                  false
                )
                ELSE shop_runtime_state.status = 'operator-paused'
                  OR coalesce((shop_runtime_state.metadata->>'operatorPaused')::boolean, false)
              END,
              'requestedAt', coalesce(
                shop_runtime_state.metadata->'maintenanceDrain'->'requestedAt',
                to_jsonb(now())
              )
            )
          ),
        updated_at = now()`, [shopId]);
  } else {
    const pendingSwaps = (await client.query(`
      SELECT metadata->'maintenanceDrain'->>'reloadFromProcessId' AS "oldProcessId"
      FROM shop_runtime_state
      WHERE coalesce((metadata->'maintenanceDrain'->>'active')::boolean, false)
        AND ($1::text IS NULL OR shop_id = $1)
      FOR UPDATE`, [shopId])).rows;
    for (const swap of pendingSwaps) {
      const pid = Number(swap.oldProcessId);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        throw new Error(`Cannot release maintenance drain while old Worker ${pid} is alive`);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await client.query(`
      UPDATE shop_runtime_state
      SET status = CASE
            WHEN status = 'operator-paused'
              AND lease_token IS NULL
              AND current_work_order_id IS NULL
              AND NOT coalesce(
                (metadata->'maintenanceDrain'->>'previousOperatorPaused')::boolean,
                false
              )
            THEN 'idle'
            ELSE status
          END,
          metadata = (coalesce(metadata, '{}'::jsonb) - 'maintenanceDrain')
          || jsonb_build_object(
            'operatorPaused', coalesce(
              (metadata->'maintenanceDrain'->>'previousOperatorPaused')::boolean,
              false
            )
          ),
        updated_at = now()
      WHERE coalesce((metadata->'maintenanceDrain'->>'active')::boolean, false)
        AND ($1::text IS NULL OR shop_id = $1)`, [shopId]);
  }

  const state = await client.query(`
    SELECT shop.name AS "shopName", runtime.status,
      coalesce((runtime.metadata->>'operatorPaused')::boolean, false) AS "operatorPaused",
      coalesce((runtime.metadata->'maintenanceDrain'->>'active')::boolean, false)
        AS "maintenanceDrain",
      runtime.current_work_order_id AS "currentWorkOrderId",
      runtime.lease_expires_at AS "leaseExpiresAt"
    FROM shops shop
    JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
    WHERE shop.enabled = true
    ORDER BY shop.created_at, shop.id`);

  await client.query('COMMIT');
  console.log(JSON.stringify({
    mode,
    shopId,
    checkedAt: new Date().toISOString(),
    shops: state.rows,
  }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
