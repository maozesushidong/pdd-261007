import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_DATA_ROOT,
  PROJECT_ROOT,
  buildMigrationPlan,
  migrationPlanSummary,
  parseCliArgs,
  readJsonStrict,
} from './lib/legacy-migration.mjs';

const args = parseCliArgs();
const apply = args.apply === true;
const dataRoot = path.resolve(String(args['data-root'] || DEFAULT_DATA_ROOT));
const manifest = args.manifest ? await readJsonStrict(path.resolve(String(args.manifest))) : null;
const plan = await buildMigrationPlan({ dataRoot, projectRoot: PROJECT_ROOT, manifest });
const summary = migrationPlanSummary(plan);

if (!apply) {
  console.log(JSON.stringify({ mode: 'dry-run', sourceMutated: false, externalWrites: false, summary }, null, 2));
  process.exit(0);
}

if (String(process.env.MIGRATION_APPLY_CONFIRM || '') !== plan.manifestHash) {
  throw new Error('Refusing live migration: MIGRATION_APPLY_CONFIRM must equal the dry-run manifestHash');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for --apply');
if (!process.env.S3_ENDPOINT || !process.env.S3_BUCKET) throw new Error('S3_ENDPOINT and S3_BUCKET are required for --apply');

const readSecret = async (name) => {
  if (process.env[`${name}_FILE`]) return (await fsp.readFile(process.env[`${name}_FILE`], 'utf8')).trim();
  return process.env[name] || '';
};

let pg;
let aws;
try {
  pg = await import('pg');
  aws = await import('@aws-sdk/client-s3');
} catch (error) {
  throw new Error('Migration dependencies are missing; run npm install before --apply', { cause: error });
}

const { Client } = pg.default || pg;
const { S3Client, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } = aws;
const s3AccessKey = await readSecret('S3_ACCESS_KEY');
const s3SecretKey = await readSecret('S3_SECRET_KEY');
if (!s3AccessKey || !s3SecretKey) throw new Error('S3 credentials are required through *_FILE or environment variables');

const database = new Client({ connectionString: process.env.DATABASE_URL });
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
  credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey },
});
const bucket = process.env.S3_BUCKET;
const checkpointFile = path.join(dataRoot, 'migration', 'state', `${plan.migrationId}.json`);

const writeCheckpoint = async (status, stage, extra = {}) => {
  await fsp.mkdir(path.dirname(checkpointFile), { recursive: true, mode: 0o700 });
  await fsp.writeFile(checkpointFile, `${JSON.stringify({
    migrationId: plan.migrationId,
    manifestHash: plan.manifestHash,
    status,
    stage,
    updatedAt: new Date().toISOString(),
    ...extra,
  }, null, 2)}\n`, { mode: 0o600 });
};

const payloadHash = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const json = (value) => value == null ? null : JSON.stringify(value);
const auditKey = (event) => crypto.createHash('sha256').update(JSON.stringify({
  shopId: event.shopId,
  workOrderId: event.workOrderId,
  eventType: event.eventType,
  payload: event.payload,
})).digest('hex');

const uploadEvidence = async () => {
  let uploaded = 0;
  let reused = 0;
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  for (const evidence of plan.evidenceAssets) {
    let existing = null;
    try { existing = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: evidence.objectKey })); } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchKey') throw error;
    }
    if (existing) {
      if (Number(existing.ContentLength) !== evidence.sizeBytes || existing.Metadata?.sha256 !== evidence.sha256) {
        throw new Error(`Existing object does not match source evidence: ${evidence.objectKey}`);
      }
      reused += 1;
      continue;
    }
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: evidence.objectKey,
      Body: fs.createReadStream(evidence.sourcePath),
      ContentLength: evidence.sizeBytes,
      ContentType: evidence.mimeType,
      Metadata: { sha256: evidence.sha256, shopid: evidence.shopId },
    }));
    uploaded += 1;
  }
  return { uploaded, reused };
};

await database.connect();
let evidenceResult = null;
try {
  await database.query(
    `INSERT INTO migration_runs (id, migration_kind, manifest_hash, status, expected_counts)
     VALUES ($1, 'legacy-json', $2, 'running', $3::jsonb)
     ON CONFLICT (id) DO UPDATE SET status = 'running', expected_counts = EXCLUDED.expected_counts, error = NULL, finished_at = NULL`,
    [plan.migrationId, plan.manifestHash, json(summary)],
  );
  await writeCheckpoint('running', 'object-storage');
  evidenceResult = await uploadEvidence();
  await writeCheckpoint('running', 'database', { evidence: evidenceResult });
  await database.query('BEGIN');

  for (const shop of plan.shops) {
    await database.query(
      `INSERT INTO shops (id, name, enabled, rule_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, rule_version = EXCLUDED.rule_version, updated_at = now()`,
      [shop.id, shop.name, shop.enabled, shop.ruleVersion],
    );
  }
  for (const scenario of plan.scenarioDefinitions) {
    await database.query(
      `INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
       VALUES ($1, $2::jsonb, $3, $4, $5::jsonb)
       ON CONFLICT (code) DO UPDATE SET title_patterns = EXCLUDED.title_patterns, policy_version = EXCLUDED.policy_version,
         enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = now()`,
      [scenario.code, json(scenario.titlePatterns), scenario.policyVersion, scenario.enabled, json(scenario.config)],
    );
  }
  for (const workOrder of plan.workOrders) {
    await database.query(
      `INSERT INTO work_orders
         (id, shop_id, external_order_number, work_order_type, scenario_code, status, idempotency_key, current_step, payload, manual_review_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
       ON CONFLICT (shop_id, external_order_number, work_order_type) DO UPDATE SET
         scenario_code = EXCLUDED.scenario_code, status = EXCLUDED.status, current_step = EXCLUDED.current_step,
         payload = EXCLUDED.payload, manual_review_reason = EXCLUDED.manual_review_reason, updated_at = EXCLUDED.updated_at`,
      [workOrder.id, workOrder.shopId, workOrder.externalOrderNumber, workOrder.workOrderType, workOrder.scenarioCode,
        workOrder.status, workOrder.idempotencyKey, workOrder.currentStep, json(workOrder.payload), workOrder.manualReviewReason,
        workOrder.createdAt, workOrder.updatedAt],
    );
  }
  for (const run of plan.workflowRuns) {
    await database.query(
      `INSERT INTO workflow_runs (id, work_order_id, worker_id, status, started_at, finished_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, finished_at = EXCLUDED.finished_at, error = EXCLUDED.error`,
      [run.id, run.workOrderId, run.workerId, run.status, run.startedAt, run.finishedAt, json(run.error)],
    );
  }
  for (const analysis of plan.logisticsAnalyses) {
    const sourceHash = payloadHash(analysis.payload);
    await database.query(
      `INSERT INTO logistics_analyses (work_order_id, payload, source_hash)
       VALUES ($1,$2::jsonb,$3) ON CONFLICT (work_order_id, source_hash) WHERE source_hash IS NOT NULL DO NOTHING`,
      [analysis.workOrderId, json(analysis.payload), sourceHash],
    );
  }
  for (const analysis of plan.omsAnalyses) {
    const sourceHash = payloadHash(analysis.payload);
    await database.query(
      `INSERT INTO oms_analyses (work_order_id, payload, source_hash)
       VALUES ($1,$2::jsonb,$3) ON CONFLICT (work_order_id, source_hash) WHERE source_hash IS NOT NULL DO NOTHING`,
      [analysis.workOrderId, json(analysis.payload), sourceHash],
    );
  }
  for (const tms of plan.tmsWorkOrders) {
    await database.query(
      `INSERT INTO tms_work_orders (id, work_order_id, scenario_code, external_ticket_id, status, request_hash, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (work_order_id, scenario_code, request_hash) DO UPDATE SET
         external_ticket_id = EXCLUDED.external_ticket_id, status = EXCLUDED.status, payload = EXCLUDED.payload`,
      [tms.id, tms.workOrderId, tms.scenarioCode, tms.externalTicketId, tms.status, tms.requestHash, json(tms.payload)],
    );
  }
  for (const evidence of plan.evidenceAssets) {
    await database.query(
      `INSERT INTO evidence_assets (id, work_order_id, shop_id, kind, status, object_key, mime_type, size_bytes, sha256, source_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, object_key = EXCLUDED.object_key,
         size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256`,
      [evidence.id, evidence.workOrderId, evidence.shopId, evidence.kind, evidence.status, evidence.objectKey,
        evidence.mimeType, evidence.sizeBytes, evidence.sha256, evidence.sourceRelativePath],
    );
  }
  for (const verification of plan.verificationLocations) {
    await database.query(
      `INSERT INTO verification_locations
         (id, shop_id, work_order_id, system_name, stage, status, url, frame_url, selector, bounding_box, confidence, detected_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, url = EXCLUDED.url, frame_url = EXCLUDED.frame_url,
         selector = EXCLUDED.selector, bounding_box = EXCLUDED.bounding_box, confidence = EXCLUDED.confidence, resolved_at = EXCLUDED.resolved_at`,
      [verification.id, verification.shopId, verification.workOrderId, verification.systemName, verification.stage,
        verification.status, verification.url, verification.frameUrl, verification.selector, json(verification.boundingBox),
        verification.confidence, verification.detectedAt, verification.resolvedAt],
    );
  }
  for (const event of plan.auditEvents) {
    await database.query(
      `INSERT INTO audit_events (shop_id, work_order_id, actor_id, event_type, payload, created_at, deduplication_key)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`,
      [event.shopId, event.workOrderId, event.actorId, event.eventType, json(event.payload), event.createdAt, auditKey(event)],
    );
  }
  await database.query('COMMIT');
  await database.query(
    `UPDATE migration_runs SET status = 'succeeded', imported_counts = $2::jsonb, finished_at = now() WHERE id = $1`,
    [plan.migrationId, json({ ...summary, objectStorage: evidenceResult })],
  );
  await writeCheckpoint('succeeded', 'complete', { evidence: evidenceResult, summary });
  console.log(JSON.stringify({ mode: 'apply', status: 'succeeded', summary, evidence: evidenceResult }, null, 2));
} catch (error) {
  await database.query('ROLLBACK').catch(() => {});
  await database.query(
    `UPDATE migration_runs SET status = 'failed', error = $2::jsonb, finished_at = now() WHERE id = $1`,
    [plan.migrationId, json({ name: error.name, message: error.message })],
  ).catch(() => {});
  await writeCheckpoint('failed', 'error', { error: { name: error.name, message: error.message }, evidence: evidenceResult });
  throw error;
} finally {
  await database.end();
}
