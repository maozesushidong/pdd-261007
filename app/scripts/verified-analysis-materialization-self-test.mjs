import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { materializeVerifiedAnalysisSnapshots } from '../packages/adapters/src/postgres/index.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const line = fs.readFileSync(path.join(root, '.env.native'), 'utf8')
  .split(/\r?\n/u).find((value) => value.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || line?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'verified-analysis-materialization-self-test' });
const workOrderId = '00000000-0000-4000-8000-000000000891';
const instanceId = '00000000-0000-4000-8000-000000000892';
const orderNumber = '260924-111111111111111';
const payload = {
  latestDiscovery: { platformCaseId: '500013400000001' },
  omsAnalysis: { orderNumber, warehouseStatus: 'confirmed', shippingWarehouse: '测试仓' },
  logisticsAnalysis: { orderNumber, carrier: '测试物流', trackingNumber: 'test-tracking' },
};
const input = { shopId: 'test-shop', workOrderId, payload };

await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE work_orders (
    id uuid PRIMARY KEY, shop_id text, external_order_number text,
    scenario_code text, frontend_visibility text,
    current_ordinary_instance_id uuid, payload jsonb
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE ordinary_work_order_instances (
    id uuid PRIMARY KEY, work_order_id uuid, shop_id text,
    identity_status text, platform_case_id text
  ) ON COMMIT DROP`);
  for (const table of ['oms_analyses', 'logistics_analyses']) {
    await client.query(`CREATE TEMP TABLE ${table} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      work_order_id uuid, ordinary_instance_id uuid,
      payload jsonb, source_hash text,
      UNIQUE (work_order_id, ordinary_instance_id, source_hash)
    ) ON COMMIT DROP`);
  }
  await client.query(`INSERT INTO work_orders VALUES
    ($1,'test-shop',$2,'abnormal-network-warning','operational',$3,$4::jsonb)`,
  [workOrderId, orderNumber, instanceId, JSON.stringify(payload)]);
  await client.query(`INSERT INTO ordinary_work_order_instances VALUES
    ($1,$2,'test-shop','pending','500013400000001')`, [instanceId, workOrderId]);
  assert.deepEqual(await materializeVerifiedAnalysisSnapshots(client, input),
    { oms: false, logistics: false }, 'unverified identity must not materialize analyses');

  await client.query(`UPDATE ordinary_work_order_instances SET identity_status='verified'`);
  await client.query(`UPDATE ordinary_work_order_instances SET platform_case_id='wrong-case'`);
  assert.deepEqual(await materializeVerifiedAnalysisSnapshots(client, input),
    { oms: false, logistics: false }, 'the current PDD case must match the snapshot');

  await client.query(`UPDATE ordinary_work_order_instances SET platform_case_id='500013400000001'`);
  assert.deepEqual(await materializeVerifiedAnalysisSnapshots(client, {
    ...input, payload: { ...payload, omsAnalysis: { ...payload.omsAnalysis, shippingWarehouse: 'stale' } },
  }), { oms: false, logistics: true },
  'a stale OMS snapshot cannot be attributed to the current work order');
  assert.deepEqual(await materializeVerifiedAnalysisSnapshots(client, input),
    { oms: true, logistics: false });
  assert.deepEqual(await materializeVerifiedAnalysisSnapshots(client, input),
    { oms: false, logistics: false }, 'repeat checkpoints must not duplicate analyses');

  const rows = await client.query(`SELECT
    (SELECT count(*)::int FROM oms_analyses) AS oms,
    (SELECT count(*)::int FROM logistics_analyses) AS logistics`);
  assert.deepEqual(rows.rows[0], { oms: 1, logistics: 1 });
  await client.query('ROLLBACK');
  console.log('verified analysis materialization self-test passed');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
