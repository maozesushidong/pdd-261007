import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';
import { confirmsReturnRefundCompletion } from '../packages/adapters/src/pdd/return-refund.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = argument('--shop');
const orderNumber = argument('--order');
const aftersaleNumber = argument('--aftersale');
const apply = process.argv.includes('--apply');
if (!shopId || !orderNumber || !aftersaleNumber) {
  throw new Error('Usage: reconcile-held-refund-terminal-result.mjs --shop ID --order NUMBER --aftersale NUMBER [--apply]');
}
if (!/^[a-z0-9-]{3,80}$/iu.test(shopId)
  || !/^[0-9-]{10,40}$/u.test(orderNumber)
  || !/^\d{8,30}$/u.test(aftersaleNumber)) {
  throw new Error('Invalid shop, order or aftersale identifier');
}
const resultPath = path.resolve(root, '..', 'data', 'workflow', 'shops', shopId,
  'state', 'return-refund-result.json');
const output = JSON.parse(await fs.readFile(resultPath, 'utf8'));
const facts = output?.result?.facts || {};
const exactOutput = output?.mode === 'claim'
  && output?.status === 'completed'
  && output?.shopId === shopId
  && output?.orderNumber === orderNumber
  && output?.aftersaleNumber === aftersaleNumber
  && output?.result?.outcome === 'manual-completed'
  && output?.result?.readOnlyReview === true
  && output?.result?.completionMethod === 'return-refund-read-only-page-completed'
  && facts.orderNumber === orderNumber
  && facts.aftersaleNumber === aftersaleNumber
  && confirmsReturnRefundCompletion(facts);
const envLine = (await fs.readFile(path.join(root, '.env.native'), 'utf8'))
  .split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
if (!envLine) throw new Error('DATABASE_URL is unavailable');
process.env.DATABASE_URL = envLine.slice(13).trim().replace(/^(['"])(.*)\1$/u, '$2');
const pool = await createPostgresPool();
try {
  const state = (await pool.query(`
    SELECT work_order.id, work_order.status, work_order.current_step,
      work_order.recovery_state, work_order.recovery_reason,
      refund.aftersale_number, effect.status AS effect_status,
      runtime.lease_token, runtime.lease_expires_at,
      runtime.current_work_order_id,
      binding.binding_token::text = refund.evidence->>'pddIdentityBindingToken'
        AS identity_token_matches,
      binding.mall_id = refund.evidence->>'pddMallId' AS mall_matches,
      binding.actual_shop_name = shop.expected_shop_name AS shop_matches
    FROM work_orders work_order
    JOIN shops shop ON shop.id = work_order.shop_id
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    JOIN external_effects effect ON effect.work_order_id = work_order.id
      AND effect.effect_type = 'pdd-return-refund'
    JOIN shop_runtime_state runtime ON runtime.shop_id = work_order.shop_id
    JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = work_order.shop_id
    WHERE work_order.shop_id = $1
      AND work_order.external_order_number = $2
      AND refund.aftersale_number = $3`, [shopId, orderNumber, aftersaleNumber])).rows;
  const row = state.length === 1 ? state[0] : null;
  const completedAt = Date.parse(String(output?.completedAt || ''));
  const leaseExpiresAt = Date.parse(String(row?.lease_expires_at || ''));
  const safe = exactOutput && row
    && row.status === 'processing'
    && row.recovery_state === 'held'
    && row.recovery_reason === 'unknown-external-effect'
    && row.effect_status === 'unknown'
    && row.current_work_order_id === row.id
    && Boolean(row.lease_token)
    && Number.isFinite(completedAt)
    && Number.isFinite(leaseExpiresAt)
    && completedAt < leaseExpiresAt
    && leaseExpiresAt > Date.now()
    && Date.now() - completedAt < 10 * 60_000
    && row.identity_token_matches === true
    && row.mall_matches === true
    && row.shop_matches === true;
  const report = {
    shopId, orderNumber, aftersaleNumber,
    outputCompletedAt: output?.completedAt || null,
    currentStep: row?.current_step || null,
    exactOutput, safe: Boolean(safe), applied: false,
  };
  if (!apply || !safe) {
    console.log(JSON.stringify(report));
    if (apply && !safe) process.exitCode = 2;
  } else {
    const repository = new PostgresWorkflowRepository(pool);
    const finished = await repository.finishHeldReturnRefundReadOnly({
      shopId, workOrderId: row.id, leaseToken: row.lease_token,
      result: output.result,
    });
    if (!finished) throw new Error('Exact held refund reconciliation lease changed');
    console.log(JSON.stringify({ ...report, applied: true }));
  }
} finally {
  await pool.end();
}
