export const isPddTabUnavailableFailure = (value) => {
  const details = [
    value?.message,
    value?.error,
    ...(Array.isArray(value?.reasons) ? value.reasons : []),
  ];
  return details.some((detail) => /pdd 标签页不可用/iu.test(String(detail || '')));
};

export const pddTabUnavailableRetryAt = (
  nowMs,
  previousRetryAt = 0,
  cooldownMs = 60_000,
) => Math.max(previousRetryAt, nowMs + cooldownMs);
