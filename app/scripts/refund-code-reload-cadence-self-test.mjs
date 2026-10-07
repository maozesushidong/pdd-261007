import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createCodeReloadScanCadence, codeReloadScanCadenceAnchor,
  consumeCodeReloadScanCadence,
} from '../apps/worker/src/worker-code-reload-cadence.mjs';
import {
  returnRefundPartialScanCooldownMs, returnRefundVerificationCooldownUntil,
} from '../apps/worker/src/return-refund-scan-policy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const now = Date.parse('2026-09-30T09:15:00Z');
const boot = now - 24 * 60 * 60_000;
const originalStart = now - 2 * 60 * 60_000;
const marker = createCodeReloadScanCadence({
  shopId: 'fixture-shop', fromVersion: 41, toVersion: 42,
  metadata: { processId: 1001, runnerStartedAt: new Date(originalStart).toISOString() },
  now: now - 5_000, bootEpochMs: boot,
});
assert.ok(marker);
const options = { marker, shopId: 'fixture-shop', configVersion: 42,
  runnerStartedAt: now, processId: 1002, bootEpochMs: boot, oldProcessAlive: false };
assert.equal(codeReloadScanCadenceAnchor(options), originalStart,
  'an authorized warm code reload must keep the original startup deadline');
for (const mutation of [
  { marker: null }, { shopId: 'another-shop' }, { configVersion: 43 },
  { oldProcessAlive: true }, { processId: 1001 },
  { bootEpochMs: now - 2_000 }, { runnerStartedAt: now + 120_001 },
  { marker: { ...marker, schema: 'untrusted' } },
  { marker: { ...marker, oldProcessId: -1 } },
  { marker: { ...marker, fromVersion: 40 } },
  { marker: { ...marker, requestedAt: new Date(now + 1).toISOString() } },
  { marker: { ...marker, startupAnchorAt: new Date(now).toISOString() } },
  { marker: { ...marker, startupAnchorAt: new Date(boot - 10_000).toISOString() } },
  { marker: { ...marker, hostBootEpochMs: null } },
]) assert.equal(codeReloadScanCadenceAnchor({ ...options, ...mutation }), null);
assert.equal(createCodeReloadScanCadence({
  shopId: 'fixture-shop', fromVersion: 41, toVersion: 42,
  metadata: { processId: 1001 }, now, bootEpochMs: boot,
}), null, 'missing original process evidence must not invent a warm startup');
const repeated = createCodeReloadScanCadence({
  shopId: 'fixture-shop', fromVersion: 42, toVersion: 43,
  metadata: { processId: 1002, runnerStartedAt: new Date(now).toISOString(),
    returnRefundScanStartup: { anchorAt: new Date(originalStart).toISOString() } },
  now: now + 30_000, bootEpochMs: boot,
});
assert.equal(codeReloadScanCadenceAnchor({ ...options, marker: repeated,
  configVersion: 43, runnerStartedAt: now + 35_000, processId: 1003 }), originalStart,
  'successive warm reloads must not extend the original stagger');

// Exercise the actual scheduler hydration function, rather than reproducing
// its implementation in a test. The pre-fix runner adds ten unnecessary
// minutes; retries and challenge cooldown must still win after the repair.
const arg = process.argv.indexOf('--runner-source');
const sourcePath = arg < 0 ? path.join(root, 'apps/worker/src/postgres-playwright-runner.mjs')
  : process.argv[arg + 1];
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('const hydrateReturnRefundScanCursor = async () => {');
const end = source.indexOf('const deferClaimsAfterPddTabFailure', start);
assert.ok(start > 0 && end > start);
const hydrateSource = source.slice(start, end);
const hydrate = async ({ retryAt = 0, verificationHandledCount = 0, scannedAt, anchorAt }) => {
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    Set, returnRefundConfiguredForShop: () => true,
    repository: { getReturnRefundScanCursor: async () => ({
      page: 4, itemOffset: 5, updatedAt: new Date(scannedAt).toISOString(),
      retryNotBefore: retryAt ? new Date(retryAt).toISOString() : null,
      verificationHandledCount,
    }) },
    shopId: 'fixture-shop', returnRefundScanCursorHydrated: false,
    lastReturnRefundScanAt: 0, returnRefundScanRetryNotBefore: 0,
    returnRefundVerificationCooldownUntil, returnRefundPartialScanCooldownMs,
    returnRefundPostVerificationCooldownMs: 300_000,
    returnRefundPartialBatchCooldownMs: 300_000,
    returnRefundCycleCursor: null, returnRefundCycleTotals: null,
    returnRefundCycleVisitedCursors: null,
    runnerStartedAt: now, returnRefundScanStartupCadence: { anchorAt },
    returnRefundScanStartupDelayMs: 600_000, mixedBusinessSlotSession: true,
  });
  await vm.runInContext(`${hydrateSource}\nhydrateReturnRefundScanCursor();`, context);
  return context.returnRefundScanRetryNotBefore;
};
const olderAnchor = now - 60 * 60_000;
assert.equal(await hydrate({ scannedAt: now - 10 * 60_000, anchorAt: olderAnchor }),
  now - 5 * 60_000, 'code-only reload must not reapply an already completed startup stagger');
assert.equal(await hydrate({ scannedAt: now - 10 * 60_000, anchorAt: now }),
  now + 600_000, 'a real fresh process without a consumed marker retains the full startup stagger');
assert.equal(await hydrate({ scannedAt: now - 10 * 60_000, anchorAt: olderAnchor,
  retryAt: now + 30 * 60_000 }), now + 30 * 60_000,
  'a platform retry deadline must remain authoritative');
assert.equal(await hydrate({ scannedAt: now - 60_000, anchorAt: olderAnchor,
  verificationHandledCount: 1 }), now + 240_000,
  'the remaining five-minute post-verification cooldown must not be shortened');

const env = fs.readFileSync(path.join(root, '.env.native'), 'utf8');
const connectionString = env.split(/\r?\n/u).find(line => line.startsWith('DATABASE_URL='))
  ?.slice(13).trim().replace(/^(['"])(.*)\1$/u, '$2');
assert.ok(connectionString, 'database URL required for rollback-only SQL integration');
const db = new pg.Client({ connectionString, application_name: 'code-reload-cadence-isolated-test' });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query('SET LOCAL statement_timeout=10000');
  // Temporary tables shadow the production names only in this connection.
  await db.query('CREATE TEMP TABLE shops (id text PRIMARY KEY, config_version int) ON COMMIT DROP');
  await db.query(`CREATE TEMP TABLE shop_runtime_state
    (shop_id text PRIMARY KEY, metadata jsonb, status text, lease_token text,
      updated_at timestamptz DEFAULT now()) ON COMMIT DROP`);
  await db.query('INSERT INTO shops VALUES ($1,$2)', ['fixture-shop', 42]);
  const retained = { returnRefundScanCursor: { page: 4, itemOffset: 5 },
    returnRefundScanRetry: { retryNotBefore: new Date(now + 600_000).toISOString() },
    protectedUnknownEffect: { status: 'unknown' },
    maintenanceDrain: { active: true, previousOperatorPaused: false } };
  await db.query('INSERT INTO shop_runtime_state (shop_id,metadata,status,lease_token) VALUES ($1,$2,$3,$4)',
    ['fixture-shop', JSON.stringify(retained), 'operator-paused', null]);
  const reloadSource = fs.readFileSync(path.join(root, 'scripts/safe-single-shop-reload.mjs'), 'utf8');
  const markerWriterSql = reloadSource.match(/UPDATE shop_runtime_state\s+SET metadata = jsonb_set\(metadata, '\{maintenanceDrain\}'[\s\S]*?WHERE shop_id = \$1/u)?.[0];
  assert.ok(markerWriterSql, 'actual safe reload marker writer must be exercised');
  await db.query(markerWriterSql, ['fixture-shop', 1001, 42, JSON.stringify(marker)]);
  retained.maintenanceDrain.reloadFromProcessId = 1001;
  retained.maintenanceDrain.reloadToConfigVersion = 42;
  const consumeOptions = { pool: db, ...options, processAlive: () => false };
  const applied = await consumeCodeReloadScanCadence(consumeOptions);
  assert.equal(applied.anchorAt, originalStart);
  assert.equal(applied.source, 'safe-idle-code-reload');
  let row = (await db.query('SELECT * FROM shop_runtime_state')).rows[0];
  assert.equal(row.metadata.codeReloadScanCadence, undefined);
  assert.equal(row.metadata.codeReloadScanCadenceApplied.processId, 1002);
  for (const [key, value] of Object.entries(retained)) assert.deepEqual(row.metadata[key], value);
  assert.equal(row.status, 'operator-paused');
  assert.equal(row.lease_token, null);
  const second = await consumeCodeReloadScanCadence(consumeOptions);
  assert.deepEqual(second, { anchorAt: now, source: 'fresh-process' },
    'a consumed marker cannot suppress the stagger on a subsequent restart');
  await db.query(`UPDATE shop_runtime_state SET metadata = metadata
    || jsonb_build_object('codeReloadScanCadence',$1::jsonb)`, [JSON.stringify(marker)]);
  const coldBoot = await consumeCodeReloadScanCadence({ ...consumeOptions, bootEpochMs: now - 2_000 });
  assert.equal(coldBoot.source, 'fresh-process', 'a host reboot must reject a recent warm marker');
  const racingPool = { query: async (sql, values) => {
    if (/UPDATE shop_runtime_state runtime/u.test(sql)) {
      await db.query(`UPDATE shop_runtime_state SET metadata = metadata
        || jsonb_build_object('codeReloadScanCadence',$1::jsonb)`,
      [JSON.stringify({ ...marker, requestedAt: new Date(now - 4_000).toISOString() })]);
    }
    return db.query(sql, values);
  } };
  const raced = await consumeCodeReloadScanCadence({ ...consumeOptions, pool: racingPool });
  assert.equal(raced.source, 'fresh-process', 'a changed marker must fail the atomic consumption fence');
  row = (await db.query('SELECT * FROM shop_runtime_state')).rows[0];
  for (const [key, value] of Object.entries(retained)) assert.deepEqual(row.metadata[key], value);
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
console.log(JSON.stringify({ ok: true, invalidMarkerCases: 14, hydrationCases: 4,
  actualReloadWriterSql: true, oneTimeSqlConsumption: true, coldBootGate: true, changedMarkerFence: true,
  productionOrdersChanged: false }));
