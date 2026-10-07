import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_DATA_ROOT,
  PROJECT_ROOT,
  assertInside,
  createMigrationManifest,
  isoFileStamp,
  parseCliArgs,
  sha256File,
  toPosix,
  walkFiles,
} from './lib/legacy-migration.mjs';

const args = parseCliArgs();
const dataRoot = path.resolve(String(args['data-root'] || DEFAULT_DATA_ROOT));
const backupRoot = path.resolve(String(args.output || path.join(dataRoot, 'migration', 'backups', `legacy-snapshot-${isoFileStamp()}`)));
const includeLocalSessionBackup = args['include-local-session-backup'] === true;
const manifest = await createMigrationManifest({ dataRoot, projectRoot: PROJECT_ROOT });
if (fs.existsSync(backupRoot) && (await fsp.readdir(backupRoot)).length) throw new Error(`Backup destination is not empty: ${backupRoot}`);
await fsp.mkdir(backupRoot, { recursive: true, mode: 0o700 });

const backupFiles = [];
for (const entry of manifest.files) {
  const destination = assertInside(backupRoot, path.join(backupRoot, ...entry.logicalPath.split('/')), 'backup destination');
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.copyFile(entry.sourcePath, destination, fs.constants.COPYFILE_EXCL);
  const copiedHash = await sha256File(destination);
  if (copiedHash !== entry.sha256) throw new Error(`Backup hash mismatch: ${entry.logicalPath}`);
  backupFiles.push({ ...entry, originalSourcePath: entry.sourcePath, sourcePath: destination });
  await fsp.chmod(destination, 0o400).catch(() => {});
}

const localSessionFiles = [];
if (includeLocalSessionBackup) {
  for (const shop of manifest.validation.shops) {
    const shopRoot = path.join(dataRoot, 'shops', shop.shopId);
    for (const area of ['auth', 'browser-profile']) {
      const sourceRoot = path.join(shopRoot, area);
      for (const source of await walkFiles(sourceRoot)) {
        const relative = toPosix(path.relative(sourceRoot, source));
        const destination = assertInside(backupRoot, path.join(backupRoot, 'local-rollback-only', shop.shopId, area, ...relative.split('/')), 'local rollback destination');
        await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        localSessionFiles.push({ shopId: shop.shopId, area, relativePath: relative, sizeBytes: (await fsp.stat(source)).size });
        await fsp.chmod(destination, 0o400).catch(() => {});
      }
    }
  }
}

const backupManifest = {
  ...manifest,
  dataRoot: backupRoot,
  originalDataRoot: manifest.dataRoot,
  files: backupFiles,
  backupCreatedAt: new Date().toISOString(),
  backupRoot,
  localSessionBackup: {
    included: includeLocalSessionBackup,
    importable: false,
    containsCredentialsOrCookies: includeLocalSessionBackup,
    files: localSessionFiles.length,
    bytes: localSessionFiles.reduce((total, file) => total + file.sizeBytes, 0),
  },
};
const manifestFile = path.join(backupRoot, 'backup-manifest.json');
await fsp.writeFile(manifestFile, `${JSON.stringify(backupManifest, null, 2)}\n`, { mode: 0o400 });
console.log(JSON.stringify({
  backupRoot,
  importableFiles: manifest.files.length,
  importableBytes: manifest.totals.bytes,
  localSessionBackup: backupManifest.localSessionBackup,
}, null, 2));
