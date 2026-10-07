import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';
import { classifyStaleBoundPreClaimVerificationGate } from '../apps/worker/src/verification-recovery-policy.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = String(arg('--shop') || '').trim();
const verificationId = String(arg('--verification-id') || '').trim();
const apply = process.argv.includes('--apply');
if (!shopId || !/^[0-9a-f-]{36}$/iu.test(verificationId)) {
  throw new Error('Usage: safe-stale-bound-refund-recovery.mjs --shop ID --verification-id UUID [--apply]');
}
const environment = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = environment.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice(13).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2,
  application_name: 'safe-stale-bound-refund-recovery' });
try {
  const progressPath = path.resolve(appRoot, '..', 'data', 'workflow', 'shops',
    shopId, 'state', 'workflow-progress.json');
  const progress = JSON.parse(await fs.readFile(progressPath, 'utf8'));
  const result = await pool.query(`
    SELECT v.id, v.shop_id, v.work_order_id, v.system_name, v.stage,
      v.status, v.detected_at, v.resolved_at,
      w.external_order_number, w.scenario_code, w.status AS work_status,
      w.runtime_status AS work_runtime_status, w.current_step,
      w.recovery_state, w.completion_state,
      r.action_state AS refund_state, r.completed_at AS refund_completed_at,
      s.enabled, s.onboarding_status, s.expected_shop_name,
      b.binding_token::text AS binding_token, b.actual_shop_name,
      b.mall_id, b.profile_fingerprint,
      i.status AS identity_status, i.mall_id AS identity_mall_id,
      i.profile_fingerprint AS identity_fingerprint,
      rt.status AS runtime_status, rt.lease_token, rt.current_work_order_id,
      rt.metadata AS runtime_metadata,
      c.snapshot #>> '{verificationLocation,id}' AS checkpoint_verification_id,
      c.source_updated_at AS checkpoint_updated_at,
      h.heartbeat_at, h.metadata AS heartbeat_metadata,
      (SELECT count(*)::int FROM external_effects e
       WHERE e.work_order_id = w.id) AS effect_count,
      (SELECT count(*)::int FROM verification_locations active
       WHERE active.shop_id = v.shop_id
         AND active.status IN ('detected','waiting-human','verification-required')
         AND active.resolved_at IS NULL) AS active_verification_count
    FROM verification_locations v
    JOIN work_orders w ON w.id = v.work_order_id AND w.shop_id = v.shop_id
    JOIN return_refunds r ON r.work_order_id = w.id AND r.shop_id = v.shop_id
    JOIN shops s ON s.id = v.shop_id
    JOIN pdd_shop_runtime_bindings b ON b.shop_id = v.shop_id
    JOIN shop_identity_bindings i ON i.shop_id = v.shop_id
    JOIN shop_runtime_state rt ON rt.shop_id = v.shop_id
    LEFT JOIN workflow_checkpoints c ON c.shop_id = v.shop_id
    LEFT JOIN LATERAL (
      SELECT heartbeat_at, metadata FROM worker_heartbeats
      WHERE shop_id = v.shop_id ORDER BY heartbeat_at DESC LIMIT 1
    ) h ON true
    WHERE v.id = $1::uuid AND v.shop_id = $2`, [verificationId, shopId]);
  const row = result.rows[0] || null;
  const classification = row
    ? classifyStaleBoundPreClaimVerificationGate({
      persistedVerification: row, progress,
    }) : null;
  const authAt = Date.parse(classification?.authenticatedAt || '');
  const heartbeat = row?.heartbeat_metadata || {};
  const failures = [];
  if (!row || !classification) failures.push('no-fresh-exact-page-proof');
  if (!row?.enabled || row?.onboarding_status !== 'ready'
    || row?.actual_shop_name !== row?.expected_shop_name
    || row?.identity_status !== 'confirmed'
    || String(row?.mall_id || '') !== String(row?.identity_mall_id || '')
    || row?.profile_fingerprint !== row?.identity_fingerprint
    || heartbeat.actualShopName !== row?.expected_shop_name
    || String(heartbeat.mallId || '') !== String(row?.mall_id || '')
    || heartbeat.identityBindingToken !== row?.binding_token) {
    failures.push('shop-identity-binding');
  }
  if (!row?.heartbeat_at || Date.now() - Date.parse(row.heartbeat_at) > 20_000
    || heartbeat.authHealth?.pdd?.status !== 'authenticated') {
    failures.push('worker-heartbeat-or-authentication');
  }
  if (row?.runtime_status !== 'idle' || row?.lease_token
    || row?.current_work_order_id
    || row?.runtime_metadata?.maintenanceDrain?.active !== true
    || row?.runtime_metadata?.operatorPaused !== true) {
    failures.push('shop-not-maintenance-idle');
  }
  if (row?.scenario_code !== 'return-refund'
    || row?.work_status !== 'retry-ready'
    || row?.work_runtime_status !== 'waiting'
    || row?.current_step !== 'return-refund-verification-required'
    || !['ready', 'retry-authorized'].includes(row?.recovery_state)
    || row?.completion_state !== 'pending'
    || row?.refund_state !== 'verification-required'
    || row?.refund_completed_at || row?.effect_count !== 0
    || row?.active_verification_count !== 1) {
    failures.push('order-or-external-effect-safety');
  }
  if (row?.checkpoint_verification_id !== verificationId
    || !(Date.parse(row?.checkpoint_updated_at || '') < authAt)) {
    failures.push('checkpoint-not-exact-stale-gate');
  }
  const check = {
    shopId, verificationId,
    orderNumber: row?.external_order_number || null,
    authenticatedAt: classification?.authenticatedAt || null,
    runtimeObservedAt: classification?.runtimeObservedAt || null,
    effectCount: row?.effect_count ?? null,
    activeVerificationCount: row?.active_verification_count ?? null,
    safe: failures.length === 0, failures,
  };
  if (!apply || failures.length) {
    console.log(JSON.stringify({ applied: false, ...check }));
    if (apply && failures.length) process.exitCode = 2;
  } else {
    const backupDir = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir,
      `stale-bound-refund-recovery-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, JSON.stringify({ checkedAt: new Date().toISOString(),
      check, persisted: {
        verification: { id: row.id, status: row.status, stage: row.stage,
          detectedAt: row.detected_at, resolvedAt: row.resolved_at },
        workOrder: { id: row.work_order_id, status: row.work_status,
          runtimeStatus: row.work_runtime_status, currentStep: row.current_step },
        refund: { actionState: row.refund_state, completedAt: row.refund_completed_at },
        checkpoint: { verificationId: row.checkpoint_verification_id,
          updatedAt: row.checkpoint_updated_at },
      },
    }, null, 2), { flag: 'wx', mode: 0o600 });
    const repository = new PostgresWorkflowRepository(pool);
    const recovery = await repository.resolveStaleBoundPddVerificationGate({
      shopId, ...classification,
    });
    if (!recovery?.verificationResolved) {
      throw new Error('Exact recovery guard changed; no verification was resolved');
    }
    console.log(JSON.stringify({ applied: true, ...check, backupPath, recovery }));
  }
} finally {
  await pool.end();
}
