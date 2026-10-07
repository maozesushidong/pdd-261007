import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../../../packages/adapters/src/postgres/index.mjs';
import { calculateTargetSlots, sampleSystemCapacity, schedulerConfigFromEnv } from './scheduler-policy.mjs';
import { ShopSchedulerRepository } from './scheduler-repository.mjs';
import { sampleProcessTreeMemory } from './process-tree-memory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const runnerFile = path.join(root, 'apps/worker/src/postgres-playwright-runner.mjs');
const windowsNative = process.platform === 'win32';
const config = schedulerConfigFromEnv();
const supervisorId = `${process.env.WORKER_ID || 'slot-supervisor'}-${process.pid}`;
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex'));
const shopsDataRoot = path.join(dataRoot, 'shops');
const displayBase = Math.max(100, Number(process.env.WORKER_DISPLAY_BASE || 200));
const vncPortBase = Math.max(5900, Number(process.env.WORKER_VNC_PORT_BASE || 5900));
const novncPortBase = Math.max(1024, Number(process.env.WORKER_NOVNC_PORT_BASE || 6080));
const reconcileIntervalMs = Math.max(1_000, Number(process.env.WORKER_SLOT_RECONCILE_MS || 2_000));
const pool = await createPostgresPool(undefined, { max: 5, applicationName: 'pdd-slot-supervisor' });
const repository = new ShopSchedulerRepository(pool, { config, supervisorId });
const children = new Map();
let stopped = false;
let reconciling = false;
let reconcileTimer = null;
let lastLaunchAt = 0;
let lastRecoveryAt = 0;
let previousCpuSample = null;
let lastMemorySampleAt = 0;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const exited = (child) => !child || child.exitCode != null || child.signalCode != null;
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);

const localProcessExists = (processId) => {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

const recoverOrphanedLocalAssignments = async () => {
  if (!windowsNative) return [];
  const result = await pool.query(`
    SELECT id, process_id
    FROM browser_slots
    WHERE state <> 'stopped' AND external_effect_active = false
      AND (process_id IS NOT NULL OR updated_at < now() - interval '30 seconds')`);
  const orphanedIds = result.rows
    .filter((row) => !localProcessExists(Number(row.process_id)))
    .map((row) => row.id);
  const recovered = await repository.recoverOrphanedAssignments(orphanedIds);
  if (recovered.length) {
    console.log(`[slot-supervisor] recovered ${recovered.length} orphaned local slot(s)`);
  }
  return recovered;
};

const cpuRatio = () => {
  const sample = os.cpus().reduce((summary, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: summary.idle + cpu.times.idle, total: summary.total + total };
  }, { idle: 0, total: 0 });
  if (!previousCpuSample) {
    previousCpuSample = sample;
    return 0;
  }
  const idleDelta = sample.idle - previousCpuSample.idle;
  const totalDelta = sample.total - previousCpuSample.total;
  previousCpuSample = sample;
  return totalDelta > 0 ? Math.max(0, Math.min(1, 1 - (idleDelta / totalDelta))) : 0;
};

const stopProcess = async (child, timeoutMs = 30_000) => {
  if (!child || exited(child)) return;
  child.kill('SIGTERM');
  const completed = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
  if (!completed && !exited(child)) child.kill('SIGKILL');
};

const waitForDisplay = async (displayNumber, xvfb) => {
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (exited(xvfb)) throw new Error(`Xvfb :${displayNumber} exited before becoming ready`);
    try {
      await fsp.access(socket);
      return;
    } catch { await delay(100); }
  }
  throw new Error(`Xvfb :${displayNumber} did not become ready`);
};

const startDesktop = async (assignment) => {
  if (windowsNative) return { kind: 'windows-native', display: null };
  const displayNumber = displayBase + assignment.slotIndex;
  const display = `:${displayNumber}`;
  const vncPort = vncPortBase + assignment.slotIndex;
  const novncPort = novncPortBase + assignment.slotIndex;
  await fsp.rm(`/tmp/.X11-unix/X${displayNumber}`, { force: true });
  await fsp.rm(`/tmp/.X${displayNumber}-lock`, { force: true });
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'], {
    stdio: 'ignore',
  });
  let openbox = null;
  let vnc = null;
  let novnc = null;
  try {
    await waitForDisplay(displayNumber, xvfb);
    openbox = spawn('openbox-session', [], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
    vnc = spawn('x11vnc', [
      '-display', display, '-forever', '-shared', '-listen', '127.0.0.1',
      '-rfbport', String(vncPort), '-nopw', '-noshm', '-noxdamage', '-modtweak',
      '-xkb', '-capslock', '-add_keysyms', '-clear_all', '-repeat', '-speeds', 'lan',
      '-wait', '5', '-defer', '5',
    ], { stdio: 'ignore' });
    novnc = spawn('websockify', [
      '--web=/usr/share/novnc', String(novncPort), `127.0.0.1:${vncPort}`,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    await delay(250);
    if ([xvfb, openbox, vnc, novnc].some(exited)) throw new Error('desktop-service-start-failed');
    return { display, displayNumber, vncPort, novncPort, xvfb, openbox, vnc, novnc };
  } catch (error) {
    await Promise.all([stopProcess(novnc), stopProcess(vnc), stopProcess(openbox), stopProcess(xvfb)]);
    throw error;
  }
};

const stopDesktop = async (desktop) => {
  if (!desktop || windowsNative) return;
  await Promise.all([
    stopProcess(desktop.novnc), stopProcess(desktop.vnc),
    stopProcess(desktop.openbox), stopProcess(desktop.xvfb),
  ]);
};

const completeEntry = async (entry, result = {}) => {
  if (entry.completing) return;
  entry.completing = true;
  clearInterval(entry.heartbeatTimer);
  await stopDesktop(entry.desktop).catch(() => {});
  await repository.complete({ assignment: entry.assignment, ...result }).catch((error) => {
    console.error(`[slot-supervisor] complete ${entry.assignment.shopId}: ${error.stack || error.message}`);
  });
  children.delete(entry.assignment.slotId);
};

const startAssignment = async (assignment) => {
  let desktop = null;
  try {
    desktop = await startDesktop(assignment);
    const heartbeatFile = path.join(
      dataRoot, 'supervisor', `${safeName(supervisorId)}-${safeName(assignment.shopId)}-heartbeat.json`,
    );
    await fsp.mkdir(path.dirname(heartbeatFile), { recursive: true });
    const workerId = `${supervisorId}-slot-${assignment.slotIndex}-${safeName(assignment.shopId)}`;
    const child = spawn(process.execPath, [runnerFile], {
      cwd: root,
      env: {
        ...process.env,
        ...(desktop.display ? { DISPLAY: desktop.display } : {}),
        WORKER_SHOP_ID: assignment.shopId,
        WORKER_ID: workerId,
        WORKER_HEARTBEAT_FILE: heartbeatFile,
        WORKER_SCHEDULER_MODE: 'slots',
        WORKER_SLOT_ID: assignment.slotId,
        WORKER_SLOT_INDEX: String(assignment.slotIndex),
        WORKER_SLOT_KIND: assignment.slotKind,
        WORKER_ASSIGNMENT_KIND: assignment.assignmentKind,
        WORKER_SLOT_LEASE_TOKEN: assignment.leaseToken,
        WORKER_SESSION_MAX_MS: String(assignment.sessionMs),
        WORKER_KEEP_ENABLED_SHOPS_RESIDENT: config.keepEnabledShopsResident ? 'true' : 'false',
        WORKER_RESIDENT_BROWSER: 'true',
        WORKFLOW_HUMAN_VERIFICATION_TIMEOUT_MS: String(config.verificationSessionMs),
        WORKER_DB_POOL_MAX: '2',
      },
      stdio: 'inherit',
      windowsHide: false,
    });
    const entry = { assignment, child, desktop, completing: false, heartbeatTimer: null };
    children.set(assignment.slotId, entry);
    await repository.markSlotRunning({
      slotId: assignment.slotId,
      leaseToken: assignment.leaseToken,
      processId: child.pid,
    });
    entry.heartbeatTimer = setInterval(() => {
      repository.heartbeat({
        slotId: assignment.slotId,
        leaseToken: assignment.leaseToken,
      }).then((valid) => {
        if (!valid && !exited(child)) child.kill('SIGTERM');
      }).catch((error) => console.error(`[slot-supervisor] heartbeat ${assignment.shopId}: ${error.message}`));
    }, 15_000);
    entry.heartbeatTimer.unref?.();
    child.once('error', (error) => completeEntry(entry, { exitCode: 1, error }));
    child.once('exit', (code, signal) => completeEntry(entry, { exitCode: code ?? 1, signal }));
    console.log(`[slot-supervisor] started ${assignment.shopId} in ${assignment.slotKind} slot ${assignment.slotIndex}`);
  } catch (error) {
    await stopDesktop(desktop).catch(() => {});
    await repository.complete({ assignment, exitCode: 1, error }).catch(() => {});
    throw error;
  }
};

const cleanupDeletedShopData = async () => {
  const result = await pool.query(`
    SELECT request.shop_id
    FROM shop_deletion_requests request
    LEFT JOIN browser_slots slot ON slot.shop_id = request.shop_id AND slot.state <> 'stopped'
    WHERE slot.id IS NULL ORDER BY request.requested_at`);
  for (const row of result.rows) {
    const shopDataPath = path.resolve(shopsDataRoot, row.shop_id);
    if (path.dirname(shopDataPath) !== shopsDataRoot) continue;
    try {
      await fsp.rm(shopDataPath, { recursive: true, force: true });
      await pool.query('DELETE FROM shop_deletion_requests WHERE shop_id = $1', [row.shop_id]);
    } catch (error) {
      console.error(`[slot-supervisor] deleted shop cleanup ${row.shop_id}: ${error.message}`);
    }
  }
};

async function reconcile() {
  if (stopped || reconciling) return;
  reconciling = true;
  try {
    if (Date.now() - lastRecoveryAt >= 30_000) {
      await recoverOrphanedLocalAssignments();
      await repository.recoverExpiredAssignments();
      await cleanupDeletedShopData();
      lastRecoveryAt = Date.now();
    }
    if (children.size && Date.now() - lastMemorySampleAt >= 30_000) {
      const runningEntries = [...children.values()].filter((entry) => !exited(entry.child));
      const memoryByPid = await sampleProcessTreeMemory(runningEntries.map((entry) => entry.child.pid))
        .catch((error) => {
          console.error(`[slot-supervisor] process memory sample failed: ${error.message}`);
          return new Map();
        });
      await Promise.all(runningEntries.map((entry) => repository.heartbeat({
        slotId: entry.assignment.slotId,
        leaseToken: entry.assignment.leaseToken,
        memoryMb: memoryByPid.get(entry.child.pid) || null,
        leaseExtensionMs: config.keepEnabledShopsResident
          ? Math.max(
            config.businessSessionMs,
            config.loginSessionMs,
            config.verificationSessionMs,
            15 * 60_000,
          ) : 0,
      }).catch(() => false)));
      lastMemorySampleAt = Date.now();
    }
    const snapshot = await repository.snapshot();
    const resources = sampleSystemCapacity({ cpuRatio: cpuRatio() });
    const capacity = calculateTargetSlots({
      ...resources,
      dueCount: config.keepEnabledShopsResident
        ? snapshot.unassignedEnabledShops
        : snapshot.unassignedDueShops,
      activeCount: snapshot.activeSlots,
      slotMemorySamplesMb: snapshot.slotMemorySamplesMb,
      config,
    });
    await repository.markCapacityBlocked(
      snapshot.unassignedDueShops > 0 && capacity.target <= snapshot.activeSlots
        ? capacity.blockedReason || 'all-slots-busy' : null,
    );
    if (snapshot.activeSlots >= capacity.target) return;
    if (config.capacityMode === 'resource' && Date.now() - lastLaunchAt < config.launchIntervalMs) return;
    const launchCount = config.capacityMode === 'unbounded'
      ? capacity.target - snapshot.activeSlots : 1;
    let currentSnapshot = snapshot;
    for (let index = 0; index < launchCount; index += 1) {
      const assignment = await repository.claim({ allowedKinds: repository.allowedKinds(currentSnapshot) });
      if (!assignment) break;
      lastLaunchAt = Date.now();
      await startAssignment(assignment);
      currentSnapshot = await repository.snapshot();
    }
  } finally {
    reconciling = false;
  }
}

const stop = async () => {
  if (stopped) return;
  stopped = true;
  clearInterval(reconcileTimer);
  await Promise.all([...children.values()].map(async (entry) => {
    await stopProcess(entry.child, 120_000);
    await completeEntry(entry, { exitCode: entry.child.exitCode ?? 0, signal: entry.child.signalCode });
  }));
  await pool.end().catch(() => {});
};

process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));

await repository.initialize();
await recoverOrphanedLocalAssignments();
await reconcile();
reconcileTimer = setInterval(() => reconcile().catch((error) => {
  console.error(`[slot-supervisor] reconcile failed: ${error.stack || error.message}`);
}), reconcileIntervalMs);
await new Promise(() => {});
