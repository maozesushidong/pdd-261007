import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataRoot = path.resolve(appRoot, '..', 'data', 'workflow');
const ordersIndex = process.argv.indexOf('--orders');
const orders = String(ordersIndex < 0 ? '' : process.argv[ordersIndex + 1] || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
if (!orders.length || orders.some((value) => !/^\d{6}-\d{15}$/u.test(value))) {
  throw new Error('Usage: restore-resident-terminal-reasons.mjs --orders N,N [--apply]');
}
const apply = process.argv.includes('--apply');
const environment = await fsp.readFile(path.join(appRoot, '.env.native'), 'utf8');
const line = environment.split(/\r?\n/u).find((value) => value.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || line?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
const genericReason = '浏览器业务命令已暂停，后台登录状态刷新覆盖了具体原因；禁止重复提交，等待人工核对';

const findTerminalEvent = async (row) => {
  const command = row.payload?.residentCommand || {};
  const recovery = row.payload?.residentTerminalRecovery || {};
  const day = String(command.completedAt || '').slice(0, 10).replace(/-/gu, '');
  const acceptedAt = Date.parse(command.acceptedAt || '');
  const completedAt = Date.parse(command.completedAt || '');
  if (!Number.isFinite(acceptedAt) || !Number.isFinite(completedAt)
    || completedAt < acceptedAt) return null;
  const file = path.join(dataRoot, 'shops', row.shop_id, 'state', 'sync-outbox',
    `events-${day}.ndjson`);
  if (!fs.existsSync(file)) return null;
  let found = null;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const text of lines) {
    if (!text.includes(row.external_order_number)) continue;
    let event;
    try { event = JSON.parse(text); } catch { continue; }
    const snapshot = event.payload?.snapshot || {};
    const eventAt = Date.parse(event.occurredAt || '');
    if (!event.eventKey || event.orderNumber !== row.external_order_number
      || event.stage !== recovery.outcome
      || snapshot.ordinaryInstanceId !== row.current_ordinary_instance_id
      || String(snapshot.platformWorkOrderId) !== String(row.platform_case_id)
      || snapshot.residentCommand?.requestId !== recovery.commandRequestId
      || snapshot.residentCommand?.assignmentId !== recovery.assignmentId
      || !Number.isFinite(eventAt)
      || eventAt < acceptedAt || eventAt > completedAt) continue;
    const reason = String(event.message || '').trim();
    if (!reason) continue;
    if (!found || eventAt > found.eventAt) {
      found = {
        eventKey: event.eventKey,
        eventAt,
        reason,
        originalStage: snapshot.manualReview?.stage
          || snapshot.transientWorkflowFailure?.stage || null,
      };
    }
  }
  return found;
};

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'restore-resident-terminal-reasons' });
await client.connect();
let inTransaction = false;
try {
  const selected = await client.query(`
    SELECT w.*, instance.platform_case_id,
      instance.runtime_status AS instance_runtime_status,
      instance.current_step AS instance_current_step,
      instance.manual_review_reason AS instance_manual_review_reason,
      instance.payload->'manualReview' AS instance_manual_review
    FROM work_orders w
    JOIN ordinary_work_order_instances instance
      ON instance.id = w.current_ordinary_instance_id
    WHERE w.external_order_number = ANY($1::text[])
      AND w.runtime_status = 'paused'
      AND instance.runtime_status = 'paused'
      AND w.manual_review_reason = $2
      AND instance.manual_review_reason = $2
      AND w.payload->'manualReview'->>'reason' = $2
      AND instance.payload->'manualReview'->>'reason' = $2
    ORDER BY w.external_order_number`, [orders, genericReason]);
  const candidates = [];
  for (const row of selected.rows) {
    const recovery = row.payload?.residentTerminalRecovery || {};
    const command = row.payload?.residentCommand || {};
    if (!['flow-paused', 'manual-review-blocked'].includes(recovery.outcome)
      || recovery.outcome !== row.current_step
      || recovery.outcome !== row.instance_current_step
      || recovery.commandRequestId !== command.requestId
      || recovery.assignmentId !== command.assignmentId
      || recovery.outcome !== command.outcome) continue;
    const event = await findTerminalEvent(row);
    if (event) candidates.push({ row, event });
  }
  if (candidates.length !== orders.length) {
    throw new Error(`Expected ${orders.length} exact paused orders; found ${candidates.length} with matching terminal event proof`);
  }
  if (!apply) {
    console.log(JSON.stringify({ applied: false, candidates: candidates.map(({ row, event }) => ({
      orderNumber: row.external_order_number, shopId: row.shop_id,
      outcome: row.current_step, sourceEventKey: event.eventKey, restoredReason: event.reason,
    })) }));
  } else {
    const backupDir = path.resolve(appRoot, '..', 'backups');
    await fsp.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir,
      `resident-terminal-reasons-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fsp.writeFile(backupPath, JSON.stringify({ createdAt: new Date().toISOString(),
      candidates: candidates.map(({ row, event }) => ({
        workOrderId: row.id, shopId: row.shop_id, orderNumber: row.external_order_number,
        instanceId: row.current_ordinary_instance_id,
        previousReason: row.manual_review_reason,
        eventKey: event.eventKey, restoredReason: event.reason,
      })),
    }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await client.query('BEGIN');
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    for (const { row, event } of candidates) {
      const locked = await client.query(`
        SELECT w.id, w.runtime_status, w.current_step, w.current_ordinary_instance_id,
          w.manual_review_reason, w.payload->'residentTerminalRecovery' AS recovery,
          instance.runtime_status AS instance_status,
          instance.manual_review_reason AS instance_reason
        FROM work_orders w
        JOIN ordinary_work_order_instances instance
          ON instance.id = w.current_ordinary_instance_id
        WHERE w.id = $1 FOR UPDATE OF w, instance`, [row.id]);
      const current = locked.rows[0];
      if (!current || current.runtime_status !== 'paused'
        || current.instance_status !== 'paused'
        || current.current_ordinary_instance_id !== row.current_ordinary_instance_id
        || current.current_step !== row.current_step
        || current.manual_review_reason !== genericReason
        || current.instance_reason !== genericReason
        || current.recovery?.commandRequestId !== row.payload.residentTerminalRecovery.commandRequestId
        || current.recovery?.assignmentId !== row.payload.residentTerminalRecovery.assignmentId) {
        throw new Error(`State changed before reason restoration: ${row.external_order_number}`);
      }
      const unsafe = await client.query(`SELECT count(*)::int AS count FROM external_effects
        WHERE work_order_id = $1
          AND ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
          AND (status IN ('reserved','unknown') OR effect_type = 'pdd-submit')`,
      [row.id, row.current_ordinary_instance_id]);
      if (unsafe.rows[0].count !== 0) {
        throw new Error(`Unresolved or submitted PDD effect: ${row.external_order_number}`);
      }
      const reasonMetadata = JSON.stringify({ reason: event.reason,
        reasonSource: 'workflow-outbox-original-terminal',
        sourceEventKey: event.eventKey, originalStage: event.originalStage });
      const workOrderUpdate = await client.query(`UPDATE work_orders SET
        manual_review_reason = $2,
        payload = jsonb_set(payload, '{manualReview}',
          coalesce(payload->'manualReview', '{}'::jsonb) || $3::jsonb)
        WHERE id = $1 AND manual_review_reason = $4`,
      [row.id, event.reason, reasonMetadata, genericReason]);
      // The existing work_orders trigger synchronizes the current instance.
      const synchronized = await client.query(`SELECT manual_review_reason,
          payload->'manualReview'->>'reason' AS payload_reason
        FROM ordinary_work_order_instances WHERE id = $1`, [row.current_ordinary_instance_id]);
      if (workOrderUpdate.rowCount !== 1 || synchronized.rowCount !== 1
        || synchronized.rows[0].manual_review_reason !== event.reason
        || synchronized.rows[0].payload_reason !== event.reason) {
        throw new Error(`Reason restoration did not synchronize the current instance: ${row.external_order_number}`);
      }
    }
    await client.query('COMMIT');
    inTransaction = false;
    console.log(JSON.stringify({ applied: true, restored: candidates.length, backupPath }));
  }
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
