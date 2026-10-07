import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const environmentText = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = environmentText.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const sha256 = async (filename) => crypto.createHash('sha256')
  .update(await fs.readFile(filename)).digest('hex');
const expected = {
  runner: await sha256(path.join(appRoot, 'apps', 'worker', 'src', 'postgres-playwright-runner.mjs')),
  workflow: await sha256(path.join(appRoot, 'workflow.mjs')),
};
const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'live-code-build-audit',
});
await client.connect();
try {
  const { rows } = await client.query(`
    SELECT shop.id, shop.name, heartbeat.heartbeat_at, heartbeat.metadata
    FROM shops shop
    LEFT JOIN LATERAL (
      SELECT heartbeat_at, metadata FROM worker_heartbeats
      WHERE shop_id = shop.id ORDER BY heartbeat_at DESC LIMIT 1
    ) heartbeat ON true
    WHERE shop.enabled = true
    ORDER BY shop.name, shop.id`);
  const checkedAt = new Date();
  const shops = rows.map((row) => {
    const build = row.metadata?.codeBuild || {};
    const runner = String(build.runnerSha256 || '');
    const workflow = String(build.workflowSha256 || '');
    const heartbeatAgeMs = checkedAt.getTime() - Date.parse(row.heartbeat_at || '');
    const online = Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs <= 30_000;
    const status = !online ? 'offline'
      : !runner || !workflow ? 'unreported'
        : runner === expected.runner && workflow === expected.workflow
          ? 'current' : 'older-or-mixed';
    return {
      shopId: row.id,
      shopName: row.name,
      status,
      heartbeatAgeSeconds: Number.isFinite(heartbeatAgeMs)
        ? Math.max(0, Math.round(heartbeatAgeMs / 1000)) : null,
      reportedRunner: runner ? runner.slice(0, 12) : null,
      reportedWorkflow: workflow ? workflow.slice(0, 12) : null,
    };
  });
  const counts = Object.fromEntries(
    ['current', 'older-or-mixed', 'unreported', 'offline']
      .map((status) => [status, shops.filter((shop) => shop.status === status).length]),
  );
  console.log(JSON.stringify({
    checkedAt: checkedAt.toISOString(),
    scope: 'runner-and-workflow-only; adapter modules are not reported by worker heartbeats',
    expectedRunner: expected.runner.slice(0, 12),
    expectedWorkflow: expected.workflow.slice(0, 12),
    counts,
    shops,
  }, null, 2));
} finally {
  await client.end();
}
