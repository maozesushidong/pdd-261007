import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../../../packages/adapters/src/postgres/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const runnerFile = path.join(root, 'apps/worker/src/postgres-playwright-runner.mjs');
const windowsNative = process.platform === 'win32';
const baseWorkerId = String(process.env.WORKER_ID || 'postgres-worker');
const intervalMs = Math.max(3000, Number(process.env.WORKER_SUPERVISOR_INTERVAL_MS || 5000));
const configuredMaxShops = Number(process.env.WORKER_SUPERVISOR_MAX_SHOPS || 0);
const maxShops = Number.isFinite(configuredMaxShops) && configuredMaxShops > 0
  ? Math.floor(configuredMaxShops)
  : null;
const configuredStartStaggerMs = Number(process.env.WORKER_SUPERVISOR_START_STAGGER_MS || 5000);
const startStaggerMs = Number.isFinite(configuredStartStaggerMs) && configuredStartStaggerMs >= 0
  ? Math.floor(configuredStartStaggerMs)
  : 5000;
const displayBase = Math.max(100, Number(process.env.WORKER_DISPLAY_BASE || 200));
const vncPortBase = Math.max(5900, Number(process.env.WORKER_VNC_PORT_BASE || 5900));
const novncPortBase = Math.max(1024, Number(process.env.WORKER_NOVNC_PORT_BASE || 6080));
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex'));
const shopsDataRoot = path.join(dataRoot, 'shops');
const pool = await createPostgresPool();
const children = new Map();
const restartState = new Map();
const reusableDesktops = new Map();
const browserDisconnectedExitCode = 90;
let stopped = false;
let reconciling = false;
let timer = null;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
const signatureFor = (shop) => `${shop.config_version}:${shop.login_requested_at || ''}:${shop.display_slot}`;
const exited = (child) => child.exitCode != null || child.signalCode != null;
const desktopExited = (desktop) => !desktop || (windowsNative
  ? desktop.kind !== 'windows-native'
  : [desktop.xvfb, desktop.openbox, desktop.vnc, desktop.novnc]
    .some((child) => !child || exited(child)));

const startDesktopPlaceholder = (shopId, display) => {
  const placeholder = spawn('xmessage', [
    '-center',
    '-geometry', '720x180',
    '-title', `拼多多远程窗口 - ${shopId}`,
    '远程桌面已连接\n浏览器正在启动或恢复，请稍候…',
  ], {
    env: { ...process.env, DISPLAY: display },
    stdio: 'ignore',
  });
  placeholder.once('error', (error) => {
    console.error(`[worker-supervisor] ${shopId} desktop placeholder: ${error.message}`);
  });
  return placeholder;
};

const ensureDesktopPlaceholder = (desktop, shopId) => {
  if (windowsNative) return;
  if (!desktop.placeholder || exited(desktop.placeholder)) {
    desktop.placeholder = startDesktopPlaceholder(shopId, desktop.display);
  }
};

const stopWindowsProcessTree = async (pid) => {
  if (!windowsNative || !Number.isInteger(pid) || pid <= 0) return false;
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return new Promise((resolve) => {
    killer.once('error', () => resolve(false));
    killer.once('exit', (code) => resolve(code === 0));
  });
};

const stopProcess = async (child, timeoutMs = 8000) => {
  if (!child || exited(child)) return;
  if (windowsNative && child.connected) {
    try { child.send({ type: 'shutdown' }); } catch { child.kill('SIGTERM'); }
  } else {
    child.kill('SIGTERM');
  }
  const completed = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
  if (!completed && !exited(child)) {
    const stoppedTree = await stopWindowsProcessTree(child.pid);
    if (!stoppedTree && !exited(child)) child.kill('SIGKILL');
  }
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

const startDesktop = async (shop) => {
  if (windowsNative) {
    return {
      kind: 'windows-native',
      display: null,
      displayNumber: null,
      vncPort: null,
      novncPort: null,
    };
  }
  const displayNumber = displayBase + Number(shop.display_slot);
  const display = `:${displayNumber}`;
  const vncPort = vncPortBase + Number(shop.display_slot);
  const novncPort = novncPortBase + Number(shop.display_slot);
  await fsp.rm(`/tmp/.X11-unix/X${displayNumber}`, { force: true });
  await fsp.rm(`/tmp/.X${displayNumber}-lock`, { force: true });
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'], {
    stdio: 'ignore',
  });
  let openbox = null;
  let placeholder = null;
  let vnc = null;
  let novnc = null;
  try {
    await waitForDisplay(displayNumber, xvfb);
    openbox = spawn('openbox-session', [], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
    placeholder = startDesktopPlaceholder(shop.id, display);
    vnc = spawn('x11vnc', [
      '-display', display, '-forever', '-shared', '-listen', '127.0.0.1',
      '-rfbport', String(vncPort), '-nopw', '-noshm', '-noxdamage', '-modtweak',
      '-xkb', '-capslock', '-add_keysyms', '-clear_all', '-repeat', '-speeds', 'lan',
      '-wait', '5', '-defer', '5',
    ], { stdio: 'ignore' });
    novnc = spawn('websockify', [
      '--web=/usr/share/novnc',
      String(novncPort),
      `127.0.0.1:${vncPort}`,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    novnc.once('error', (error) => console.error(`[worker-supervisor] ${shop.id} noVNC: ${error.message}`));
    await delay(250);
    if (exited(openbox) || exited(placeholder) || exited(vnc) || exited(novnc)) {
      throw new Error(`Desktop services failed for ${shop.id}`);
    }
    return { display, displayNumber, vncPort, novncPort, xvfb, openbox, placeholder, vnc, novnc };
  } catch (error) {
    await Promise.all([
      stopProcess(novnc),
      stopProcess(vnc),
      stopProcess(placeholder),
      stopProcess(openbox),
      stopProcess(xvfb),
    ]);
    throw error;
  }
};

const stopDesktop = async (desktop) => {
  if (!desktop) return;
  if (windowsNative) return;
  await Promise.all([
    stopProcess(desktop.novnc),
    stopProcess(desktop.vnc),
    stopProcess(desktop.placeholder),
    stopProcess(desktop.openbox),
    stopProcess(desktop.xvfb),
  ]);
};

const removeDeletedShopData = async (shopId) => {
  const shopDataPath = path.resolve(shopsDataRoot, shopId);
  if (path.dirname(shopDataPath) !== shopsDataRoot) throw new Error(`Invalid deleted shop path: ${shopId}`);
  await fsp.rm(shopDataPath, { recursive: true, force: true });
};

const recordUnexpectedExit = (entry, code, signal) => {
  if (entry.stopping || stopped) return null;
  const previous = restartState.get(entry.shopId) || { failures: 0 };
  const stable = Date.now() - entry.startedAt > 5 * 60_000;
  const browserRecovery = code === browserDisconnectedExitCode;
  const cleanExit = code === 0 && !signal;
  const failures = browserRecovery || cleanExit ? 0 : stable ? 1 : previous.failures + 1;
  const retryDelay = browserRecovery || cleanExit
    ? 500
    : Math.min(60_000, 2000 * (2 ** Math.min(failures - 1, 5)));
  restartState.set(entry.shopId, { failures, restartAfter: Date.now() + retryDelay });
  const exitLabel = cleanExit ? 'ended cleanly' : `exited (${code ?? signal})`;
  console.error(`[worker-supervisor] ${entry.shopId} ${exitLabel}; retry in ${retryDelay}ms`);
  if (!cleanExit) {
    pool.query(`
      UPDATE shops SET onboarding_status = CASE WHEN onboarding_status = 'ready' THEN onboarding_status ELSE 'error' END,
        onboarding_error = CASE WHEN onboarding_status = 'ready' THEN onboarding_error ELSE $2 END,
        updated_at = now()
      WHERE id = $1`, [entry.shopId, `Worker exited: ${code ?? signal}`]).catch(() => {});
  }
  return retryDelay;
};

const stopChild = async (entry, { preserveDesktop = false } = {}) => {
  if (!entry || entry.stopping) return;
  entry.stopping = true;
  await stopProcess(entry.child, 120_000);
  if (preserveDesktop && !desktopExited(entry.desktop)) {
    ensureDesktopPlaceholder(entry.desktop, entry.shopId);
    reusableDesktops.set(entry.shopId, {
      desktop: entry.desktop,
      signature: entry.signature,
    });
    return;
  }
  await stopDesktop(entry.desktop);
};

const startChild = async (shop) => {
  const workerId = `${baseWorkerId}-${safeName(shop.id)}`;
  const expectedSignature = signatureFor(shop);
  const reusable = reusableDesktops.get(shop.id);
  reusableDesktops.delete(shop.id);
  let desktop = null;
  if (reusable?.signature === expectedSignature && !desktopExited(reusable.desktop)) {
    desktop = reusable.desktop;
    ensureDesktopPlaceholder(desktop, shop.id);
    console.log(`[worker-supervisor] reusing ${shop.id} desktop on ${desktop.display}`);
  } else {
    if (reusable?.desktop) await stopDesktop(reusable.desktop);
    desktop = await startDesktop(shop);
  }
  const heartbeatFile = windowsNative
    ? path.join(dataRoot, 'supervisor', `${safeName(workerId)}-heartbeat.json`)
    : `/tmp/${safeName(workerId)}-heartbeat.json`;
  await fsp.mkdir(path.dirname(heartbeatFile), { recursive: true });
  const child = spawn(process.execPath, [runnerFile], {
    cwd: root,
    env: {
      ...process.env,
      ...(desktop.display ? { DISPLAY: desktop.display } : {}),
      WORKER_SHOP_ID: shop.id,
      WORKER_ID: workerId,
      WORKER_HEARTBEAT_FILE: heartbeatFile,
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    serialization: 'json',
    windowsHide: false,
  });
  const entry = {
    child,
    desktop,
    shopId: shop.id,
    signature: expectedSignature,
    stopping: false,
    startedAt: Date.now(),
  };
  entry.exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => {
    entry.exitCode = code;
    entry.exitSignal = signal;
    const retryDelay = recordUnexpectedExit(entry, code, signal);
    if (retryDelay !== null) {
      const restartTimer = setTimeout(() => reconcile().catch((error) => {
        console.error(`[worker-supervisor] immediate reconcile failed: ${error.stack || error.message}`);
      }), retryDelay + 50);
      restartTimer.unref?.();
    }
    resolve();
  }));
  child.once('error', (error) => console.error(`[worker-supervisor] ${shop.id}: ${error.message}`));
  children.set(shop.id, entry);
  const desktopLabel = windowsNative
    ? 'local Windows desktop'
    : `${desktop.display}, noVNC ${desktop.novncPort}`;
  console.log(`[worker-supervisor] started ${shop.id} on ${desktopLabel}`);
};

async function reconcile() {
  if (stopped || reconciling) return;
  reconciling = true;
  try {
    const result = await pool.query(`
      SELECT id, enabled, config_version, login_requested_at, display_slot
      FROM shops
      WHERE id NOT LIKE 'scheduler-test-%'
      ORDER BY created_at, id`);
    const deletionResult = await pool.query(`
      SELECT shop_id, display_slot FROM shop_deletion_requests ORDER BY requested_at`);
    const enabled = result.rows.filter((shop) => shop.enabled);
    const desired = maxShops == null ? enabled : enabled.slice(0, maxShops);
    const desiredIds = new Set(desired.map((shop) => shop.id));
    const childrenToStop = [];
    for (const [shopId, entry] of children) {
      const desiredShop = desired.find((shop) => shop.id === shopId);
      const childExited = exited(entry.child);
      const failedDesktop = desktopExited(entry.desktop);
      const changed = desiredShop && entry.signature !== signatureFor(desiredShop);
      if (failedDesktop && desiredShop && !changed && !childExited) {
        const previous = restartState.get(shopId) || { failures: 0 };
        restartState.set(shopId, {
          failures: previous.failures + 1,
          restartAfter: Date.now() + 2000,
        });
        console.error(`[worker-supervisor] ${shopId} desktop exited; restarting desktop services`);
      }
      if (!desiredIds.has(shopId) || changed || childExited || failedDesktop) {
        const preserveDesktop = Boolean(desiredShop && !changed && childExited && !failedDesktop);
        childrenToStop.push({ shopId, entry, preserveDesktop, changed });
      }
    }
    // Shops own isolated browser profiles and leases, so configuration reloads
    // can drain concurrently without serializing the per-shop safety timeout.
    await Promise.all(childrenToStop.map(async ({ shopId, entry, preserveDesktop, changed }) => {
      await stopChild(entry, { preserveDesktop });
      children.delete(shopId);
      if (changed) {
        restartState.delete(shopId);
        console.log(`[worker-supervisor] reloading ${shopId}`);
      }
    }));
    for (const [shopId, reusable] of reusableDesktops) {
      const desiredShop = desired.find((shop) => shop.id === shopId);
      if (!desiredShop
        || reusable.signature !== signatureFor(desiredShop)
        || desktopExited(reusable.desktop)) {
        await stopDesktop(reusable.desktop);
        reusableDesktops.delete(shopId);
        if (desiredShop) restartState.delete(shopId);
      }
    }
    for (const deletion of deletionResult.rows) {
      if (children.has(deletion.shop_id)) continue;
      try {
        await removeDeletedShopData(deletion.shop_id);
        await pool.query('DELETE FROM shop_deletion_requests WHERE shop_id = $1', [deletion.shop_id]);
        console.log(`[worker-supervisor] removed deleted shop data: ${deletion.shop_id}`);
      } catch (error) {
        console.error(`[worker-supervisor] failed to remove deleted shop data ${deletion.shop_id}: ${error.message}`);
      }
    }
    let startAttemptsThisPass = 0;
    for (const shop of desired) {
      if (children.has(shop.id)) continue;
      const restart = restartState.get(shop.id);
      if (restart?.restartAfter > Date.now()) continue;
      if (startAttemptsThisPass > 0 && startStaggerMs > 0) {
        console.log(`[worker-supervisor] staggering ${shop.id} startup by ${startStaggerMs}ms`);
        await delay(startStaggerMs);
      }
      startAttemptsThisPass += 1;
      try {
        await startChild(shop);
      } catch (error) {
        const failures = (restart?.failures || 0) + 1;
        const retryDelay = Math.min(60_000, 2000 * (2 ** Math.min(failures - 1, 5)));
        restartState.set(shop.id, { failures, restartAfter: Date.now() + retryDelay });
        console.error(`[worker-supervisor] failed to start ${shop.id}: ${error.message}`);
      }
    }
    if (maxShops != null && enabled.length > maxShops) {
      console.error(`[worker-supervisor] enabled shops exceed WORKER_SUPERVISOR_MAX_SHOPS=${maxShops}`);
    }
  } finally {
    reconciling = false;
  }
}

const stop = async () => {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  await Promise.all([
    ...[...children.values()].map((entry) => stopChild(entry)),
    ...[...reusableDesktops.values()].map(({ desktop }) => stopDesktop(desktop)),
  ]);
  reusableDesktops.clear();
  await pool.end().catch(() => {});
};

process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));

await reconcile();
timer = setInterval(() => reconcile().catch((error) => {
  console.error(`[worker-supervisor] reconcile failed: ${error.stack || error.message}`);
}), intervalMs);
await new Promise(() => {});
