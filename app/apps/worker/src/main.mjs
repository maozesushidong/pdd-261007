import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || '/tmp/pdd-worker-heartbeat.json';
const executionEnabled = String(process.env.WORKER_EXECUTION_ENABLED || 'false').toLowerCase() === 'true';
const workerRunMode = String(process.env.WORKER_RUN_MODE || 'shadow').toLowerCase();
fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
const writeHeartbeat = (state) => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({
    state,
    mode: process.env.WORKER_DATA_BACKEND || 'legacy-json',
    updatedAt: new Date().toISOString(),
  }));
};
writeHeartbeat(executionEnabled ? 'starting' : 'disabled');
const heartbeatTimer = setInterval(() => writeHeartbeat(executionEnabled ? 'running' : 'disabled'), 10_000);

if (!executionEnabled) {
  console.log('Worker execution is disabled; set WORKER_EXECUTION_ENABLED=true only during an approved cutover.');
  const stopDisabledWorker = () => {
    clearInterval(heartbeatTimer);
    process.exit(0);
  };
  process.once('SIGINT', stopDisabledWorker);
  process.once('SIGTERM', stopDisabledWorker);
  await new Promise(() => {});
}

if ((process.env.WORKER_DATA_BACKEND || 'legacy-json') === 'postgres') {
  if (!['shadow', 'live'].includes(workerRunMode)) throw new Error('WORKER_RUN_MODE must be shadow or live');
  console.log(`Starting PostgreSQL worker in ${workerRunMode} mode.`);
  if (workerRunMode === 'live') {
    const dynamicSupervisor = String(process.env.WORKER_DYNAMIC_SUPERVISOR || 'false').toLowerCase() === 'true';
    const schedulerMode = String(process.env.WORKER_SCHEDULER_MODE || 'legacy').toLowerCase();
    if (!['legacy', 'shadow', 'slots'].includes(schedulerMode)) {
      throw new Error('WORKER_SCHEDULER_MODE must be legacy, shadow, or slots');
    }
    const runners = !dynamicSupervisor
      ? ['apps/worker/src/postgres-playwright-runner.mjs']
      : schedulerMode === 'slots'
        ? ['apps/worker/src/slot-supervisor.mjs']
        : schedulerMode === 'shadow'
          ? ['apps/worker/src/dynamic-supervisor.mjs', 'apps/worker/src/shadow-scheduler.mjs']
          : ['apps/worker/src/dynamic-supervisor.mjs'];
    const liveWorkers = runners.map((runner) => spawn(process.execPath, [path.join(root, runner)], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      windowsHide: false,
    }));
    let stopping = false;
    const stopLive = (signal) => {
      if (stopping) return;
      stopping = true;
      clearInterval(heartbeatTimer);
      for (const liveWorker of liveWorkers) liveWorker.kill(signal);
    };
    process.once('SIGINT', () => stopLive('SIGINT'));
    process.once('SIGTERM', () => stopLive('SIGTERM'));
    for (const liveWorker of liveWorkers) liveWorker.once('exit', (code, signal) => {
      if (!stopping) {
        stopping = true;
        for (const sibling of liveWorkers) {
          if (sibling !== liveWorker && sibling.exitCode == null && sibling.signalCode == null) sibling.kill('SIGTERM');
        }
      }
      clearInterval(heartbeatTimer);
      writeHeartbeat('stopped');
      process.exit(code ?? (signal ? 1 : 0));
    });
    await new Promise(() => {});
  }
  const postgresWorker = spawn(process.execPath, [path.join(root, 'apps/worker/src/postgres-runtime.mjs')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
  const stopPostgres = (signal) => {
    clearInterval(heartbeatTimer);
    postgresWorker.kill(signal);
  };
  process.once('SIGINT', () => stopPostgres('SIGINT'));
  process.once('SIGTERM', () => stopPostgres('SIGTERM'));
  postgresWorker.once('exit', (code, signal) => {
    clearInterval(heartbeatTimer);
    writeHeartbeat('stopped');
    process.exit(code ?? (signal ? 1 : 0));
  });
  await new Promise(() => {});
}

if (!['legacy-json', 'postgres'].includes(process.env.WORKER_DATA_BACKEND || 'legacy-json')) {
  throw new Error('WORKER_DATA_BACKEND must be legacy-json or postgres');
}
const child = spawn(process.execPath, [path.join(root, 'run-shops.mjs')], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
});
const stop = (signal) => {
  clearInterval(heartbeatTimer);
  child.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('exit', (code, signal) => {
  clearInterval(heartbeatTimer);
  writeHeartbeat('stopped');
  process.exit(code ?? (signal ? 1 : 0));
});
