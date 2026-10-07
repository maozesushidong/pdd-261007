import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sinceInput = process.argv[process.argv.indexOf('--since') + 1];
if (!sinceInput || Number.isNaN(Date.parse(sinceInput))) {
  throw new Error('--since requires an ISO-8601 timestamp');
}
const since = new Date(sinceInput).toISOString();
const nativeEnvironment = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = nativeEnvironment.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'refund-platform-proof-readonly-audit',
});
await client.connect();
try {
  const { rows } = await client.query(`
    SELECT shop.name AS "shopName",
      refund.external_order_number AS "orderNumber",
      refund.aftersale_number AS "aftersaleNumber",
      refund.action_state AS "actionState",
      refund.aftersale_status AS "aftersaleStatus",
      refund.completion_method AS "completionMethod",
      refund.completed_at AS "completedAt",
      refund.evidence #>> '{fieldSources,aftersaleStatus,source}' AS "statusSource",
      refund.evidence->>'capturedAt' AS "statusCapturedAt",
      effect_counts.total_count AS "totalEffects",
      effect_counts.succeeded_count AS "succeededEffects",
      effect_counts.unresolved_count AS "unresolvedEffects",
      effect.status AS "effectStatus",
      effect.receipt->>'orderNumber' AS "receiptOrderNumber",
      effect.receipt->>'aftersaleNumber' AS "receiptAftersaleNumber",
      effect.receipt->>'confirmationMethod' AS "confirmationMethod",
      effect.receipt->>'confirmedAt' AS "confirmedAt",
      effect.receipt #>> '{submission,approveClicked}' AS "approveClicked",
      effect.receipt #>> '{submission,confirmationFound}' AS "confirmationFound",
      effect.receipt #>> '{submission,confirmationClicked}' AS "confirmationClicked",
      effect.receipt #>> '{submission,confirmationDispatchStarted}' AS "confirmationDispatchStarted"
    FROM return_refunds refund
    JOIN shops shop ON shop.id = refund.shop_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total_count,
        count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_count,
        count(*) FILTER (WHERE status IN ('reserved', 'unknown'))::int AS unresolved_count
      FROM external_effects
      WHERE work_order_id = refund.work_order_id
        AND effect_type = 'pdd-return-refund'
    ) effect_counts ON true
    LEFT JOIN LATERAL (
      SELECT status, receipt, updated_at
      FROM external_effects
      WHERE work_order_id = refund.work_order_id
        AND effect_type = 'pdd-return-refund'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    ) effect ON true
    WHERE refund.action_state = 'auto-refunded'
      AND refund.completed_at >= $1::timestamptz
    ORDER BY refund.completed_at DESC
    LIMIT 100`, [since]);
  const records = rows.map((row) => {
    const receiptIdentityMatches = row.receiptOrderNumber === row.orderNumber
      && row.receiptAftersaleNumber === row.aftersaleNumber;
    const exactPersistedProof = row.actionState === 'auto-refunded'
      && /退款成功/u.test(String(row.aftersaleStatus || ''))
      && row.totalEffects === 1
      && row.succeededEffects === 1
      && row.unresolvedEffects === 0
      && row.effectStatus === 'succeeded'
      && receiptIdentityMatches
      && row.confirmationClicked === 'true'
      && row.confirmationDispatchStarted === 'true'
      && Boolean(row.confirmedAt);
    return {
      shopName: row.shopName,
      orderNumber: row.orderNumber,
      aftersaleNumber: row.aftersaleNumber,
      completedAt: row.completedAt,
      aftersaleStatus: row.aftersaleStatus,
      statusSource: row.statusSource,
      statusCapturedAt: row.statusCapturedAt,
      completionMethod: row.completionMethod,
      totalEffects: row.totalEffects,
      succeededEffects: row.succeededEffects,
      unresolvedEffects: row.unresolvedEffects,
      effectStatus: row.effectStatus,
      receiptIdentityMatches,
      approveClicked: row.approveClicked === 'true',
      confirmationFound: row.confirmationFound === 'true',
      confirmationClicked: row.confirmationClicked === 'true',
      confirmationDispatchStarted: row.confirmationDispatchStarted === 'true',
      confirmedAt: row.confirmedAt,
      confirmationMethod: row.confirmationMethod,
      exactPersistedProof,
    };
  });
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    since,
    checked: records.length,
    exactPersistedProof: records.filter((record) => record.exactPersistedProof).length,
    incompleteProof: records.filter((record) => !record.exactPersistedProof).length,
    records,
  }, null, 2));
} finally {
  await client.end();
}
