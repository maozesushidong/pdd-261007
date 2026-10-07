import { createPostgresPool } from '../../../packages/adapters/src/postgres/index.mjs';
import { schedulerConfigFromEnv } from './scheduler-policy.mjs';
import { ShopSchedulerRepository } from './scheduler-repository.mjs';

const intervalMs = Math.max(5_000, Number(process.env.WORKER_SHADOW_INTERVAL_MS || 15_000));
const pool = await createPostgresPool(undefined, { max: 2, applicationName: 'pdd-shadow-scheduler' });
const repository = new ShopSchedulerRepository(pool, {
  config: schedulerConfigFromEnv(),
  supervisorId: `${process.env.WORKER_ID || 'worker'}-shadow`,
});
let stopped = false;
let timer = null;

const observe = async () => {
  const [snapshot, candidates] = await Promise.all([
    repository.snapshot(),
    repository.peek({ limit: 100 }),
  ]);
  console.log(JSON.stringify({
    type: 'scheduler-shadow-decision',
    at: new Date().toISOString(),
    snapshot,
    candidates: candidates.map((candidate) => ({
      shopId: candidate.shop_id,
      assignmentKind: candidate.assignment_kind,
      dueAt: candidate.due_at,
      priority: Number(candidate.priority),
    })),
  }));
};

const stop = async () => {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  await pool.end().catch(() => {});
};
process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));

await repository.initialize();
await observe();
timer = setInterval(() => observe().catch((error) => {
  console.error(`[shadow-scheduler] ${error.stack || error.message}`);
}), intervalMs);
await new Promise(() => {});
