const transientLoadingPattern = /^(?:查询中|正在查询|加载中|正在加载|请稍候|未返回查询结果)/u;
const transientGatewayPattern = /(?:\b(?:500|502|503|504)\b[\s\S]{0,160}(?:internal server error|bad gateway|service unavailable|gateway time-?out)|bad gateway|service unavailable|gateway time-?out|upstream[\s\S]{0,80}timed out)/iu;
const transientFetchPattern = /^(?:(?:TypeError:\s*)?Failed to fetch|NetworkError when attempting to fetch resource\.?)$/iu;

export const classifyTmsOmsQueryHttpStatus = (status) => {
  const normalized = Number(status);
  if ([401, 403].includes(normalized)) return 'authorization-recovery';
  if ([408, 425, 429].includes(normalized) || normalized >= 500) return 'transient-retry';
  return 'terminal';
};

export const isTransientTmsOmsQueryMessage = (message) => {
  const normalized = String(message || '').replace(/\s+/gu, ' ').trim();
  return transientLoadingPattern.test(normalized) || transientGatewayPattern.test(normalized)
    || transientFetchPattern.test(normalized);
};
