import path from 'node:path';
import { DEFAULT_DATA_ROOT, PROJECT_ROOT, parseCliArgs, validateLegacyData } from './lib/legacy-migration.mjs';

const args = parseCliArgs();
const dataRoot = path.resolve(String(args['data-root'] || DEFAULT_DATA_ROOT));
const report = await validateLegacyData({ dataRoot, projectRoot: PROJECT_ROOT });
console.log(JSON.stringify(report, null, 2));
if (!report.valid) process.exitCode = 1;
