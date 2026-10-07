import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const shopId = arg('--shop');
const expectedVersion = Number(arg('--expected-version'));
const orders = String(arg('--orders') || '').split(',').map((value) => value.trim()).filter(Boolean);
const apply = process.argv.includes('--apply');
if (!/^[a-z0-9-]{5,100}$/u.test(shopId || '')
  || !Number.isInteger(expectedVersion) || expectedVersion < 0
  || !orders.length || orders.length > 5
  || new Set(orders).size !== orders.length
  || orders.some((order) => !/^\d{6}-\d{15}$/u.test(order))) {
  throw new Error('Usage: recollect-verified-shop-alias-chat.mjs --shop ID --expected-version N --orders ORDER[,ORDER] [--apply]');
}

const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'verified-shop-alias-chat-recollection' });
await client.connect();
let transactionOpen = false;
try {
  await client.query('BEGIN');
  transactionOpen = true;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0] || null;
  const shop = await one(`SELECT id, expected_shop_name, config_version, enabled, onboarding_status
    FROM shops WHERE id = $1 FOR UPDATE`, [shopId]);
  const binding = await one(`SELECT actual_shop_name, mall_id, binding_token::text AS token,
    profile_fingerprint FROM pdd_shop_runtime_bindings WHERE shop_id = $1`, [shopId]);
  const identity = await one(`SELECT status, expected_shop_name, mall_id, profile_fingerprint
    FROM shop_identity_bindings WHERE shop_id = $1`, [shopId]);
  const heartbeat = await one(`SELECT heartbeat_at, metadata FROM worker_heartbeats
    WHERE shop_id = $1 ORDER BY heartbeat_at DESC LIMIT 1`, [shopId]);
  const runtime = await one(`SELECT status, lease_token, lease_expires_at, current_work_order_id
    FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`, [shopId]);
  const auth = heartbeat?.metadata?.authHealth || {};
  const shopFailures = [];
  if (!shop?.enabled || shop.onboarding_status !== 'ready'
    || shop.config_version !== expectedVersion) shopFailures.push('shop-version-or-readiness');
  if (!binding || !identity || identity.status !== 'confirmed'
    || binding.actual_shop_name !== shop?.expected_shop_name
    || identity.expected_shop_name !== shop?.expected_shop_name
    || String(binding.mall_id || '') !== String(identity.mall_id || '')
    || binding.profile_fingerprint !== identity.profile_fingerprint) {
    shopFailures.push('shop-identity-binding');
  }
  if (!heartbeat || Date.now() - Date.parse(heartbeat.heartbeat_at) > 20_000
    || heartbeat.metadata?.actualShopName !== shop?.expected_shop_name
    || heartbeat.metadata?.identityBindingToken !== binding?.token
    || String(heartbeat.metadata?.mallId || '') !== String(binding?.mall_id || '')) {
    shopFailures.push('worker-heartbeat-identity');
  }
  if (['pdd', 'oms', 'tms'].some((system) => auth[system]?.status !== 'authenticated')) {
    shopFailures.push('system-authentication');
  }
  if (!runtime || runtime.lease_token || runtime.current_work_order_id) {
    shopFailures.push('runtime-active');
  }
  const active = await one(`SELECT
    (SELECT count(*)::int FROM external_effects WHERE shop_id = $1 AND status = 'reserved') AS reserved_effects,
    (SELECT count(*)::int FROM verification_locations WHERE shop_id = $1
      AND status IN ('detected','waiting-human','verification-required') AND resolved_at IS NULL) AS verifications`, [shopId]);
  if (Number(active?.reserved_effects || 0) || Number(active?.verifications || 0)) {
    shopFailures.push('reserved-effect-or-verification');
  }
  const sellerPrefix = String(shop?.expected_shop_name || '').replace(/\s+/gu, '')
    .replace(/(?:官方旗舰店|旗舰店|官方店|专营店|专卖店|店铺)$/u, '');
  if (sellerPrefix.length < 6 || !/\p{Script=Han}{2}/u.test(sellerPrefix)) {
    shopFailures.push('shop-alias-prefix-unavailable');
  }

  const inspected = [];
  for (const orderNumber of orders) {
    const candidate = await one(`
      SELECT chat.id AS chat_case_id, chat.status AS chat_status,
        chat.collect_requested, chat.collect_token, chat.collect_lease_until,
        chat.platform_case_id, chat.platform_case_key,
        work_order.id AS work_order_id, work_order.status AS work_order_status,
        work_order.current_step, work_order.completion_state,
        work_order.payload #>> '{latestDiscovery,pddIdentityBindingToken}' AS discovery_token,
        instance.id AS instance_id, instance.identity_status,
        instance.platform_case_id AS instance_platform_case_id,
        instance.platform_case_key AS instance_platform_case_key,
        instance.detail_url AS instance_detail_url
      FROM chat_cases chat
      JOIN work_orders work_order
        ON work_order.shop_id = chat.shop_id
        AND work_order.external_order_number = chat.order_number
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
        AND instance.work_order_id = work_order.id
        AND instance.shop_id = chat.shop_id
      WHERE chat.shop_id = $1 AND chat.order_number = $2
        AND chat.platform_case_id = instance.platform_case_id
      FOR UPDATE OF chat, work_order, instance`, [shopId, orderNumber]);
    const failures = [];
    if (!candidate) failures.push('case-or-instance-missing');
    if (candidate && (candidate.chat_status !== 'owner-review'
      || candidate.collect_requested || candidate.collect_token
      || (candidate.collect_lease_until && Date.parse(candidate.collect_lease_until) > Date.now()))) {
      failures.push('chat-case-not-idle-owner-review');
    }
    if (candidate && (candidate.work_order_status !== 'paused'
      || candidate.current_step !== 'manual-review-blocked'
      || candidate.completion_state !== 'pending'
      || candidate.identity_status !== 'verified'
      || candidate.instance_platform_case_id !== candidate.platform_case_id
      || candidate.instance_platform_case_key !== candidate.platform_case_key
      || candidate.instance_detail_url !==
        `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${candidate.platform_case_id}`
      || candidate.discovery_token !== binding?.token)) {
      failures.push('work-order-identity-or-state');
    }
    const effectCount = candidate ? await one(`SELECT count(*)::int AS count FROM external_effects
      WHERE work_order_id = $1`, [candidate.work_order_id]) : null;
    if (Number(effectCount?.count || 0) !== 0) failures.push('external-effect-present');
    const snapshot = candidate ? await one(`SELECT snapshot.id, snapshot.payload,
      job.status AS job_status, job.result
      FROM chat_snapshots snapshot
      JOIN chat_analysis_jobs job ON job.snapshot_id = snapshot.id
        AND job.case_id = snapshot.case_id
      WHERE snapshot.case_id = $1
      ORDER BY snapshot.created_at DESC, job.updated_at DESC LIMIT 1`, [candidate.chat_case_id]) : null;
    const messages = Array.isArray(snapshot?.payload?.messages) ? snapshot.payload.messages : [];
    const unknown = messages.filter((message) => message.role === 'unknown');
    const otherIssues = (snapshot?.payload?.completeness?.issues || [])
      .filter((issue) => issue !== '部分消息发言人角色无法确认');
    const policyIssues = snapshot?.result?.policy?.issues || [];
    if (!snapshot || snapshot.job_status !== 'analyzed'
      || snapshot.result?.analysis?.conclusion !== 'no-shortage'
      || snapshot.result?.policy?.eligible !== false
      || !messages.length || !unknown.length
      || snapshot.payload?.completeness?.complete !== false
      || otherIssues.length
      || policyIssues.some((issue) => ![
        '部分消息发言人角色无法确认', '聊天记录未确认完整',
      ].includes(issue))
      || unknown.some((message) => !String(message.rawText || '').split('\n')[0]
        .trim().replace(/\s+/gu, '').startsWith(sellerPrefix))) {
      failures.push('chat-evidence-not-alias-only');
    }
    inspected.push({ orderNumber, chatCaseId: candidate?.chat_case_id || null,
      workOrderId: candidate?.work_order_id || null,
      snapshotId: snapshot?.id || null,
      unknownAliasMessages: unknown.length,
      otherCompletenessIssues: otherIssues,
      policyIssues,
      failures });
  }
  const safe = shopFailures.length === 0 && inspected.every((item) => item.failures.length === 0);
  const report = { checkedAt: new Date().toISOString(), shopId, expectedVersion,
    observedVersion: shop?.config_version ?? null, safe, shopFailures, inspected };
  if (!apply || !safe) {
    await client.query('ROLLBACK');
    transactionOpen = false;
    console.log(JSON.stringify({ applied: false, ...report }));
    if (apply && !safe) process.exitCode = 2;
  } else {
    const backupDirectory = path.resolve(appRoot, '..', 'backups');
    await fs.mkdir(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory,
      `shop-alias-chat-recollection-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await fs.writeFile(backupPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    for (const item of inspected) {
      const updated = await client.query(`UPDATE chat_cases SET collect_requested = true,
        next_collect_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'owner-review' AND collect_requested = false
          AND collect_token IS NULL RETURNING id`, [item.chatCaseId]);
      if (updated.rowCount !== 1) throw new Error(`chat-case-changed:${item.orderNumber}`);
      await client.query(`INSERT INTO audit_events
        (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
        VALUES ($1,$2::uuid,'codex-safe-chat-recollection',
          'chat-shop-alias-recollection-requested',$3::jsonb,$4)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        shopId, item.workOrderId,
        JSON.stringify({ orderNumber: item.orderNumber, chatCaseId: item.chatCaseId,
          snapshotId: item.snapshotId, externalActionsReplayed: false }),
        `chat-shop-alias-recollection:${item.chatCaseId}:${item.snapshotId}`,
      ]);
    }
    await client.query('COMMIT');
    transactionOpen = false;
    console.log(JSON.stringify({ applied: true, backupPath, ...report }));
  }
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
