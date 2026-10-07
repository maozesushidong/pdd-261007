import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'chat-shop-alias-opportunity-read-only-audit' });
await client.connect();
try {
  const result = await client.query(`
    SELECT chat.shop_id, shop.name AS shop_name,
      shop.expected_shop_name, chat.order_number,
      chat.status, chat.updated_at,
      snapshot.payload AS snapshot,
      job.result AS analysis_result
    FROM chat_cases chat
    JOIN shops shop ON shop.id = chat.shop_id AND shop.enabled
    JOIN LATERAL (
      SELECT * FROM chat_snapshots snapshot
      WHERE snapshot.case_id = chat.id
      ORDER BY snapshot.created_at DESC LIMIT 1
    ) snapshot ON true
    JOIN LATERAL (
      SELECT * FROM chat_analysis_jobs job
      WHERE job.snapshot_id = snapshot.id AND job.status = 'analyzed'
      ORDER BY job.updated_at DESC LIMIT 1
    ) job ON true
    WHERE chat.scenario_code = 'product-shortage'
      AND chat.status = 'owner-review'
      AND chat.updated_at >= now() - interval '14 days'
    ORDER BY chat.updated_at DESC
    LIMIT 1000`);
  const byShop = new Map();
  for (const row of result.rows) {
    const prefix = String(row.expected_shop_name || '').replace(/\s+/gu, '')
      .replace(/(?:官方旗舰店|旗舰店|官方店|专营店|专卖店|店铺)$/u, '');
    const messages = Array.isArray(row.snapshot?.messages) ? row.snapshot.messages : [];
    const unknown = messages.filter((message) => message.role === 'unknown');
    const matched = unknown.filter((message) => prefix.length >= 6
      && /\p{Script=Han}{2}/u.test(prefix)
      && String(message.rawText || '').split('\n')[0]
        .trim().replace(/\s+/gu, '').startsWith(prefix));
    if (!matched.length) continue;
    const completenessIssues = row.snapshot?.completeness?.issues || [];
    const policyIssues = row.analysis_result?.policy?.issues || [];
    const aliasOnly = unknown.length === matched.length
      && completenessIssues.every((issue) => issue === '部分消息发言人角色无法确认')
      && policyIssues.every((issue) => [
        '部分消息发言人角色无法确认', '聊天记录未确认完整',
      ].includes(issue));
    const entry = byShop.get(row.shop_id) || {
      shopId: row.shop_id, shopName: row.shop_name,
      casesWithAliasUnknown: 0, aliasOnlyCases: 0,
      unknownAliasMessages: 0, candidates: [],
    };
    entry.casesWithAliasUnknown += 1;
    entry.unknownAliasMessages += matched.length;
    if (aliasOnly) {
      entry.aliasOnlyCases += 1;
      entry.candidates.push({ orderNumber: row.order_number,
        messageCount: messages.length, unknownAliasMessages: matched.length,
        conclusion: row.analysis_result?.analysis?.conclusion || null });
    }
    byShop.set(row.shop_id, entry);
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(),
    ownerReviewCasesScanned: result.rows.length,
    shops: [...byShop.values()].sort((a, b) => b.aliasOnlyCases - a.aliasOnlyCases),
  }, null, 2));
} finally {
  await client.end();
}
