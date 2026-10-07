import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const assess = (row) => {
  let detailUrl;
  try { detailUrl = new URL(row.detailUrl); } catch { /* A missing URL cannot prove a page observation. */ }
  const capturedAt = new Date(row.capturedAt).getTime();
  const completedAt = new Date(row.completedAt).getTime();
  const elapsedMs = completedAt - capturedAt;
  const terminalOutcome = /退款成功/u.test(String(row.aftersaleStatus || ''))
    ? 'refunded' : row.aftersaleStatus === '买家已经撤销申请,退款关闭'
      ? 'withdrawn-closed'
      : /^因为买家逾期未处理或逾期未发货[,，]此次退款失败$/u
        .test(String(row.aftersaleStatus || ''))
        ? 'buyer-timeout-refund-failed-closed' : 'unrecognized';
  const checks = {
    readOnlyMethod: row.completionMethod === 'return-refund-read-only-page-completed',
    completedPageStatus: terminalOutcome !== 'unrecognized',
    renderedStatusMatches: row.renderedStatusValue === row.aftersaleStatus,
    exactDetailUrl: detailUrl?.hostname === 'mms.pinduoduo.com'
      && detailUrl.pathname === '/aftersales-ssr/detail'
      && detailUrl.searchParams.get('orderSn') === row.orderNumber
      && detailUrl.searchParams.get('id') === row.aftersaleNumber,
    shopIdentity: row.identityStatus === 'confirmed'
      && row.detectedShopName === row.expectedShopName
      && String(row.observedMallId || '') === String(row.confirmedMallId || ''),
    renderedStatusSource: ['label-following-line', 'status-text'].includes(row.statusSource)
      && /^[0-9a-f]{64}$/iu.test(String(row.pageTextSha256 || ''))
      && Number(row.extractedLineCount) > 0,
    freshObservation: Number.isFinite(elapsedMs) && elapsedMs >= -1_000
      && elapsedMs <= 60_000,
    noLocalRefundSubmission: row.refundEffectCount === 0,
  };
  const priorLocalSubmitConfirmed = row.refundEffectCount === 1
    && row.effectStatus === 'succeeded'
    && row.receiptOrderNumber === row.orderNumber
    && row.receiptAftersaleNumber === row.aftersaleNumber
    && row.confirmationClicked === 'true';
  return { ...row, terminalOutcome, checks, priorLocalSubmitConfirmed,
    exactPersistedProof: Object.values(checks).every(Boolean) };
};

if (process.argv.includes('--self-test')) {
  const valid = {
    completionMethod: 'return-refund-read-only-page-completed',
    aftersaleStatus: '商家同意退款,本单退款成功',
    orderNumber: '260920-123456789012345',
    aftersaleNumber: '22901234567890',
    detailUrl: 'https://mms.pinduoduo.com/aftersales-ssr/detail?id=22901234567890&orderSn=260920-123456789012345',
    identityStatus: 'confirmed', expectedShopName: '店铺甲',
    detectedShopName: '店铺甲', observedMallId: '123', confirmedMallId: '123',
    statusSource: 'label-following-line', renderedStatusValue: '商家同意退款,本单退款成功',
    pageTextSha256: 'a'.repeat(64),
    extractedLineCount: 12, capturedAt: '2026-09-28T04:00:00.500Z',
    completedAt: new Date('2026-09-28T04:00:04.000Z'), refundEffectCount: 0,
  };
  assert.equal(assess(valid).exactPersistedProof, true);
  assert.equal(assess({ ...valid, aftersaleNumber: 'wrong' }).checks.exactDetailUrl, false);
  assert.equal(assess({ ...valid, refundEffectCount: 1 }).checks.noLocalRefundSubmission, false);
  assert.equal(assess({ ...valid, detectedShopName: '店铺乙' }).checks.shopIdentity, false);
  assert.equal(assess({ ...valid, capturedAt: '2026-09-28T03:00:00Z' }).checks.freshObservation, false);
  const withdrawn = { ...valid, aftersaleStatus: '买家已经撤销申请,退款关闭',
    renderedStatusValue: '买家已经撤销申请,退款关闭' };
  assert.equal(assess(withdrawn).terminalOutcome, 'withdrawn-closed');
  assert.equal(assess(withdrawn).exactPersistedProof, true);
  const buyerTimeout = { ...valid,
    aftersaleStatus: '因为买家逾期未处理或逾期未发货,此次退款失败',
    renderedStatusValue: '因为买家逾期未处理或逾期未发货,此次退款失败' };
  assert.equal(assess(buyerTimeout).terminalOutcome, 'buyer-timeout-refund-failed-closed');
  assert.equal(assess(buyerTimeout).exactPersistedProof, true);
  assert.equal(assess({ ...valid, renderedStatusValue: '退款处理中' })
    .checks.renderedStatusMatches, false);
  assert.equal(assess({ ...valid, refundEffectCount: 1, effectStatus: 'succeeded',
    receiptOrderNumber: valid.orderNumber, receiptAftersaleNumber: valid.aftersaleNumber,
    confirmationClicked: 'true' }).priorLocalSubmitConfirmed, true);
  console.log('Refund read-only proof audit self-test passed');
  process.exit(0);
}

const sinceIndex = process.argv.indexOf('--since');
const sinceInput = sinceIndex >= 0 ? process.argv[sinceIndex + 1] : null;
if (!sinceInput || Number.isNaN(Date.parse(sinceInput))) {
  throw new Error('--since requires an ISO-8601 timestamp');
}
const since = new Date(sinceInput).toISOString();
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeEnvironment = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = nativeEnvironment.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'refund-readonly-proof-audit' });
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const { rows } = await client.query(`
    SELECT shop.name AS "shopName", shop.expected_shop_name AS "expectedShopName",
      identity.status AS "identityStatus", identity.mall_id AS "confirmedMallId",
      refund.external_order_number AS "orderNumber",
      refund.aftersale_number AS "aftersaleNumber",
      refund.aftersale_status AS "aftersaleStatus",
      refund.completion_method AS "completionMethod",
      refund.completed_at AS "completedAt",
      refund.evidence->>'detailUrl' AS "detailUrl",
      refund.evidence->>'pddMallId' AS "observedMallId",
      refund.evidence->>'detectedShopName' AS "detectedShopName",
      refund.evidence->>'capturedAt' AS "capturedAt",
      refund.evidence->>'pageTextSha256' AS "pageTextSha256",
      refund.evidence->>'extractedLineCount' AS "extractedLineCount",
      refund.evidence #>> '{fieldSources,aftersaleStatus,source}' AS "statusSource",
      refund.evidence #>> '{fieldSources,aftersaleStatus,value}' AS "renderedStatusValue",
      (SELECT count(*)::int FROM external_effects effect
       WHERE effect.work_order_id = refund.work_order_id
         AND effect.effect_type = 'pdd-return-refund') AS "refundEffectCount",
      effect.status AS "effectStatus",
      effect.receipt->>'orderNumber' AS "receiptOrderNumber",
      effect.receipt->>'aftersaleNumber' AS "receiptAftersaleNumber",
      effect.receipt #>> '{submission,confirmationClicked}' AS "confirmationClicked"
    FROM return_refunds refund
    JOIN shops shop ON shop.id = refund.shop_id
    LEFT JOIN shop_identity_bindings identity ON identity.shop_id = shop.id
    LEFT JOIN LATERAL (
      SELECT status, receipt FROM external_effects
      WHERE work_order_id = refund.work_order_id
        AND effect_type = 'pdd-return-refund'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    ) effect ON true
    WHERE refund.action_state = 'manual-completed'
      AND refund.completed_at >= $1::timestamptz
    ORDER BY refund.completed_at DESC`, [since]);
  await client.query('ROLLBACK');
  const records = rows.map(assess);
  const incomplete = records.filter((record) => !record.exactPersistedProof);
  const failedCheckCounts = {};
  for (const record of incomplete) {
    for (const [check, passed] of Object.entries(record.checks)) {
      if (!passed) failedCheckCounts[check] = (failedCheckCounts[check] || 0) + 1;
    }
  }
  const byShop = new Map();
  for (const record of records) {
    const count = byShop.get(record.shopName) || { shopName: record.shopName,
      checked: 0, exactPersistedProof: 0 };
    count.checked += 1;
    if (record.exactPersistedProof) count.exactPersistedProof += 1;
    byShop.set(record.shopName, count);
  }
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(), since,
    checked: records.length,
    exactPersistedProof: records.length - incomplete.length,
    incompleteProof: incomplete.length,
    terminalOutcomes: {
      refunded: records.filter((record) => record.terminalOutcome === 'refunded').length,
      withdrawnClosed: records.filter((record) => record.terminalOutcome === 'withdrawn-closed').length,
      buyerTimeoutRefundFailedClosed: records.filter((record) =>
        record.terminalOutcome === 'buyer-timeout-refund-failed-closed').length,
      unrecognized: records.filter((record) => record.terminalOutcome === 'unrecognized').length,
    },
    priorLocalSubmitConfirmed: records.filter((record) => record.priorLocalSubmitConfirmed).length,
    failedCheckCounts,
    byShop: [...byShop.values()].sort((left, right) => right.checked - left.checked),
    incompleteRecords: incomplete.slice(0, 20).map((record) => ({
      shopName: record.shopName, orderNumber: record.orderNumber,
      aftersaleNumber: record.aftersaleNumber, completedAt: record.completedAt,
      terminalOutcome: record.terminalOutcome,
      priorLocalSubmitConfirmed: record.priorLocalSubmitConfirmed,
      failedChecks: Object.entries(record.checks).filter(([, passed]) => !passed)
        .map(([check]) => check),
    })),
    omittedIncompleteRecords: Math.max(0, incomplete.length - 20),
  }, null, 2));
} finally {
  await client.end();
}
