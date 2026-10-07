import crypto from 'node:crypto';
import { createPostgresPool } from '../packages/adapters/src/postgres/index.mjs';

const value = (name) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length).trim() : '';
};

const shopId = value('shop');
const orderNumber = value('order');
const workOrderType = value('title') || '在途无理由退款处理';
const scenarioCode = value('scenario') || 'in-transit-refund';
const dryRun = process.argv.includes('--dry-run');

if (!shopId || !orderNumber) {
  console.error('Usage: node scripts/prepare-gray-run.mjs --shop=<shopId> --order=<orderNumber> [--title=<title>] [--scenario=<code>] [--dry-run]');
  process.exit(2);
}
if (!/^\d[\d-]{5,63}$/.test(orderNumber)) throw new Error('Order number format is invalid');

const pool = await createPostgresPool();
try {
  const shop = await pool.query('SELECT id, enabled FROM shops WHERE id = $1', [shopId]);
  if (!shop.rowCount || !shop.rows[0].enabled) throw new Error(`Enabled shop not found: ${shopId}`);
  const existing = await pool.query(`
    SELECT id, status FROM work_orders
    WHERE shop_id = $1 AND external_order_number = $2 AND work_order_type = $3`,
  [shopId, orderNumber, workOrderType]);
  if (existing.rowCount) {
    const row = existing.rows[0];
    throw new Error(`Work order already exists (${row.id}, status=${row.status}); refusing to requeue or duplicate it`);
  }
  const id = crypto.randomUUID();
  const idempotencyKey = `gray:${shopId}:${orderNumber}:${scenarioCode}`;
  const payload = {
    source: 'manual-gray-run',
    scenarioCode,
    authorization: 'operator-confirmed',
    preparedAt: new Date().toISOString(),
  };
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, shopId, orderNumber, workOrderType, scenarioCode }, null, 2));
  } else {
    await pool.query(`
      INSERT INTO work_orders
        (id, shop_id, external_order_number, work_order_type, scenario_code, status, idempotency_key, current_step, payload)
      VALUES ($1,$2,$3,$4,$5,'queued',$6,'gray-run-ready',$7::jsonb)`,
    [id, shopId, orderNumber, workOrderType, scenarioCode, idempotencyKey, JSON.stringify(payload)]);
    console.log(JSON.stringify({ queued: true, shopId, orderNumber, workOrderType, scenarioCode }, null, 2));
  }
} finally {
  await pool.end();
}
