import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  probeBrowserProxyConnectivity,
  resolveBrowserProxyConfig,
} from '../packages/adapters/src/browser-runtime-config.mjs';

const publicProxyReport = (health) => ({
  ok: Boolean(health?.ok),
  enabled: Boolean(health?.enabled),
  required: Boolean(health?.required),
  ...(health?.protocol ? { protocol: health.protocol } : {}),
  ...(health?.port ? { port: health.port } : {}),
  ...(health?.authenticated != null ? { authenticated: Boolean(health.authenticated) } : {}),
  ...(health?.expiresAt ? { expiresAt: health.expiresAt } : {}),
  ...(health?.validationMode ? { validationMode: health.validationMode } : {}),
  ...(health?.latencyMs != null ? { latencyMs: health.latencyMs } : {}),
  ...(health?.checkedAt ? { checkedAt: health.checkedAt } : {}),
  ...(health?.errorCode ? { errorCode: health.errorCode } : {}),
});

export const parseBrowserProxyEnvironment = (contents, { baseDir = process.cwd() } = {}) => {
  const parsed = {};
  for (const rawLine of String(contents || '').split(/\r?\n/u)) {
    const match = rawLine.match(/^\s*(WORKFLOW_BROWSER_PROXY_[A-Z0-9_]+)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    if (match[1].endsWith('_FILE') && value && !path.isAbsolute(value)) {
      value = path.resolve(baseDir, value);
    }
    parsed[match[1]] = value;
  }
  return parsed;
};

export const readBrowserProxyEnvironmentFile = (filePath) => {
  const resolvedPath = path.resolve(String(filePath || ''));
  return parseBrowserProxyEnvironment(fs.readFileSync(resolvedPath, 'utf8'), {
    baseDir: path.dirname(resolvedPath),
  });
};

export const inspectBrowserProxyConfiguration = ({
  env = process.env,
  now = Date.now(),
} = {}) => {
  const nowValue = typeof now === 'function' ? now() : Number(now);
  const { runtime } = resolveBrowserProxyConfig({ env, now: nowValue });
  return publicProxyReport({
    ...runtime,
    ok: true,
    validationMode: 'configuration-only',
    checkedAt: new Date(nowValue).toISOString(),
  });
};

export const inspectWorkerBrowserProxy = async ({
  env = process.env,
  timeoutMs = 5_000,
  dial,
  now = Date.now,
} = {}) => {
  const nowFunction = typeof now === 'function' ? now : () => Number(now);
  const { runtime } = resolveBrowserProxyConfig({ env, now: nowFunction() });
  const health = await probeBrowserProxyConnectivity({
    runtime,
    timeoutMs,
    ...(dial ? { dial } : {}),
    now: nowFunction,
  });
  const report = publicProxyReport(health);
  if (!health.ok) {
    const error = new Error(
      `Browser proxy preflight failed (${health.errorCode || 'PROXY_CONNECT_FAILED'}); Worker start blocked.`,
    );
    error.code = 'BROWSER_PROXY_UNAVAILABLE';
    error.report = report;
    throw error;
  }
  return report;
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const envFileIndex = process.argv.indexOf('--env-file');
  const envFile = envFileIndex >= 0 ? process.argv[envFileIndex + 1] : null;
  const env = envFile
    ? { ...process.env, ...readBrowserProxyEnvironmentFile(envFile) }
    : process.env;
  const configurationOnly = process.argv.includes('--config-only');
  try {
    const browserProxy = configurationOnly
      ? inspectBrowserProxyConfiguration({ env })
      : await inspectWorkerBrowserProxy({ env });
    console.log(JSON.stringify({ ok: true, browserProxy }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: {
        code: String(error?.code || 'BROWSER_PROXY_CONFIG_INVALID'),
        message: String(error?.message || 'Browser proxy preflight failed; Worker start blocked.'),
      },
      ...(error?.report ? { browserProxy: error.report } : {}),
    }));
    process.exitCode = 1;
  }
}
