import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../packages/adapters/src/postgres/index.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const shopId = String(args.get('--shop') || '').trim();
const confirmedBy = String(args.get('--confirmed-by') || '').trim();
if (!shopId || !confirmedBy) {
  throw new Error('Usage: node scripts/confirm-pdd-profile-identity.mjs --shop <shopId> --confirmed-by <owner>');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'shops.config.json'), 'utf8'));
const shop = config.shops.find((item) => item.shopId === shopId && item.enabled !== false);
if (!shop) throw new Error(`Unknown enabled shop: ${shopId}`);
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex'));
const markerPath = path.join(dataRoot, 'shops', shopId, 'browser-profile', '.workflow-profile.json');
if (!fs.existsSync(markerPath)) throw new Error(`Profile marker does not exist: ${markerPath}`);
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
if (marker.shopId && marker.shopId !== shopId) throw new Error(`Profile belongs to another shop: ${marker.shopId}`);
const profileFingerprint = marker.profileFingerprint || crypto.randomUUID();
const confirmedAt = new Date().toISOString();
const next = {
  ...marker,
  shopId,
  profileFingerprint,
  identityBinding: {
    shopId,
    expectedShopName: shop.expectedShopName,
    loginRequestedAt: marker.loginRequestedAt || null,
    status: 'confirmed',
    source: 'owner-confirmed-no-vnc',
    confirmedBy,
    confirmedAt,
  },
  updatedAt: confirmedAt,
};
const temporary = `${markerPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
fs.renameSync(temporary, markerPath);

if (process.env.DATABASE_URL) {
  const pool = await createPostgresPool();
  try {
    await pool.query(`
      INSERT INTO shop_identity_bindings
        (shop_id, expected_shop_name, profile_fingerprint, status, confirmed_by, confirmed_at, updated_at)
      VALUES ($1,$2,$3,'confirmed',$4,$5,now())
      ON CONFLICT (shop_id) DO UPDATE SET expected_shop_name = EXCLUDED.expected_shop_name,
        profile_fingerprint = EXCLUDED.profile_fingerprint, status = 'confirmed',
        confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at, updated_at = now()`,
    [shopId, shop.expectedShopName, profileFingerprint, confirmedBy, confirmedAt]);
  } finally {
    await pool.end();
  }
}

console.log(`Confirmed PDD Profile binding: ${shopId} -> ${shop.expectedShopName}`);
