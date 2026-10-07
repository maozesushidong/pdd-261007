import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex'));
const controlFile = path.resolve(process.env.WORKFLOW_SUPERVISOR_CONTROL_FILE
  || path.join(dataRoot, 'supervisor', 'local-worker-control.json'));
const valueFor = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const shopId = String(valueFor('shop') || '').trim();
const enabledValue = String(valueFor('enabled') || '').trim().toLowerCase();
if (!shopId || !['true', 'false'].includes(enabledValue)) {
  console.error('Usage: node scripts/set-local-shop-enabled.mjs --shop=<shopId> --enabled=<true|false>');
  process.exit(2);
}
const config = JSON.parse(await fsp.readFile(path.join(root, 'shops.config.json'), 'utf8'));
if (!config.shops?.some((shop) => shop.shopId === shopId && shop.enabled)) {
  throw new Error(`Enabled shop not found: ${shopId}`);
}
let current = { version: 1, disabledShopIds: [] };
try { current = JSON.parse(await fsp.readFile(controlFile, 'utf8')); } catch { /* first write */ }
const disabled = new Set(Array.isArray(current.disabledShopIds) ? current.disabledShopIds.map(String) : []);
if (enabledValue === 'true') disabled.delete(shopId);
else disabled.add(shopId);
const next = {
  version: 1,
  disabledShopIds: [...disabled].sort(),
  updatedAt: new Date().toISOString(),
  updatedBy: process.env.USERNAME || process.env.USER || 'operator',
};
await fsp.mkdir(path.dirname(controlFile), { recursive: true, mode: 0o700 });
const temporary = `${controlFile}.${process.pid}.tmp`;
await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
await fsp.rename(temporary, controlFile);
console.log(JSON.stringify({ shopId, localWorkerEnabled: enabledValue === 'true', controlFile }, null, 2));
