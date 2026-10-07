import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataBackend } from './data-backend.mjs';
import {
  deliverDailySummaryToDingTalk,
  normalizeDailySummaryMessage,
} from './dingtalk-daily-summary.mjs';
import { normalizeOwnerDingTalkMessage } from './dingtalk-message.mjs';
import { analyzeIncompleteWorkflow } from './incomplete-workflow-analysis.mjs';
import { createWindowsLocalBrowserLauncher } from './windows-local-browser.mjs';
import { registerChatAnalysisRoutes } from './chat-analysis-routes.mjs';
import { createNativeAutomationControl } from './native-automation-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex'));
const chromeExtensionPackageDir = process.env.CHROME_EXTENSION_PACKAGE_DIR
  ? path.resolve(process.env.CHROME_EXTENSION_PACKAGE_DIR)
  : null;
const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
const ownerAllowedOrigins = new Set([
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  ...String(process.env.OWNER_ALLOWED_ORIGINS || '')
    .split(',').map((value) => value.trim()).filter(Boolean),
]);
await app.register(cors, {
  credentials: true,
  origin(origin, callback) {
    callback(null, !origin || ownerAllowedOrigins.has(origin));
  },
});
const backend = await createDataBackend({ root, dataRoot });
const verificationScreenshotRetentionDays = Math.max(1, Number(process.env.VERIFICATION_SCREENSHOT_RETENTION_DAYS || 7));
const evidenceScreenshotRetentionDays = Math.max(1, Number(process.env.PDD_TMS_SCREENSHOT_RETENTION_DAYS || 7));
const runtimeEnvironment = Object.freeze({
  stage: process.env.DEPLOYMENT_STAGE || 'STG',
  platform: process.env.DEPLOYMENT_PLATFORM || 'Windows Docker',
  dataBackend: process.env.DATA_BACKEND || 'legacy-json',
  version: process.env.APP_VERSION || 'development',
  gitSha: process.env.GIT_SHA || 'unknown',
  schedulerMode: String(process.env.WORKER_SCHEDULER_MODE || 'legacy').toLowerCase(),
  dynamicWorkerSupervisor: String(process.env.WORKER_DYNAMIC_SUPERVISOR || 'false').toLowerCase() === 'true',
});
const localBrowserLauncher = createWindowsLocalBrowserLauncher({
  dataRoot,
  platform: runtimeEnvironment.platform,
});

const readSecret = async (name) => {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try { return (await fsp.readFile(file, 'utf8')).trim(); } catch { return ''; }
  }
  return String(process.env[name] || '').trim();
};

const ownerUsername = process.env.OWNER_USERNAME || 'owner';
const ownerPassword = await readSecret('OWNER_PASSWORD');
const ownerSessionSecret = await readSecret('OWNER_SESSION_SECRET');
const workerIngestToken = await readSecret('WORKER_INGEST_TOKEN');
const dingtalkWebhook = await readSecret('DINGTALK_WEBHOOK');
const dingtalkSigningSecret = await readSecret('DINGTALK_SIGNING_SECRET');
const ownerEnabled = Boolean(ownerPassword && ownerSessionSecret);
const sessionCookieName = 'work_order_owner_session';
const sseClients = new Set();
let eventSequence = Date.now();

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const verifyPassword = (value, stored) => {
  if (!stored.startsWith('scrypt$')) return safeEqual(value, stored);
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(value), salt, Buffer.from(expected, 'hex').length).toString('hex');
  return safeEqual(actual, expected);
};

const signSession = (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', ownerSessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

const parseCookies = (request) => Object.fromEntries(String(request.headers.cookie || '')
  .split(';').map((value) => value.trim()).filter(Boolean).map((value) => {
    const separator = value.indexOf('=');
    return separator < 0 ? [value, ''] : [value.slice(0, separator), decodeURIComponent(value.slice(separator + 1))];
  }));

const authenticateOwner = (request) => {
  if (!ownerEnabled) return null;
  const token = parseCookies(request)[sessionCookieName];
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', ownerSessionSecret).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.role !== 'system-owner' || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch { return null; }
};

const requireOwner = async (request, reply) => {
  const owner = request.owner || authenticateOwner(request);
  if (!owner) return reply.code(401).send({ error: 'system-owner-authentication-required' });
  if (!safeEqual(String(request.headers['x-csrf-token'] || ''), String(owner.csrf || ''))) {
    return reply.code(403).send({ error: 'csrf-token-invalid' });
  }
  request.owner = owner;
};

const requireOwnerSession = async (request, reply) => {
  const owner = authenticateOwner(request);
  if (!owner) return reply.code(401).send({ error: 'system-owner-authentication-required' });
  request.owner = owner;
};

await registerChatAnalysisRoutes(app, {
  requireOwner, requireOwnerSession,
  audit: (event) => backend.recordAuditEvent(event),
});

const hasWorkerToken = (request) => {
  if (!workerIngestToken) return false;
  const provided = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return safeEqual(provided, workerIngestToken);
};

const publicApiPaths = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
  '/api/v1/metrics/summary',
  '/api/v1/dashboard/summary',
]);
const viewerReadApiPaths = new Set([
  '/api/v1/runtime',
  '/api/v1/runtime/capacity',
  '/api/v1/settings',
  '/api/v1/shops',
  '/api/v1/shops/health',
  '/api/v1/scenarios',
  '/api/v1/rules',
  '/api/v1/dashboard/scenarios',
  '/api/v1/work-orders',
  '/api/v1/logs',
  '/api/v1/manual-interventions',
  '/api/v1/verifications',
  '/api/v1/events',
]);
const workerApiPaths = new Set([
  '/api/v1/worker-events',
  '/api/v1/worker-assets',
  '/api/v1/worker-sync-heartbeat',
]);

app.addHook('onRequest', async (request, reply) => {
  const pathname = String(request.raw.url || '').split('?', 1)[0];
  if (!pathname.startsWith('/api/v1/') || request.method === 'OPTIONS'
    || publicApiPaths.has(pathname) || workerApiPaths.has(pathname)) return;
  if (request.method === 'GET' && (viewerReadApiPaths.has(pathname)
    || /^\/api\/v1\/work-orders\/[^/]+(?:\/events)?$/u.test(pathname)
    || /^\/api\/v1\/verifications\/[0-9a-f-]+\/screenshot$/iu.test(pathname))) return;
  if (request.method === 'GET' && pathname === '/api/v1/shops' && hasWorkerToken(request)) return;
  return requireOwnerSession(request, reply);
});

app.addHook('onSend', async (request, reply, payload) => {
  const pathname = String(request.raw.url || '').split('?', 1)[0];
  if (pathname.startsWith('/api/') || pathname === '/robots.txt') {
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('Pragma', 'no-cache');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    const vary = String(reply.getHeader('Vary') || '');
    if (!vary.toLowerCase().split(',').map((value) => value.trim()).includes('cookie')) {
      reply.header('Vary', [vary, 'Cookie'].filter(Boolean).join(', '));
    }
  }
  return payload;
});

const ownerAuditContext = (request) => ({
  remoteAddress: request.ip || request.raw.socket?.remoteAddress || null,
  userAgent: String(request.headers['user-agent'] || '').slice(0, 512) || null,
});

const validSummaryDate = (value) => /^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''));

const dingtalkDailySummaryStartDate = (now = new Date()) => {
  const clock = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const summaryDate = `${clock.year}-${clock.month}-${clock.day}`;
  const afterCutoff = Number(clock.hour) > 18
    || (Number(clock.hour) === 18 && Number(clock.minute) >= 30);
  if (!afterCutoff) return summaryDate;
  const nextDate = new Date(Date.UTC(Number(clock.year), Number(clock.month) - 1, Number(clock.day) + 1));
  return nextDate.toISOString().slice(0, 10);
};

const recordAuditSafely = async (event) => {
  try {
    const recorded = await backend.recordAuditEvent(event);
    if (recorded) broadcast('audit-event.created', { eventType: recorded.eventType });
    return recorded;
  } catch (error) {
    app.log.error({ error, eventType: event.eventType }, 'audit event write failed');
    return null;
  }
};

const requireWorkerToken = async (request, reply) => {
  if (!workerIngestToken) return reply.code(503).send({ error: 'worker-ingest-token-not-configured' });
  if (!hasWorkerToken(request)) return reply.code(401).send({ error: 'worker-ingest-unauthorized' });
};

const broadcast = (type, payload = {}) => {
  eventSequence += 1;
  const event = { id: String(eventSequence), type, at: new Date().toISOString(), ...payload };
  const text = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of [...sseClients]) {
    try { response.write(text); } catch { sseClients.delete(response); }
  }
};

const csvCell = (value) => {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const purgeVerificationScreenshots = () => backend
  .purgeExpiredVerificationScreenshots({ retentionDays: verificationScreenshotRetentionDays })
  .catch((error) => app.log.error({ error }, 'verification screenshot retention failed'));
const purgeEvidenceScreenshots = () => backend
  .purgeExpiredEvidenceScreenshots({ retentionDays: evidenceScreenshotRetentionDays })
  .catch((error) => app.log.error({ error }, 'PDD/TMS screenshot retention failed'));
const reconcileTimedOutVerificationGates = () => backend
  && Promise.resolve(backend.reconcileTimedOutVerificationGates?.({ limit: 50, timeoutMs: 120_000 }))
  .then((result) => {
    if (result?.expired) app.log.info(result, 'verification timeout gates reconciled');
  })
  .catch((error) => app.log.error({ error }, 'verification timeout reconciliation failed'));
const synchronizedLoginSessions = new Map();
let loginSessionSynchronizationRunning = false;
const synchronizeLocalBrowserLoginSessions = async () => {
  if (loginSessionSynchronizationRunning || !localBrowserLauncher.available) return;
  loginSessionSynchronizationRunning = true;
  try {
    const observations = await localBrowserLauncher.listSessionObservations();
    for (const observation of observations) {
      const observationKey = `${observation.sessionId || '-'}:${observation.revision || 0}`;
      if (synchronizedLoginSessions.get(observation.shopId) === observationKey) continue;
      const result = await backend.synchronizeShopLoginObservation(observation.shopId, observation);
      synchronizedLoginSessions.set(observation.shopId, observationKey);
      if (result?.shop) {
        broadcast('shop.updated', {
          shopId: observation.shopId,
          onboardingStatus: result.status,
          source: 'native-login-browser',
        });
      }
    }
  } catch (error) {
    app.log.error({ error }, 'native login browser session synchronization failed');
  } finally {
    loginSessionSynchronizationRunning = false;
  }
};
const verificationRetentionTimer = setInterval(purgeVerificationScreenshots, 6 * 60 * 60 * 1000);
verificationRetentionTimer.unref();
const evidenceRetentionTimer = setInterval(purgeEvidenceScreenshots, 6 * 60 * 60 * 1000);
evidenceRetentionTimer.unref();
const verificationTimeoutTimer = setInterval(reconcileTimedOutVerificationGates, 30_000);
verificationTimeoutTimer.unref();
const loginSessionSynchronizationTimer = setInterval(synchronizeLocalBrowserLoginSessions, 1_000);
loginSessionSynchronizationTimer.unref();
await Promise.all([purgeVerificationScreenshots(), purgeEvidenceScreenshots()]);
await synchronizeLocalBrowserLoginSessions();
await reconcileTimedOutVerificationGates();

app.addHook('onClose', async () => {
  clearInterval(verificationRetentionTimer);
  clearInterval(evidenceRetentionTimer);
  clearInterval(verificationTimeoutTimer);
  clearInterval(loginSessionSynchronizationTimer);
  await backend.close();
});

app.get('/healthz', async (_request, reply) => {
  try {
    return {
      ok: true,
      service: 'work-order-api',
      now: new Date().toISOString(),
      ownerAuthConfigured: ownerEnabled,
      workerIngestConfigured: Boolean(workerIngestToken),
      runtime: runtimeEnvironment,
      ...await backend.health(),
    };
  } catch (error) {
    return reply.code(503).send({ ok: false, service: 'work-order-api', error: error.message });
  }
});

app.get('/robots.txt', async (_request, reply) => reply
  .type('text/plain; charset=utf-8')
  .send('User-agent: *\nDisallow: /\n'));

const readChromeExtensionPackage = async () => {
  if (!chromeExtensionPackageDir) return null;
  const metadata = JSON.parse(await fsp.readFile(
    path.join(chromeExtensionPackageDir, 'metadata.json'),
    'utf8',
  ));
  if (!/^[a-p]{32}$/.test(String(metadata.extensionId || ''))
    || !/^\d+(?:\.\d+){1,3}$/.test(String(metadata.version || ''))
    || !/^[a-zA-Z0-9._-]+\.crx$/.test(String(metadata.fileName || ''))) {
    throw new Error('Chrome extension package metadata is invalid');
  }
  return metadata;
};

app.get('/internal/chrome-extension/update.xml', async (_request, reply) => {
  try {
    const metadata = await readChromeExtensionPackage();
    if (!metadata) return reply.code(404).send({ error: 'chrome-extension-package-not-configured' });
    const apiPort = Number(process.env.API_PORT || 3000);
    const codebase = `http://127.0.0.1:${apiPort}/internal/chrome-extension/package.crx`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${metadata.extensionId}"><updatecheck codebase="${codebase}" version="${metadata.version}" /></app></gupdate>\n`;
    return reply.header('Cache-Control', 'no-store').type('application/xml').send(xml);
  } catch (error) {
    app.log.error({ error }, 'Chrome extension update manifest failed');
    return reply.code(503).send({ error: 'chrome-extension-package-unavailable' });
  }
});

app.get('/internal/chrome-extension/package.crx', async (_request, reply) => {
  try {
    const metadata = await readChromeExtensionPackage();
    if (!metadata) return reply.code(404).send({ error: 'chrome-extension-package-not-configured' });
    const content = await fsp.readFile(path.join(chromeExtensionPackageDir, metadata.fileName));
    return reply.header('Cache-Control', 'no-store').type('application/x-chrome-extension').send(content);
  } catch (error) {
    app.log.error({ error }, 'Chrome extension package download failed');
    return reply.code(503).send({ error: 'chrome-extension-package-unavailable' });
  }
});

app.get('/api/v1/runtime', async () => ({ data: runtimeEnvironment }));
app.get('/api/v1/runtime/capacity', async () => ({ data: await backend.runtimeCapacity() }));

// Owner-only control for the automation backend.  The public frontend/API stay
// online while these scripts start or stop workers and shop browsers.
const automationControl = createNativeAutomationControl();
app.get('/api/v1/runtime/control', { preHandler: requireOwner }, async () => ({ data: await automationControl.snapshot() }));
app.post('/api/v1/runtime/control', { preHandler: requireOwner }, async (request, reply) => {
  const action = String(request.body?.action || '');
  if (!['start', 'stop'].includes(action)) return reply.code(400).send({ error: 'runtime-control-action-invalid' });
  return { data: await automationControl.run(action) };
});
app.get('/api/v1/settings', async () => ({ data: await backend.getSystemSettings() }));

app.patch('/api/v1/settings/verification-alerts', { preHandler: requireOwner }, async (request, reply) => {
  const enabled = request.body?.enabled;
  if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'verification-alert-setting-invalid' });
  const settings = await backend.updateSystemSettings(
    { verificationAlertsEnabled: enabled },
    { actorId: request.owner.sub },
  );
  broadcast('settings.verification-alerts-updated', { enabled });
  return { data: settings };
});

app.patch('/api/v1/settings/return-refund', { preHandler: requireOwner }, async (request, reply) => {
  const scanEnabled = request.body?.scanEnabled;
  const autoApproveEnabled = request.body?.autoApproveEnabled;
  if (typeof scanEnabled !== 'boolean' && typeof autoApproveEnabled !== 'boolean') {
    return reply.code(400).send({ error: 'return-refund-setting-invalid' });
  }
  const settings = await backend.updateSystemSettings({
    ...(typeof scanEnabled === 'boolean' ? { returnRefundScanEnabled: scanEnabled } : {}),
    ...(typeof autoApproveEnabled === 'boolean'
      ? { returnRefundAutoApproveEnabled: autoApproveEnabled } : {}),
  }, { actorId: request.owner.sub });
  broadcast('settings.return-refund-updated', {
    scanEnabled: settings.returnRefundScanEnabled,
    autoApproveEnabled: settings.returnRefundAutoApproveEnabled,
  });
  return { data: settings };
});

app.patch('/api/v1/settings/dingtalk', { preHandler: requireOwner }, async (request, reply) => {
  const automaticEnabled = request.body?.automaticEnabled;
  if (typeof automaticEnabled !== 'boolean') return reply.code(400).send({ error: 'dingtalk-setting-invalid' });
  const settings = await backend.updateDingTalkSettings(
    { dingtalkAutomaticEnabled: automaticEnabled },
    { actorId: request.owner.sub },
  );
  broadcast('settings.dingtalk-updated', { automaticEnabled });
  return { data: settings };
});

app.patch('/api/v1/settings/dingtalk-daily-summary', { preHandler: requireOwner }, async (request, reply) => {
  const automaticEnabled = request.body?.automaticEnabled;
  if (typeof automaticEnabled !== 'boolean') {
    return reply.code(400).send({ error: 'dingtalk-daily-summary-setting-invalid' });
  }
  const startDate = automaticEnabled ? dingtalkDailySummaryStartDate() : null;
  const settings = await backend.updateDingTalkDailySummarySettings(
    { automaticEnabled, startDate },
    { actorId: request.owner.sub },
  );
  broadcast('settings.dingtalk-daily-summary-updated', { automaticEnabled, startDate });
  return { data: settings };
});

app.post('/api/v1/auth/login', async (request, reply) => {
  if (!ownerEnabled) return reply.code(503).send({ error: 'system-owner-not-configured' });
  const username = String(request.body?.username || '');
  const password = String(request.body?.password || '');
  if (!safeEqual(username, ownerUsername) || !verifyPassword(password, ownerPassword)) {
    await recordAuditSafely({
      actorId: 'anonymous',
      eventType: 'owner-login-failed',
      payload: { ...ownerAuditContext(request), usernameMatched: safeEqual(username, ownerUsername) },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    return reply.code(401).send({ error: 'invalid-credentials' });
  }
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const token = signSession({ sub: ownerUsername, role: 'system-owner', csrf, iat: Date.now(), exp: expiresAt });
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '')
    .split(',', 1)[0].trim().toLowerCase();
  const secure = String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true'
    || forwardedProtocol === 'https' ? '; Secure' : '';
  reply.header('Set-Cookie', `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
  await recordAuditSafely({
    actorId: ownerUsername,
    eventType: 'owner-login-succeeded',
    payload: { ...ownerAuditContext(request), expiresAt: new Date(expiresAt).toISOString() },
  });
  return { data: { username: ownerUsername, role: 'system-owner', csrfToken: csrf, expiresAt: new Date(expiresAt).toISOString() } };
});

app.post('/api/v1/auth/logout', async (request, reply) => {
  const owner = authenticateOwner(request);
  if (owner) {
    await recordAuditSafely({
      actorId: owner.sub,
      eventType: 'owner-logout',
      payload: ownerAuditContext(request),
    });
  }
  reply.header('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  return { data: { loggedOut: true } };
});

app.get('/api/v1/auth/me', async (request) => {
  const owner = authenticateOwner(request);
  return { data: owner
    ? { username: owner.sub, role: owner.role, csrfToken: owner.csrf, expiresAt: new Date(owner.exp).toISOString() }
    : { username: null, role: 'viewer' } };
});

app.get('/api/v1/auth/authorize', { preHandler: requireOwnerSession }, async (request) => ({
  data: { username: request.owner.sub, role: request.owner.role, authorized: true },
}));

app.post('/api/v1/auth/verify', { preHandler: requireOwner }, async (request) => ({
  data: { username: request.owner.sub, role: request.owner.role, valid: true },
}));

app.get('/api/v1/shops', async (request) => ({
  data: await backend.listShops({ includeCredentialStatus: Boolean(authenticateOwner(request)) }),
}));
app.get('/api/v1/shops/health', async (request) => ({
  data: await backend.listShops({ includeCredentialStatus: Boolean(authenticateOwner(request)) }),
}));
app.post('/api/v1/shops', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const shop = await backend.createShop(request.body || {}, { actorId: request.owner.sub });
    broadcast('shop.created', { shopId: shop.shopId });
    return reply.code(201).send({ data: shop });
  } catch (error) {
    if (error.code === 'SHOP_CONFLICT') return reply.code(409).send({ error: error.message });
    if (error.code === 'SHOP_CAPACITY_REACHED') return reply.code(409).send({ error: error.message });
    if (/^(?:shop-name|expected-shop-name|shop-id)-invalid$/.test(error.message)) {
      return reply.code(400).send({ error: error.message });
    }
    if (error.message === 'oms-credentials-incomplete') return reply.code(400).send({ error: error.message });
    if (error.message === 'oms-credentials-storage-unavailable') return reply.code(503).send({ error: error.message });
    if (error.message === 'shop-capacity-reached') return reply.code(409).send({ error: error.message });
    throw error;
  }
});
app.patch('/api/v1/shops/:shopId', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const shop = await backend.updateShop(String(request.params.shopId), request.body || {}, { actorId: request.owner.sub });
    if (!shop) return reply.code(404).send({ error: 'shop-not-found' });
    broadcast('shop.updated', { shopId: shop.shopId });
    return { data: shop };
  } catch (error) {
    if (error.code === 'SHOP_CONFLICT') return reply.code(409).send({ error: error.message });
    if (error.code === 'SHOP_CAPACITY_REACHED') return reply.code(409).send({ error: error.message });
    if (/^(?:shop-name|expected-shop-name)-invalid$/.test(error.message)) {
      return reply.code(400).send({ error: error.message });
    }
    if (error.message === 'oms-credentials-incomplete') return reply.code(400).send({ error: error.message });
    if (error.message === 'oms-credentials-storage-unavailable') return reply.code(503).send({ error: error.message });
    throw error;
  }
});
app.delete('/api/v1/shops/:shopId', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const shop = await backend.deleteShop(String(request.params.shopId), { actorId: request.owner.sub });
    if (!shop) return reply.code(404).send({ error: 'shop-not-found' });
    broadcast('shop.deleted', { shopId: shop.shopId });
    return { data: { ...shop, deleted: true } };
  } catch (error) {
    if (error.code === 'SHOP_HAS_BUSINESS_DATA') {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  }
});
app.post('/api/v1/shops/:shopId/login', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const shop = await backend.requestShopLogin(String(request.params.shopId), { actorId: request.owner.sub });
    if (!shop) return reply.code(404).send({ error: 'shop-not-found' });
    // A dynamic Worker owns the persistent profile. During a login request it
    // briefly reports offline while the supervisor reloads it; launching a
    // second browser in that window locks the same profile and causes the
    // visible browser to restart repeatedly. Let the Worker open or reuse its
    // own window and only use the standalone launcher for legacy deployments.
    const workerManagedLogin = localBrowserLauncher.available
      && runtimeEnvironment.schedulerMode !== 'slots'
      && runtimeEnvironment.dynamicWorkerSupervisor;
    const browserLaunch = workerManagedLogin
      ? {
        mode: 'windows-local',
        status: 'worker-managed',
        shopId: shop.shopId,
        requestId: null,
        workerOnline: Boolean(shop.workerOnline),
        requestedAt: new Date().toISOString(),
      }
      : localBrowserLauncher.available
        && runtimeEnvironment.schedulerMode !== 'slots'
        && !shop.workerOnline
        ? await localBrowserLauncher.launch(shop)
        : null;
    broadcast('shop.login-requested', { shopId: shop.shopId });
    return { data: { ...shop, browserLaunch } };
  } catch (error) {
    if (error.code === 'SHOP_CAPACITY_REACHED') return reply.code(409).send({ error: error.message });
    if (error.code === 'WINDOWS_LOCAL_BROWSER_LAUNCHER_UNAVAILABLE') {
      return reply.code(503).send({ error: error.message });
    }
    if (error.code === 'WINDOWS_LOCAL_BROWSER_LAUNCH_FAILED') {
      return reply.code(502).send({ error: error.message });
    }
    throw error;
  }
});
app.post('/api/v1/shops/:shopId/reset-pdd-login', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const result = await backend.requestShopPddLoginReset(
      String(request.params.shopId),
      { actorId: request.owner.sub },
    );
    if (!result) return reply.code(404).send({ error: 'shop-not-found' });
    broadcast('shop.pdd-login-reset-requested', {
      shopId: result.shop.shopId,
      commandId: result.command.id,
    });
    return { data: { ...result.shop, pddLoginResetCommand: result.command } };
  } catch (error) {
    if (error.code === 'SHOP_WORKER_DISABLED') {
      return reply.code(409).send({ error: error.message });
    }
    if (error.code === 'SHOP_PDD_LOGIN_RESET_NOT_REQUIRED') {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  }
});
app.post('/api/v1/shops/:shopId/system-login', { preHandler: requireOwner }, async (request, reply) => {
  const system = String(request.body?.system || '').trim().toLowerCase();
  if (!['oms', 'tms'].includes(system)) {
    return reply.code(400).send({ error: 'shop-system-login-invalid' });
  }
  try {
    const result = await backend.requestShopSystemLogin(
      String(request.params.shopId),
      system,
      { actorId: request.owner.sub },
    );
    if (!result) return reply.code(404).send({ error: 'shop-not-found' });
    broadcast('shop.system-login-requested', {
      shopId: result.shop.shopId,
      system,
      commandId: result.command.id,
    });
    return { data: { ...result.shop, systemLoginCommand: result.command } };
  } catch (error) {
    if (error.code === 'SHOP_SYSTEM_LOGIN_INVALID') {
      return reply.code(400).send({ error: error.message });
    }
    if (error.code === 'SHOP_WORKER_DISABLED') {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  }
});
app.post('/api/v1/shops/:shopId/browser', { preHandler: requireOwner }, async (request, reply) => {
  const shopId = String(request.params.shopId);
  const shop = (await backend.listShops()).find((item) => item.shopId === shopId);
  if (!shop) return reply.code(404).send({ error: 'shop-not-found' });
  try {
    // An enabled Windows-native shop already has a visible persistent browser
    // owned by its Worker. Starting system Chrome with the same profile locks
    // that profile and leaves the Worker on about:blank.
    const workerManagedBrowser = localBrowserLauncher.available
      && runtimeEnvironment.schedulerMode !== 'slots'
      && runtimeEnvironment.dynamicWorkerSupervisor
      && shop.enabled;
    const launch = runtimeEnvironment.schedulerMode === 'slots'
      ? await backend.requestShopSession(shopId, 'login')
      : workerManagedBrowser || (localBrowserLauncher.available && shop.enabled && shop.workerOnline)
      ? {
        mode: 'windows-local',
        status: 'worker-managed',
        shopId,
        requestId: null,
        workerOnline: Boolean(shop.workerOnline),
        requestedAt: new Date().toISOString(),
      }
      : await localBrowserLauncher.launch(shop);
    await recordAuditSafely({
      shopId,
      actorId: request.owner.sub,
      eventType: 'shop-local-browser-requested',
      payload: { ...ownerAuditContext(request), status: launch.status, requestId: launch.requestId },
    });
    broadcast('shop.local-browser-requested', { shopId, status: launch.status });
    return { data: launch };
  } catch (error) {
    if (error.code === 'WINDOWS_LOCAL_BROWSER_UNAVAILABLE') {
      return reply.code(409).send({ error: error.message });
    }
    if (error.code === 'WINDOWS_LOCAL_BROWSER_LAUNCHER_UNAVAILABLE') {
      return reply.code(503).send({ error: error.message });
    }
    if (error.code === 'WINDOWS_LOCAL_BROWSER_LAUNCH_FAILED') {
      return reply.code(502).send({ error: error.message });
    }
    throw error;
  }
});
app.get('/api/v1/scenarios', async () => ({ data: await backend.listScenarios() }));
app.get('/api/v1/rules', async () => ({ data: { version: 1, source: process.env.DATA_BACKEND || 'legacy-json', warehouseCarrierRules: 'managed-by-rule-service' } }));
const metricsResponseFor = async (request) => {
  const summary = await backend.metricsSummary(request.query || {});
  if (request.owner || authenticateOwner(request)) return summary;
  const sanitizeScenario = (scenario = {}) => {
    const { strictAutoSuccess: _strictAutoSuccess, humanConfirmed: _humanConfirmed, ...viewerScenario } = scenario;
    return viewerScenario;
  };
  return {
    ...summary,
    strictAutoSuccess: undefined,
    humanConfirmed: undefined,
    adminOverrides: undefined,
    reconciliationRequired: undefined,
    byScenario: Array.isArray(summary.byScenario) ? summary.byScenario.map(sanitizeScenario) : [],
  };
};
app.get('/api/v1/metrics/summary', async (request) => ({ data: await metricsResponseFor(request) }));
app.get('/api/v1/dashboard/summary', async (request) => ({ data: await metricsResponseFor(request) }));
app.get('/api/v1/dashboard/scenarios', async (request) => {
  const summary = await backend.metricsSummary(request.query || {});
  if (request.owner || authenticateOwner(request)) return { data: summary.byScenario || [] };
  return { data: (summary.byScenario || []).map((scenario) => {
    const { strictAutoSuccess: _strictAutoSuccess, humanConfirmed: _humanConfirmed, ...viewerScenario } = scenario;
    return viewerScenario;
  }) };
});
app.get('/api/v1/work-orders', async (request) => {
  if (!(request.owner || authenticateOwner(request))
    && ['strictAutoSuccess', 'notStrictSuccessful', 'humanConfirmed'].includes(String(request.query?.metric || ''))) {
    return { data: [], page: 1, pageSize: 50, total: 0 };
  }
  return backend.listWorkOrders(request.query || {}, {
    includeIncompleteAnalysis: true,
  });
});
app.get('/api/v1/logs', async (request) => backend.listLogs(request.query || {}));
app.get('/api/v1/audit-events', async (request, reply) => {
  if (!authenticateOwner(request)) return reply.code(401).send({ error: 'system-owner-authentication-required' });
  return backend.listAuditEvents(request.query || {});
});
app.get('/api/v1/manual-interventions', async (request) => backend.listManualInterventions(request.query || {}));

app.patch('/api/v1/manual-interventions/:id', { preHandler: requireOwner }, async (request, reply) => {
  const status = String(request.body?.status || '');
  if (!['acknowledged', 'resolved', 'cancelled'].includes(status)) {
    return reply.code(400).send({ error: 'intervention-status-invalid' });
  }
  const intervention = await backend.updateInterventionStatus(String(request.params.id), {
    status, actorId: request.owner.sub,
  });
  if (!intervention) return reply.code(404).send({ error: 'intervention-not-found' });
  broadcast('manual-intervention.updated', { interventionId: intervention.id, status });
  return { data: intervention };
});

app.get('/api/v1/work-orders/:id', async (request, reply) => {
  const workOrder = await backend.getWorkOrder(decodeURIComponent(request.params.id));
  if (!workOrder) return reply.code(404).send({ error: 'work-order-not-found' });
  return {
    data: authenticateOwner(request)
      ? { ...workOrder, incompleteAnalysis: analyzeIncompleteWorkflow(workOrder) }
      : workOrder,
  };
});

app.get('/api/v1/work-orders/:id/events', async (request, reply) => {
  const workOrderId = decodeURIComponent(request.params.id);
  if (!await backend.getWorkOrder(workOrderId)) return reply.code(404).send({ error: 'work-order-not-found' });
  return backend.listLogs({
    workOrderId,
    page: request.query?.page,
    pageSize: request.query?.pageSize,
    includePayload: request.query?.includePayload,
  });
});

app.patch('/api/v1/work-orders/:id/classification', { preHandler: requireOwner }, async (request, reply) => {
  const classification = String(request.body?.classification || '');
  const reason = String(request.body?.reason || '').trim();
  if (!['automated', 'manual'].includes(classification)) return reply.code(400).send({ error: 'classification-invalid' });
  if (!reason) return reply.code(400).send({ error: 'reason-required' });
  try {
    const updated = await backend.updateClassification(String(request.params.id), {
      classification,
      reason,
      expectedVersion: request.body?.expectedVersion,
      actorId: request.owner.sub,
    });
    if (!updated) return reply.code(404).send({ error: 'work-order-not-found' });
    broadcast('work-order.classification-updated', { workOrderId: request.params.id });
    return { data: updated };
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') return reply.code(409).send({ error: error.message, currentVersion: error.currentVersion });
    throw error;
  }
});

app.post('/api/v1/work-orders/bulk-classification', { preHandler: requireOwner }, async (request, reply) => {
  const ids = Array.isArray(request.body?.ids) ? request.body.ids.map(String).slice(0, 200) : [];
  const classification = String(request.body?.classification || '');
  const reason = String(request.body?.reason || '').trim();
  if (!ids.length || !['automated', 'manual'].includes(classification) || !reason) {
    return reply.code(400).send({ error: 'ids-classification-and-reason-required' });
  }
  try {
    const result = await backend.bulkUpdateClassification({
      ids,
      classification,
      reason,
      expectedVersions: request.body?.expectedVersions || {},
      actorId: request.owner.sub,
    });
    broadcast('work-order.bulk-classification-updated', { count: result.length });
    return { data: result };
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') return reply.code(409).send({ error: error.message, currentVersion: error.currentVersion });
    throw error;
  }
});

app.post('/api/v1/work-orders/bulk-delete', { preHandler: requireOwner }, async (request, reply) => {
  const ids = [...new Set(Array.isArray(request.body?.ids) ? request.body.ids.map(String).slice(0, 200) : [])];
  const reason = String(request.body?.reason || '').trim().slice(0, 500);
  if (!ids.length || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    return reply.code(400).send({ error: 'work-order-ids-invalid' });
  }
  if (!reason) return reply.code(400).send({ error: 'reason-required' });
  try {
    const deleted = await backend.deleteWorkOrders({ ids, reason, actorId: request.owner.sub });
    broadcast('work-order.deleted', { count: deleted.length, workOrderIds: deleted.map((row) => row.id) });
    return { data: { deleted: deleted.length, workOrders: deleted } };
  } catch (error) {
    if (error.code === 'WORK_ORDER_DELETE_NOT_FOUND') {
      return reply.code(404).send({ error: error.message, missingIds: error.missingIds || [] });
    }
    if (error.code === 'WORK_ORDER_DELETE_BLOCKED') {
      return reply.code(409).send({ error: error.message, blockers: error.blockers || [] });
    }
    throw error;
  }
});

app.post('/api/v1/work-orders/:id/classification/rollback', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const result = await backend.rollbackClassification(String(request.params.id), String(request.body?.historyId || ''), {
      reason: String(request.body?.reason || '').trim(),
      expectedVersion: request.body?.expectedVersion,
      actorId: request.owner.sub,
    });
    if (!result) return reply.code(404).send({ error: 'classification-history-not-found' });
    broadcast('work-order.classification-rolled-back', { workOrderId: request.params.id });
    return { data: result };
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') return reply.code(409).send({ error: error.message, currentVersion: error.currentVersion });
    throw error;
  }
});

app.post('/api/v1/work-orders/:id/corrections', { preHandler: requireOwner }, async (request, reply) => {
  const reason = String(request.body?.reason || '').trim();
  if (!reason) return reply.code(400).send({ error: 'reason-required' });
  try {
    const result = await backend.createCorrection(String(request.params.id), {
      patch: request.body?.patch || {},
      reason,
      expectedVersion: request.body?.expectedVersion,
      actorId: request.owner.sub,
    });
    if (!result) return reply.code(404).send({ error: 'work-order-not-found' });
    broadcast('work-order.data-corrected', { workOrderId: request.params.id });
    return { data: result };
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') return reply.code(409).send({ error: error.message, currentVersion: error.currentVersion });
    throw error;
  }
});

app.post('/api/v1/work-orders/:id/actions', { preHandler: requireOwner }, async (request, reply) => {
  const commandType = String(request.body?.commandType || '');
  const allowed = ['resume-auto', 'retry-stage', 'verification-recheck', 'force-clear-verification', 'skip-order', 'refresh-next-order', 'pause-shop', 'resume-shop'];
  if (!allowed.includes(commandType)) return reply.code(400).send({ error: 'operator-command-invalid' });
  try {
    const command = await backend.createOperatorCommand(String(request.params.id), {
      commandType,
      payload: { reason: String(request.body?.reason || '').trim(), ...(request.body?.payload || {}) },
      actorId: request.owner.sub,
    });
    if (!command) return reply.code(404).send({ error: 'work-order-not-found' });
    broadcast('operator-command.created', { workOrderId: request.params.id, commandId: command.id, commandType });
    return { data: command };
  } catch (error) {
    if (error.code === 'WORK_ORDER_BLOCKED') {
      return reply.code(409).send({
        error: error.message,
        blockers: error.blockers || [],
        recoveryVersion: error.recoveryVersion,
      });
    }
    throw error;
  }
});

app.post('/api/v1/work-orders/:id/external-state-review', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const result = await backend.reviewExternalState(String(request.params.id), {
      decision: String(request.body?.decision || ''),
      observationMethod: String(request.body?.observationMethod || '').trim(),
      reason: String(request.body?.reason || '').trim(),
      evidence: request.body?.evidence && typeof request.body.evidence === 'object' ? request.body.evidence : {},
      expectedRecoveryVersion: request.body?.expectedRecoveryVersion,
      actorId: request.owner.sub,
    });
    if (!result) return reply.code(404).send({ error: 'work-order-not-found' });
    broadcast('work-order.external-state-reviewed', { workOrderId: request.params.id, decision: request.body?.decision });
    return { data: result };
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') {
      return reply.code(409).send({ error: error.message, currentVersion: error.currentVersion });
    }
    if (/^external-state-(?:decision-invalid|review-evidence-required)$/.test(error.message)) {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  }
});

app.post('/api/v1/worker-events', { preHandler: requireWorkerToken }, async (request, reply) => {
  const events = Array.isArray(request.body?.events) ? request.body.events : [];
  if (!events.length) return reply.code(400).send({ error: 'events-required' });
  try {
    const result = await backend.ingestWorkerEvents(events, { sourceId: String(request.body?.sourceId || 'windows-native') });
    broadcast('worker-events.ingested', {
      accepted: result.accepted.length,
      duplicates: result.duplicates.length,
      rejected: result.rejected?.length || 0,
    });
    return { data: result };
  } catch (error) {
    if (error.code === 'UNKNOWN_SHOP') {
      return reply.code(422).send({ error: 'unknown-shop', shopIds: error.shopIds || [] });
    }
    if (['ORDINARY_INSTANCE_INVALID', 'ORDINARY_INSTANCE_MISMATCH'].includes(error.code)) {
      return reply.code(409).send({
        error: error.message,
        code: error.code,
        eventKey: error.eventKey || null,
        workOrderId: error.workOrderId || null,
      });
    }
    throw error;
  }
});

app.post('/api/v1/worker-assets', { preHandler: requireWorkerToken }, async (request, reply) => {
  try {
    const asset = await backend.ingestWorkerAsset(request.body || {});
    broadcast('worker-asset.ingested', { assetId: asset.id, shopId: request.body?.shopId });
    return { data: asset };
  } catch (error) {
    if (/worker-asset-(?:invalid|hash-mismatch|mime-invalid|ordinary-instance-mismatch)/.test(error.message)) {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  }
});

app.post('/api/v1/worker-sync-heartbeat', { preHandler: requireWorkerToken }, async (request, reply) => {
  try {
    return {
      data: await backend.recordSyncHeartbeat({
        sourceId: String(request.body?.sourceId || 'windows-native'),
        shopIds: Array.isArray(request.body?.shopIds) ? request.body.shopIds : [],
        backlogCount: Number(request.body?.backlogCount || 0),
      }),
    };
  } catch (error) {
    if (error.code === 'UNKNOWN_SHOP') {
      return reply.code(422).send({ error: 'unknown-shop', shopIds: error.shopIds || [] });
    }
    throw error;
  }
});

app.get('/api/v1/evidence/:id/content', async (request, reply) => {
  const asset = await backend.getEvidenceAsset(String(request.params.id));
  if (!asset) return reply.code(404).send({ error: 'evidence-not-found' });
  return reply.type(asset.contentType || 'application/octet-stream').send(asset.body);
});

app.delete('/api/v1/evidence/:id', { preHandler: requireOwner }, async (request, reply) => {
  const id = String(request.params.id || '');
  const reason = String(request.body?.reason || '').trim().slice(0, 500);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return reply.code(400).send({ error: 'evidence-id-invalid' });
  }
  if (!reason) return reply.code(400).send({ error: 'reason-required' });
  const deleted = await backend.deleteEvidenceAsset(id, { actorId: request.owner.sub, reason });
  if (!deleted) return reply.code(404).send({ error: 'evidence-not-found-or-not-deletable' });
  broadcast('evidence.screenshot-deleted', { evidenceId: id, workOrderId: deleted.workOrderId, kind: deleted.kind });
  return { data: deleted };
});

app.get('/api/v1/verifications', async (request) => ({
  data: await backend.listVerifications({ activeOnly: ['1', 'true'].includes(String(request.query?.active || '').toLowerCase()) }),
}));

app.post('/api/v1/work-orders/:id/dingtalk', { preHandler: requireOwner }, async (request, reply) => {
  const reason = String(request.body?.reason || '').trim();
  if (reason.length > 500) return reply.code(400).send({ error: 'dingtalk-reason-too-long' });
  const controlledMessage = normalizeOwnerDingTalkMessage(request.body?.message);
  if (controlledMessage.error) return reply.code(400).send({ error: controlledMessage.error });
  const notification = await backend.createDingTalkNotification(String(request.params.id), {
    actorId: request.owner.sub,
    reason,
    message: controlledMessage.value,
  });
  if (!notification) return reply.code(404).send({ error: 'work-order-not-found' });
  broadcast('work-order.dingtalk-queued', {
    workOrderId: request.params.id,
    outboxId: notification.outboxId,
  });
  return reply.code(notification.alreadyQueued ? 200 : 202).send({ data: notification });
});
app.get('/api/v1/dingtalk/daily-summary', { preHandler: requireOwner }, async (request, reply) => {
  const summaryDate = request.query?.date == null ? null : String(request.query.date);
  if (summaryDate && !validSummaryDate(summaryDate)) {
    return reply.code(400).send({ error: 'daily-summary-date-invalid' });
  }
  reply.header('Cache-Control', 'no-store');
  return { data: await backend.getDingTalkDailySummary(summaryDate) };
});
app.patch('/api/v1/dingtalk/daily-summary/:date', { preHandler: requireOwner }, async (request, reply) => {
  const summaryDate = String(request.params.date || '');
  if (!validSummaryDate(summaryDate)) return reply.code(400).send({ error: 'daily-summary-date-invalid' });
  const message = normalizeDailySummaryMessage(request.body?.messageText);
  if (message.error) return reply.code(400).send({ error: message.error });
  try {
    const summary = await backend.updateDingTalkDailySummary(summaryDate, {
      actorId: request.owner.sub,
      messageText: message.value,
    });
    if (!summary) return reply.code(404).send({ error: 'daily-summary-not-found' });
    broadcast('dingtalk.daily-summary-updated', { summaryDate });
    return { data: summary };
  } catch (error) {
    if (error.code === 'DAILY_SUMMARY_IMMUTABLE') {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  }
});
app.post('/api/v1/dingtalk/daily-summary/:date/send', { preHandler: requireOwner }, async (request, reply) => {
  const summaryDate = String(request.params.date || '');
  if (!validSummaryDate(summaryDate)) return reply.code(400).send({ error: 'daily-summary-date-invalid' });
  const message = normalizeDailySummaryMessage(request.body?.messageText);
  if (message.error) return reply.code(400).send({ error: message.error });
  let claimed;
  try {
    claimed = await backend.claimDingTalkDailySummary(summaryDate, {
      actorId: request.owner.sub,
      messageText: message.value,
    });
  } catch (error) {
    if (['DAILY_SUMMARY_ALREADY_SENT', 'DAILY_SUMMARY_SEND_IN_PROGRESS'].includes(error.code)) {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  }
  if (!claimed) return reply.code(404).send({ error: 'daily-summary-not-found' });
  try {
    const delivery = await deliverDailySummaryToDingTalk({
      webhook: dingtalkWebhook,
      signingSecret: dingtalkSigningSecret,
      messageText: claimed.messageText,
      summaryDate: claimed.summaryDate,
    });
    const summary = await backend.finishDingTalkDailySummary(summaryDate, {
      actorId: request.owner.sub,
      succeeded: true,
      ...delivery,
    });
    broadcast('dingtalk.daily-summary-sent', { summaryDate });
    return { data: summary };
  } catch (error) {
    const deliveryError = { name: error.name, message: error.message };
    await backend.finishDingTalkDailySummary(summaryDate, {
      actorId: request.owner.sub,
      succeeded: false,
      responseStatus: error.responseStatus || null,
      responsePayload: error.responsePayload || null,
      deliveryError,
    });
    app.log.error({ error, summaryDate }, 'DingTalk daily summary delivery failed');
    broadcast('dingtalk.daily-summary-failed', { summaryDate });
    return reply.code(error.message === 'dingtalk-summary-not-configured' ? 503 : 502)
      .send({ error: error.message });
  }
});
app.get('/api/v1/verifications/:id/screenshot', async (request, reply) => {
  const screenshot = await backend.getVerificationScreenshot(String(request.params.id));
  if (!screenshot) return reply.code(404).send({ error: 'verification-screenshot-not-found' });
  return reply.type(screenshot.contentType || 'image/png').send(screenshot.body);
});
app.post('/api/v1/verifications/:id/recheck', { preHandler: requireOwner }, async (request, reply) => {
  const command = await backend.requestVerificationRecheck(String(request.params.id), { actorId: request.owner.sub });
  if (!command) return reply.code(404).send({ error: 'verification-not-found' });
  broadcast('verification.recheck-requested', { verificationId: request.params.id, commandId: command.id });
  return { data: command };
});
app.post('/api/v1/verifications/:id/force-clear', { preHandler: requireOwner }, async (request, reply) => {
  try {
    const command = await backend.requestVerificationForceClear(String(request.params.id), {
      actorId: request.owner.sub,
      reason: String(request.body?.reason || '').trim(),
    });
    if (!command) return reply.code(404).send({ error: 'verification-not-found' });
    broadcast('verification.force-clear-requested', { verificationId: request.params.id, commandId: command.id });
    return { data: command };
  } catch (error) {
    if (error.code === 'WORK_ORDER_BLOCKED') {
      return reply.code(409).send({ error: error.message, blockers: error.blockers || [] });
    }
    throw error;
  }
});
app.post('/api/v1/verifications/:id/refresh-next', { preHandler: requireOwner }, async (request, reply) => {
  const command = await backend.requestVerificationRefreshNext(String(request.params.id), {
    actorId: request.owner.sub,
    reason: String(request.body?.reason || '').trim(),
  });
  if (!command) return reply.code(404).send({ error: 'verification-not-found' });
  broadcast('verification.refresh-next-requested', { verificationId: request.params.id, commandId: command.id });
  return { data: command };
});
app.delete('/api/v1/verifications/:id/screenshot', { preHandler: requireOwner }, async (request, reply) => {
  const reason = String(request.body?.reason || '').trim();
  if (!reason) return reply.code(400).send({ error: 'reason-required' });
  const result = await backend.deleteVerificationScreenshot(String(request.params.id), {
    actorId: request.owner.sub, reason,
  });
  if (!result) return reply.code(404).send({ error: 'verification-not-found' });
  broadcast('verification.screenshot-deleted', { verificationId: request.params.id });
  return { data: result };
});

app.post('/api/v1/verifications/screenshots/bulk-delete', { preHandler: requireOwner }, async (request, reply) => {
  const ids = [...new Set(Array.isArray(request.body?.ids) ? request.body.ids.map(String).slice(0, 500) : [])];
  const reason = String(request.body?.reason || '').trim().slice(0, 500);
  if (!ids.length || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    return reply.code(400).send({ error: 'verification-ids-invalid' });
  }
  if (!reason) return reply.code(400).send({ error: 'reason-required' });
  const results = await backend.deleteVerificationScreenshots(ids, {
    actorId: request.owner.sub,
    reason,
  });
  const deleted = results.filter((item) => item.screenshotDeleted).length;
  broadcast('verification.screenshots-deleted', {
    verificationIds: results.map((item) => item.id),
    deleted,
  });
  return { data: { processed: results.length, deleted, verifications: results } };
});

app.get('/api/v1/exports/work-orders.csv', async (request, reply) => {
  const rows = [];
  let page = 1;
  while (page <= 50) {
    const result = await backend.listWorkOrders(
      { ...(request.query || {}), page, pageSize: 200 },
      { includeIncompleteAnalysis: true },
    );
    rows.push(...result.data);
    if (rows.length >= result.total || !result.data.length) break;
    page += 1;
  }
  const scenarioNames = {
    'in-transit-refund': '在途无理由退款',
    'shipped-no-tracking-refund': '已发货无轨迹退款',
    'abnormal-network-warning': '异常网点预警',
    'return-refund': '退货退款',
    'delivery-risk-concern': '消费者担忧货物无法送达',
    'proactive-logistics-service': '物流异常主动服务',
    'reverse-logistics-signed-refund': '逆向物流已签收退款',
    'intercept-recall': '消费者申请退款后提示拦截',
    'good-deed-expedited-shipping': '好人好事服务单-加急发货',
    'delivered-not-received': '消费者反馈未收到货',
    'consumer-refusal': '消费者拒收问题处理',
  };
  const statusNames = {
    completed: '已完成', archived: '已完成', processing: '处理中', queued: '待处理', waiting: '等待中',
    verification: '等待验证', 'manual-review': '人工复核', failed: '已中断', paused: '已暂停',
  };
  const headers = ['更新时间', '店铺 / 订单', '业务场景', '平台工单实例', '物流', '仓库', '运行状态', '处理分类', '当前阶段'];
  const exportRows = rows.map((row) => [
    row.updatedAt,
    `${row.shopName || row.shopId || '-'}\n${row.orderNumber || '-'}`,
    `${scenarioNames[row.scenarioCode] || row.scenarioCode || '-'}\n${row.workOrderType || '-'}`,
    row.scenarioCode === 'return-refund'
      ? `${row.aftersaleCount || 0} 次售后`
      : `${row.currentPlatformCaseId || '身份未确认'}\n共 ${row.ordinaryInstanceCount || 0} 次平台工单`,
    `${row.carrier || '-'}\n${row.trackingNumber || '暂无运单'}`,
    row.warehouse || '-',
    statusNames[row.runtimeStatus] || row.runtimeStatus || '-',
    row.handlingClassification === 'manual' ? '转人工' : '自动化',
    row.currentStep || '-',
  ]);
  const csv = `\uFEFF${headers.map(csvCell).join(',')}\r\n${exportRows
    .map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  return reply.header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', 'attachment; filename="work-orders.csv"').send(csv);
});

app.get('/api/v1/events', async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-store, no-transform',
    Connection: 'keep-alive',
    ...(request.headers.origin && ownerAllowedOrigins.has(request.headers.origin)
      ? { 'Access-Control-Allow-Origin': request.headers.origin }
      : {}),
    'Access-Control-Allow-Credentials': 'true',
    'X-Accel-Buffering': 'no',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    Vary: 'Cookie, Origin',
  });
  sseClients.add(reply.raw);
  eventSequence += 1;
  reply.raw.write(`id: ${eventSequence}\nevent: connected\ndata: ${JSON.stringify({ type: 'connected', id: String(eventSequence), at: new Date().toISOString() })}\n\n`);
  const heartbeat = setInterval(() => {
    try { reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`); } catch { clearInterval(heartbeat); }
  }, 15000);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(reply.raw);
  });
});

const port = Number(process.env.API_PORT || 3000);
if (process.argv[1] === fileURLToPath(import.meta.url)) await app.listen({ port, host: process.env.API_HOST || '127.0.0.1' });
export { app };
