import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(process.env.WORKFLOW_SHOPS_CONFIG
  || path.join(workspaceDir, 'shops.config.json'));
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT
  || (process.platform === 'linux' ? '/var/lib/pdd-workflow' : path.join(workspaceDir, '.codex')));
const selfTest = process.argv.includes('--self-test');
const requestedShopArg = process.argv.find((argument) => argument.startsWith('--shop='));
const requestedShopId = requestedShopArg?.slice('--shop='.length) || null;
const workerRestartDelayMs = Number.parseInt(process.env.WORKFLOW_WORKER_RESTART_DELAY_MS || '10000', 10);
const shopStartStaggerMs = Number.parseInt(process.env.WORKFLOW_SHOP_START_STAGGER_MS || '30000', 10);
const supervisorControlPollMs = Math.max(1000, Number.parseInt(
  process.env.WORKFLOW_SUPERVISOR_CONTROL_POLL_MS || '3000',
  10,
));
const supervisorControlPath = path.resolve(process.env.WORKFLOW_SUPERVISOR_CONTROL_FILE
  || path.join(dataRoot, 'supervisor', 'local-worker-control.json'));

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const config = readJson(configPath);
const scenarioCatalog = readJson(path.join(workspaceDir, 'config', 'scenarios.json'));
const enabledScenarioCodes = scenarioCatalog.scenarios
  .filter((scenario) => scenario.enabled !== false)
  .map((scenario) => String(scenario.code || '').trim())
  .filter(Boolean);
assert(config.version === 1, 'shops.config.json version must be 1');
assert(Array.isArray(config.shops) && config.shops.length > 0, 'shops.config.json must contain shops');
assert(enabledScenarioCodes.length > 0, 'config/scenarios.json must contain enabled scenarios');

const seenShopIds = new Set();
const seenSecretPrefixes = new Set();
for (const shop of config.shops) {
  assert(/^[a-z0-9][a-z0-9-]{0,63}$/.test(shop.shopId || ''), `Invalid shopId: ${shop.shopId}`);
  assert(!seenShopIds.has(shop.shopId), `Duplicate shopId: ${shop.shopId}`);
  assert(typeof shop.enabled === 'boolean', `enabled must be boolean for ${shop.shopId}`);
  assert(shop.workOrderTitle === '订单问题：在途无理由退款处理',
    `Unsupported work order title for ${shop.shopId}`);
  assert(/^[A-Z][A-Z0-9_]{1,63}$/.test(shop.pddSecretPrefix || ''),
    `Invalid pddSecretPrefix for ${shop.shopId}`);
  assert(typeof shop.expectedShopName === 'string' && shop.expectedShopName.trim(),
    `expectedShopName must be configured for ${shop.shopId}`);
  assert(!seenSecretPrefixes.has(shop.pddSecretPrefix),
    `Duplicate pddSecretPrefix: ${shop.pddSecretPrefix}`);
  assert(Array.isArray(shop.scenarioCodes), `scenarioCodes must be configured for ${shop.shopId}`);
  const missingScenarioCodes = enabledScenarioCodes.filter((code) => !shop.scenarioCodes.includes(code));
  assert(missingScenarioCodes.length === 0,
    `Shop ${shop.shopId} is missing enabled scenarios: ${missingScenarioCodes.join(', ')}`);
  seenShopIds.add(shop.shopId);
  seenSecretPrefixes.add(shop.pddSecretPrefix);
}

let selectedShops = config.shops.filter((shop) => shop.enabled);
if (requestedShopId) {
  selectedShops = selectedShops.filter((shop) => shop.shopId === requestedShopId);
  assert(selectedShops.length === 1, `Enabled shop not found: ${requestedShopId}`);
}
assert(selectedShops.length > 0, 'No enabled shops selected');
assert(Number.isFinite(workerRestartDelayMs) && workerRestartDelayMs >= 1000,
  'WORKFLOW_WORKER_RESTART_DELAY_MS must be an integer of at least 1000');
assert(Number.isFinite(shopStartStaggerMs) && shopStartStaggerMs >= 0,
  'WORKFLOW_SHOP_START_STAGGER_MS must be a non-negative integer');

const omsMode = String(process.env.OMS_MODE || 'per-shop').trim().toLowerCase();
const omsSecretPrefixesForShop = (shop) => {
  const shopKey = String(shop.shopId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const legacyKey = String(shop.pddSecretPrefix || '')
    .replace(/^PDD_/u, '')
    .replace(/[^A-Z0-9]+/g, '_');
  return [...new Set([
    `JEOMS_${shopKey}`,
    ...(legacyKey ? [`JEOMS_${legacyKey}`] : []),
  ])];
};
const optionalPerShopOmsSecretNames = omsMode === 'per-shop'
  ? selectedShops.flatMap((shop) => omsSecretPrefixesForShop(shop)
    .flatMap((prefix) => [`${prefix}_ACCOUNT`, `${prefix}_PASSWORD`]))
  : [];
const selectedSecretNames = [
  ...(String(process.env.PDD_LOGIN_MODE || 'manual').toLowerCase() === 'auto'
    ? selectedShops.flatMap((shop) => [
      `${shop.pddSecretPrefix}_ACCOUNT`,
      `${shop.pddSecretPrefix}_PASSWORD`,
    ])
    : []),
  ...(omsMode === 'shared' ? ['JEOMS_ACCOUNT', 'JEOMS_PASSWORD'] : optionalPerShopOmsSecretNames),
  'TMS_ACCOUNT',
  'TMS_PASSWORD',
];
const requiredSecretNames = selectedSecretNames.filter((name) => (
  !optionalPerShopOmsSecretNames.includes(name)
));

const loadWindowsUserSecrets = (names) => {
  if (process.platform !== 'win32') return;
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  for (const name of names) {
    if (process.env[name]) continue;
    const result = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$value = [Environment]::GetEnvironmentVariable('${name}', 'User'); `
        + `if ($null -ne $value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }`,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    if (result.status === 0) {
      const encoded = result.stdout.trim();
      const value = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
      if (value) process.env[name] = value;
    }
  }
};

const loadSecretFiles = (names) => {
  for (const name of names) {
    if (process.env[name]) continue;
    const secretPath = String(process.env[`${name}_FILE`] || '').trim();
    if (!secretPath) continue;
    assert(fs.existsSync(secretPath), `Secret file does not exist for ${name}: ${secretPath}`);
    const value = fs.readFileSync(secretPath, 'utf8').trim();
    if (value) process.env[name] = value;
  }
};

if (!selfTest) {
  loadSecretFiles(selectedSecretNames);
  loadWindowsUserSecrets(selectedSecretNames);

  const missingSecretNames = requiredSecretNames.filter((name) => !process.env[name]);
  assert(missingSecretNames.length === 0,
    `Missing required Secret environment variables: ${missingSecretNames.join(', ')}`);
  const invalidEncodingSecretNames = selectedSecretNames.filter((name) => process.env[name]?.includes('\uFFFD'));
  assert(invalidEncodingSecretNames.length === 0,
    `Secret environment variable decoding failed: ${invalidEncodingSecretNames.join(', ')}`);
}

const validateStorageState = (value, sourcePath) => {
  assert(value && Array.isArray(value.cookies) && Array.isArray(value.origins),
    `Invalid browser storage state: ${sourcePath}`);
  return value;
};

const copyJsonIfMissing = (sourcePath, targetPath, transform = (value) => value) => {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  const value = transform(readJson(sourcePath));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(targetPath, 0o600);
  return true;
};

const copyDirectoryIfMissing = (sourcePath, targetPath) => {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: false });
  return true;
};

const migrateLegacyData = (shop) => {
  if (!shop.migrateLegacy) return [];
  const shopDir = path.join(dataRoot, 'shops', shop.shopId);
  const copied = [];
  const storageMappings = [
    [path.join(workspaceDir, 'pdd-auth.json'), path.join(shopDir, 'auth', 'pdd-auth.json')],
    [path.join(workspaceDir, 'jeoms-auth.json'), path.join(shopDir, 'auth', 'jeoms-auth.json')],
    [path.join(workspaceDir, 'tms-auth.json'), path.join(shopDir, 'auth', 'tms-auth.json')],
    [path.join(dataRoot, 'auth', 'pdd-auth.json'), path.join(shopDir, 'auth', 'pdd-auth.json')],
    [path.join(dataRoot, 'auth', 'jeoms-auth.json'), path.join(shopDir, 'auth', 'jeoms-auth.json')],
    [path.join(dataRoot, 'auth', 'tms-auth.json'), path.join(shopDir, 'auth', 'tms-auth.json')],
  ];
  for (const [sourcePath, targetPath] of storageMappings) {
    if (copyJsonIfMissing(sourcePath, targetPath, (value) => validateStorageState(value, sourcePath))) {
      copied.push(path.relative(workspaceDir, sourcePath));
    }
  }

  const progressSources = [
    path.join(workspaceDir, '.codex', 'workflow-progress.json'),
    path.join(dataRoot, 'state', 'workflow-progress.json'),
  ];
  for (const sourcePath of progressSources) {
    const targetPath = path.join(shopDir, 'state', 'workflow-progress.json');
    if (copyJsonIfMissing(sourcePath, targetPath, (value) => {
      assert(!value.shopId || value.shopId === shop.shopId,
        `Legacy progress belongs to another shop: ${value.shopId}`);
      return { ...value, shopId: shop.shopId, migratedAt: new Date().toISOString() };
    })) {
      copied.push(path.relative(workspaceDir, sourcePath));
      break;
    }
  }

  const directoryMappings = [
    [path.join(workspaceDir, '.codex', 'tmp'), path.join(shopDir, 'tmp')],
    [path.join(workspaceDir, '.codex', 'diagnostics'), path.join(shopDir, 'diagnostics')],
    [path.join(dataRoot, 'tmp'), path.join(shopDir, 'tmp')],
    [path.join(dataRoot, 'diagnostics'), path.join(shopDir, 'diagnostics')],
  ];
  for (const [sourcePath, targetPath] of directoryMappings) {
    if (copyDirectoryIfMissing(sourcePath, targetPath)) copied.push(path.relative(workspaceDir, sourcePath));
  }
  return copied;
};

if (selfTest) {
  for (const shop of selectedShops) {
    const accountName = `${shop.pddSecretPrefix}_ACCOUNT`;
    const passwordName = `${shop.pddSecretPrefix}_PASSWORD`;
    const pddAuto = String(process.env.PDD_LOGIN_MODE || 'manual').toLowerCase() === 'auto';
    const accountConfigured = Boolean(process.env[accountName]);
    const passwordConfigured = Boolean(process.env[passwordName]);
    if (pddAuto) assert(accountConfigured && passwordConfigured,
      `${shop.shopId} must configure both ${accountName} and ${passwordName}`);
    const omsPrefixes = omsSecretPrefixesForShop(shop);
    assert(omsPrefixes.length > 0 && omsPrefixes.every((prefix) => prefix.startsWith('JEOMS_')),
      `${shop.shopId} must resolve at least one isolated OMS Secret prefix`);
    console.log(JSON.stringify({
      shopId: shop.shopId,
      workOrderTitle: shop.workOrderTitle,
      dataDir: path.join(dataRoot, 'shops', shop.shopId),
      pddCredentials: pddAuto ? 'secret-configured' : 'manual-login-required',
      omsCredentials: omsMode === 'shared' ? ['JEOMS_ACCOUNT', 'JEOMS_PASSWORD'] : omsPrefixes,
    }));
  }
  console.log(JSON.stringify({
    runtimeCredentials: {
      omsMode,
      tms: ['TMS_ACCOUNT', 'TMS_PASSWORD'],
    },
  }));
  console.log('多店铺配置、隔离目录和十项 Secret 映射自测通过');
  process.exit(0);
}

const secretEnvironmentNames = new Set(config.shops.flatMap((shop) => [
  `${shop.pddSecretPrefix}_ACCOUNT`,
  `${shop.pddSecretPrefix}_PASSWORD`,
]));
const workerIsolationEnvironmentNames = new Set([
  'WORKFLOW_SHOP_ID',
  'WORKFLOW_DATA_DIR',
  'PDD_WORK_ORDER_TITLE',
  'PDD_ACCOUNT',
  'PDD_PASSWORD',
  'PDD_ORDER_NUMBER',
  'PDD_STATE',
  'JEOMS_STATE',
  'TMS_STATE',
  'PDD_PROGRESS',
  'PDD_LOCK',
  'WORKFLOW_DIAGNOSTICS_DIR',
  'PDD_TEMP_SCREENSHOT_DIR',
  'TMS_TEMP_SCREENSHOT_DIR',
]);
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !secretEnvironmentNames.has(name) && !workerIsolationEnvironmentNames.has(name)
  )),
);
const children = new Map();
const restartTimers = new Map();
const cutoverStops = new Set();
let shuttingDown = false;
let syncerChild = null;
let supervisorControlTimer = null;

const readDisabledShopIds = () => {
  if (!fs.existsSync(supervisorControlPath)) return new Set();
  try {
    const value = readJson(supervisorControlPath);
    return new Set(Array.isArray(value.disabledShopIds) ? value.disabledShopIds.map(String) : []);
  } catch (error) {
    console.error(`[Supervisor] 店铺启停文件无效，保留当前状态: ${error.message}`);
    return null;
  }
};
let disabledShopIds = readDisabledShopIds() || new Set();
const isShopDisabled = (shopId) => disabledShopIds.has(shopId);

const prefixStream = (stream, prefix, output) => {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';
    for (const line of lines) output.write(`[${prefix}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffered) output.write(`[${prefix}] ${buffered}\n`);
  });
};

const startWorker = (shop) => {
  if (shuttingDown || isShopDisabled(shop.shopId) || children.has(shop.shopId)) return;
  cutoverStops.delete(shop.shopId);
  const accountName = `${shop.pddSecretPrefix}_ACCOUNT`;
  const passwordName = `${shop.pddSecretPrefix}_PASSWORD`;
  const pddAccount = process.env[accountName] || '';
  const pddPassword = process.env[passwordName] || '';
  const omsCredential = omsMode === 'shared'
    ? { account: process.env.JEOMS_ACCOUNT || '', password: process.env.JEOMS_PASSWORD || '' }
    : omsSecretPrefixesForShop(shop).map((prefix) => ({
      account: process.env[`${prefix}_ACCOUNT`] || '',
      password: process.env[`${prefix}_PASSWORD`] || '',
    })).find((credential) => credential.account && credential.password)
      || { account: '', password: '' };
  const pddAuto = String(process.env.PDD_LOGIN_MODE || 'manual').toLowerCase() === 'auto';
  if (pddAuto) assert(Boolean(pddAccount) && Boolean(pddPassword),
    `${shop.shopId} must configure both ${accountName} and ${passwordName}`);
  const copied = migrateLegacyData(shop);
  if (copied.length) console.log(`[${shop.shopId}] 已复制旧单店铺数据，源文件保留。`);

  const shopDataDir = path.join(dataRoot, 'shops', shop.shopId);
  const child = spawn(process.execPath, [path.join(workspaceDir, 'workflow.mjs')], {
    cwd: workspaceDir,
    env: {
      ...baseEnvironment,
      WORKFLOW_SHOP_ID: shop.shopId,
      WORKFLOW_DATA_ROOT: dataRoot,
      WORKFLOW_DATA_DIR: shopDataDir,
      PDD_WORK_ORDER_TITLE: shop.workOrderTitle,
      // Let each worker discover every scenario enabled for this shop. The
      // workflow still matches the concrete title on each PDD row.
      PDD_SCENARIO_CODES: Array.isArray(shop.scenarioCodes) ? shop.scenarioCodes.join(',') : '',
      PDD_EXPECTED_SHOP_NAME: shop.expectedShopName,
      PDD_LOGIN_MODE: process.env.PDD_LOGIN_MODE || 'manual',
      OMS_MODE: omsMode,
      WORKFLOW_BROWSER_PROFILE: path.join(shopDataDir, 'browser-profile'),
      PDD_ACCOUNT: pddAccount,
      PDD_PASSWORD: pddPassword,
      // Never let a global OMS credential leak into isolated shop profiles.
      JEOMS_ACCOUNT: omsCredential.account,
      JEOMS_PASSWORD: omsCredential.password,
    },
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    // IPC lets the worker close Chromium's persistent context gracefully.
    // Keep stdin inherited for the manual PDD QR login flow.
    serialization: 'json',
    windowsHide: false,
  });
  children.set(shop.shopId, child);
  const startedAt = Date.now();
  prefixStream(child.stdout, shop.shopId, process.stdout);
  prefixStream(child.stderr, shop.shopId, process.stderr);
  child.on('exit', (code, signal) => {
    console.log(`[${shop.shopId}] 工作进程退出: code=${code ?? 'null'}, signal=${signal ?? 'null'}`);
    children.delete(shop.shopId);
    cutoverStops.delete(shop.shopId);
    if (shuttingDown) return;
    if (isShopDisabled(shop.shopId)) {
      console.log(`[${shop.shopId}] 本地 Worker 已按切换控制停用，不再自动重启。`);
      return;
    }
    // A duplicate worker exits immediately after observing the per-shop lock.
    // Do not create an endless restart storm for that expected no-op exit.
    if (code === 0 && Date.now() - startedAt < 5000) return;
    console.error(`[${shop.shopId}] 将在 ${Math.ceil(workerRestartDelayMs / 1000)} 秒后恢复该店铺工作进程。`);
    const timer = setTimeout(() => {
      restartTimers.delete(shop.shopId);
      startWorker(shop);
    }, workerRestartDelayMs);
    restartTimers.set(shop.shopId, timer);
  });
};

const stopWorkerForCutover = (shopId) => {
  const timer = restartTimers.get(shopId);
  if (timer) clearTimeout(timer);
  restartTimers.delete(shopId);
  const child = children.get(shopId);
  if (!child || child.killed || cutoverStops.has(shopId)) return;
  cutoverStops.add(shopId);
  console.log(`[${shopId}] 收到本地停用配置，正在保存登录态并优雅停止。`);
  try { child.send({ type: 'shutdown' }); } catch { child.kill(); }
};

const refreshSupervisorControl = () => {
  const nextDisabled = readDisabledShopIds();
  if (!nextDisabled) return;
  const previous = disabledShopIds;
  disabledShopIds = nextDisabled;
  for (const shop of selectedShops) {
    if (nextDisabled.has(shop.shopId)) {
      stopWorkerForCutover(shop.shopId);
    } else if (previous.has(shop.shopId) && !children.has(shop.shopId) && !restartTimers.has(shop.shopId)) {
      console.log(`[${shop.shopId}] 本地停用已解除，恢复 Windows Worker。`);
      startWorker(shop);
    }
  }
};

const startStateSyncer = () => {
  if (process.platform !== 'win32' || String(process.env.WINDOWS_STATE_SYNC_ENABLED || 'true').toLowerCase() === 'false') return;
  const tokenFile = process.env.WORKER_INGEST_TOKEN_FILE
    || path.join(workspaceDir, 'secrets', 'staging', 'WORKER_INGEST_TOKEN');
  if (!fs.existsSync(tokenFile)) {
    console.warn('[Windows同步] 未找到 WORKER_INGEST_TOKEN，跳过看板实时同步。');
    return;
  }
  syncerChild = spawn(process.execPath, [path.join(workspaceDir, 'scripts', 'sync-windows-worker-state.mjs')], {
    cwd: workspaceDir,
    env: { ...baseEnvironment, WORKFLOW_DATA_ROOT: dataRoot, WORKER_INGEST_TOKEN_FILE: tokenFile },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  prefixStream(syncerChild.stdout, 'dashboard-sync', process.stdout);
  prefixStream(syncerChild.stderr, 'dashboard-sync', process.stderr);
  syncerChild.on('exit', (code) => {
    syncerChild = null;
    if (shuttingDown || code === 0) return;
    console.error(`[Windows同步] 进程退出 code=${code}，将在 ${Math.ceil(workerRestartDelayMs / 1000)} 秒后恢复。`);
    const timer = setTimeout(() => { restartTimers.delete('dashboard-sync'); startStateSyncer(); }, workerRestartDelayMs);
    restartTimers.set('dashboard-sync', timer);
  });
};

startStateSyncer();

selectedShops.forEach((shop, index) => {
  if (isShopDisabled(shop.shopId)) {
    console.log(`[${shop.shopId}] 已按切换控制停用本地 Worker。`);
    return;
  }
  const delayMs = index * shopStartStaggerMs;
  if (!delayMs) {
    startWorker(shop);
    return;
  }
  console.log(`[${shop.shopId}] 将在 ${Math.ceil(delayMs / 1000)} 秒后启动，避免共享系统并发登录。`);
  const timer = setTimeout(() => {
    restartTimers.delete(shop.shopId);
    startWorker(shop);
  }, delayMs);
  restartTimers.set(shop.shopId, timer);
});
supervisorControlTimer = setInterval(refreshSupervisorControl, supervisorControlPollMs);
supervisorControlTimer.unref();

const stopChildren = () => {
  shuttingDown = true;
  if (supervisorControlTimer) clearInterval(supervisorControlTimer);
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const child of children.values()) {
    try { child.send({ type: 'shutdown' }); } catch { child.kill(); }
  }
  if (syncerChild && !syncerChild.killed) syncerChild.kill();
  const forceKillTimer = setTimeout(() => {
    for (const child of children.values()) {
      if (!child.killed) child.kill();
    }
  }, 15000);
  forceKillTimer.unref();
};
process.once('SIGINT', stopChildren);
process.once('SIGTERM', stopChildren);
