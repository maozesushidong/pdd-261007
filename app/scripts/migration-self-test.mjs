import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildMigrationPlan,
  collectImportableFiles,
  createMigrationManifest,
  validateLegacyData,
} from './lib/legacy-migration.mjs';

const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-migration-test-'));
const projectRoot = path.join(fixtureRoot, 'project');
const dataRoot = path.join(fixtureRoot, 'data');
const shopId = 'test-shop';
const shopRoot = path.join(dataRoot, 'shops', shopId);
await fsp.mkdir(path.join(projectRoot, 'config'), { recursive: true });
await fsp.mkdir(path.join(shopRoot, 'state', 'completed-work-orders'), { recursive: true });
await fsp.mkdir(path.join(shopRoot, 'tmp', 'pdd-work-order-replies'), { recursive: true });
await fsp.mkdir(path.join(shopRoot, 'diagnostics'), { recursive: true });
await fsp.mkdir(path.join(shopRoot, 'auth'), { recursive: true });
await fsp.mkdir(path.join(shopRoot, 'browser-profile'), { recursive: true });
await fsp.mkdir(path.join(shopRoot, 'locks'), { recursive: true });
await fsp.writeFile(path.join(projectRoot, 'shops.config.json'), JSON.stringify({
  version: 1,
  shops: [{ shopId, enabled: true, expectedShopName: 'Test Shop' }],
}));
await fsp.writeFile(path.join(projectRoot, 'config', 'scenarios.json'), JSON.stringify({
  scenarios: [{ code: 'in-transit-refund', titlePatterns: ['in transit'], policyVersion: 1, enabled: true }],
}));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
await fsp.writeFile(path.join(shopRoot, 'tmp', 'pdd-work-order-replies', '260729-123456789012345.png'), png);
await fsp.writeFile(path.join(shopRoot, 'state', 'workflow-progress.json'), JSON.stringify({
  shopId,
  orderNumber: '260729-123456789012345',
  targetWorkOrderTitle: 'in transit',
  step: 'manual-review-required',
  updatedAt: '2026-07-29T00:00:00.000Z',
  logisticsAnalysis: { carrier: 'ZTO', password: 'must-not-migrate' },
  omsAnalysis: { shippingWarehouse: 'warehouse' },
  tmsFormDecision: { status: 'ready' },
  tmsEvidenceScreenshot: {
    orderNumber: '260729-123456789012345',
    relativePath: 'tmp/pdd-work-order-replies/260729-123456789012345.png',
    mimeType: 'image/png',
    status: 'ready',
  },
}));
await fsp.writeFile(path.join(shopRoot, 'state', 'completed-work-orders', '260728-123456789012345.json'), JSON.stringify({
  shopId,
  orderNumber: '260728-123456789012345',
  targetWorkOrderTitle: 'in transit',
  step: 'completed',
  updatedAt: '2026-07-28T00:00:00.000Z',
}));
await fsp.writeFile(path.join(shopRoot, 'auth', 'pdd-auth.json'), '{"cookie":"secret"}');
await fsp.writeFile(path.join(shopRoot, 'browser-profile', 'Cookies'), 'secret');

try {
  const validation = await validateLegacyData({ dataRoot, projectRoot });
  assert.equal(validation.valid, true);
  assert.equal(validation.totals.completedOrders, 1);
  assert.equal(validation.totals.pngFiles, 1);
  const files = await collectImportableFiles({ dataRoot, projectRoot });
  assert.equal(files.some((file) => file.includes(`${path.sep}auth${path.sep}`)), false);
  assert.equal(files.some((file) => file.includes(`${path.sep}browser-profile${path.sep}`)), false);
  const manifest = await createMigrationManifest({ dataRoot, projectRoot });
  const plan = await buildMigrationPlan({ dataRoot, projectRoot, manifest });
  assert.equal(plan.shops.length, 1);
  assert.equal(plan.workOrders.length, 2);
  assert.equal(plan.evidenceAssets.length, 1);
  assert.equal(plan.logisticsAnalyses[0].payload.password, undefined);
  assert.equal(plan.workOrders.filter((order) => order.status === 'archived').length, 1);
  console.log('migration self-test passed');
} finally {
  await fsp.rm(fixtureRoot, { recursive: true, force: true });
}
