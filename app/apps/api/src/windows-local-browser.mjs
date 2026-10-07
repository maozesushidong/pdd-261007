import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const launcherError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const triggerScheduledTask = (taskName) => new Promise((resolve, reject) => {
  execFile('schtasks.exe', ['/Run', '/TN', taskName], { windowsHide: true }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

const readJson = async (file) => {
  try {
    const content = await fsp.readFile(file, 'utf8');
    return JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const writeJsonAtomic = async (file, value) => {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, file);
};

export const isWindowsLocalBrowserRuntime = ({ platform, operatingSystem = process.platform }) => (
  operatingSystem === 'win32' && String(platform || '').trim().toLowerCase() === 'windows native'
);

export function createWindowsLocalBrowserLauncher({
  dataRoot,
  platform,
  operatingSystem = process.platform,
  taskName = process.env.WINDOWS_BROWSER_TASK_NAME || 'PDD Native Browser Launcher',
  waitTimeoutMs = Number(process.env.WINDOWS_BROWSER_LAUNCH_WAIT_MS || 8000),
  runTask = triggerScheduledTask,
} = {}) {
  const available = isWindowsLocalBrowserRuntime({ platform, operatingSystem });
  const shopsRoot = path.resolve(dataRoot, 'shops');
  const queueRoot = path.resolve(dataRoot, 'supervisor', 'browser-launch-queue');
  const resultRoot = path.resolve(dataRoot, 'supervisor', 'browser-launch-results');
  const sessionRoot = path.resolve(dataRoot, 'supervisor', 'browser-login-sessions');

  return Object.freeze({
    available,
    mode: available ? 'windows-local' : 'remote-desktop',
    async launch(shopOrId) {
      if (!available) {
        throw launcherError('windows-local-browser-unavailable', 'WINDOWS_LOCAL_BROWSER_UNAVAILABLE');
      }
      const shop = typeof shopOrId === 'object' && shopOrId !== null ? shopOrId : {};
      const shopId = typeof shopOrId === 'string' ? shopOrId : shop.shopId;
      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(String(shopId || ''))) {
        throw launcherError('shop-id-invalid', 'SHOP_ID_INVALID');
      }

      const profileRoot = path.resolve(shopsRoot, shopId, 'browser-profile');
      if (!profileRoot.startsWith(`${shopsRoot}${path.sep}`)) {
        throw launcherError('shop-profile-path-invalid', 'SHOP_PROFILE_PATH_INVALID');
      }
      await Promise.all([
        fsp.mkdir(profileRoot, { recursive: true }),
        fsp.mkdir(queueRoot, { recursive: true }),
        fsp.mkdir(resultRoot, { recursive: true }),
        fsp.mkdir(sessionRoot, { recursive: true }),
      ]);

      const requestId = crypto.randomUUID();
      const requestedAt = new Date().toISOString();
      const queueFile = path.join(queueRoot, `${requestId}.json`);
      const resultFile = path.join(resultRoot, `${requestId}.json`);
      const loginContextFile = path.join(shopsRoot, shopId, 'browser-login-context.json');
      await writeJsonAtomic(loginContextFile, {
        requestId,
        shopId,
        name: String(shop.name || shop.expectedShopName || shopId).trim(),
        expectedShopName: String(shop.expectedShopName || shop.name || shopId).trim(),
        expectedShopNames: [shop.expectedShopName || shop.name || shopId]
          .map((value) => String(value || '').trim())
          .filter(Boolean),
        loginRequestedAt: shop.loginRequestedAt || requestedAt,
        requestedAt,
      });
      await writeJsonAtomic(queueFile, { requestId, shopId, requestedAt });

      try {
        await runTask(taskName);
      } catch {
        await fsp.unlink(queueFile).catch(() => {});
        throw launcherError('windows-local-browser-launcher-unavailable', 'WINDOWS_LOCAL_BROWSER_LAUNCHER_UNAVAILABLE');
      }

      const deadline = Date.now() + Math.max(0, Number(waitTimeoutMs) || 0);
      while (Date.now() <= deadline) {
        const result = await readJson(resultFile);
        if (result) {
          await fsp.unlink(resultFile).catch(() => {});
          if (!['launched', 'already-running'].includes(result.status)) {
            throw launcherError(
              result.error || 'windows-local-browser-launch-failed',
              'WINDOWS_LOCAL_BROWSER_LAUNCH_FAILED',
            );
          }
          return { mode: 'windows-local', status: result.status, shopId, requestId, requestedAt };
        }
        await delay(200);
      }

      return { mode: 'windows-local', status: 'queued', shopId, requestId, requestedAt };
    },
    async listSessionObservations() {
      if (!available) return [];
      const files = await fsp.readdir(sessionRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const observations = await Promise.all(files
        .filter((item) => item.isFile() && /^[a-z0-9][a-z0-9-]{2,62}\.json$/.test(item.name))
        .map((item) => readJson(path.join(sessionRoot, item.name))));
      return observations.filter((item) => item && item.shopId);
    },
  });
}
