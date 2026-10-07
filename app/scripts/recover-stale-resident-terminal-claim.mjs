import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';
import { classifyResidentTerminalPauseAfterSessionRecovery } from '../apps/worker/src/resident-command-recovery-policy.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = argument('--shop');
const orderNumber = argument('--order');
const commandRequestId = argument('--request-id');
const apply = process.argv.includes('--apply');
if (!shopId || !/^\d{6}-\d{15}$/u.test(orderNumber || '') || !commandRequestId) {
  throw new Error('Usage: recover-stale-resident-terminal-claim.mjs --shop ID --order NUMBER --request-id UUID [--apply]');
}
const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2,
  application_name: 'guarded-stale-resident-terminal-claim-recovery' });
try {
  const result = await pool.query(`
    SELECT work_order.*, instance.id AS ordinary_instance_id,
      instance.platform_case_id, instance.platform_case_key,
      instance.status AS instance_status,
      runtime.status AS shop_runtime_status,
      runtime.lease_token::text AS lease_token,
      runtime.lease_expires_at,
      runtime.current_work_order_id,
      checkpoint.snapshot, checkpoint.synchronized_at,
      heartbeat.heartbeat_at, heartbeat.metadata AS heartbeat_metadata,
      (SELECT count(*)::int FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.status IN ('reserved','unknown')) AS unresolved_effects,
      (SELECT count(*)::int FROM verification_locations verification
        WHERE verification.work_order_id = work_order.id
          AND verification.status IN ('detected','waiting-human','verification-required')
          AND verification.resolved_at IS NULL) AS active_verifications
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    JOIN shop_runtime_state runtime ON runtime.shop_id = work_order.shop_id
    JOIN workflow_checkpoints checkpoint ON checkpoint.shop_id = work_order.shop_id
    JOIN LATERAL (
      SELECT heartbeat_at, metadata FROM worker_heartbeats
      WHERE shop_id = work_order.shop_id ORDER BY heartbeat_at DESC LIMIT 1
    ) heartbeat ON true
    WHERE work_order.shop_id = $1 AND work_order.external_order_number = $2`,
  [shopId, orderNumber]);
  if (result.rowCount !== 1) throw new Error('Target work order is not unique');
  const row = result.rows[0];
  const progress = row.snapshot || {};
  const command = progress.residentCommand || {};
  const hydratedAtMs = Date.parse(progress.hydratedAt || '');
  const recovered = classifyResidentTerminalPauseAfterSessionRecovery({
    progress,
    claim: { external_order_number: orderNumber, leaseToken: row.lease_token },
    claimHydratedAtMs: hydratedAtMs,
    commandRequestId,
  });
  const failures = [];
  if (row.scenario_code === 'return-refund' || row.status !== 'processing'
    || row.instance_status !== 'processing') failures.push('ordinary-processing-state');
  const leaseExpiresAtMs = Date.parse(row.lease_expires_at || '');
  if (row.shop_runtime_status !== 'processing'
    || String(row.current_work_order_id) !== String(row.id)
    || !row.lease_token || !Number.isFinite(leaseExpiresAtMs)
    || leaseExpiresAtMs <= Date.now()) {
    failures.push('active-lease');
  }
  const heartbeatAtMs = Date.parse(row.heartbeat_at || '');
  if (!Number.isFinite(heartbeatAtMs)
    || heartbeatAtMs > Date.now()
    || Date.now() - heartbeatAtMs > 20_000
    || row.heartbeat_metadata?.state !== 'processing'
    || row.heartbeat_metadata?.currentOrderNumber !== orderNumber) {
    failures.push('fresh-processing-heartbeat');
  }
  if (row.unresolved_effects !== 0 || row.active_verifications !== 0) {
    failures.push('unresolved-effect-or-verification');
  }
  if (progress.ordinaryInstanceId !== row.ordinary_instance_id
    || String(progress.platformWorkOrderId) !== String(row.platform_case_id)
    || progress.platformCaseKey !== row.platform_case_key) {
    failures.push('platform-case-identity');
  }
  if (progress.lastCompletedOrder?.orderNumber === orderNumber
    || progress.completionArchive?.orderNumber === orderNumber) {
    failures.push('completion-evidence-present');
  }
  const commandCompletedAtMs = Date.parse(command.completedAt || '');
  if (!Number.isFinite(commandCompletedAtMs)
    || commandCompletedAtMs > Date.now()
    || Date.now() - commandCompletedAtMs < 2 * 60_000) {
    failures.push('terminal-command-too-recent');
  }
  if (!recovered) failures.push('terminal-command-proof');
  const check = {
    shopId, orderNumber, commandRequestId,
    outcome: command.outcome || null,
    commandCompletedAt: command.completedAt || null,
    unresolvedEffects: row.unresolved_effects,
    activeVerifications: row.active_verifications,
    safe: failures.length === 0,
    failures,
  };
  if (!apply || failures.length) {
    console.log(JSON.stringify({ ...check, applied: false }));
    process.exitCode = failures.length ? 2 : 0;
  } else {
    const backupDir = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir,
      `stale-resident-terminal-${orderNumber}-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({ checkedAt: new Date().toISOString(), row }, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const repository = new PostgresWorkflowRepository(pool);
    const finished = await repository.finishClaimed({
      shopId,
      workOrderId: row.id,
      leaseToken: row.lease_token,
      ordinaryInstanceId: row.ordinary_instance_id,
      status: 'paused',
      currentStep: recovered.outcome,
      payload: recovered.payload,
      error: new Error(recovered.reason),
    });
    console.log(JSON.stringify({ ...check, applied: finished, backupPath }));
    if (!finished) process.exitCode = 3;
  }
} finally {
  await pool.end();
}
