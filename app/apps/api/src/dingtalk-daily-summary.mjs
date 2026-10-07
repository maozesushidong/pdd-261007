import crypto from 'node:crypto';

const maxMessageLength = 2000;
export const dailySummaryTitle = '拼多多Agent执行汇报';

export const buildDailySummaryDraftText = ({ todayProcessed, historicalProcessed }) => [
  `今日Agent已处理单量 ${Number(todayProcessed || 0)} 单`,
  `Agent历史总处理单量 ${Number(historicalProcessed || 0)} 单`,
].join('\n');

export const normalizeDailySummaryMessage = (input) => {
  if (typeof input !== 'string') return { error: 'daily-summary-message-invalid' };
  const value = input.replace(/\r\n?/gu, '\n').trim();
  if (!value) return { error: 'daily-summary-message-required' };
  if (value.length > maxMessageLength) return { error: 'daily-summary-message-too-long' };
  return { value };
};

export const signDingTalkSummaryUrl = (webhook, secret, timestamp = Date.now()) => {
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
  const url = new URL(webhook);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', signature);
  return url.toString();
};

export const buildDailySummaryDingTalkMessage = ({ messageText }) => {
  const lines = String(messageText || '')
    .split(/\r?\n/gu)
    .map((line) => line.replace(/^\s*[-*·•]\s*/u, '').trim())
    .filter(Boolean);
  return {
    msgtype: 'markdown',
    markdown: {
      title: dailySummaryTitle,
      text: [`### ${dailySummaryTitle}`, '', ...lines.map((line) => `- ${line}`)].join('\n'),
    },
    at: { atMobiles: [], atUserIds: [], isAtAll: false },
  };
};

export const deliverDailySummaryToDingTalk = async ({
  webhook,
  signingSecret,
  messageText,
  summaryDate,
  fetchImpl = fetch,
}) => {
  if (!webhook || !signingSecret) throw new Error('dingtalk-summary-not-configured');
  const response = await fetchImpl(signDingTalkSummaryUrl(webhook, signingSecret), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildDailySummaryDingTalkMessage({ messageText })),
  });
  const payload = await response.json().catch(() => ({ parseError: true }));
  if (!response.ok || Number(payload?.errcode || 0) !== 0) {
    const error = new Error('dingtalk-summary-delivery-failed');
    error.responseStatus = response.status;
    error.responsePayload = payload;
    throw error;
  }
  return { responseStatus: response.status, responsePayload: payload };
};
