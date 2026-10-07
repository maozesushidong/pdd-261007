import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(appRoot, '.env.native');
const databaseUrl = process.env.DATABASE_URL || fs.readFileSync(envPath, 'utf8')
  .split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='))
  ?.slice('DATABASE_URL='.length)
  .trim()
  .replace(/^(['"])(.*)\1$/u, '$2');

if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: 'deploy-safety-readonly-audit',
});

try {
  const [ordinary, refunds, effects] = await Promise.all([
    pool.query(`
      SELECT instance.id, instance.shop_id AS "shopId",
        work_order.external_order_number AS "orderNumber",
        instance.current_step AS "currentStep", instance.updated_at AS "updatedAt"
      FROM ordinary_work_order_instances instance
      JOIN work_orders work_order ON work_order.id = instance.work_order_id
      WHERE instance.runtime_status = 'processing'
      ORDER BY instance.updated_at
    `),
    pool.query(`
      SELECT refund.shop_id AS "shopId",
        refund.external_order_number AS "orderNumber",
        refund.aftersale_number AS "aftersaleNumber",
        refund.action_state AS "actionState", refund.updated_at AS "updatedAt"
      FROM return_refunds refund
      WHERE refund.action_state = 'submitting'
      ORDER BY refund.updated_at
    `),
    pool.query(`
      SELECT effect.id, effect.shop_id AS "shopId",
        work_order.external_order_number AS "orderNumber",
        effect.effect_type AS "effectType", effect.status,
        effect.reserved_at AS "reservedAt", effect.updated_at AS "updatedAt"
      FROM external_effects effect
      JOIN work_orders work_order ON work_order.id = effect.work_order_id
      WHERE effect.status IN ('reserved', 'unknown')
      ORDER BY effect.updated_at
    `),
  ]);
  const reservedEffects = effects.rows.filter((effect) => effect.status === 'reserved');
  const unknownEffects = effects.rows.filter((effect) => effect.status === 'unknown');
  const result = {
    checkedAt: new Date().toISOString(),
    safeToRestart: ordinary.rowCount === 0
      && refunds.rowCount === 0
      && reservedEffects.length === 0,
    processingOrdinary: ordinary.rows,
    submittingRefunds: refunds.rows,
    reservedExternalEffects: reservedEffects,
    unknownExternalEffects: unknownEffects,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.safeToRestart) process.exitCode = 2;
} finally {
  await pool.end();
}
