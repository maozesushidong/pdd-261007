import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgPackage from 'pg';
import { createDataBackend } from '../apps/api/src/data-backend.mjs';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
process.env.DATA_BACKEND = 'postgres';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const summaryDate = '2099-12-30';
const actorId = 'daily-summary-self-test-owner';
const { Client } = pgPackage;
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  application_name: 'dingtalk-daily-summary-self-test',
});
await client.connect();
await client.query(`
  INSERT INTO dingtalk_daily_summaries
    (summary_date, today_processed, today_completed, today_strict_automated,
     historical_processed, message_text, status)
  VALUES ($1,12,11,9,345,$2,'pending')`, [
  summaryDate,
  '今日Agent已处理单量 12 单\nAgent历史总处理单量 345 单',
]);
await client.end();

const backend = await createDataBackend({ root, dataRoot: path.join(root, '.codex') });
try {
  const initial = await backend.getDingTalkDailySummary(summaryDate);
  const [expectedToday, expectedHistorical] = await Promise.all([
    backend.metricsSummary({ from: summaryDate, to: summaryDate }),
    backend.metricsSummary({}),
  ]);
  assert.equal(initial.todayProcessed, expectedToday.autoSuccess);
  assert.equal(initial.historicalProcessed, expectedHistorical.autoSuccess);
  assert.equal(initial.todayCompleted, 11);
  assert.equal(initial.todayStrictAutomated, 9);
  assert.equal(initial.status, 'pending');
  assert.equal(initial.messageText,
    `今日Agent已处理单量 ${expectedToday.autoSuccess} 单\nAgent历史总处理单量 ${expectedHistorical.autoSuccess} 单`);

  const edited = await backend.updateDingTalkDailySummary(summaryDate, {
    actorId,
    messageText: '今日Agent已处理单量 13 单\nAgent历史总处理单量 346 单',
  });
  assert.equal(edited.editedBy, actorId);
  assert.match(edited.messageText, /13 单/u);

  const firstClaim = await backend.claimDingTalkDailySummary(summaryDate, {
    actorId,
    messageText: edited.messageText,
  });
  assert.equal(firstClaim.status, 'sending');
  assert.equal(firstClaim.attemptCount, 1);

  const failed = await backend.finishDingTalkDailySummary(summaryDate, {
    actorId,
    succeeded: false,
    responseStatus: 502,
    responsePayload: { errcode: 310000 },
    deliveryError: { name: 'Error', message: 'mock-failure' },
  });
  assert.equal(failed.status, 'failed');

  const secondClaim = await backend.claimDingTalkDailySummary(summaryDate, {
    actorId,
    messageText: failed.messageText,
  });
  assert.equal(secondClaim.attemptCount, 2);
  const sent = await backend.finishDingTalkDailySummary(summaryDate, {
    actorId,
    succeeded: true,
    responseStatus: 200,
    responsePayload: { errcode: 0, errmsg: 'ok' },
  });
  assert.equal(sent.status, 'sent');
  assert.ok(sent.sentAt);

  await assert.rejects(() => backend.updateDingTalkDailySummary(summaryDate, {
    actorId,
    messageText: '不能再次编辑',
  }), /daily-summary-already-sent/u);
  await assert.rejects(() => backend.claimDingTalkDailySummary(summaryDate, {
    actorId,
    messageText: sent.messageText,
  }), /daily-summary-already-sent/u);
} finally {
  await backend.pool.query('DELETE FROM dingtalk_daily_summaries WHERE summary_date = $1::date', [summaryDate]);
  await backend.close();
}

console.log('DingTalk daily summary PostgreSQL self-test passed');
