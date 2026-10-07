import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_DATA_ROOT, PROJECT_ROOT, createMigrationManifest, isoFileStamp, parseCliArgs } from './lib/legacy-migration.mjs';

const args = parseCliArgs();
const dataRoot = path.resolve(String(args['data-root'] || DEFAULT_DATA_ROOT));
const output = path.resolve(String(args.output || path.join(dataRoot, 'migration', 'manifests', `legacy-manifest-${isoFileStamp()}.json`)));
const manifest = await createMigrationManifest({ dataRoot, projectRoot: PROJECT_ROOT });
await fsp.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await fsp.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, totals: manifest.totals, exclusions: manifest.exclusions }, null, 2));
