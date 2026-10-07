export const pddVerificationPressureCooldownUntil = ({
  distinctResolvedCases = 0,
  distinctResolvedCasesHour = distinctResolvedCases,
  latestResolvedAt = null,
  now = Date.now(),
} = {}) => {
  const checkedAt = Number(now);
  const resolvedAt = latestResolvedAt instanceof Date
    ? latestResolvedAt.getTime()
    : Date.parse(String(latestResolvedAt || ''));
  if (!Number.isFinite(checkedAt) || !Number.isFinite(resolvedAt)) return 0;
  // Give this shop a five-minute break after every resolved challenge before
  // opening another order. An in-flight claim continues outside this policy.
  const cooldownMs = Number(distinctResolvedCasesHour) >= 1
    || Number(distinctResolvedCases) >= 1 ? 5 * 60_000 : 0;
  if (!cooldownMs) return 0;
  const until = resolvedAt + cooldownMs;
  return until > checkedAt ? until : 0;
};
