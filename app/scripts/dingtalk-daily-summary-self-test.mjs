import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDailySummaryDraftText,
  buildDailySummaryDingTalkMessage,
  deliverDailySummaryToDingTalk,
  normalizeDailySummaryMessage,
} from '../apps/api/src/dingtalk-daily-summary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(buildDailySummaryDraftText({ todayProcessed: 12, historicalProcessed: 345 }),
  '今日Agent已处理单量 12 单\nAgent历史总处理单量 345 单');
assert.deepEqual(normalizeDailySummaryMessage('  今日Agent已处理单量 12 单\r\nAgent历史总处理单量 345 单  '), {
  value: '今日Agent已处理单量 12 单\nAgent历史总处理单量 345 单',
});
assert.equal(normalizeDailySummaryMessage('').error, 'daily-summary-message-required');
assert.equal(normalizeDailySummaryMessage('x'.repeat(2001)).error, 'daily-summary-message-too-long');

const message = buildDailySummaryDingTalkMessage({
  messageText: '今日Agent已处理单量 12 单\nAgent历史总处理单量 345 单',
  summaryDate: '2026-08-17',
});
assert.equal(message.msgtype, 'markdown');
assert.equal(message.markdown.title, '拼多多Agent执行汇报');
assert.equal(message.markdown.text, [
  '### 拼多多Agent执行汇报',
  '',
  '- 今日Agent已处理单量 12 单',
  '- Agent历史总处理单量 345 单',
].join('\n'));
assert.doesNotMatch(message.markdown.text, /所有者|手动发送|编辑人|发送人|统计日期/u);
assert.deepEqual(message.at, { atMobiles: [], atUserIds: [], isAtAll: false });

let request = null;
const delivery = await deliverDailySummaryToDingTalk({
  webhook: 'https://example.com/robot?access_token=self-test',
  signingSecret: 'self-test-secret',
  messageText: '今日Agent已处理单量 12 单',
  summaryDate: '2026-08-17',
  fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
  },
});
assert.equal(delivery.responseStatus, 200);
assert.match(request.url, /timestamp=/u);
assert.match(request.url, /sign=/u);
assert.match(JSON.parse(request.options.body).markdown.text, /- 今日Agent已处理单量 12 单/u);

await assert.rejects(() => deliverDailySummaryToDingTalk({
  webhook: 'https://example.com/robot?access_token=self-test',
  signingSecret: 'self-test-secret',
  messageText: '今日Agent已处理单量 12 单',
  summaryDate: '2026-08-17',
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errcode: 310000, errmsg: 'rejected' }),
  }),
}), /dingtalk-summary-delivery-failed/u);

const dispatcher = await readFile(path.join(root, 'scripts/dingtalk-dispatcher.mjs'), 'utf8');
const panel = await readFile(
  path.join(root, 'apps/web/src/features/dashboard/DailySummaryPanel.jsx'),
  'utf8',
);
const backend = await readFile(path.join(root, 'apps/api/src/data-backend.mjs'), 'utf8');
assert.match(dispatcher, /message_text, status/u);
assert.match(dispatcher, /today_strict_automated/u);
assert.match(dispatcher, /today_completed/u);
assert.match(dispatcher,
  /refund\.action_state = 'manual-completed'[\s\S]*refund\.completion_method = 'return-refund-read-only-page-completed'/u,
  'system read-only return-refund completion must count as strict automation');
assert.match(dispatcher,
  /pddResolutionSubmission'->>'recoveredFromCompletedPage'[\s\S]*lastCompletedOrder'->>'recoveredFromCompletedPage'[\s\S]*completionArchive'->>'recoveredFromCompletedPage'[\s\S]*false[\s\S]*\) = false/u,
  'recovered old work orders must count as completed without inflating first-pass automation');
assert.match(dispatcher, /拼多多Agent执行汇报/u);
assert.match(dispatcher, /今日Agent已处理单量/u);
assert.match(dispatcher, /Agent历史总处理单量/u);
assert.doesNotMatch(dispatcher, /今日完成（含验证及业务人工协助）/u);
const strictStatisticsSql = dispatcher.slice(
  dispatcher.indexOf('WITH successful_outcomes AS ('),
  dispatcher.indexOf('), successfully_processed_units AS ('),
);
const dailyStatisticsSql = dispatcher.slice(
  dispatcher.indexOf('), statistics AS ('),
  dispatcher.indexOf('INSERT INTO dingtalk_daily_summaries'),
);
assert.doesNotMatch(strictStatisticsSql, /reason_code NOT IN/u,
  'login and verification assistance must disqualify strict automation');
assert.doesNotMatch(strictStatisticsSql, /verification-recheck|force-clear-verification/u,
  'owner verification commands must disqualify strict automation');
assert.match(dailyStatisticsSql,
  /processed_at >= \(\(\(\$1::date - 1\) \+ time '18:30'\)[\s\S]*processed_at < \(\(\$1::date \+ time '18:30'\)/u,
  'daily summary must include the previous 18:30 boundary and exclude the current 18:30 boundary');
assert.match(dispatcher,
  /Number\(clock\.hour\) === 18 && Number\(clock\.minute\) >= 25/u,
  'the editable summary draft must be ready before the 18:30 manual send time');
assert.match(dispatcher,
  /dingtalk-daily-summary-automatic-enabled/u,
  'daily summary automatic delivery must use its own persisted setting');
assert.match(dispatcher,
  /Number\(clock\.hour\) === 18 && Number\(clock\.minute\) >= 30/u,
  'automatic daily summary delivery must not start before 18:30 Beijing time');
assert.match(dispatcher,
  /status IN \('pending', 'failed'\)[\s\S]*attempt_count < 3/u,
  'automatic daily summary delivery must claim a bounded retryable row');
assert.match(dispatcher,
  /WHERE summary_date = \$1::date AND status = 'sending'/u,
  'automatic daily summary result must only finish the claimed sending row');
assert.doesNotMatch(dispatcher, /time '17:30'/u);
assert.doesNotMatch(dispatcher, /const claimDailySummary/u);
assert.doesNotMatch(dispatcher, /deliverDailySummary\(/u);
assert.match(panel, /今日Agent已处理单量/u);
assert.match(panel, /Agent历史总处理单量/u);
assert.match(panel, /每天 18:30 自动发送/u);
assert.match(panel, /dingtalk-daily-summary/u);
assert.match(panel, /今日已发送/u);
assert.doesNotMatch(panel, /今日完成（含协助）|今日纯自动完成|历史已处理（含等待物流）/u);
assert.match(backend,
  /this\.metricsSummary\(\{ dailySummaryDate: storedSummary\.summaryDate \}\)/u);
assert.match(backend,
  /w\.updated_at >= \(\(\(\$\{summaryDateParameter\}::date - 1\) \+ time '18:30'\)[\s\S]*w\.updated_at < \(\(\$\{summaryDateParameter\}::date \+ time '18:30'\)/u,
  'owner summary viewer metrics must use the same Beijing 18:30 window');
assert.match(backend, /historicalViewerMetrics[\s\S]*this\.metricsSummary\(\{\}\)/u);
assert.match(backend, /dingtalk-daily-summary-automatic-start-date/u);

const api = await readFile(path.join(root, 'apps/api/src/main.mjs'), 'utf8');
assert.match(api,
  /afterCutoff[\s\S]*Number\(clock\.hour\) === 18 && Number\(clock\.minute\) >= 30/u,
  'enabling after 18:30 must defer automatic delivery to the next Beijing date');
assert.match(api, /dingtalkDailySummaryStartDate\(\)/u);

console.log('DingTalk daily summary self-test passed (mock delivery only)');
