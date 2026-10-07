import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = String(argument('--shop-id') || '').trim();
const orderNumber = String(argument('--order-number') || '').trim();
const apply = process.argv.includes('--apply');
if (!shopId || !/^\d{6}-\d{15}$/u.test(orderNumber)) {
  throw new Error('Provide --shop-id and --order-number (YYMMDD-15 digits)');
}
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databaseLine = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8')
  .split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2,
  application_name: 'safe-exact-resolved-verification-requeue' });
try {
  const { rows } = await pool.query(`
    SELECT work_order.id, shop.name AS "shopName", shop.enabled,
      shop.expected_shop_name AS "expectedShopName",
      shop.onboarding_status AS "onboardingStatus",
      work_order.scenario_code AS "scenarioCode",
      work_order.status, work_order.runtime_status AS "runtimeStatus",
      work_order.current_step AS "currentStep",
      work_order.recovery_state AS "recoveryState",
      refund.action_state AS "refundActionState",
      refund.next_check_at AS "nextCheckAt",
      refund.last_scanned_at AS "lastScannedAt",
      identity.status AS "identityStatus",
      identity.mall_id AS "confirmedMallId",
      binding.actual_shop_name AS "boundShopName",
      binding.mall_id AS "boundMallId",
      binding.binding_token::text = refund.evidence->>'pddIdentityBindingToken'
        AS "bindingMatches",
      heartbeat.heartbeat_at AS "heartbeatAt",
      heartbeat.metadata #>> '{authHealth,pdd,status}' AS "pddAuth",
      heartbeat.metadata->>'actualShopName' AS "heartbeatShopName",
      heartbeat.metadata->>'mallId' AS "heartbeatMallId",
      runtime.status AS "shopRuntimeStatus",
      runtime.metadata->>'operatorPaused' AS "operatorPaused",
      latest.resolved_at AS "latestResolvedAt",
      (SELECT count(*)::int FROM verification_locations active
       WHERE active.shop_id = shop.id
         AND active.status IN ('detected','waiting-human','verification-required')
         AND active.resolved_at IS NULL) AS "activeShopVerifications",
      (SELECT count(*)::int FROM external_effects effect
       WHERE effect.work_order_id = work_order.id) AS "effectCount",
      EXISTS (SELECT 1 FROM shop_runtime_state lease
        WHERE lease.current_work_order_id = work_order.id
          AND lease.lease_token IS NOT NULL
          AND lease.lease_expires_at > now()) AS "activeOrderLease"
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    JOIN shops shop ON shop.id = work_order.shop_id
    LEFT JOIN shop_identity_bindings identity ON identity.shop_id = shop.id
    LEFT JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = shop.id
    LEFT JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
    LEFT JOIN LATERAL (
      SELECT heartbeat_at, metadata FROM worker_heartbeats
      WHERE shop_id = shop.id ORDER BY heartbeat_at DESC LIMIT 1
    ) heartbeat ON true
    LEFT JOIN LATERAL (
      SELECT resolved_at FROM verification_locations
      WHERE work_order_id = work_order.id AND status = 'resolved'
      ORDER BY resolved_at DESC LIMIT 1
    ) latest ON true
    WHERE work_order.shop_id = $1 AND work_order.external_order_number = $2`,
  [shopId, orderNumber]);
  if (rows.length !== 1) throw new Error('Exact shop/order match was not found');
  const row = rows[0];
  const now = Date.now();
  const resolvedMs = Date.parse(String(row.latestResolvedAt || ''));
  const scannedMs = Date.parse(String(row.lastScannedAt || ''));
  const heartbeatMs = Date.parse(String(row.heartbeatAt || ''));
  const checks = {
    shopReady: row.enabled && row.onboardingStatus === 'ready',
    identityConfirmed: row.identityStatus === 'confirmed'
      && row.expectedShopName === row.boundShopName
      && row.confirmedMallId && row.confirmedMallId === row.boundMallId
      && row.bindingMatches === true,
    freshCorrectPddSession: row.pddAuth === 'authenticated'
      && row.heartbeatShopName === row.expectedShopName
      && row.heartbeatMallId === row.confirmedMallId
      && Number.isFinite(heartbeatMs) && now - heartbeatMs < 60_000,
    noActiveShopChallenge: row.activeShopVerifications === 0,
    shopNotPaused: row.shopRuntimeStatus !== 'operator-paused'
      && row.operatorPaused !== 'true',
    exactSafeRefund: row.scenarioCode === 'return-refund'
      && row.status === 'retry-ready'
      && ['waiting', 'verification', 'retry-ready'].includes(row.runtimeStatus)
      && row.currentStep === 'return-refund-verification-required'
      && ['ready', 'retry-authorized'].includes(row.recoveryState)
      && row.refundActionState === 'verification-required'
      && Date.parse(String(row.nextCheckAt || '')) <= now,
    sameClaimClear: Number.isFinite(resolvedMs)
      && (!Number.isFinite(scannedMs) || scannedMs <= resolvedMs + 30_000)
      && resolvedMs >= now - 24 * 60 * 60_000,
    noExternalEffectOrLease: row.effectCount === 0 && !row.activeOrderLease,
  };
  const blockers = Object.entries(checks)
    .filter(([, passed]) => !passed).map(([name]) => name);
  let dryRunCandidate = false;
  if (!blockers.length) {
    const dryPool = { connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, ...args) => client.query(
          String(sql).trim() === 'COMMIT' ? 'ROLLBACK' : sql, ...args,
        ),
        release: () => client.release(),
      };
    } };
    const preview = await new PostgresWorkflowRepository(dryPool)
      .requeueResolvedVerificationWorkOrders({ shopId, workOrderId: row.id, limit: 1 });
    dryRunCandidate = preview.length === 1 && preview[0].workOrderId === row.id;
  }
  let applied = false;
  if (apply && !blockers.length && dryRunCandidate) {
    const result = await new PostgresWorkflowRepository(pool)
      .requeueResolvedVerificationWorkOrders({ shopId, workOrderId: row.id, limit: 1 });
    applied = result.length === 1 && result[0].workOrderId === row.id;
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), shopId,
    shopName: row.shopName, orderNumber, checks, blockers, dryRunCandidate,
    applied, externalActionsReplayed: false }, null, 2));
  if (apply && !applied) process.exitCode = 2;
} finally {
  await pool.end();
}
