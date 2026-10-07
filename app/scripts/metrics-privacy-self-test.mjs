import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataBackend } from '../apps/api/src/data-backend.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(String(process.env.DATA_BACKEND || '').toLowerCase(), 'postgres',
  'metrics privacy self-test requires DATA_BACKEND=postgres');

const backend = await createDataBackend({
  root,
  dataRoot: path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex')),
});

try {
  const summary = await backend.metricsSummary({});
  const relaxed = Number(summary.autoSuccess || 0);
  const strict = Number(summary.strictAutoSuccess || 0);
  const assisted = Number(summary.humanConfirmed || 0);
  assert(relaxed >= strict, 'ordinary-view relaxed success must never be lower than owner strict success');
  assert.equal(strict + assisted, relaxed,
    'strict and assisted success must partition relaxed automation success');

  const originalQuery = backend.pool.query.bind(backend.pool);
  let queryCount = 0;
  backend.pool.query = (...args) => {
    queryCount += 1;
    return originalQuery(...args);
  };
  const cacheProbe = {
    shopId: `metrics-cache-self-test-${process.pid}-${Date.now()}`,
  };
  const concurrent = await Promise.all([
    backend.metricsSummary(cacheProbe),
    backend.metricsSummary(cacheProbe),
    backend.metricsSummary(cacheProbe),
  ]);
  assert.equal(queryCount, 1, 'concurrent identical summaries must share one PostgreSQL query');
  assert.deepEqual(concurrent[1], concurrent[0]);
  assert.deepEqual(concurrent[2], concurrent[0]);
  await backend.metricsSummary(cacheProbe);
  assert.equal(queryCount, 1, 'a repeated summary must use the short-lived cache');

  const apiMain = await fsp.readFile(path.join(root, 'apps/api/src/main.mjs'), 'utf8');
  const webApp = await fsp.readFile(path.join(root, 'apps/web/src/app/App.jsx'), 'utf8');
  const webServer = await fsp.readFile(path.join(root, 'apps/web/src/server.mjs'), 'utf8');
  assert.match(apiMain, /metricsResponseFor/);
  assert.match(apiMain, /system-owner-authentication-required/);
  assert.match(apiMain, /X-Robots-Tag/);
  assert.match(webApp, /event\.ctrlKey && event\.altKey && event\.shiftKey && event\.code === 'KeyO'/);
  assert.match(webServer, /ownerSessionAuthorized/);

  console.log(JSON.stringify({ total: Number(summary.total || 0), relaxed, strict, assisted }));
  console.log('metrics and owner-data privacy self-test passed (read-only)');
} finally {
  await backend.close();
}
