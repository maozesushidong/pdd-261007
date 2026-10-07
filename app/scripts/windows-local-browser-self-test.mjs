import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsLocalBrowserLauncher } from '../apps/api/src/windows-local-browser.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const readProjectFile = (file) => fsp.readFile(path.join(projectRoot, file), 'utf8');

const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-windows-browser-'));
const dataRoot = path.join(temporaryRoot, 'workflow');

try {
  let triggeredTask = null;
  const launcher = createWindowsLocalBrowserLauncher({
    dataRoot,
    platform: 'Windows Native',
    operatingSystem: 'win32',
    waitTimeoutMs: 1000,
    runTask: async (taskName) => {
      triggeredTask = taskName;
      const queueRoot = path.join(dataRoot, 'supervisor', 'browser-launch-queue');
      const resultRoot = path.join(dataRoot, 'supervisor', 'browser-launch-results');
      const [queueName] = await fsp.readdir(queueRoot);
      const request = JSON.parse(await fsp.readFile(path.join(queueRoot, queueName), 'utf8'));
      await fsp.unlink(path.join(queueRoot, queueName));
      await fsp.writeFile(path.join(resultRoot, `${request.requestId}.json`), `\uFEFF${JSON.stringify({
        requestId: request.requestId,
        shopId: request.shopId,
        status: 'launched',
      })}`);
    },
  });

  assert.equal(launcher.available, true);
  assert.equal(launcher.mode, 'windows-local');
  const result = await launcher.launch({
    shopId: 'shop-self-test',
    name: '自测店铺',
    expectedShopName: '自测店铺官方旗舰店',
    loginRequestedAt: '2026-08-26T01:02:03.000Z',
  });
  assert.equal(result.status, 'launched');
  assert.equal(result.shopId, 'shop-self-test');
  assert.equal(triggeredTask, 'PDD Native Browser Launcher');
  await fsp.access(path.join(dataRoot, 'shops', 'shop-self-test', 'browser-profile'));
  const loginContext = JSON.parse(await fsp.readFile(
    path.join(dataRoot, 'shops', 'shop-self-test', 'browser-login-context.json'), 'utf8',
  ));
  assert.equal(loginContext.expectedShopName, '自测店铺官方旗舰店');
  assert.deepEqual(loginContext.expectedShopNames, ['自测店铺官方旗舰店']);
  assert.equal(loginContext.loginRequestedAt, '2026-08-26T01:02:03.000Z');
  const sessionRoot = path.join(dataRoot, 'supervisor', 'browser-login-sessions');
  await fsp.writeFile(path.join(sessionRoot, 'shop-self-test.json'), JSON.stringify({
    shopId: 'shop-self-test', sessionId: result.requestId, revision: 2, status: 'authenticated',
  }));
  const [observation] = await launcher.listSessionObservations();
  assert.equal(observation.status, 'authenticated');

  await assert.rejects(() => launcher.launch('../outside'), (error) => error.code === 'SHOP_ID_INVALID');

  const dockerLauncher = createWindowsLocalBrowserLauncher({
    dataRoot,
    platform: 'Windows Docker',
    operatingSystem: 'linux',
  });
  assert.equal(dockerLauncher.mode, 'remote-desktop');
  await assert.rejects(
    () => dockerLauncher.launch('shop-self-test'),
    (error) => error.code === 'WINDOWS_LOCAL_BROWSER_UNAVAILABLE',
  );

  const [resolver, componentRunner, proxyPreflight, launcherScript, nativeShopBrowser, shopBrowserOpener, extensionDeployScript, bundledExtensionInstaller, extensionSmokeTest, startScript, stopScript, shortcutInstaller, windowKeeper, workflow, apiMain] = await Promise.all([
    readProjectFile('scripts/resolve-native-windows-chrome.ps1'),
    readProjectFile('scripts/run-native-windows-component.ps1'),
    readProjectFile('scripts/browser-proxy-preflight.mjs'),
    readProjectFile('scripts/run-native-windows-browser-launcher.ps1'),
    readProjectFile('scripts/run-native-windows-shop-browser.mjs'),
    readProjectFile('scripts/open-native-windows-shop-browsers.ps1'),
    readProjectFile('scripts/deploy-native-extension-policy.ps1'),
    readProjectFile('scripts/install-bundled-native-extension.ps1'),
    readProjectFile('scripts/chrome-extension-smoke-test.mjs'),
    readProjectFile('scripts/start-native-windows.ps1'),
    readProjectFile('scripts/stop-native-windows.ps1'),
    readProjectFile('scripts/install-native-windows-shortcuts.ps1'),
    readProjectFile('scripts/restore-native-worker-windows.ps1'),
    readProjectFile('workflow.mjs'),
    readProjectFile('apps/api/src/main.mjs'),
  ]);
  assert.match(resolver, /WORKFLOW_BROWSER_EXECUTABLE_PATH/);
  assert.match(resolver, /WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS/);
  assert.match(resolver, /if \(\$preferConfiguredPath\) \{ \$candidates\.Add\(\$configuredPath\.Trim\(\)\) \}/);
  assert.match(resolver, /WORKFLOW_EXPECTED_BROWSER_VERSION/);
  assert.match(resolver, /WORKFLOW_ALLOW_MANUAL_EXTENSIONS = 'true'/);
  assert.match(componentRunner, /resolve-native-windows-chrome\.ps1/);
  assert.match(componentRunner, /function Get-NativeProcessTreeIds/);
  assert.match(componentRunner, /function Get-StaleNativeWorkerRoots/);
  assert.match(componentRunner, /function Stop-StaleNativeWorkerProcessTrees/);
  assert.match(componentRunner, /function Stop-NativeLoginBrowserHosts/);
  assert.match(componentRunner,
    /'Worker'[\s\S]*Stop-NativeLoginBrowserHosts[\s\S]*Stop-StaleNativeWorkerProcessTrees/,
    'Worker startup must release interactive login profiles before opening Worker browsers');
  assert.match(componentRunner,
    /'Worker'[\s\S]*Stop-StaleNativeWorkerProcessTrees[\s\S]*browser-proxy-preflight\.mjs/,
    'a replacement Worker must recursively clear stale workers before preflight and startup');
  assert.match(componentRunner, /ExecutablePath[\s\S]*apps\\\\worker\\\\src\\\\main\\\.mjs/,
    'stale cleanup must be scoped to the bundled Node executable and Worker entrypoint');
  assert.match(componentRunner,
    /'Worker'[\s\S]{0,300}browser-proxy-preflight\.mjs[\s\S]{0,300}resolve-native-windows-chrome\.ps1/);
  assert.match(proxyPreflight, /resolveBrowserProxyConfig/);
  assert.match(proxyPreflight, /probeBrowserProxyConnectivity/);
  assert.match(proxyPreflight, /validationMode/);
  assert.doesNotMatch(proxyPreflight, /health\.host|runtime\.server/,
    'the command output must not expose the configured proxy endpoint');
  assert.match(componentRunner, /Invoke-RestartingNativeProcess/);
  assert.match(componentRunner, /'MinIO'[\s\S]{0,500}Invoke-RestartingNativeProcess/);
  assert.match(componentRunner, /'Notifier'[\s\S]*Invoke-RestartingNativeProcess/);
  assert.match(launcherScript, /load-native-windows-env\.ps1/,
    'the interactive browser launcher must load the migrated native environment');
  assert.match(launcherScript, /run-native-windows-shop-browser\.mjs/);
  assert.match(launcherScript, /Start-Process -FilePath \$node/);
  assert.match(nativeShopBrowser, /resolveBrowserProxyConfig\(\)/,
    'manual shop browsers must reuse the Worker proxy and authentication configuration');
  assert.match(nativeShopBrowser, /probeBrowserProxyConnectivity/);
  assert.match(nativeShopBrowser, /proxy: proxyConfig\.launch/);
  assert.match(nativeShopBrowser, /--load-extension=\$\{joined\}/);
  assert.match(nativeShopBrowser, /browser-login-context\.json/);
  assert.match(nativeShopBrowser, /detectPddIdentity/);
  assert.match(nativeShopBrowser, /应登录：\$\{expectedShopName\}｜拼多多登录/);
  assert.match(nativeShopBrowser, /\$\{detected\.actualShopName\}｜已登录/);
  assert.match(shopBrowserOpener, /-FilePath \$serverChrome\.Path/);
  assert.match(shopBrowserOpener, /load-native-windows-env\.ps1/);
  assert.match(shopBrowserOpener, /run-native-windows-shop-browser\.mjs/);
  assert.match(extensionDeployScript, /WORKFLOW_REQUIRED_EXTENSION_IDS = \$unpackedExtensionId/);
  assert.match(extensionDeployScript, /WORKFLOW_BROWSER_EXTENSION_PATHS = \(Join-Path \$extensionRoot 'source'\)/);
  assert.match(extensionDeployScript, /WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS = 'true'/);
  assert.match(extensionDeployScript, /\$oldExtensionId, \$extensionId, \$unpackedExtensionId/);
  assert.match(bundledExtensionInstaller, /chrome-extension-smoke-test\.mjs/);
  assert.match(bundledExtensionInstaller, /WORKFLOW_BROWSER_EXTENSION_PATHS/);
  assert.match(bundledExtensionInstaller, /WORKFLOW_BROWSER_EXECUTABLE_PATH/);
  assert.match(bundledExtensionInstaller, /runtime\\node\\node\.exe/);
  assert.match(bundledExtensionInstaller, /& \$nodeExecutable \$smokeTest \$installedExtensionRoot \$extensionId \$installedBrowser/);
  assert.match(bundledExtensionInstaller, /if \(\$LASTEXITCODE -ne 0\)[\s\S]{0,160}throw/);
  assert.match(extensionSmokeTest, /pcopnibgkbdnlaeagepigbboebdfejmb|expectedExtensionId/);
  assert.match(extensionSmokeTest, /--disable-extensions-except=/);
  assert.match(extensionSmokeTest, /--load-extension=/);
  assert.match(extensionSmokeTest, /fsp\.cp\(extensionRoot, loadedExtensionRoot/);
  assert.match(extensionSmokeTest, /--load-extension=\$\{loadedExtensionRoot\}/);
  assert.match(extensionSmokeTest, /chrome-extension:\/\//);
  assert.match(extensionSmokeTest, /context\.serviceWorkers\(\)/);
  assert.match(extensionSmokeTest, /waitForEvent\('serviceworker'/);
  assert.match(extensionSmokeTest, /chrome\.runtime\.id/);
  assert.match(extensionSmokeTest, /chrome\.tabs\.sendMessage/);
  assert.match(extensionSmokeTest, /PERF_REQUEST/);
  assert.match(extensionSmokeTest, /http\.createServer/);
  assert.match(extensionSmokeTest, /127\.0\.0\.1/);
  assert.match(startScript, /data\\console-browser-profile/);
  assert.match(startScript,
    /if \(\$StartWorker\)[\s\S]{0,160}Assert-WorkerBrowserProxyReady[\s\S]{0,300}PDD Native Worker/);
  assert.match(startScript, /Start-NativeScheduledTask -TaskName 'PDD Native Worker'/);
  assert.match(startScript, /Start-Process -FilePath \$serverChrome\.Path/);
  assert.match(startScript, /workerOnline/);
  assert.match(stopScript, /Get-CimInstance Win32_Process/);
  assert.match(stopScript, /Stop-Process -Id \$process\.ProcessId -Force/);
  assert.match(stopScript, /data\\workflow\\shops/);
  assert.match(stopScript, /data\\console-browser-profile/);
  assert.match(shortcutInstaller, /PDD-Start\.lnk/);
  assert.match(shortcutInstaller, /PDD-Stop\.lnk/);
  assert.doesNotMatch(shortcutInstaller, /Name = 'PDD-Two-Shops-/);
  assert.match(shortcutInstaller, /Remove-Item -LiteralPath/);
  assert.match(windowKeeper, /\$seenWindowHandles\.Add/);
  assert.match(windowKeeper, /Test-ShopWaitingForVerification/);
  assert.match(windowKeeper, /Get-VerificationFocusOwner/);
  assert.match(windowKeeper, /Test-ShopPopupFocusSuppressed/);
  assert.doesNotMatch(windowKeeper, /SetForegroundWindow/,
    'the window keeper must never activate a worker browser window');
  const restoreWindowBody = windowKeeper.split('function Restore-WorkerBrowserWindow {')[1]
    ?.split('function Restore-AllowedForegroundWindow {')[0] || '';
  assert.doesNotMatch(restoreWindowBody, /\[PddWindowTools\]::(?:ShowWindow|SetWindowPos)/,
    'the window keeper must leave browser windows as the operator left them');
  assert.doesNotMatch(windowKeeper, /BringWindowToTop/);
  assert.match(workflow, /--silent-debugger-extension-api/);
  assert.match(
    workflow,
    /const browserStartsWithoutActivation = process\.platform === 'win32'[\s\S]*workflowForegroundMode !== 'always'/,
    'manual-only resident browsers must start minimized and wait for an explicit owner focus command',
  );
  assert.match(apiMain,
    /dynamicWorkerSupervisor: String\(process\.env\.WORKER_DYNAMIC_SUPERVISOR/,
    'API must detect the dynamic Worker supervisor before deciding how to open a login browser');
  assert.match(apiMain,
    /const workerManagedLogin = localBrowserLauncher\.available[\s\S]{0,180}runtimeEnvironment\.dynamicWorkerSupervisor/,
    're-login must stay on the dynamic Worker profile instead of opening a second browser');
  assert.match(apiMain,
    /const workerManagedBrowser = localBrowserLauncher\.available[\s\S]{0,180}runtimeEnvironment\.dynamicWorkerSupervisor/,
    'the explicit open-browser action must use the dynamic Worker profile as well');
  assert.match(apiMain,
    /const browserLaunch = workerManagedLogin\s*\?[\s\S]{0,900}: localBrowserLauncher\.available[\s\S]{0,180}!shop\.workerOnline[\s\S]{0,120}localBrowserLauncher\.launch\(shop\)/,
    'standalone login launch must remain only the legacy fallback after the dynamic Worker decision');
  assert.match(apiMain,
    /localBrowserLauncher\.available && shop\.enabled && shop\.workerOnline/,
    'an enabled shop without a live Worker must not be reported as worker-managed');
  assert.match(apiMain, /synchronizeLocalBrowserLoginSessions/);
  assert.match(apiMain, /broadcast\('shop\.updated'/);

  console.log('Windows local browser launcher self-test passed');
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
