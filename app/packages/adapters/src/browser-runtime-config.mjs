import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { retryTransientBrowserOperation } from './browser-transient-operation.mjs';

export const browserViewport = Object.freeze({ width: 1920, height: 1080 });
export const browserDeviceScaleFactor = 1;

const readSecret = (env, name) => {
  const file = String(env[`${name}_FILE`] || '').trim();
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return String(env[name] || '').trim();
};

const parseExpiry = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const epoch = /^\d{10}$/.test(raw)
    ? Number(raw) * 1000
    : /^\d{13}$/.test(raw)
      ? Number(raw)
      : Date.parse(raw);
  if (!Number.isFinite(epoch)) {
    throw new Error('WORKFLOW_BROWSER_PROXY_EXPIRES_AT must be an ISO timestamp or Unix timestamp');
  }
  return new Date(epoch);
};

const mergeProxyBypass = (...sources) => {
  const entries = sources.flatMap((source) => (
    Array.isArray(source) ? source : String(source || '').split(/[;,]/u)
  ));
  const seen = new Set();
  return entries.map((entry) => String(entry || '').trim()).filter((entry) => {
    if (!entry) return false;
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(',');
};

export const resolveBrowserProxyConfig = ({
  env = process.env,
  now = Date.now(),
  directHosts = [],
} = {}) => {
  // Explicit direct mode must also bypass the operating system proxy.
  // Omitting Playwright's proxy option alone inherits Windows proxy settings.
  if (String(env.WORKFLOW_BROWSER_PROXY_FORCE_DIRECT || 'false').trim().toLowerCase() === 'true') {
    return {
      launch: null,
      args: ['--no-proxy-server'],
      runtime: { enabled: false, required: false, mode: 'direct' },
    };
  }
  const required = String(env.WORKFLOW_BROWSER_PROXY_REQUIRED || 'false').trim().toLowerCase() === 'true';
  const server = String(env.WORKFLOW_BROWSER_PROXY_SERVER || '').trim();
  const bypass = mergeProxyBypass(env.WORKFLOW_BROWSER_PROXY_BYPASS, directHosts);
  const username = readSecret(env, 'WORKFLOW_BROWSER_PROXY_USERNAME');
  const password = readSecret(env, 'WORKFLOW_BROWSER_PROXY_PASSWORD');
  const expiresAt = parseExpiry(env.WORKFLOW_BROWSER_PROXY_EXPIRES_AT);

  if (required && !server) {
    throw new Error('WORKFLOW_BROWSER_PROXY_REQUIRED=true requires WORKFLOW_BROWSER_PROXY_SERVER');
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('WORKFLOW_BROWSER_PROXY_USERNAME and WORKFLOW_BROWSER_PROXY_PASSWORD must be configured together');
  }
  if (!server) {
    if (username || password || expiresAt) {
      throw new Error('Proxy credentials and expiry require WORKFLOW_BROWSER_PROXY_SERVER');
    }
    return { launch: null, runtime: { enabled: false, required } };
  }

  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    throw new Error('WORKFLOW_BROWSER_PROXY_SERVER must be an absolute proxy URL');
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error('WORKFLOW_BROWSER_PROXY_SERVER uses an unsupported protocol');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Proxy credentials must use WORKFLOW_BROWSER_PROXY_USERNAME or its _FILE variant');
  }
  if (expiresAt && expiresAt.getTime() <= now) {
    throw new Error(`Configured browser proxy expired at ${expiresAt.toISOString()}`);
  }

  const runtime = {
    enabled: true,
    required,
    server,
    bypass: bypass || null,
    authenticated: Boolean(username),
    expiresAt: expiresAt?.toISOString() || null,
  };
  proxyRuntimeSecrets.set(runtime, { username, password });
  return {
    launch: {
      server,
      ...(bypass ? { bypass } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    },
    runtime,
  };
};

const proxyDefaultPorts = Object.freeze({
  'http:': 80,
  'https:': 443,
  'socks4:': 1080,
  'socks5:': 1080,
});

const proxyRuntimeSecrets = new WeakMap();
const proxyProbeTarget = Object.freeze({ host: 'mms.pinduoduo.com', port: 443 });

const proxyConnectErrorCode = (statusCode) => {
  if (statusCode === 407) return 'PROXY_AUTH_REQUIRED';
  if ([502, 503, 504].includes(statusCode)) return 'PROXY_UPSTREAM_UNAVAILABLE';
  if (statusCode === 403) return 'PROXY_CONNECT_FORBIDDEN';
  if (statusCode === 429) return 'PROXY_RATE_LIMITED';
  return `PROXY_CONNECT_HTTP_${statusCode}`;
};

const dialHttpProxyTunnel = ({
  host,
  port,
  protocol,
  timeoutMs,
  targetHost,
  targetPort,
  username,
  password,
}) => new Promise((resolve, reject) => {
  const connectOptions = {
    host,
    port,
    ...(protocol === 'https:' && net.isIP(host) === 0 ? { servername: host } : {}),
  };
  const socket = protocol === 'https:'
    ? tls.connect(connectOptions)
    : net.createConnection(connectOptions);
  let settled = false;
  let deadlineTimer = null;
  let response = Buffer.alloc(0);
  const finish = (error = null) => {
    if (settled) return;
    settled = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    socket.destroy();
    if (error) reject(error);
    else resolve();
  };
  const fail = (message, code) => {
    const error = new Error(message);
    error.code = code;
    finish(error);
  };
  socket.setTimeout(timeoutMs, () => {
    fail('Browser proxy CONNECT probe timed out', 'ETIMEDOUT');
  });
  // DNS/TLS/connect phases can occasionally fail to emit a socket timeout.
  // Keep the preflight bounded independently so a stuck probe cannot block the Worker forever.
  deadlineTimer = setTimeout(() => {
    fail('Browser proxy CONNECT probe timed out', 'ETIMEDOUT');
  }, Math.max(1, Number(timeoutMs) || 5_000));
  socket.once('error', (error) => finish(error));
  socket.once('end', () => {
    if (!settled) fail('Browser proxy closed the CONNECT probe early', 'PROXY_CONNECT_CLOSED');
  });
  socket.on('data', (chunk) => {
    if (settled) return;
    response = Buffer.concat([response, chunk]);
    if (response.length > 32 * 1024) {
      fail('Browser proxy CONNECT response headers were too large', 'PROXY_CONNECT_HEADER_TOO_LARGE');
      return;
    }
    const headerEnd = response.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const statusLine = response.subarray(0, headerEnd).toString('latin1').split('\r\n', 1)[0];
    const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/u);
    if (!match) {
      fail('Browser proxy returned an invalid CONNECT response', 'PROXY_CONNECT_INVALID_RESPONSE');
      return;
    }
    const statusCode = Number(match[1]);
    if (statusCode >= 200 && statusCode < 300) finish();
    else fail(`Browser proxy CONNECT probe returned HTTP ${statusCode}`, proxyConnectErrorCode(statusCode));
  });
  const sendConnect = () => {
    const authority = `${targetHost}:${targetPort}`;
    const authorization = username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}\r\n`
      : '';
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: close\r\n${authorization}\r\n`,
    );
  };
  socket.once(protocol === 'https:' ? 'secureConnect' : 'connect', sendConnect);
});

const dialTcpEndpoint = ({ host, port, timeoutMs }) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host, port });
  let settled = false;
  let deadlineTimer = null;
  const finish = (error = null) => {
    if (settled) return;
    settled = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    socket.destroy();
    if (error) reject(error);
    else resolve();
  };
  socket.setTimeout(timeoutMs, () => {
    const error = new Error('Browser proxy connection timed out');
    error.code = 'ETIMEDOUT';
    finish(error);
  });
  // Keep TCP preflight bounded even when DNS/connect does not emit a socket timeout.
  deadlineTimer = setTimeout(() => {
    const error = new Error('Browser proxy connection timed out');
    error.code = 'ETIMEDOUT';
    finish(error);
  }, Math.max(1, Number(timeoutMs) || 5_000));
  socket.once('connect', () => finish());
  socket.once('error', (error) => finish(error));
});

export const probeBrowserProxyConnectivity = async ({
  runtime,
  timeoutMs = 5_000,
  dial = null,
  now = Date.now,
} = {}) => {
  const checkedAtMs = now();
  if (!runtime?.enabled) {
    return {
      ok: true,
      enabled: false,
      required: Boolean(runtime?.required),
      checkedAt: new Date(checkedAtMs).toISOString(),
    };
  }

  const endpoint = new URL(runtime.server);
  const port = Number(endpoint.port) || proxyDefaultPorts[endpoint.protocol];
  if (!port) throw new Error('Browser proxy endpoint has no usable port');
  const normalizedTimeoutMs = Math.max(500, Number(timeoutMs) || 5_000);
  const validationMode = dial
    ? 'custom'
    : ['http:', 'https:'].includes(endpoint.protocol) ? 'https-connect' : 'tcp-endpoint';
  try {
    if (dial) {
      await dial({ host: endpoint.hostname, port, timeoutMs: normalizedTimeoutMs });
    } else if (validationMode === 'https-connect') {
      const credentials = proxyRuntimeSecrets.get(runtime) || {};
      await dialHttpProxyTunnel({
        host: endpoint.hostname,
        port,
        protocol: endpoint.protocol,
        timeoutMs: normalizedTimeoutMs,
        targetHost: proxyProbeTarget.host,
        targetPort: proxyProbeTarget.port,
        username: credentials.username || '',
        password: credentials.password || '',
      });
    } else {
      await dialTcpEndpoint({
        host: endpoint.hostname,
        port,
        timeoutMs: normalizedTimeoutMs,
      });
    }
    return {
      ok: true,
      enabled: true,
      required: Boolean(runtime.required),
      protocol: endpoint.protocol.slice(0, -1),
      host: endpoint.hostname,
      port,
      authenticated: Boolean(runtime.authenticated),
      expiresAt: runtime.expiresAt || null,
      validationMode,
      latencyMs: Math.max(0, now() - checkedAtMs),
      checkedAt: new Date(checkedAtMs).toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      required: Boolean(runtime.required),
      protocol: endpoint.protocol.slice(0, -1),
      host: endpoint.hostname,
      port,
      authenticated: Boolean(runtime.authenticated),
      expiresAt: runtime.expiresAt || null,
      validationMode,
      errorCode: String(error?.code || error?.name || 'PROXY_CONNECT_FAILED'),
      checkedAt: new Date(checkedAtMs).toISOString(),
    };
  }
};

export const detectBrowserProxyNavigationFailure = (error) => {
  const message = String(error?.message || error || '');
  const match = message.match(
    /net::(ERR_(?:HTTP_RESPONSE_CODE_FAILURE|PROXY_[A-Z0-9_]+|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|NO_SUPPORTED_PROXIES))/iu,
  );
  if (!match) return null;
  return { errorCode: match[1].toUpperCase() };
};

export const advanceBrowserProxyNavigationFailureCircuit = ({
  state = null,
  error = null,
  proxyEnabled = false,
  now = Date.now(),
  failureWindowMs = 2 * 60_000,
  failureLimit = 3,
  cooldownMs = 2 * 60_000,
  maxCooldownMs = 10 * 60_000,
} = {}) => {
  const failure = proxyEnabled ? detectBrowserProxyNavigationFailure(error) : null;
  if (!failure) return { matched: false, opened: false, failure: null, state };

  const observedAtMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedWindowMs = Math.max(30_000, Number(failureWindowMs) || 2 * 60_000);
  const normalizedFailureLimit = Math.max(2, Number(failureLimit) || 3);
  const normalizedCooldownMs = Math.max(30_000, Number(cooldownMs) || 2 * 60_000);
  const normalizedMaxCooldownMs = Math.max(
    normalizedCooldownMs,
    Number(maxCooldownMs) || 10 * 60_000,
  );
  const previousOpenUntilMs = Date.parse(String(state?.openUntil || ''));
  const previousOpenCount = Math.max(
    0,
    Number(state?.openCount) || (Number.isFinite(previousOpenUntilMs) ? 1 : 0),
  );
  const recoveryProbeFailure = Number.isFinite(previousOpenUntilMs)
    && previousOpenUntilMs <= observedAtMs
    && previousOpenCount > 0;
  const previousWindowStartedAtMs = Date.parse(String(state?.windowStartedAt || ''));
  const sameWindow = !recoveryProbeFailure
    && Number.isFinite(previousWindowStartedAtMs)
    && observedAtMs - previousWindowStartedAtMs <= normalizedWindowMs;
  const count = recoveryProbeFailure
    ? normalizedFailureLimit
    : sameWindow ? Math.max(0, Number(state?.count) || 0) + 1 : 1;
  const windowStartedAtMs = sameWindow ? previousWindowStartedAtMs : observedAtMs;
  const opened = count >= normalizedFailureLimit;
  const newOpening = opened
    && (!Number.isFinite(previousOpenUntilMs) || previousOpenUntilMs <= observedAtMs);
  const openCount = newOpening ? previousOpenCount + 1 : previousOpenCount;
  const effectiveCooldownMs = opened
    ? Math.min(
      normalizedMaxCooldownMs,
      normalizedCooldownMs * (2 ** Math.min(20, Math.max(0, openCount - 1))),
    )
    : normalizedCooldownMs;
  const openUntilMs = opened
    ? Math.max(
      Number.isFinite(previousOpenUntilMs) ? previousOpenUntilMs : 0,
      observedAtMs + effectiveCooldownMs,
    )
    : null;
  return {
    matched: true,
    opened,
    failure,
    state: {
      count,
      failureLimit: normalizedFailureLimit,
      windowMs: normalizedWindowMs,
      baseCooldownMs: normalizedCooldownMs,
      cooldownMs: effectiveCooldownMs,
      maxCooldownMs: normalizedMaxCooldownMs,
      openCount,
      recoveryProbeFailure,
      windowStartedAt: new Date(windowStartedAtMs).toISOString(),
      lastFailureAt: new Date(observedAtMs).toISOString(),
      lastErrorCode: failure.errorCode,
      openUntil: Number.isFinite(openUntilMs) ? new Date(openUntilMs).toISOString() : null,
    },
  };
};

export const inspectBrowserScale = async (page, retryOptions = {}) => retryTransientBrowserOperation(
  () => page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    visualViewportScale: window.visualViewport?.scale ?? 1,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  })),
  { maxAttempts: 12, initialDelayMs: 250, ...retryOptions },
);

export const browserScaleIsExpected = (scale) => Boolean(
  scale
  && Math.abs(Number(scale.devicePixelRatio) - browserDeviceScaleFactor) < 0.001
  && Math.abs(Number(scale.visualViewportScale) - 1) < 0.001
  && Number(scale.innerWidth) === browserViewport.width
  && Number(scale.innerHeight) === browserViewport.height
);
