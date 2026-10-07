import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { materializeVerifiedAnalysisSnapshots } from '../packages/adapters/src/postgres/index.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sinceIndex = process.argv.indexOf('--since');
const sinceInput = sinceIndex < 0 ? null : process.argv[sinceIndex + 1];
const since = sinceInput ? new Date(sinceInput) : new Date(Date.now() - 7 * 24 * 60 * 60_000);
if (Number.isNaN(since.getTime())) throw new Error('--since requires an ISO-8601 timestamp');
const apply = process.argv.includes('--apply');
const environment = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const line = environment.split(/\r?\n/u).find((value) => value.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || line?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'verified-analysis-backfill',
});
await client.connect();
let inTransaction = false;
try {
  await client.query('BEGIN');
  inTransaction = true;
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const selected = await client.query(`
    SELECT w.id, w.shop_id, w.current_ordinary_instance_id,
      w.external_order_number, w.payload,
      (jsonb_typeof(w.payload->'omsAnalysis') = 'object'
        AND w.payload #>> '{omsAnalysis,orderNumber}' = w.external_order_number
        AND NOT EXISTS (
          SELECT 1 FROM oms_analyses analysis
          WHERE analysis.work_order_id = w.id
            AND analysis.ordinary_instance_id = w.current_ordinary_instance_id
            AND analysis.payload = w.payload->'omsAnalysis'
        )) AS oms_missing,
      (jsonb_typeof(w.payload->'logisticsAnalysis') = 'object'
        AND w.payload #>> '{logisticsAnalysis,orderNumber}' = w.external_order_number
        AND NOT EXISTS (
          SELECT 1 FROM logistics_analyses analysis
          WHERE analysis.work_order_id = w.id
            AND analysis.ordinary_instance_id = w.current_ordinary_instance_id
            AND analysis.payload = w.payload->'logisticsAnalysis'
        )) AS logistics_missing
    FROM work_orders w
    JOIN ordinary_work_order_instances instance
      ON instance.id = w.current_ordinary_instance_id
      AND instance.work_order_id = w.id
      AND instance.shop_id = w.shop_id
    WHERE w.updated_at >= $1
      AND w.frontend_visibility = 'operational'
      AND w.scenario_code IS DISTINCT FROM 'return-refund'
      AND w.runtime_status IS DISTINCT FROM 'processing'
      AND instance.identity_status = 'verified'
      AND nullif(instance.platform_case_id, '') IS NOT NULL
      AND w.payload #>> '{latestDiscovery,platformCaseId}' = instance.platform_case_id
      AND (
        (jsonb_typeof(w.payload->'omsAnalysis') = 'object'
          AND w.payload #>> '{omsAnalysis,orderNumber}' = w.external_order_number
          AND NOT EXISTS (
            SELECT 1 FROM oms_analyses analysis
            WHERE analysis.work_order_id = w.id
              AND analysis.ordinary_instance_id = w.current_ordinary_instance_id
              AND analysis.payload = w.payload->'omsAnalysis'
          ))
        OR (jsonb_typeof(w.payload->'logisticsAnalysis') = 'object'
          AND w.payload #>> '{logisticsAnalysis,orderNumber}' = w.external_order_number
          AND NOT EXISTS (
            SELECT 1 FROM logistics_analyses analysis
            WHERE analysis.work_order_id = w.id
              AND analysis.ordinary_instance_id = w.current_ordinary_instance_id
              AND analysis.payload = w.payload->'logisticsAnalysis'
          ))
      )
    ORDER BY w.updated_at, w.id
    LIMIT 500
    ${apply ? 'FOR UPDATE OF w SKIP LOCKED' : ''}`, [since.toISOString()]);
  const candidates = selected.rows.map((row) => ({
    workOrderId: row.id,
    shopId: row.shop_id,
    ordinaryInstanceId: row.current_ordinary_instance_id,
    orderNumber: row.external_order_number,
    omsMissing: row.oms_missing,
    logisticsMissing: row.logistics_missing,
  }));
  if (!apply || candidates.length === 0) {
    await client.query('ROLLBACK');
    inTransaction = false;
    console.log(JSON.stringify({ applied: apply, since: since.toISOString(),
      candidates: candidates.length, omsMissing: candidates.filter((row) => row.omsMissing).length,
      logisticsMissing: candidates.filter((row) => row.logisticsMissing).length }));
  } else {
    const backupDir = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir,
      `verified-analysis-backfill-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(), since: since.toISOString(), candidates,
    }, null, 2), 'utf8');
    const inserted = { oms: 0, logistics: 0 };
    for (const row of selected.rows) {
      const result = await materializeVerifiedAnalysisSnapshots(client, {
        shopId: row.shop_id, workOrderId: row.id, payload: row.payload,
      });
      if (result.oms) inserted.oms += 1;
      if (result.logistics) inserted.logistics += 1;
    }
    await client.query('COMMIT');
    inTransaction = false;
    console.log(JSON.stringify({ applied: true, since: since.toISOString(),
      candidates: candidates.length, inserted, backupPath }));
  }
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
