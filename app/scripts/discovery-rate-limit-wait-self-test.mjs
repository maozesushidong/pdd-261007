import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { discoveryWaitsForRateLimit } from '../apps/worker/src/discovery-wait-state.mjs';

const requestId = 'current-discovery';
const base = {
  step: 'rate-limited-waiting', updatedAt: new Date(10000).toISOString(),
  rateLimitWaitMs: 300000, retryAfterAt: new Date(310000).toISOString(),
  residentCommand: { requestId, action: 'discover', status: 'active' },
};
assert(discoveryWaitsForRateLimit(base, { requestId, now: 10000 }));
for (const change of [
  { step: 'ordinary-pending-filter-confirmed' },
  { retryAfterAt: 'invalid' }, { retryAfterAt: new Date(9999).toISOString() },
  { rateLimitWaitMs: -1 }, { rateLimitWaitMs: 2 * 60 * 60_000 },
  { retryAfterAt: new Date(999999).toISOString() },
  { residentCommand: { ...base.residentCommand, requestId: 'stale' } },
  { residentCommand: { ...base.residentCommand, status: 'idle' } },
  { residentCommand: { ...base.residentCommand, action: 'run-refund' } },
]) assert.equal(discoveryWaitsForRateLimit({ ...base, ...change }, { requestId, now: 10000 }), false);
assert(discoveryWaitsForRateLimit(base, { startedAt: 9000, now: 10000 }));
assert.equal(discoveryWaitsForRateLimit(base, { startedAt: 11000, now: 12000 }), false);
assert.equal(discoveryWaitsForRateLimit(base, { startedAt: 0, now: 0 }), false);

// Execute the actual production discovery loop using a virtual clock. This
// reproduces a five-minute platform wait against its four-minute work budget.
const source = fs.readFileSync(new URL('../apps/worker/src/postgres-playwright-runner.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function discoverPendingOrder(');
const end = source.indexOf('\nif (!shopId)', start);
assert(start >= 0 && end > start);
const simulate = async ({ marker = true, stale = false, finishAt = Infinity,
  gateEndsAt = 310000, verification = false, childExit = false } = {}) => {
  let clock = 0;
  let recycledAt = null;
  let sent = 0;
  const progress = () => ({
    ...base, updatedAt: new Date(clock).toISOString(),
    step: verification && clock < gateEndsAt ? 'human-verification-required'
      : marker && clock >= 10000 && clock < gateEndsAt ? 'rate-limited-waiting' : 'discovery-running',
    residentCommand: { requestId: stale ? 'previous-command' : requestId,
      action: 'discover', status: clock >= finishAt ? 'idle' : 'active' },
  });
  const sandbox = {
    Date: { now: () => clock }, path: { dirname: () => '/mock' },
    fsp: { mkdir: async () => {}, rm: async () => {}, readFile: async () => {
      if (clock < finishAt) throw new Error('result not yet written');
      return JSON.stringify({ requestId, status: 'completed' });
    } },
    discoveryFile: '/mock/discovery.json', residentBrowser: true,
    activeChildRunning: () => true, activeChild: {},
    activeChildExitPromise: childExit ? Promise.resolve({ code: 1 }) : new Promise(() => {}),
    waitForActiveResidentReady: async () => {},
    sendWorkflowCommand: async () => { sent += 1; return { requestId }; },
    observeOnboardingProgress: async () => {}, readProgress: async () => progress(),
    discoveryResultTimeoutMs: 240000, shopId: 'mock-shop',
    discoveryWaitsForRateLimit,
    recoverDiscoveryFailure: async () => { recycledAt = clock; return { status: 'retryable-error' }; },
    setTimeout: (callback, milliseconds) => { clock += milliseconds; callback(); },
    console: { error() {} },
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = discoverPendingOrder;', sandbox);
  const result = await sandbox.run();
  return { result, recycledAt, clock, sent };
};
const recovered = await simulate({ finishAt: 350000 });
assert.equal(recovered.result.status, 'completed');
assert.equal(recovered.recycledAt, null, 'the browser must survive the complete five-minute platform wait');
assert.equal(recovered.sent, 1, 'waiting must not duplicate a resident command');
assert.equal((await simulate({ stale: true })).recycledAt, 240000,
  'a stale command marker must not suspend the new discovery budget');
assert.equal((await simulate({ marker: false })).recycledAt, 240000,
  'a genuinely stuck discovery must still time out');
const expired = await simulate({ gateEndsAt: Infinity });
assert(expired.recycledAt >= 539000 && expired.recycledAt <= 541000,
  'even a stuck rate-limit marker must stop exempting time once its deadline expires');
assert.equal((await simulate({ marker: false, verification: true,
  gateEndsAt: 650000, finishAt: 660000 })).result.status, 'completed',
'the existing human-verification wait must remain protected');
assert.equal((await simulate({ childExit: true })).result.status, 'retryable-error',
  'an actual browser exit must still return promptly');
console.log('Discovery platform-wait regression passed (actual loop: 5-minute cooldown, stale markers, expired wait, true timeout, human verification, child exit)');
