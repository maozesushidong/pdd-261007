import os from 'node:os';

const schema = 'safe-idle-code-reload-scan-cadence-v1';
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const validPid = value => Number.isSafeInteger(value) && value > 0;
const validVersion = value => Number.isSafeInteger(value) && value >= 0;

// A real host restart must retain the normal startup stagger, even when a
// maintenance marker was committed just before the machine shut down.
export const hostBootEpochMs = () => Date.now() - os.uptime() * 1000;

export const createCodeReloadScanCadence = ({
  shopId, fromVersion, toVersion, metadata, now = Date.now(),
  bootEpochMs = hostBootEpochMs(),
}) => {
  const startedAt = timestamp(metadata?.runnerStartedAt);
  const inheritedAt = timestamp(metadata?.returnRefundScanStartup?.anchorAt);
  const anchorAt = Number.isFinite(inheritedAt) && inheritedAt <= startedAt
    ? inheritedAt : startedAt;
  if (!shopId || !validVersion(fromVersion) || toVersion !== fromVersion + 1
    || !validPid(metadata?.processId) || !Number.isFinite(startedAt)
    || startedAt <= 0 || startedAt > now || !Number.isFinite(bootEpochMs)
    || bootEpochMs <= 0 || bootEpochMs > now || anchorAt < bootEpochMs - 3_000) return null;
  return {
    schema, shopId, fromVersion, toVersion, oldProcessId: metadata.processId,
    requestedAt: new Date(now).toISOString(),
    hostBootEpochMs: bootEpochMs,
    startupAnchorAt: new Date(anchorAt).toISOString(),
  };
};

export const codeReloadScanCadenceAnchor = ({
  marker, shopId, configVersion, runnerStartedAt, processId = process.pid,
  bootEpochMs = hostBootEpochMs(), oldProcessAlive = true,
}) => {
  const requestedAt = timestamp(marker?.requestedAt);
  const anchorAt = timestamp(marker?.startupAnchorAt);
  if (marker?.schema !== schema || marker.shopId !== shopId
    || !validVersion(marker.fromVersion) || !validVersion(configVersion)
    || marker.toVersion !== configVersion
    || marker.toVersion !== marker.fromVersion + 1
    || !validPid(marker.oldProcessId) || marker.oldProcessId === processId
    || oldProcessAlive !== false || !Number.isFinite(runnerStartedAt)
    || !Number.isFinite(requestedAt) || requestedAt > runnerStartedAt
    || runnerStartedAt - requestedAt > 120_000
    || !Number.isFinite(anchorAt) || anchorAt <= 0 || anchorAt > requestedAt
    || !Number.isFinite(marker.hostBootEpochMs) || !Number.isFinite(bootEpochMs)
    || marker.hostBootEpochMs <= 0 || bootEpochMs > requestedAt
    || anchorAt < bootEpochMs - 3_000
    || Math.abs(marker.hostBootEpochMs - bootEpochMs) > 3_000) return null;
  return anchorAt;
};

const isProcessAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
};

export const consumeCodeReloadScanCadence = async ({
  pool, shopId, configVersion, runnerStartedAt, processId = process.pid,
  bootEpochMs = hostBootEpochMs(), processAlive = isProcessAlive,
}) => {
  const fresh = { anchorAt: runnerStartedAt, source: 'fresh-process' };
  const { rows } = await pool.query(`
    SELECT metadata->'codeReloadScanCadence' AS marker
    FROM shop_runtime_state WHERE shop_id = $1`, [shopId]);
  const marker = rows[0]?.marker;
  if (!marker) return fresh;
  const anchorAt = codeReloadScanCadenceAnchor({
    marker, shopId, configVersion, runnerStartedAt, processId, bootEpochMs,
    oldProcessAlive: validPid(marker.oldProcessId)
      ? processAlive(marker.oldProcessId) : true,
  });
  if (anchorAt == null) return fresh;
  const applied = {
    ...marker, processId, consumedAt: new Date().toISOString(),
    runnerStartedAt: new Date(runnerStartedAt).toISOString(),
  };
  // Consume once, against the exact version and exact marker. No cursor,
  // retry, lease, order, identity, or external effect is changed here.
  const result = await pool.query(`
    UPDATE shop_runtime_state runtime
    SET metadata = (runtime.metadata - 'codeReloadScanCadence')
      || jsonb_build_object('codeReloadScanCadenceApplied', $4::jsonb)
    FROM shops shop
    WHERE runtime.shop_id = $1 AND shop.id = runtime.shop_id
      AND shop.config_version = $3
      AND runtime.metadata->'codeReloadScanCadence' = $2::jsonb`,
  [shopId, JSON.stringify(marker), configVersion, JSON.stringify(applied)]);
  return result.rowCount === 1
    ? { anchorAt, source: 'safe-idle-code-reload', oldProcessId: marker.oldProcessId }
    : fresh;
};
