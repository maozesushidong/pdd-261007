import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'cross-shop-effect-read-only-audit' });
await client.connect();
try {
  const result = await client.query(`
    SELECT effect.shop_id AS effect_shop_id,
      work_order.shop_id AS work_order_shop_id,
      effect.effect_type, effect.status, effect.idempotency_key,
      work_order.external_order_number AS order_number,
      work_order.scenario_code,
      work_order.current_step,
      effect.ordinary_instance_id::text AS effect_instance_id,
      work_order.current_ordinary_instance_id::text AS current_instance_id,
      effect.updated_at,
      (
        SELECT jsonb_agg(jsonb_build_object(
          'eventType', audit.event_type,
          'createdAt', audit.created_at,
          'previousShopId', audit.payload->>'previousShopId'
        ) ORDER BY audit.created_at)
        FROM audit_events audit
        WHERE audit.work_order_id = work_order.id
          AND audit.event_type = 'pending-ordinary-work-order-shop-corrected'
      ) AS relocation_events
    FROM external_effects effect
    JOIN work_orders work_order ON work_order.id = effect.work_order_id
    WHERE effect.shop_id <> work_order.shop_id
       OR (
         effect.idempotency_key LIKE '%:shop-%'
         AND effect.idempotency_key NOT LIKE '%:' || effect.shop_id || ':%'
       )
    ORDER BY effect.updated_at DESC
    LIMIT 100`);
  const grouped = {};
  for (const row of result.rows) {
    const key = `${row.effect_type}:${row.status}`;
    grouped[key] = (grouped[key] || 0) + 1;
  }
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    limitedTo: 100,
    rows: result.rows.length,
    grouped,
    examples: result.rows.slice(0, 30),
  }, null, 2));
} finally {
  await client.end();
}
