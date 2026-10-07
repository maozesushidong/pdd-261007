import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const orderNumber = process.argv[2];
if (!/^\d{6}-\d{15}$/u.test(orderNumber || '')) {
  throw new Error('Usage: chat-case-state-audit.mjs <order-number>');
}
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'chat-case-state-read-only-audit' });
await client.connect();
try {
  const result = await client.query(`
    SELECT chat.id AS case_id, chat.shop_id, chat.platform_case_id,
      chat.status, chat.last_error, chat.collect_requested,
      chat.collect_lease_until, chat.next_collect_at,
      chat.collect_generation, chat.updated_at,
      snapshot.id AS snapshot_id, snapshot.payload AS snapshot_payload,
      snapshot.created_at AS snapshot_created_at,
      jsonb_typeof(snapshot.payload->'messages') AS messages_type,
      CASE WHEN jsonb_typeof(snapshot.payload->'messages') = 'array'
        THEN jsonb_array_length(snapshot.payload->'messages') ELSE NULL END AS message_count,
      snapshot.payload #>> '{completeness,complete}' AS completeness,
      snapshot.payload #> '{completeness,issues}' AS issues,
      job.status AS analysis_status, job.error_code AS analysis_error_code,
      job.result #>> '{analysis,conclusion}' AS model_conclusion,
      job.result #>> '{policy,conclusion}' AS policy_conclusion,
      job.result #>> '{policy,eligible}' AS policy_eligible,
      job.result #>> '{policy,disposition}' AS policy_disposition,
      job.result #> '{policy,issues}' AS policy_issues,
      job.updated_at AS analysis_updated_at
    FROM chat_cases chat
    LEFT JOIN LATERAL (
      SELECT * FROM chat_snapshots snapshot
      WHERE snapshot.case_id = chat.id
      ORDER BY snapshot.created_at DESC LIMIT 1
    ) snapshot ON true
    LEFT JOIN LATERAL (
      SELECT * FROM chat_analysis_jobs job
      WHERE job.case_id = chat.id
      ORDER BY job.created_at DESC LIMIT 1
    ) job ON true
    WHERE chat.order_number = $1
    ORDER BY chat.updated_at DESC`, [orderNumber]);
  const cases = result.rows.map(({ snapshot_payload: snapshot, ...row }) => {
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const roleCounts = {};
    const unknownSourceClasses = {};
    const unknownFirstLines = {};
    for (const message of messages) {
      const role = String(message?.role || 'missing');
      roleCounts[role] = (roleCounts[role] || 0) + 1;
      if (role === 'unknown') {
        const sourceClass = String(message?.source?.class || '<empty>').slice(0, 120);
        unknownSourceClasses[sourceClass] = (unknownSourceClasses[sourceClass] || 0) + 1;
        const firstLine = String(message?.rawText || '').split('\n')[0].trim();
        const fingerprint = crypto.createHash('sha256').update(firstLine).digest('hex').slice(0, 12);
        const shape = firstLine.replace(/\p{Script=Han}/gu, '中')
          .replace(/[A-Za-z]/gu, 'A').replace(/[0-9]/gu, '0');
        const brandSpeaker = /^PANAPOPO\p{Script=Han}{1,12}$/u.test(firstLine)
          ? `:brandSpeaker=${firstLine}` : '';
        const key = `${fingerprint}:shape=${shape}:lines=${String(message?.rawText || '').split('\n').length}${brandSpeaker}`;
        unknownFirstLines[key] = (unknownFirstLines[key] || 0) + 1;
      }
    }
    return { ...row, roleCounts, unknownSourceClasses, unknownFirstLines };
  });
  const settings = (await client.query('SELECT mode FROM chat_analysis_settings WHERE id = 1')).rows[0] || null;
  console.log(JSON.stringify({ orderNumber, mode: settings?.mode || null, cases }, null, 2));
} finally {
  await client.end();
}
