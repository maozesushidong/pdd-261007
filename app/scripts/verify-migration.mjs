import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_DATA_ROOT,
  PROJECT_ROOT,
  buildMigrationPlan,
  migrationPlanSummary,
  parseCliArgs,
  readJsonStrict,
  sha256File,
} from './lib/legacy-migration.mjs';

const args = parseCliArgs();
const verifyLive = args['verify-live'] === true;
const dataRoot = path.resolve(String(args['data-root'] || DEFAULT_DATA_ROOT));
const manifest = args.manifest ? await readJsonStrict(path.resolve(String(args.manifest))) : null;
const plan = await buildMigrationPlan({ dataRoot, projectRoot: PROJECT_ROOT, manifest });
const sourceErrors = [];
for (const file of plan.sourceManifest.files) {
  try {
    const actual = await sha256File(file.sourcePath);
    if (actual !== file.sha256) sourceErrors.push(`Source file changed: ${file.logicalPath}`);
  } catch (error) {
    sourceErrors.push(`Source file missing or unreadable: ${file.logicalPath}: ${error.message}`);
  }
}
if (sourceErrors.length) {
  console.error(JSON.stringify({ valid: false, stage: 'source-manifest', errors: sourceErrors }, null, 2));
  process.exit(1);
}
if (!verifyLive) {
  console.log(JSON.stringify({ valid: true, mode: 'source-only', externalReads: false, summary: migrationPlanSummary(plan) }, null, 2));
  process.exit(0);
}

if (!process.env.DATABASE_URL || !process.env.S3_ENDPOINT || !process.env.S3_BUCKET) {
  throw new Error('DATABASE_URL, S3_ENDPOINT and S3_BUCKET are required for --verify-live');
}
const readSecret = async (name) => process.env[`${name}_FILE`]
  ? (await fsp.readFile(process.env[`${name}_FILE`], 'utf8')).trim()
  : process.env[name] || '';
let pg;
let aws;
try {
  pg = await import('pg');
  aws = await import('@aws-sdk/client-s3');
} catch (error) {
  throw new Error('Verification dependencies are missing; run npm install first', { cause: error });
}
const { Client } = pg.default || pg;
const { S3Client, HeadObjectCommand } = aws;
const database = new Client({ connectionString: process.env.DATABASE_URL });
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
  credentials: { accessKeyId: await readSecret('S3_ACCESS_KEY'), secretAccessKey: await readSecret('S3_SECRET_KEY') },
});
const errors = [];
const checks = {};
const countIds = async (table, ids) => {
  if (!ids.length) return 0;
  const result = await database.query(`SELECT count(*)::int AS count FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  return result.rows[0].count;
};
const hashPayload = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
await database.connect();
try {
  checks.shops = Number((await database.query('SELECT count(*)::int AS count FROM shops WHERE id = ANY($1::text[])', [plan.shops.map((shop) => shop.id)])).rows[0].count);
  checks.scenarioDefinitions = Number((await database.query('SELECT count(*)::int AS count FROM scenario_definitions WHERE code = ANY($1::text[])', [plan.scenarioDefinitions.map((scenario) => scenario.code)])).rows[0].count);
  checks.workOrders = await countIds('work_orders', plan.workOrders.map((item) => item.id));
  checks.workflowRuns = await countIds('workflow_runs', plan.workflowRuns.map((item) => item.id));
  checks.tmsWorkOrders = await countIds('tms_work_orders', plan.tmsWorkOrders.map((item) => item.id));
  checks.evidenceAssets = await countIds('evidence_assets', plan.evidenceAssets.map((item) => item.id));
  checks.verificationLocations = await countIds('verification_locations', plan.verificationLocations.map((item) => item.id));
  for (const analysis of plan.logisticsAnalyses) {
    const result = await database.query('SELECT 1 FROM logistics_analyses WHERE work_order_id = $1 AND source_hash = $2', [analysis.workOrderId, hashPayload(analysis.payload)]);
    if (!result.rowCount) errors.push(`Missing logistics analysis for ${analysis.workOrderId}`);
  }
  for (const analysis of plan.omsAnalyses) {
    const result = await database.query('SELECT 1 FROM oms_analyses WHERE work_order_id = $1 AND source_hash = $2', [analysis.workOrderId, hashPayload(analysis.payload)]);
    if (!result.rowCount) errors.push(`Missing OMS analysis for ${analysis.workOrderId}`);
  }
  const expected = migrationPlanSummary(plan);
  for (const key of ['shops', 'scenarioDefinitions', 'workOrders', 'workflowRuns', 'tmsWorkOrders', 'evidenceAssets', 'verificationLocations']) {
    if (checks[key] !== expected[key]) errors.push(`Count mismatch for ${key}: expected ${expected[key]}, got ${checks[key]}`);
  }
  for (const evidence of plan.evidenceAssets) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: evidence.objectKey }));
      if (Number(head.ContentLength) !== evidence.sizeBytes || head.Metadata?.sha256 !== evidence.sha256) {
        errors.push(`Object hash or size mismatch: ${evidence.objectKey}`);
      }
    } catch (error) {
      errors.push(`Object missing: ${evidence.objectKey}: ${error.name}`);
    }
  }
  const migration = await database.query('SELECT status, manifest_hash FROM migration_runs WHERE id = $1', [plan.migrationId]);
  if (migration.rows[0]?.status !== 'succeeded' || migration.rows[0]?.manifest_hash !== plan.manifestHash) {
    errors.push('Migration run is absent, incomplete, or has a different manifest hash');
  }
} finally {
  await database.end();
}
console.log(JSON.stringify({ valid: errors.length === 0, mode: 'live', checks, errors, summary: migrationPlanSummary(plan) }, null, 2));
if (errors.length) process.exitCode = 1;
