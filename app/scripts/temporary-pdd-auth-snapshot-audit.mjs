import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2] || 'D:/pdd-native/data/workflow/shops');
const statMetadata = (filePath, { hash = true } = {}) => {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      sha256: hash
        ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
        : null,
    };
  } catch {
    return { exists: false, bytes: 0, modifiedAt: null, sha256: null };
  }
};

const readJson = (filePath) => {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
};

const nowSeconds = Math.floor(Date.now() / 1000);
const shops = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'default')
  .map((entry) => {
    const shopRoot = path.join(root, entry.name);
    const authPath = path.join(shopRoot, 'auth', 'pdd-auth.json');
    const goodPath = path.join(shopRoot, 'auth', 'pdd-auth.last-good.json');
    const markerPath = path.join(shopRoot, 'browser-profile', '.workflow-profile.json');
    const cookiesDbPath = path.join(shopRoot, 'browser-profile', 'Default', 'Network', 'Cookies');
    const auth = readJson(authPath);
    const good = readJson(goodPath);
    const marker = readJson(markerPath);
    const tokens = (good.value?.cookies || []).filter((cookie) => (
      /^windows_app_shop_token(?:_\d+)?$/iu.test(String(cookie?.name || ''))
    ));
    return {
      shopId: entry.name,
      auth: { ...statMetadata(authPath), parseError: auth.error },
      lastGood: { ...statMetadata(goodPath), parseError: good.error },
      authMatchesLastGood: Boolean(
        statMetadata(authPath).sha256
        && statMetadata(authPath).sha256 === statMetadata(goodPath).sha256
      ),
      sessionTokens: tokens.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        expiresAt: Number(cookie.expires) > 0
          ? new Date(Number(cookie.expires) * 1000).toISOString()
          : null,
        expired: Number(cookie.expires) > 0 && Number(cookie.expires) <= nowSeconds,
      })),
      profile: {
        ...statMetadata(markerPath),
        parseError: marker.error,
        createdAt: marker.value?.createdAt || null,
        updatedAt: marker.value?.updatedAt || null,
        profileFingerprint: marker.value?.profileFingerprint || null,
        loginRequestedAt: marker.value?.loginRequestedAt || null,
      },
      // Chromium can lock its live SQLite database. A metadata check does not
      // need to read or hash it, and must not mistake that lock for absence.
      cookiesDatabase: statMetadata(cookiesDbPath, { hash: false }),
    };
  });

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), shops }, null, 2));
