import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = arg('--shop');
const verificationId = arg('--verification-id');
const apply = process.argv.includes('--apply');
if (!/^[a-z0-9-]+$/u.test(shopId || '')
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(verificationId || '')) {
  throw new Error('Usage: reconcile-cleared-preclaim-verification.mjs --shop ID --verification-id UUID [--apply]');
}
const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseUrl = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='))
  ?.slice('DATABASE_URL='.length).trim();
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
const progress = JSON.parse(await fs.readFile(path.resolve(appRoot, '..', 'data', 'workflow',
  'shops', shopId, 'state', 'workflow-progress.json'), 'utf8'));
const recovery = progress.verificationRecovery || {};
const recheck = progress.verificationRecheck || {};
const pageUrl = new URL(String(progress.systemTabs?.pdd?.url || ''));
const observedUrl = new URL(String(recovery.observedUrl || ''));
const identityAtMs = Date.parse(String(progress.pddShopIdentity?.detectedAt || ''));
const tabsAtMs = Date.parse(String(progress.systemTabs?.checkedAt || ''));
const now = Date.now();
if (progress.shopId !== shopId || progress.verificationLocation
  || recovery.trigger !== 'resident-browser-restart-recovery'
  || recovery.status !== 'cleared' || recovery.verificationId !== verificationId
  || recheck.trigger !== recovery.trigger || recheck.status !== 'cleared'
  || recheck.verificationId !== verificationId
  || recovery.workOrderId !== recheck.workOrderId
  || recovery.externalActionsReplayed !== false
  || recheck.externalActionsReplayed !== false
  || pageUrl.origin !== 'https://mms.pinduoduo.com'
  || !pageUrl.pathname.startsWith('/aftersales/')
  || observedUrl.origin !== pageUrl.origin
  || !observedUrl.pathname.startsWith('/aftersales/')
  || progress.pddShopIdentity?.status !== 'detected'
  || !Number.isFinite(identityAtMs) || now - identityAtMs > 30_000
  || !Number.isFinite(tabsAtMs) || now - tabsAtMs > 30_000) {
  throw new Error('Live business page and exact cleared-verification evidence are required');
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2,
  application_name: 'reconcile-cleared-preclaim-verification' });
try {
  const { rows: [state] } = await pool.query(`
    SELECT shop.expected_shop_name, shop.onboarding_status,
      binding.mall_id, binding.actual_shop_name, binding.profile_fingerprint,
      runtime.status AS runtime_status, runtime.lease_token,
      runtime.current_work_order_id,
      verification.work_order_id, verification.status AS verification_status,
      verification.resolved_at, verification.url AS verification_url,
      work_order.external_order_number, work_order.completion_state,
      (SELECT count(*)::int FROM external_effects effect
       WHERE effect.work_order_id = verification.work_order_id
         AND effect.status IN ('reserved','unknown')) AS uncertain_effects
    FROM verification_locations verification
    JOIN work_orders work_order ON work_order.id = verification.work_order_id
    JOIN shops shop ON shop.id = verification.shop_id
    JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = shop.id
    JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
    WHERE verification.id = $1::uuid AND verification.shop_id = $2`,
  [verificationId, shopId]);
  if (!state
    || !['detected', 'waiting-human', 'verification-required'].includes(state.verification_status)
    || state.resolved_at || state.work_order_id !== recovery.workOrderId
    || state.verification_url !== recovery.verificationUrl
    || state.completion_state !== 'pending'
    || state.runtime_status !== 'idle' || state.lease_token
    || state.current_work_order_id || state.uncertain_effects !== 0
    || state.expected_shop_name !== state.actual_shop_name
    || state.actual_shop_name !== progress.pddShopIdentity.actualShopName
    || String(state.mall_id) !== String(progress.pddShopIdentity.mallId)
    || state.profile_fingerprint !== progress.pddShopIdentity.profileFingerprint) {
    throw new Error('Database verification, shop binding, or idle/effect guard failed');
  }
  const check = { shopId, verificationId, orderNumber: state.external_order_number,
    observedUrl: pageUrl.href, mallId: String(state.mall_id), safe: true, applied: false };
  if (!apply) {
    console.log(JSON.stringify(check));
  } else {
    // Repository locks the exact verification and work order, preserves effects,
    // and keeps uncertain submissions in the read-only reconciliation path.
    const repository = new PostgresWorkflowRepository(pool);
    const result = await repository.resolveRestoredPreClaimPddVerification({
      shopId, verificationId, workOrderId: recovery.workOrderId,
      recoveryStartedAt: recovery.startedAt,
      authenticatedAt: recovery.authenticatedAt,
      resolvedAt: recovery.completedAt,
      verificationUrl: recovery.verificationUrl,
      observedUrl: recovery.observedUrl,
    });
    if (!result?.verificationResolved) throw new Error('Repository did not resolve verification');
    console.log(JSON.stringify({ ...check, applied: true, result }));
  }
} finally {
  await pool.end();
}
