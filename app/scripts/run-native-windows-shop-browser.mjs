import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  browserDeviceScaleFactor,
  browserViewport,
  probeBrowserProxyConnectivity,
  resolveBrowserProxyConfig,
} from '../packages/adapters/src/browser-runtime-config.mjs';
import {
  canonicalDetectedPddShopName,
  normalizeDetectedPddShopName,
  pddIdentityMatches,
  pddIdentityNameSet,
} from '../apps/worker/src/pdd-shop-identity.mjs';

const loginUrl = 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmms.pinduoduo.com%2F';
const root = path.resolve(import.meta.dirname, '..');
const installRoot = path.resolve(root, '..');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const readJson = async (file) => {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const writeJsonAtomic = async (file, value) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
};

const extensionArguments = (environment = process.env) => {
  if (String(environment.WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS || 'false').toLowerCase() !== 'true') {
    return [];
  }
  const extensionPaths = String(environment.WORKFLOW_BROWSER_EXTENSION_PATHS || '')
    .split(path.delimiter).map((value) => value.trim()).filter(Boolean)
    .map((value) => path.resolve(value));
  if (!extensionPaths.length) return [];
  const joined = extensionPaths.join(',');
  return [`--disable-extensions-except=${joined}`, `--load-extension=${joined}`];
};

const launchOptions = ({ proxy, proxyArgs = [], executablePath, environment = process.env }) => ({
  executablePath,
  headless: false,
  slowMo: 0,
  ...(proxy ? { proxy } : {}),
  ignoreDefaultArgs: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
  ],
  viewport: browserViewport,
  deviceScaleFactor: browserDeviceScaleFactor,
  args: [
    ...proxyArgs,
    '--start-maximized',
    '--deny-permission-prompts',
    '--silent-debugger-extension-api',
    '--disable-session-crashed-bubble',
    '--disable-restore-session-state',
    '--force-device-scale-factor=1',
    '--noerrdialogs',
    ...extensionArguments(environment),
  ],
});

const isPddPage = (page) => !page.isClosed()
  && /^https:\/\/mms\.pinduoduo\.com(?:\/|$)/u.test(page.url());

const isMaskedShopName = (value) => {
  const name = normalizeDetectedPddShopName(value);
  return name.includes('***') || /(?:\.{3}|…)/u.test(name);
};

const normalizeMallId = (value) => {
  const normalized = String(value ?? '').trim();
  return /^\d{5,30}$/u.test(normalized) ? normalized : null;
};

const pddIdentityFromUserInfo = (value) => {
  let userInfo = value;
  if (typeof userInfo === 'string') {
    try { userInfo = JSON.parse(userInfo); } catch { return null; }
  }
  if (!userInfo || typeof userInfo !== 'object' || Array.isArray(userInfo)) return null;
  const mall = userInfo.mall && typeof userInfo.mall === 'object' ? userInfo.mall : {};
  const mallId = normalizeMallId(userInfo.mall_id ?? userInfo.mallId ?? mall.mall_id ?? mall.mallId);
  const actualShopName = normalizeDetectedPddShopName(
    mall.mall_name ?? mall.mallName ?? userInfo.mall_name ?? userInfo.mallName,
  );
  if (!mallId || actualShopName.length < 2 || actualShopName.length > 120 || isMaskedShopName(actualShopName)) {
    return null;
  }
  return { actualShopName, mallId, source: 'local-storage-new_userinfo' };
};

const detectPddIdentity = async (page) => {
  if (!isPddPage(page) || /\/login(?:\/|\?|$)/u.test(page.url())) return null;
  const userInfo = await page.evaluate(() => localStorage.getItem('new_userinfo')).catch(() => null);
  const storageIdentity = pddIdentityFromUserInfo(userInfo);
  if (storageIdentity) {
    const visibleIdentity = await page.evaluate(() => {
      const selectors = [
        '.user-name-name', '.mms-header__user-info [title]', '.user-name [title]',
        '[class*="user-info"] [title]', '[class*="shop-name"]', '[class*="mall-name"]',
      ];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          const rectangle = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (rectangle.width <= 0 || rectangle.height <= 0 || style.visibility === 'hidden'
            || style.display === 'none') continue;
          const candidate = String(element.getAttribute('title') || element.getAttribute('aria-label')
            || element.textContent || '').replace(/\s+/g, ' ').trim();
          if (candidate) return candidate;
        }
      }
      return null;
    }).catch(() => null);
    const headerShopName = normalizeDetectedPddShopName(visibleIdentity);
    return {
      ...storageIdentity,
      mallName: storageIdentity.actualShopName,
      headerShopName: headerShopName.length >= 2 && headerShopName.length <= 120
        && !isMaskedShopName(headerShopName) ? headerShopName : null,
      identityNames: pddIdentityNameSet(storageIdentity.actualShopName, headerShopName),
    };
  }
  const visibleName = await page.evaluate(() => {
    const selectors = [
      '.user-name-name', '.mms-header__user-info [title]', '.user-name [title]',
      '[class*="user-info"] [title]', '[class*="shop-name"]', '[class*="mall-name"]',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const rectangle = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (rectangle.width <= 0 || rectangle.height <= 0 || style.visibility === 'hidden'
          || style.display === 'none') continue;
        const candidate = String(element.getAttribute('title') || element.getAttribute('aria-label')
          || element.textContent || '').replace(/\s+/g, ' ').trim();
        if (candidate) return candidate;
      }
    }
    return null;
  }).catch(() => null);
  const actualShopName = normalizeDetectedPddShopName(visibleName);
  if (actualShopName.length < 2 || actualShopName.length > 120 || isMaskedShopName(actualShopName)) return null;
  return {
    actualShopName,
    mallName: null,
    headerShopName: actualShopName,
    identityNames: pddIdentityNameSet(actualShopName),
    mallId: null,
    source: 'visible-header',
  };
};

const installManagedTitle = async (page, title) => {
  if (page.isClosed()) return;
  await page.evaluate((managedTitle) => {
    globalThis.__pddManagedWindowTitle = managedTitle;
    const updateTitle = () => {
      if (document.title !== globalThis.__pddManagedWindowTitle) {
        document.title = globalThis.__pddManagedWindowTitle;
      }
    };
    updateTitle();
    if (!globalThis.__pddManagedWindowTitleTimer) {
      globalThis.__pddManagedWindowTitleTimer = setInterval(updateTitle, 500);
    }
  }, title).catch(() => {});
};

const openLoginPage = async (browserContext) => {
  let lastAbortedNavigation = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existingPddPage = browserContext.pages().find(isPddPage);
    if (existingPddPage) return existingPddPage;
    const page = browserContext.pages().find((candidate) => !candidate.isClosed())
      || await browserContext.newPage();
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      if (!String(error?.message || '').includes('net::ERR_ABORTED')) throw error;
      lastAbortedNavigation = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const recoveredPddPage = browserContext.pages().find(isPddPage);
    if (recoveredPddPage) return recoveredPddPage;
  }
  throw lastAbortedNavigation || new Error('pdd-login-page-not-opened');
};

if (process.argv.includes('--self-test')) {
  const environment = {
    WORKFLOW_BROWSER_PROXY_REQUIRED: 'true',
    WORKFLOW_BROWSER_PROXY_SERVER: 'http://127.0.0.1:29875',
    WORKFLOW_BROWSER_PROXY_USERNAME: 'proxy-user',
    WORKFLOW_BROWSER_PROXY_PASSWORD: 'proxy-password',
    WORKFLOW_BROWSER_PROXY_BYPASS: 'localhost,127.0.0.1',
    WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS: 'true',
    WORKFLOW_BROWSER_EXTENSION_PATHS: path.join(root, 'test-extension'),
  };
  const proxy = resolveBrowserProxyConfig({ env: environment }).launch;
  const options = launchOptions({ proxy, executablePath: 'project-chrome.exe', environment });
  assert.equal(options.executablePath, 'project-chrome.exe');
  assert.equal(options.proxy.server, 'http://127.0.0.1:29875');
  assert.equal(options.proxy.username, 'proxy-user');
  assert.equal(options.proxy.password, 'proxy-password');
  assert.equal(options.proxy.bypass, 'localhost,127.0.0.1');
  assert.ok(options.args.some((value) => value.startsWith('--load-extension=')));
  console.log('Native Windows shop browser self-test passed');
  process.exit(0);
}

const [shopId, requestId = '-'] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(String(shopId || ''))) {
  throw new Error('shop-id-invalid');
}
if (requestId !== '-' && !/^[0-9a-f-]{36}$/.test(String(requestId || ''))) {
  throw new Error('browser-launch-request-id-invalid');
}

const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(installRoot, 'data', 'workflow'));
const shopsRoot = path.resolve(dataRoot, 'shops');
const profileRoot = path.resolve(shopsRoot, shopId, 'browser-profile');
if (!profileRoot.startsWith(`${shopsRoot}${path.sep}`)) throw new Error('shop-profile-path-invalid');
const resultRoot = path.resolve(dataRoot, 'supervisor', 'browser-launch-results');
const resultFile = requestId === '-' ? null : path.join(resultRoot, `${requestId}.json`);
const sessionRoot = path.resolve(dataRoot, 'supervisor', 'browser-login-sessions');
const sessionFile = path.join(sessionRoot, `${shopId}.json`);
const stopAllFile = path.resolve(dataRoot, 'supervisor', 'browser-login-control', 'stop-all.json');
const loginContext = await readJson(path.join(shopsRoot, shopId, 'browser-login-context.json')) || {};
const displayName = normalizeDetectedPddShopName(loginContext.name || loginContext.expectedShopName || shopId);
const expectedShopName = normalizeDetectedPddShopName(loginContext.expectedShopName || displayName || shopId);
const expectedShopNames = pddIdentityNameSet(expectedShopName);
const loginRequestedAt = loginContext.loginRequestedAt || null;
const sessionId = loginContext.requestId || requestId;
const launchedAt = new Date().toISOString();
const executablePath = path.resolve(String(process.env.WORKFLOW_BROWSER_EXECUTABLE_PATH || ''));
const extensionPaths = String(process.env.WORKFLOW_BROWSER_EXTENSION_PATHS || '')
  .split(path.delimiter).map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));

const writeResult = async (result) => {
  if (!resultFile) return;
  await fsp.mkdir(resultRoot, { recursive: true });
  const temporary = `${resultFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify({
    requestId,
    shopId,
    ...result,
    completedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, resultFile);
};

let context = null;
let launchReported = false;
let contextClosed = false;
let sessionRevision = 0;
let lastSessionSignature = '';
let currentTitle = `应登录：${expectedShopName}｜拼多多登录`;
const closeContext = () => context?.close().catch(() => {});
process.once('SIGINT', closeContext);
process.once('SIGTERM', closeContext);

const writeSessionObservation = async (observation) => {
  const normalized = {
    shopId,
    sessionId,
    loginRequestedAt,
    expectedShopName,
    displayName,
    ...observation,
  };
  const signature = JSON.stringify(normalized);
  if (signature === lastSessionSignature) return;
  lastSessionSignature = signature;
  sessionRevision += 1;
  await writeJsonAtomic(sessionFile, {
    ...normalized,
    revision: sessionRevision,
    processId: process.pid,
    launchedAt,
    observedAt: new Date().toISOString(),
  });
};

const persistConfirmedProfileIdentity = async (identity) => {
  const markerFile = path.join(profileRoot, '.workflow-profile.json');
  const marker = await readJson(markerFile) || {};
  const profileFingerprint = String(marker.profileFingerprint || crypto.randomUUID());
  const existingBinding = marker.identityBinding || {};
  const sameIdentity = canonicalDetectedPddShopName(existingBinding.expectedShopName)
      === canonicalDetectedPddShopName(identity.actualShopName)
    && String(existingBinding.mallId || '') === String(identity.mallId || '')
    && String(existingBinding.loginRequestedAt || '') === String(loginRequestedAt || '')
    && existingBinding.status === 'confirmed';
  if (sameIdentity && marker.profileFingerprint) return profileFingerprint;
  const confirmedAt = new Date().toISOString();
  await writeJsonAtomic(markerFile, {
    ...marker,
    shopId,
    profileFingerprint,
    loginRequestedAt: loginRequestedAt || marker.loginRequestedAt || null,
    identityBinding: {
      shopId,
      expectedShopName: identity.actualShopName,
      mallId: identity.mallId,
      loginRequestedAt,
      status: 'confirmed',
      source: identity.source,
      confirmedAt,
    },
    lastUnmaskedIdentityObservation: {
      ...identity,
      profileFingerprint,
      loginRequestedAt,
      detectedAt: confirmedAt,
    },
    updatedAt: confirmedAt,
  });
  return profileFingerprint;
};

try {
  if (!executablePath || !await fsp.stat(executablePath).then((item) => item.isFile()).catch(() => false)) {
    throw new Error('project-browser-not-found');
  }
  for (const extensionPath of extensionPaths) {
    const manifest = path.join(extensionPath, 'manifest.json');
    if (!await fsp.stat(manifest).then((item) => item.isFile()).catch(() => false)) {
      throw new Error(`browser-extension-missing:${extensionPath}`);
    }
  }
  await fsp.mkdir(profileRoot, { recursive: true });
  const proxyConfig = resolveBrowserProxyConfig();
  const proxyHealth = await probeBrowserProxyConnectivity({ runtime: proxyConfig.runtime, timeoutMs: 8_000 });
  if (!proxyHealth.ok) {
    const error = new Error(proxyHealth.errorCode || 'browser-proxy-unavailable');
    error.code = proxyHealth.errorCode || 'BROWSER_PROXY_UNAVAILABLE';
    throw error;
  }
  context = await chromium.launchPersistentContext(profileRoot, launchOptions({
    proxy: proxyConfig.launch,
    proxyArgs: proxyConfig.args || [],
    executablePath,
  }));
  context.once('close', () => { contextClosed = true; });
  context.on('page', (page) => {
    page.on('domcontentloaded', () => installManagedTitle(page, currentTitle));
  });
  const loginPage = await openLoginPage(context);
  await installManagedTitle(loginPage, currentTitle);
  await writeSessionObservation({ status: 'waiting-login', actualShopName: null, mallId: null });
  const browserVersion = context.browser()?.version() || null;
  await writeResult({
    status: 'launched',
    error: null,
    processId: process.pid,
    browserVersion,
    proxy: {
      enabled: Boolean(proxyConfig.runtime.enabled),
      authenticated: Boolean(proxyConfig.runtime.authenticated),
      required: Boolean(proxyConfig.runtime.required),
    },
  });
  launchReported = true;
  while (!contextClosed) {
    const stopRequest = await readJson(stopAllFile);
    if (Date.parse(stopRequest?.requestedAt || '') >= Date.parse(launchedAt)) {
      await writeSessionObservation({ status: 'handoff-requested', actualShopName: null, mallId: null });
      await context.close().catch(() => {});
      break;
    }
    let detected = null;
    for (const page of context.pages().filter(isPddPage)) {
      await installManagedTitle(page, currentTitle);
      detected = await detectPddIdentity(page);
      if (detected) break;
    }
    if (detected) {
      const expectedCanonical = canonicalDetectedPddShopName(expectedShopName);
      const actualCanonical = canonicalDetectedPddShopName(detected.actualShopName);
      if (expectedCanonical && !pddIdentityMatches(expectedShopNames, detected.identityNames || [
        detected.actualShopName,
        detected.mallName,
        detected.headerShopName,
      ])) {
        currentTitle = `登录错误：${detected.actualShopName}｜应登录：${expectedShopName}`;
        await writeSessionObservation({ ...detected, status: 'identity-mismatch' });
      } else {
        const profileFingerprint = await persistConfirmedProfileIdentity(detected);
        currentTitle = `${detected.actualShopName}｜已登录`;
        await writeSessionObservation({ ...detected, profileFingerprint, status: 'authenticated' });
      }
      for (const page of context.pages()) await installManagedTitle(page, currentTitle);
    }
    await delay(1_500);
  }
} catch (error) {
  if (!launchReported) {
    await writeResult({
      status: 'failed',
      error: String(error?.code || error?.message || 'windows-local-browser-launch-failed'),
      processId: process.pid,
      browserVersion: null,
    }).catch(() => {});
  }
  await writeSessionObservation({
    status: 'error',
    actualShopName: null,
    mallId: null,
    error: String(error?.code || error?.message || 'windows-local-browser-launch-failed'),
  }).catch(() => {});
  console.error(`[native-shop-browser] ${shopId}: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
