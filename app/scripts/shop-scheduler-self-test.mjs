import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateTargetSlots,
  nextOrdinaryScanAt,
  percentile,
  rankScheduleCandidates,
  schedulerConfigFromEnv,
  schedulerDefaults,
} from '../apps/worker/src/scheduler-policy.mjs';
import { aggregateProcessTreeMemory } from '../apps/worker/src/process-tree-memory.mjs';
import { ShopSchedulerRepository } from '../apps/worker/src/scheduler-repository.mjs';
import {
  normalizeShopSchedulerTelemetry,
  runtimeCapacityTelemetry,
} from '../apps/api/src/data-backend.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(percentile([300, 100, 200, 500, 400]), 500);
assert.equal(percentile([], 0.95), null);

const normal = calculateTargetSlots({
  totalMemoryMb: 16 * 1024,
  freeMemoryMb: 12 * 1024,
  dueCount: 100,
  activeCount: 0,
  slotMemorySamplesMb: [1100, 1200, 1250],
  config: { ...schedulerDefaults, capacityMode: 'resource', hardSlotLimit: 100 },
});
assert.equal(normal.target, 9);
assert.equal(normal.resourceBlocked, false);

const memoryBlocked = calculateTargetSlots({
  totalMemoryMb: 16 * 1024,
  freeMemoryMb: 2 * 1024,
  dueCount: 95,
  activeCount: 5,
  config: { ...schedulerDefaults, capacityMode: 'resource', hardSlotLimit: 100 },
});
assert.equal(memoryBlocked.target, 5);
assert.equal(memoryBlocked.blockedReason, 'memory-high');

const emergency = calculateTargetSlots({
  totalMemoryMb: 16 * 1024,
  freeMemoryMb: 700,
  dueCount: 100,
  activeCount: 4,
  config: { ...schedulerDefaults, capacityMode: 'resource', hardSlotLimit: 100 },
});
assert.equal(emergency.target, 4);
assert.equal(emergency.emergency, true);

const unbounded = calculateTargetSlots({
  totalMemoryMb: 16 * 1024,
  freeMemoryMb: 700,
  dueCount: 100,
  activeCount: 4,
});
assert.equal(unbounded.target, 104);
assert.equal(unbounded.capacityMode, 'unbounded');
assert.equal(unbounded.blockedReason, null);
assert.equal(unbounded.warningReason, 'memory-emergency');
assert.equal(schedulerConfigFromEnv({
  WORKER_SLOT_CAPACITY_MODE: 'unbounded',
  WORKER_SLOT_HARD_LIMIT: '0',
}).hardSlotLimit, null);
assert.equal(schedulerConfigFromEnv({
  WORKER_SLOT_CAPACITY_MODE: 'unbounded',
}).keepEnabledShopsResident, true);
assert.equal(schedulerConfigFromEnv({
  WORKER_SLOT_CAPACITY_MODE: 'resource',
}).keepEnabledShopsResident, false);

assert.deepEqual(normalizeShopSchedulerTelemetry({
  enabled: true,
  workerOnline: true,
  scheduleState: 'queued',
  nextOrdinaryScanAt: '2026-08-24T17:18:03.025Z',
  nextRefundScanAt: '2026-08-24T17:18:03.025Z',
  queueEnteredAt: '2026-08-24T17:18:03.025Z',
  capacityBlockedReason: null,
  overdueReason: 'scheduler-not-running',
  queuePosition: 1,
}, 'legacy'), {
  enabled: true,
  workerOnline: true,
  scheduleState: 'resident',
  nextOrdinaryScanAt: null,
  nextRefundScanAt: null,
  queueEnteredAt: null,
  capacityBlockedReason: null,
  overdueReason: null,
  queuePosition: null,
});
assert.equal(normalizeShopSchedulerTelemetry({
  enabled: true,
  workerOnline: true,
  overdueReason: 'verification-waiting',
}, 'legacy').overdueReason, 'verification-waiting');
assert.equal(normalizeShopSchedulerTelemetry({
  enabled: true,
  workerOnline: false,
  overdueReason: 'scheduler-not-running',
}, 'legacy').overdueReason, 'worker-offline');
assert.deepEqual(runtimeCapacityTelemetry({
  schedulerMode: 'legacy',
  snapshot: { enabledShops: 10, dueShops: 10, overdueShops: 10 },
  activeWorkers: 10,
}), { enabledShops: 10, dueShops: 0, overdueShops: 0 });
assert.deepEqual(runtimeCapacityTelemetry({
  schedulerMode: 'legacy',
  snapshot: { enabledShops: 10, dueShops: 10, overdueShops: 10 },
  activeWorkers: 9,
}), { enabledShops: 10, dueShops: 1, overdueShops: 1 });
const slotTelemetry = { enabledShops: 10, dueShops: 4, overdueShops: 2 };
assert.equal(runtimeCapacityTelemetry({
  schedulerMode: 'slots', snapshot: slotTelemetry, activeWorkers: 6,
}), slotTelemetry);

const unboundedRepository = new ShopSchedulerRepository(null, {
  config: {
    ...schedulerDefaults,
    capacityMode: 'unbounded',
    keepEnabledShopsResident: true,
  },
});
assert.ok(unboundedRepository.allowedKinds({ verificationSlots: 5, loginSlots: 2 })
  .includes('verification'),
  'unbounded resident mode must keep admitting verification shops so every enabled shop gets a browser');

const resourceRepository = new ShopSchedulerRepository(null, {
  config: {
    ...schedulerDefaults,
    capacityMode: 'resource',
    keepEnabledShopsResident: false,
    verificationSlots: 1,
  },
});
assert.ok(resourceRepository.allowedKinds({ verificationSlots: 0, loginSlots: 0 })
  .includes('verification'));
assert.ok(!resourceRepository.allowedKinds({ verificationSlots: 1, loginSlots: 0 })
  .includes('verification'),
  'resource mode must preserve the single verification-browser limit');

const now = Date.now();
assert.equal(
  nextOrdinaryScanAt({ now, hotUntil: new Date(now + 1_000), config: schedulerDefaults }).getTime(),
  now + 60_000,
);
assert.equal(
  nextOrdinaryScanAt({ now, hotUntil: new Date(now - 1_000), config: schedulerDefaults }).getTime(),
  now + 10 * 60_000,
);

const processMemory = aggregateProcessTreeMemory([
  { pid: 10, parentPid: 1, memoryBytes: 100 * 1024 * 1024 },
  { pid: 11, parentPid: 10, memoryBytes: 200 * 1024 * 1024 },
  { pid: 12, parentPid: 11, memoryBytes: 300 * 1024 * 1024 },
  { pid: 20, parentPid: 1, memoryBytes: 50 * 1024 * 1024 },
], [10, 20]);
assert.equal(processMemory.get(10), 600);
assert.equal(processMemory.get(20), 50);

const candidates = Array.from({ length: 100 }, (_, index) => ({
  shopId: `shop-${String(index).padStart(3, '0')}`,
  assignmentKind: index % 5 === 0 ? 'refund-scan' : 'ordinary',
  queueEnteredAt: new Date(now - (index % 5 === 0 ? 60 : 2) * 60_000).toISOString(),
  dueAt: new Date(now - index * 1_000).toISOString(),
}));
const ranked = rankScheduleCandidates(candidates, now);
assert.equal(new Set(ranked.map((candidate) => candidate.shopId)).size, 100);
assert.equal(ranked[0].assignmentKind, 'refund-scan', 'aged refunds must not starve behind fresh ordinary scans');
assert.ok(ranked.findIndex((candidate) => candidate.assignmentKind === 'ordinary') >= 0);

const firstRound = ranked.slice(0, 8);
assert.equal(firstRound.length, 8);
assert.equal(new Set(firstRound.map((candidate) => candidate.shopId)).size, 8);

const [migration, unboundedMigration, loginTimestampMigration, runner, supervisor, schedulerRepository, apiBackend] = await Promise.all([
  fsp.readFile(path.join(root, 'infra/db/migrations/057_shop_scheduler_slots.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/058_unbounded_shop_and_browser_slots.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/074_align_scheduler_login_request_timestamp.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'apps/worker/src/postgres-playwright-runner.mjs'), 'utf8'),
  fsp.readFile(path.join(root, 'apps/worker/src/slot-supervisor.mjs'), 'utf8'),
  fsp.readFile(path.join(root, 'apps/worker/src/scheduler-repository.mjs'), 'utf8'),
  fsp.readFile(path.join(root, 'apps/api/src/data-backend.mjs'), 'utf8'),
]);
assert.match(migration, /FOR UPDATE|shop_schedule_state/);
assert.match(migration, /display_slot >= 0 AND display_slot < 1000/);
assert.match(unboundedMigration, /CHECK \(display_slot >= 0\)/);
assert.match(loginTimestampMigration, /date_trunc\('milliseconds', schedule\.last_login_request_at\)/);
assert.match(loginTimestampMigration, /date_trunc\('milliseconds', shop\.login_requested_at\)/);
assert.match(runner, /WORKER_SESSION_MAX_MS/);
assert.match(runner, /recordRefundCursor/);
assert.match(runner, /recordOrdinaryScan/);
assert.match(runner, /persistentSlotSession/);
assert.match(runner, /transitionPersistentSlot\('login', 'login'\)/);
assert.match(runner, /transitionPersistentSlot\('business', 'ordinary'\)/);
assert.match(
  runner,
  /status IN \('detected', 'waiting-human', 'verification-required'\)[\s\S]*assignmentKind === 'verification'[\s\S]*verification-cleared-business-resumed/u,
);
assert.match(runner, /pdd-identity-duplicate-login-waiting/);
assert.match(
  runner,
  /UPDATE shops SET onboarding_status = \$2[\s\S]*waiting-login/u,
  'runner must persist the waiting-login onboarding state through the parameterized update',
);
assert.match(supervisor, /WORKER_SLOT_LAUNCH_INTERVAL_MS|launchIntervalMs/);
assert.match(supervisor, /sampleProcessTreeMemory/);
assert.match(supervisor, /capacityMode === 'unbounded'/);
assert.match(supervisor, /WORKER_KEEP_ENABLED_SHOPS_RESIDENT/);
assert.match(
  supervisor,
  /keepEnabledShopsResident[\s\S]*snapshot\.unassignedEnabledShops[\s\S]*snapshot\.unassignedDueShops/,
  'resident mode must scale from the current enabled-shop count, including shops added while running',
);
assert.match(supervisor, /recoverOrphanedLocalAssignments/);
assert.match(schedulerRepository, /shop\.onboarding_status = 'ready'/);
assert.match(schedulerRepository, /SELECT login_requested_at FROM shops WHERE id = \$1/);
assert.match(schedulerRepository, /leaseExtensionMs/);
assert.match(schedulerRepository, /transitionResidentSlot/);
assert.match(schedulerRepository, /AS unassigned_enabled_shops/);
assert.match(schedulerRepository, /AS unassigned_due_shops/);
assert.match(schedulerRepository, /slot\.lease_expires_at > now\(\)/);
assert.match(schedulerRepository, /async recordOrdinaryScan/);
assert.match(schedulerRepository, /last_ordinary_scan_at = now\(\)/);
assert.match(schedulerRepository, /WHEN \$3 = 'verification-required' THEN now\(\) \+ interval '10 minutes'/);
assert.match(schedulerRepository, /this\.config\.hotOrdinaryIntervalMs/);
assert.match(schedulerRepository, /this\.config\.coldOrdinaryIntervalMs/);
assert.doesNotMatch(schedulerRepository, /this\.config\.(?:hot|cold)ScanIntervalMs/);
assert.doesNotMatch(
  schedulerRepository,
  /AS due_shops,[\s\S]{0,500}schedule\.assigned_slot_id IS NULL[\s\S]{0,200}AS overdue_shops/,
  'resident assignments must remain visible in due and overdue scan telemetry',
);
assert.match(schedulerRepository, /schedule_state = 'queued', queue_entered_at = now\(\), retry_at = NULL/);
assert.doesNotMatch(schedulerRepository, /const retryDelay = this\.config\.verificationRetryMs/);
assert.match(
  schedulerRepository,
  /UPDATE shop_schedule_state schedule SET retry_at = NULL,[\s\S]*schedule\.assigned_slot_id IS NULL AND schedule\.retry_at IS NOT NULL/,
  'scheduler startup must clear retry delays left by older worker versions',
);
assert.match(schedulerRepository, /\$3::boolean AND shop\.onboarding_status IS DISTINCT FROM 'ready'/);
assert.match(apiBackend, /runtimeCapacity/);
assert.match(apiBackend, /heartbeat_at > now\(\) - interval '45 seconds'/);
assert.match(apiBackend, /schedulerMode === 'legacy' \? snapshot\.enabledShops : capacity\.target/);
assert.match(apiBackend, /slot\.lease_expires_at > now\(\)/);
assert.match(apiBackend, /SELECT count\(\*\)::int FROM occupied/);

console.log('shop scheduler self-test passed');
