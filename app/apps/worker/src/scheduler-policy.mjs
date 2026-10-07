import os from 'node:os';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const numberFrom = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const schedulerDefaults = Object.freeze({
  capacityMode: 'unbounded',
  keepEnabledShopsResident: true,
  hardSlotLimit: null,
  initialSlotBudgetMb: 1280,
  reservedMemoryMb: 4096,
  reservedMemoryRatio: 0.20,
  expansionMemoryRatio: 0.82,
  emergencyMemoryRatio: 0.92,
  expansionCpuRatio: 0.85,
  businessSessionMs: 10 * 60_000,
  // Verification pages must not hold a shop indefinitely.  Two minutes is
  // the agreed human-response window; after that the worker releases the
  // gate and continues with the next eligible task.
  verificationSessionMs: 2 * 60_000,
  loginSessionMs: 15 * 60_000,
  launchIntervalMs: 10_000,
  scaleDownIntervalMs: 30_000,
  hotWindowMs: 2 * 60 * 60_000,
  hotOrdinaryIntervalMs: 60_000,
  coldOrdinaryIntervalMs: 10 * 60_000,
  refundIntervalMs: 30 * 60_000,
  verificationRetryMs: [10 * 60_000, 30 * 60_000, 60 * 60_000],
  loginSlots: 2,
  verificationSlots: 1,
});

export const schedulerConfigFromEnv = (environment = process.env) => {
  const capacityMode = String(environment.WORKER_SLOT_CAPACITY_MODE || 'unbounded').toLowerCase();
  const configuredHardLimit = Math.floor(numberFrom(environment.WORKER_SLOT_HARD_LIMIT, 0));
  const keepEnabledShopsResident = String(
    environment.WORKER_SLOT_KEEP_ENABLED_RESIDENT ?? (capacityMode === 'resource' ? 'false' : 'true'),
  ).toLowerCase() === 'true';
  return {
    ...schedulerDefaults,
    capacityMode: capacityMode === 'resource' ? 'resource' : 'unbounded',
    keepEnabledShopsResident,
    hardSlotLimit: configuredHardLimit > 0 ? clamp(configuredHardLimit, 1, 1_000_000) : null,
    initialSlotBudgetMb: Math.max(512, numberFrom(environment.WORKER_SLOT_MEMORY_BUDGET_MB, 1280)),
    reservedMemoryMb: Math.max(2048, numberFrom(environment.WORKER_SLOT_RESERVED_MEMORY_MB, 4096)),
    businessSessionMs: Math.max(60_000, numberFrom(environment.WORKER_SLOT_SESSION_MS, 10 * 60_000)),
    verificationSessionMs: Math.max(60_000, numberFrom(environment.WORKER_VERIFICATION_SESSION_MS, 2 * 60_000)),
    launchIntervalMs: Math.max(1_000, numberFrom(environment.WORKER_SLOT_LAUNCH_INTERVAL_MS, 10_000)),
    hotWindowMs: Math.max(10 * 60_000, numberFrom(environment.WORKER_HOT_WINDOW_MS, 2 * 60 * 60_000)),
    hotOrdinaryIntervalMs: Math.max(60_000, numberFrom(environment.WORKER_HOT_SCAN_INTERVAL_MS, 60_000)),
    coldOrdinaryIntervalMs: Math.max(2 * 60_000, numberFrom(environment.WORKER_COLD_SCAN_INTERVAL_MS, 10 * 60_000)),
    refundIntervalMs: Math.max(5 * 60_000, numberFrom(environment.RETURN_REFUND_SCAN_INTERVAL_MS, 30 * 60_000)),
  };
};

export const percentile = (values, ratio = 0.95) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

export const calculateTargetSlots = ({
  totalMemoryMb,
  freeMemoryMb,
  cpuRatio = 0,
  dueCount = 0,
  activeCount = 0,
  slotMemorySamplesMb = [],
  config = schedulerDefaults,
}) => {
  const total = Math.max(1, numberFrom(totalMemoryMb, 1));
  const free = Math.max(0, numberFrom(freeMemoryMb, 0));
  const usedRatio = clamp(1 - (free / total), 0, 1);
  const reserved = Math.max(config.reservedMemoryMb, total * config.reservedMemoryRatio);
  const usable = Math.max(0, total - reserved);
  const measuredP95 = percentile(slotMemorySamplesMb);
  const slotBudgetMb = Math.max(512, measuredP95 || config.initialSlotBudgetMb);
  const memoryLimit = Math.floor(usable / slotBudgetMb);
  const demand = Math.max(0, Math.ceil(dueCount) + Math.ceil(activeCount));
  const capacityMode = config.capacityMode === 'resource' ? 'resource' : 'unbounded';
  const hardLimit = Number.isFinite(Number(config.hardSlotLimit)) && Number(config.hardSlotLimit) > 0
    ? Math.floor(Number(config.hardSlotLimit)) : Number.POSITIVE_INFINITY;
  const resourcePressure = usedRatio >= config.expansionMemoryRatio
    || cpuRatio >= config.expansionCpuRatio;
  const emergency = usedRatio >= config.emergencyMemoryRatio;
  const allowedByResources = emergency
    ? activeCount
    : resourcePressure ? activeCount : memoryLimit;
  const targetBeforeHardLimit = capacityMode === 'unbounded'
    ? demand : Math.min(demand, allowedByResources);
  const target = Math.max(0, Math.min(targetBeforeHardLimit, hardLimit));
  const warningReason = emergency ? 'memory-emergency'
    : usedRatio >= config.expansionMemoryRatio ? 'memory-high'
      : cpuRatio >= config.expansionCpuRatio ? 'cpu-high'
        : demand > memoryLimit ? 'memory-capacity' : null;
  return {
    target,
    demand,
    capacityMode,
    hardLimit: Number.isFinite(hardLimit) ? hardLimit : null,
    memoryLimit: Math.max(0, Math.min(memoryLimit, hardLimit)),
    slotBudgetMb,
    usedMemoryRatio: usedRatio,
    cpuRatio,
    resourceBlocked: capacityMode === 'resource' && resourcePressure,
    resourcePressure,
    emergency,
    warningReason,
    blockedReason: demand > hardLimit ? 'slot-limit'
      : capacityMode === 'resource' ? warningReason : null,
  };
};

export const sampleSystemCapacity = ({ cpuRatio = 0 } = {}) => ({
  totalMemoryMb: os.totalmem() / 1024 / 1024,
  freeMemoryMb: os.freemem() / 1024 / 1024,
  cpuRatio,
});

export const assignmentPriority = Object.freeze({
  recovery: 0,
  verification: 1,
  login: 2,
  ordinary: 3,
  'refund-execution': 4,
  'refund-scan': 5,
});

export const rankScheduleCandidates = (candidates, now = Date.now()) => [...candidates].sort((left, right) => {
  const leftPriority = assignmentPriority[left.assignmentKind] ?? 99;
  const rightPriority = assignmentPriority[right.assignmentKind] ?? 99;
  const leftWaitMinutes = Math.max(0, (now - Date.parse(left.queueEnteredAt || now)) / 60_000);
  const rightWaitMinutes = Math.max(0, (now - Date.parse(right.queueEnteredAt || now)) / 60_000);
  const leftEffective = Math.max(0, leftPriority - Math.floor(leftWaitMinutes / 10));
  const rightEffective = Math.max(0, rightPriority - Math.floor(rightWaitMinutes / 10));
  if (leftEffective !== rightEffective) return leftEffective - rightEffective;
  const dueDifference = Date.parse(left.dueAt || 0) - Date.parse(right.dueAt || 0);
  if (dueDifference) return dueDifference;
  return String(left.shopId || '').localeCompare(String(right.shopId || ''));
});

export const nextOrdinaryScanAt = ({ now = Date.now(), hotUntil, config = schedulerDefaults }) => {
  const hot = Date.parse(hotUntil || '') > now;
  return new Date(now + (hot ? config.hotOrdinaryIntervalMs : config.coldOrdinaryIntervalMs));
};
