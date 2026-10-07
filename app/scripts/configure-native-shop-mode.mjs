import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf('=');
  return separator < 0
    ? [argument.replace(/^--/, ''), 'true']
    : [argument.slice(0, separator).replace(/^--/, ''), argument.slice(separator + 1)];
}));

const shopIds = String(argumentsMap.get('shops') || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const uniqueShopIds = [...new Set(shopIds)];
const envFile = path.resolve(argumentsMap.get('env') || '.env.native');
const backupDir = path.resolve(argumentsMap.get('backup') || path.join(
  path.dirname(path.dirname(envFile)),
  'backup',
  `shop-mode-${new Date().toISOString().replace(/[:.]/g, '-')}`,
));

if (!uniqueShopIds.length) throw new Error('--shops requires at least one shop ID');
if (uniqueShopIds.some((shopId) => !/^[a-z0-9][a-z0-9-]{2,62}$/.test(shopId))) {
  throw new Error('Invalid shop ID');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!fs.existsSync(envFile)) throw new Error(`Native environment file not found: ${envFile}`);

const replaceEnvironment = (source, replacements) => {
  const lines = source.split(/\r?\n/);
  for (const [name, value] of Object.entries(replacements)) {
    const replacement = `${name}=${value}`;
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (index >= 0) lines[index] = replacement;
    else lines.push(replacement);
  }
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\r\n')}\r\n`;
};

const originalEnvironment = fs.readFileSync(envFile, 'utf8');
const nextEnvironment = replaceEnvironment(originalEnvironment, {
  WORKER_DYNAMIC_SUPERVISOR: uniqueShopIds.length > 1 ? 'true' : 'false',
  WORKER_SUPERVISOR_MAX_SHOPS: '0',
  WORKER_SCHEDULER_MODE: 'legacy',
  WORKER_SHOP_ID: uniqueShopIds[0],
});
const temporaryEnvironment = `${envFile}.${process.pid}.tmp`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let environmentChanged = false;

try {
  await pool.query('BEGIN');
  const before = await pool.query(`
    SELECT id, name, enabled, onboarding_status, display_slot
    FROM shops ORDER BY display_slot, id`);
  const knownIds = new Set(before.rows.map((shop) => shop.id));
  const unknownIds = uniqueShopIds.filter((shopId) => !knownIds.has(shopId));
  if (unknownIds.length) throw new Error(`Unknown shop IDs: ${unknownIds.join(', ')}`);

  await pool.query(`
    UPDATE shops
    SET enabled = id = ANY($1::text[]),
      onboarding_status = CASE
        WHEN id = ANY($1::text[]) THEN CASE
          WHEN onboarding_status = 'disabled' THEN 'waiting-login'
          ELSE onboarding_status
        END
        ELSE 'disabled'
      END,
      updated_at = now()`, [uniqueShopIds]);

  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'env.native'), originalEnvironment, 'utf8');
  fs.writeFileSync(path.join(backupDir, 'shops-before.json'), JSON.stringify(before.rows, null, 2), 'utf8');
  fs.writeFileSync(temporaryEnvironment, nextEnvironment, 'utf8');
  fs.renameSync(temporaryEnvironment, envFile);
  environmentChanged = true;
  await pool.query('COMMIT');

  const after = await pool.query(`
    SELECT id, name, enabled, onboarding_status, display_slot
    FROM shops ORDER BY display_slot, id`);
  console.log(JSON.stringify({
    mode: uniqueShopIds.length > 1 ? 'multi-shop' : 'single-shop',
    enabledShopIds: uniqueShopIds,
    backupDir,
    shops: after.rows,
  }));
} catch (error) {
  await pool.query('ROLLBACK').catch(() => {});
  if (environmentChanged) fs.writeFileSync(envFile, originalEnvironment, 'utf8');
  fs.rmSync(temporaryEnvironment, { force: true });
  throw error;
} finally {
  await pool.end();
}
