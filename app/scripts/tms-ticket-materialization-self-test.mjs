import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { materializeConfirmedTmsTicket } from '../packages/adapters/src/postgres/index.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const line = fs.readFileSync(path.join(root, '.env.native'), 'utf8')
  .split(/\r?\n/u).find((value) => value.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || line?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl, application_name: 'tms-ticket-materialization-self-test' });
const workOrderId = '00000000-0000-4000-8000-000000000881';
const instanceId = '00000000-0000-4000-8000-000000000882';
const orderNumber = '260924-165150790022430';
const ticketNo = 'L00061898';
const input = {
  shopId: 'test-shop', workOrderId,
  payload: {
    latestDiscovery: { scenarioCode: 'in-transit-refund' },
    tmsWorkOrder: {
      status: 'created', orderNumber, ticketNo, ticketId: '61996',
      problemType: '拦截退回', customerRemark: '超时未揽收，请拦截',
      createdAt: '2026-09-24T17:37:52.305Z',
    },
  },
};

await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE work_orders (
    id uuid PRIMARY KEY, shop_id text, external_order_number text,
    scenario_code text, current_ordinary_instance_id uuid
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE ordinary_work_order_instances (
    id uuid PRIMARY KEY, work_order_id uuid, shop_id text, identity_status text
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE external_effects (
    work_order_id uuid, ordinary_instance_id uuid, effect_type text,
    status text, receipt jsonb
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE tms_work_orders (
    id uuid PRIMARY KEY, work_order_id uuid, ordinary_instance_id uuid,
    scenario_code text, external_ticket_id text, status text,
    request_hash text, payload jsonb, created_at timestamptz,
    UNIQUE (work_order_id, ordinary_instance_id, scenario_code, request_hash)
  ) ON COMMIT DROP`);
  await client.query(`INSERT INTO work_orders VALUES ($1,'test-shop',$2,'in-transit-refund',$3)`,
    [workOrderId, orderNumber, instanceId]);
  await client.query(`INSERT INTO ordinary_work_order_instances VALUES ($1,$2,'test-shop','verified')`,
    [instanceId, workOrderId]);

  assert.equal(await materializeConfirmedTmsTicket(client, input), false,
    'a saved browser snapshot alone must not assert that TMS created a ticket');
  await client.query(`INSERT INTO external_effects VALUES
    ($1,$2,'tms-create','succeeded',$3::jsonb)`, [workOrderId, instanceId,
    JSON.stringify({ result: { data: { ticketNo: 'different-ticket' } } })]);
  assert.equal(await materializeConfirmedTmsTicket(client, input), false,
    'the receipt must identify the same ticket');
  await client.query(`UPDATE external_effects SET receipt=$3::jsonb
    WHERE work_order_id=$1 AND ordinary_instance_id=$2`, [workOrderId, instanceId,
    JSON.stringify({ result: { data: { ticketNo } } })]);
  assert.equal(await materializeConfirmedTmsTicket(client, input), true);
  assert.equal(await materializeConfirmedTmsTicket(client, input), false,
    'repeat checkpoints must not create duplicate rows');
  const inserted = await client.query(`SELECT external_ticket_id,status,payload->>'ticketNo' AS ticket_no,
    created_at FROM tms_work_orders`);
  assert.equal(inserted.rowCount, 1);
  assert.equal(inserted.rows[0].external_ticket_id, ticketNo);
  assert.equal(inserted.rows[0].ticket_no, ticketNo);
  assert.equal(inserted.rows[0].status, 'created');
  assert.equal(inserted.rows[0].created_at.toISOString(), input.payload.tmsWorkOrder.createdAt);

  await client.query('TRUNCATE tms_work_orders');
  await client.query(`UPDATE ordinary_work_order_instances SET identity_status='pending'`);
  assert.equal(await materializeConfirmedTmsTicket(client, input), false,
    'unverified shop identity must not materialize the ticket');
  await client.query(`UPDATE ordinary_work_order_instances SET identity_status='verified'`);
  await client.query(`INSERT INTO external_effects VALUES
    ($1,$2,'tms-create','unknown','{}'::jsonb)`, [workOrderId, instanceId]);
  assert.equal(await materializeConfirmedTmsTicket(client, input), false,
    'an unresolved TMS create effect must block materialization');
  await client.query('ROLLBACK');
  console.log('TMS ticket materialization self-test passed');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
