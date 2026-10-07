const fields = [
  ['problemZh', 100, '问题（中文）'],
  ['descriptionZh', 220, '未完成流程分析（中文）'],
  ['descriptionEn', 260, 'Incomplete workflow analysis (English)'],
];

const logPattern = /(?:^|\n)\s*at\s+\S|file:\/\/\/|[A-Za-z]:\\\S+\.(?:mjs|js|ts):\d+|\b(?:workflow|runner|data-backend)\.mjs:\d+|page\.goto:|Target page, context or browser has been closed|Playwright workflow exited with code|"(?:level|reqId|eventKey)"\s*:/imu;

export const normalizeOwnerDingTalkMessage = (input) => {
  if (input == null) return { value: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: '钉钉消息内容格式无效' };
  }
  const value = {};
  for (const [field, maxLength, label] of fields) {
    const raw = String(input[field] || '');
    if (logPattern.test(raw)) return { error: `${label}不能包含日志或错误堆栈` };
    const normalized = raw.replace(/\s+/gu, ' ').trim();
    if (!normalized) return { error: `${label}不能为空` };
    if (normalized.length > maxLength) return { error: `${label}不能超过 ${maxLength} 个字符` };
    value[field] = normalized;
  }
  return { value };
};
