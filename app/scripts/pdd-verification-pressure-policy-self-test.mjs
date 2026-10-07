import assert from 'node:assert/strict';

import { pddVerificationPressureCooldownUntil } from '../apps/worker/src/pdd-verification-pressure-policy.mjs';

const now = Date.parse('2026-09-29T02:40:00.000Z');
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 1,
  latestResolvedAt: new Date(now - 60_000).toISOString(),
  now,
}), now + 4 * 60_000);
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 0,
  distinctResolvedCasesHour: 0,
  latestResolvedAt: new Date(now - 60_000).toISOString(),
  now,
}), 0);
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 2,
  latestResolvedAt: new Date(now - 60_000).toISOString(),
  now,
}), now + 4 * 60_000);
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 2,
  latestResolvedAt: new Date(now - 60_000),
  now,
}), now + 4 * 60_000);
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 3,
  latestResolvedAt: new Date(now - 3 * 60_000).toISOString(),
  now,
}), now + 2 * 60_000);
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 1,
  distinctResolvedCasesHour: 3,
  latestResolvedAt: new Date(now - 4 * 60_000).toISOString(),
  now,
}), now + 60_000);
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 3,
  latestResolvedAt: new Date(now - 6 * 60_000).toISOString(),
  now,
}), 0);
assert.equal(pddVerificationPressureCooldownUntil({
  distinctResolvedCases: 2,
  latestResolvedAt: null,
  now,
}), 0);
console.log('PDD post-verification cooldown policy passed');
