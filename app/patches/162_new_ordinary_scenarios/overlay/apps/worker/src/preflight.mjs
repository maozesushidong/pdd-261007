import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../../../packages/adapters/src/postgres/index.mjs';
import { createRedisConnection } from '../../../packages/adapters/src/redis/index.mjs';

const readSecret = async (name) => process.env[`${name}_FILE`]
  ? (await fs.readFile(process.env[`${name}_FILE`], 'utf8')).trim()
  : process.env[name] || '';

async function checkObjectStorage() {
  let aws;
  try { aws = await import('@aws-sdk/client-s3'); } catch (error) {
    throw new Error('MinIO preflight requires @aws-sdk/client-s3', { cause: error });
  }
  const accessKeyId = await readSecret('S3_ACCESS_KEY');
  const secretAccessKey = await readSecret('S3_SECRET_KEY');
  if (!accessKeyId || !secretAccessKey) throw new Error('S3 credentials are not configured');
  const client = new aws.S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
    credentials: { accessKeyId, secretAccessKey },
  });
  await client.send(new aws.HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
  const probeKey = `._preflight/${crypto.randomUUID()}.txt`;
  await client.send(new aws.PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: probeKey,
    Body: 'preflight',
    ContentType: 'text/plain',
  }));
  await client.send(new aws.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: probeKey }));
  return { ok: true, bucket: process.env.S3_BUCKET, probe: 'write-delete' };
}

async function checkPostgres() {
  const pool = await createPostgresPool();
  try {
    const result = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM shops) AS shops,
        (SELECT count(*)::int FROM shops WHERE enabled IS TRUE) AS enabled_shops,
        (SELECT count(*)::int FROM work_orders) AS work_orders,
        (SELECT count(*)::int FROM work_orders WHERE status IN ('queued','retry-ready')) AS queued,
        (SELECT count(*)::int FROM shop_runtime_state WHERE lease_expires_at > now()) AS active_leases`);
    const rows = result.rows[0];
    if (rows.shops < 1) throw new Error('No shops are registered');
    if (rows.enabled_shops < 1) throw new Error('No shops are enabled');
    return { ok: true, ...rows };
  } finally {
    await pool.end();
  }
}

async function checkRedis() {
  const redis = await createRedisConnection();
  try {
    const key = `pdd-workflow:preflight:${crypto.randomUUID()}`;
    await redis.set(key, 'ok', 'EX', 30);
    const value = await redis.get(key);
    await redis.del(key);
    if (value !== 'ok') throw new Error('Redis probe value mismatch');
    return { ok: true, probe: 'set-get-delete' };
  } finally {
    await redis.quit();
  }
}

const checks = {};
try {
  checks.postgres = await checkPostgres();
  checks.redis = await checkRedis();
  checks.objectStorage = await checkObjectStorage();
  const result = { ok: true, executionEnabled: String(process.env.WORKER_EXECUTION_ENABLED || 'false').toLowerCase() === 'true', workerDataBackend: process.env.WORKER_DATA_BACKEND || 'legacy-json', checks };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, checks, error: { name: error.name, message: error.message } }, null, 2));
  process.exitCode = 1;
}

export { checkPostgres, checkRedis, checkObjectStorage };
