import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { materializeConfirmedTmsTicket } from '../packages/adapters/src/postgres/index.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const sinceInput = arg('--since');
const since = sinceInput ? new Date(sinceInput) : new Date(Date.now() - 24 * 60 * 60_000);
if (Number.isNaN(since.getTime())) throw new Error('--since requires an ISO-8601 timestamp');
const apply = process.argv.includes('--apply');
const environment = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const line = environment.split(/\r?\n/u).find((value) => value.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || line?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'confirmed-tms-ticket-backfill',
});
await client.connect();
let inTransaction = false;
try {
  await client.query('BEGIN');
  inTransaction = true;
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const selected = await client.query(`
    SELECT work_order.id, work_order.shop_id, work_order.current_ordinary_instance_id,
      work_order.external_order_number, work_order.payload,
      work_order.payload #>> '{tmsWorkOrder,ticketNo}' AS ticket_no
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
      AND instance.work_order_id = work_order.id
      AND instance.shop_id = work_order.shop_id
      AND instance.identity_status = 'verified'
    WHERE work_order.updated_at >= $1
      AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
      AND work_order.runtime_status IN ('archived','completed','paused','retry-ready')
      AND work_order.payload #>> '{tmsWorkOrder,status}' = 'created'
      AND work_order.payload #>> '{tmsWorkOrder,orderNumber}' = work_order.external_order_number
      AND work_order.payload #>> '{latestDiscovery,scenarioCode}' = work_order.scenario_code
      AND nullif(work_order.payload #>> '{tmsWorkOrder,ticketNo}', '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tms_work_orders ticket
        WHERE ticket.work_order_id = work_order.id
          AND ticket.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
      )
      AND (
        SELECT count(*) FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
          AND effect.effect_type = 'tms-create' AND effect.status = 'succeeded'
          AND effect.receipt #>> '{result,data,ticketNo}'
            = work_order.payload #>> '{tmsWorkOrder,ticketNo}'
      ) = 1
      AND NOT EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
          AND effect.effect_type = 'tms-create'
          AND effect.status IN ('reserved','unknown')
      )
    ORDER BY work_order.updated_at, work_order.id
    LIMIT 500
    ${apply ? 'FOR UPDATE OF work_order SKIP LOCKED' : ''}`, [since.toISOString()]);
  const candidates = selected.rows.map((row) => ({
    workOrderId: row.id,
    shopId: row.shop_id,
    ordinaryInstanceId: row.current_ordinary_instance_id,
    orderNumber: row.external_order_number,
    ticketNo: row.ticket_no,
  }));
  if (!apply) {
    await client.query('ROLLBACK');
    inTransaction = false;
    console.log(JSON.stringify({ applied: false, since: since.toISOString(), candidates: candidates.length }));
  } else if (candidates.length === 0) {
    await client.query('ROLLBACK');
    inTransaction = false;
    console.log(JSON.stringify({ applied: true, since: since.toISOString(), candidates: 0,
      inserted: 0, skipped: 0, backupPath: null }));
  } else {
    const backupDir = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir,
      `confirmed-tms-ticket-backfill-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(), since: since.toISOString(), candidates,
    }, null, 2), 'utf8');
    let inserted = 0;
    for (const row of selected.rows) {
      if (await materializeConfirmedTmsTicket(client, {
        shopId: row.shop_id, workOrderId: row.id, payload: row.payload,
      })) inserted += 1;
    }
    await client.query('COMMIT');
    inTransaction = false;
    console.log(JSON.stringify({
      applied: true, since: since.toISOString(), candidates: candidates.length,
      inserted, skipped: candidates.length - inserted, backupPath,
    }));
  }
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
