import crypto from 'node:crypto';
import fs from 'node:fs';
import { createPostgresPool, PostgresWorkflowRepository } from '../../../packages/adapters/src/postgres/index.mjs';
import { createRedisConnection } from '../../../packages/adapters/src/redis/index.mjs';

const workerId = process.env.WORKER_ID || `postgres-worker-${crypto.randomUUID()}`;
const mode = String(process.env.WORKER_RUN_MODE || 'shadow').toLowerCase();
const approved = String(process.env.WORKER_LIVE_APPROVED || 'false').toLowerCase() === 'true';
const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || '/tmp/pdd-worker-heartbeat.json';
const intervalMs = Math.max(10_000, Number(process.env.WORKER_POLL_INTERVAL_MS || 10_000));

if (!['shadow', 'live'].includes(mode)) throw new Error('WORKER_RUN_MODE must be shadow or live');
if (mode === 'live' && !approved) throw new Error('WORKER_LIVE_APPROVED=true is required for live mode');

const writeHeartbeat = (state, metadata = {}) => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({ state, mode, workerId, updatedAt: new Date().toISOString(), ...metadata }));
};

const pool = await createPostgresPool();
const repository = new PostgresWorkflowRepository(pool);
const redis = await createRedisConnection();
let stopped = false;
const stop = async () => {
  stopped = true;
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  writeHeartbeat('stopped');
};
process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));

async function poll() {
  if (stopped) return;
  const snapshot = await repository.getQueueSnapshot();
  await repository.writeHeartbeat({
    workerId,
    mode,
    metadata: { queue: snapshot, externalAutomation: mode === 'live' },
  });
  writeHeartbeat(mode === 'live' ? 'running' : 'shadow-idle', { queue: snapshot });

  if (snapshot.queued > 0 && mode === 'shadow') {
    // Shadow mode never claims or mutates a work order; it only exposes pending work.
    return;
  }
  if (snapshot.queued > 0 && mode === 'live') {
    throw new Error('Live PostgreSQL Playwright adapters are not composed; refusing to claim queued work');
  }
}

writeHeartbeat(mode === 'live' ? 'starting' : 'shadow-starting');
await poll();
const timer = setInterval(() => poll().catch((error) => {
  writeHeartbeat('error', { error: { name: error.name, message: error.message } });
  console.error(error);
  clearInterval(timer);
  stop().finally(() => process.exit(1));
}), intervalMs);
