import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeEnvironment = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = nativeEnvironment.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'refund-overdue-throughput-readonly-audit',
});
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query('SET LOCAL statement_timeout = 15000');
  const { rows } = await client.query(`
    SELECT shop.id AS "shopId", shop.name AS "shopName",
      heartbeat.heartbeat_at AS "heartbeatAt",
      heartbeat.metadata->>'state' AS "workerState",
      heartbeat.metadata #>> '{authHealth,pdd,status}' AS "pddAuthStatus",
      heartbeat.metadata #>> '{authHealth,pdd,evidence}' AS "pddAuthEvidence",
      heartbeat.metadata #>> '{preClaimVerificationGate,verificationId}'
        AS "preClaimVerificationId",
      heartbeat.metadata #>> '{verificationBrowserRecovery,status}'
        AS "verificationBrowserRecoveryStatus",
      runtime.status AS "runtimeStatus",
      count(refund.work_order_id)::int AS "openRefunds",
      count(refund.work_order_id) FILTER (
        WHERE work_order.recovery_state = 'held'
          OR work_order.status IN ('archived', 'completed'))::int AS "heldOrArchivedOpenRefunds",
      count(refund.work_order_id) FILTER (
        WHERE work_order.recovery_state IN ('ready', 'retry-authorized')
          AND work_order.status IN ('queued', 'retry-ready', 'processing'))::int
        AS "runnableOpenRefunds",
      count(refund.work_order_id) FILTER (
        WHERE refund.action_state = 'waiting-logistics'
          AND refund.next_check_at <= now()
          AND work_order.recovery_state IN ('ready', 'retry-authorized')
          AND work_order.status IN ('queued', 'retry-ready', 'processing'))::int
        AS "overdueLogisticsWaits",
      -- Mirror claimNext's four-hour post-scan guard to distinguish truly
      -- claimable overdue work from a recently scanned row cooling down.
      count(refund.work_order_id) FILTER (
        WHERE refund.action_state = 'waiting-logistics'
          AND refund.next_check_at <= now()
          AND work_order.recovery_state IN ('ready', 'retry-authorized')
          AND work_order.status IN ('queued', 'retry-ready', 'processing')
          AND (refund.last_scanned_at IS NULL
            OR refund.next_check_at > refund.last_scanned_at
            OR refund.last_scanned_at + interval '4 hours' <= now()))::int
        AS "timeEligibleOverdueLogisticsWaits",
      count(refund.work_order_id) FILTER (
        WHERE refund.action_state = 'waiting-logistics'
          AND refund.next_check_at <= now()
          AND work_order.recovery_state IN ('ready', 'retry-authorized')
          AND work_order.status IN ('queued', 'retry-ready', 'processing')
          AND refund.last_scanned_at IS NOT NULL
          AND refund.next_check_at <= refund.last_scanned_at
          AND refund.last_scanned_at + interval '4 hours' > now())::int
        AS "cooldownSuppressedOverdueLogisticsWaits",
      count(refund.work_order_id) FILTER (
        WHERE refund.action_state IN ('page-error', 'verification-required')
          AND refund.next_check_at <= now()
          AND work_order.recovery_state IN ('ready', 'retry-authorized')
          AND work_order.status IN ('queued', 'retry-ready', 'processing'))::int
        AS "overdueRetries",
      count(refund.work_order_id) FILTER (
        WHERE refund.last_scanned_at >= now() - interval '30 minutes')::int
        AS "openScannedLast30Minutes",
      max(refund.last_scanned_at) AS "latestOpenRefundScanAt",
      max(throughput.scanned_last_30_minutes)::int AS "allScannedLast30Minutes",
      max(throughput.completed_last_30_minutes)::int AS "completedLast30Minutes",
      max(throughput.auto_refunded_last_30_minutes)::int AS "autoRefundedLast30Minutes",
      max(throughput.latest_scan_at) AS "latestAnyRefundScanAt",
      min(refund.next_check_at) FILTER (
        WHERE refund.action_state = 'waiting-logistics'
          AND refund.next_check_at <= now()
          AND work_order.recovery_state IN ('ready', 'retry-authorized')
          AND work_order.status IN ('queued', 'retry-ready', 'processing'))
        AS "oldestOverdueCheckAt"
    FROM shops shop
    LEFT JOIN LATERAL (
      SELECT heartbeat_at, metadata FROM worker_heartbeats
      WHERE shop_id = shop.id ORDER BY heartbeat_at DESC LIMIT 1
    ) heartbeat ON true
    LEFT JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (
          WHERE last_scanned_at >= now() - interval '30 minutes')
          AS scanned_last_30_minutes,
        count(*) FILTER (
          WHERE completed_at >= now() - interval '30 minutes')
          AS completed_last_30_minutes,
        count(*) FILTER (
          WHERE completed_at >= now() - interval '30 minutes'
            AND action_state = 'auto-refunded')
          AS auto_refunded_last_30_minutes,
        max(last_scanned_at) AS latest_scan_at
      FROM return_refunds
      WHERE shop_id = shop.id
    ) throughput ON true
    LEFT JOIN return_refunds refund ON refund.shop_id = shop.id
      AND refund.completed_at IS NULL
    LEFT JOIN work_orders work_order ON work_order.id = refund.work_order_id
    WHERE shop.enabled = true
    GROUP BY shop.id, shop.name, heartbeat.heartbeat_at, heartbeat.metadata,
      runtime.status
    ORDER BY "overdueLogisticsWaits" DESC, shop.name`);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), shops: rows }, null, 2));
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
