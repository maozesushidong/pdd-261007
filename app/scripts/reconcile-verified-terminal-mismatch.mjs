import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { archiveReadiness } from '../workflow-runtime.mjs';
import {
  verifyProactiveTerminalDetailProof,
  verifiedProactiveSummaryMatchesCompletion,
} from '../packages/adapters/src/pdd/proactive-terminal-proof.mjs';
import {
  verifyInterceptTerminalDetailProof,
  verifiedInterceptSummaryMatchesCompletion,
} from '../packages/adapters/src/pdd/intercept-terminal-proof.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeRoot = path.dirname(appRoot);
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const shopId = arg('--shop');
const orderNumber = arg('--order');
const platformWorkOrderId = arg('--platform-id');
const scenarioCode = arg('--scenario');
const expectedWorkOrderId = arg('--work-order-id');
const apply = process.argv.includes('--apply');
const stageByScenario = {
  'proactive-logistics-service': 'ordinary-proactive-logistics-service-consumer-return-waybill-unconfirmed-without-logistics',
  'intercept-recall': 'ordinary-intercept-recall-consumer-received-shipment',
};
if (!/^[a-z0-9-]+$/u.test(shopId || '')
  || !/^\d{6}-\d{12,20}$/u.test(orderNumber || '')
  || !/^\d{6,30}$/u.test(platformWorkOrderId || '')
  || !stageByScenario[scenarioCode]
  || !/^[a-f0-9-]{36}$/u.test(expectedWorkOrderId || '')) {
  throw new Error('Usage: reconcile-verified-terminal-mismatch.mjs --shop ID --order NUMBER --platform-id ID --scenario proactive-logistics-service|intercept-recall --work-order-id UUID [--apply]');
}

const databaseLine = (await fs.readFile(path.join(appRoot, '.env.native'), 'utf8'))
  .split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
const client = new pg.Client({ connectionString: databaseUrl,
  application_name: 'reconcile-verified-terminal-mismatch' });
await client.connect();

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const safeEvidence = async (shopRoot, metadata, subdirectory) => {
  if (!metadata) return null;
  assert(metadata.status === 'ready' && metadata.shopId === shopId
    && metadata.orderNumber === orderNumber
    && metadata.relativePath === `tmp/${subdirectory}/${orderNumber}.png`,
  `evidence-metadata-mismatch:${subdirectory}`);
  const source = path.resolve(shopRoot, ...metadata.relativePath.split('/'));
  const expected = path.resolve(shopRoot, 'tmp', subdirectory, `${orderNumber}.png`);
  assert(source === expected, `evidence-path-mismatch:${subdirectory}`);
  const stat = await fs.stat(source);
  assert(stat.isFile() && stat.size === metadata.sizeBytes,
    `evidence-size-mismatch:${subdirectory}`);
  const handle = await fs.open(source, 'r');
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    assert(header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && header.readUInt32BE(16) === metadata.width
      && header.readUInt32BE(20) === metadata.height,
    `evidence-png-mismatch:${subdirectory}`);
  } finally { await handle.close(); }
  return { source, name: `${subdirectory}-${orderNumber}.png` };
};

let inTransaction = false;
let committed = false;
let archivePath = null;
let createdArchive = false;
const moved = [];
try {
  await client.query('BEGIN');
  inTransaction = true;
  await client.query("SET LOCAL lock_timeout = '5s'");
  const selected = await client.query(`
    SELECT w.*, i.status AS instance_status, i.runtime_status AS instance_runtime_status,
      i.platform_case_id, i.platform_case_key, i.work_order_id AS instance_work_order_id
    FROM work_orders w
    JOIN ordinary_work_order_instances i ON i.id = w.current_ordinary_instance_id
    WHERE w.id = $1::uuid AND w.shop_id = $2 AND w.external_order_number = $3
      AND w.scenario_code = $4
    FOR UPDATE OF w, i`, [expectedWorkOrderId, shopId, orderNumber, scenarioCode]);
  assert(selected.rowCount === 1, 'exact-work-order-not-found');
  const workOrder = selected.rows[0];
  assert(workOrder.status === 'paused' && workOrder.runtime_status === 'paused'
    && workOrder.current_step === 'manual-review-blocked'
    && workOrder.completion_state === 'pending'
    && workOrder.instance_status === 'paused'
    && workOrder.instance_runtime_status === 'paused'
    && workOrder.instance_work_order_id === workOrder.id
    && String(workOrder.platform_case_id) === platformWorkOrderId
    && workOrder.platform_case_key === `pdd-work-order:${platformWorkOrderId}`,
  'paused-case-identity-or-state-mismatch');
  const progress = workOrder.payload || {};
  const submission = progress.pddResolutionSubmission || {};
  const stage = stageByScenario[scenarioCode];
  assert(progress.orderNumber === orderNumber && progress.shopId === shopId
    && progress.scenarioCode === scenarioCode
    && String(progress.platformWorkOrderId) === platformWorkOrderId
    && progress.platformCaseKey === workOrder.platform_case_key
    && progress.manualReview?.stage === 'pdd-resolution-outcome-mismatch'
    && progress.pddResolutionOutcomeMismatch?.status === 'manual-review-blocked'
    && submission.orderNumber === orderNumber
    && submission.effectStage === stage
    && submission.status === 'manual-review-blocked'
    && submission.submitClicked === true
    && submission.submitReceipt?.success === true
    && submission.transitionConfirmed === true
    && submission.confirmationMethod === 'detail-completed',
  'checkpoint-or-submission-mismatch');

  const effects = (await client.query(`
    SELECT id, effect_type, idempotency_key, status, ordinary_instance_id,
      reserved_at, receipt
    FROM external_effects WHERE work_order_id = $1::uuid AND shop_id = $2
    FOR UPDATE`, [workOrder.id, shopId])).rows;
  assert(effects.length > 0
    && effects.every((effect) => effect.status === 'succeeded'
      && effect.ordinary_instance_id === workOrder.current_ordinary_instance_id)
    && effects.some((effect) => effect.effect_type === 'evidence-upload'),
  'external-effects-unresolved-or-upload-missing');
  const finalEffects = effects.filter((effect) => effect.effect_type === 'pdd-submit'
    && effect.idempotency_key.endsWith(`:${stage}`));
  assert(finalEffects.length === 1, 'final-pdd-effect-not-unique');
  const effect = finalEffects[0];
  const result = effect.receipt?.result || {};
  assert(result.selectedPddOption === submission.outcome
    && result.submitClicked === true
    && result.submitReceipt?.success === true
    && result.transitionConfirmed === true,
  'final-effect-receipt-mismatch');
  const input = {
    scenarioCode, stage, orderNumber, platformWorkOrderId,
    selectedOption: result.selectedPddOption,
    selectionProof: progress.pddSubmitSelectionProof,
    submitClicked: result.submitClicked,
    submitReceipt: result.submitReceipt,
    transitionConfirmed: result.transitionConfirmed,
    effectStartedAt: submission.externalActionStartedAt,
    submittedAt: result.submittedAt,
    responseCandidates: result.responseCandidates,
  };
  const proactive = scenarioCode === 'proactive-logistics-service';
  const proof = proactive
    ? verifyProactiveTerminalDetailProof(input)
    : verifyInterceptTerminalDetailProof(input);
  assert(proof?.status === 'verified', 'exact-platform-detail-proof-missing');
  const completion = {
    shopId, orderNumber, scenarioCode, outcome: submission.outcome,
    status: 'succeeded',
    completionEvidence: submission.completionEvidence,
    completionResultOption: submission.completionResultOption || null,
    submitClicked: true, submitReceipt: submission.submitReceipt,
    transitionConfirmed: true, confirmationMethod: 'detail-completed',
    platformDetailProof: proof,
    completedAt: result.submittedAt,
  };
  const matching = (proactive
    ? verifiedProactiveSummaryMatchesCompletion
    : verifiedInterceptSummaryMatchesCompletion)({
    proof, progress, completion, scenarioCode,
    expectedOutcome: completion.outcome,
    observedOutcome: completion.completionEvidence,
    observedResultOption: completion.completionResultOption,
  });
  assert(matching, 'completed-summary-not-explained-by-exact-detail');
  assert(progress.ordinaryEvidenceUpload?.status === 'uploaded'
    && progress.ordinaryEvidenceUpload.orderNumber === orderNumber,
  'evidence-upload-progress-missing');

  const shopRoot = path.resolve(nativeRoot, 'data', 'workflow', 'shops', shopId);
  const evidence = [
    await safeEvidence(shopRoot, progress.pddEvidenceScreenshot, 'tms-logistics-work-orders'),
    await safeEvidence(shopRoot, progress.tmsEvidenceScreenshot, 'pdd-work-order-replies'),
  ].filter(Boolean);
  const completedDir = path.join(shopRoot, 'state', 'completed-work-orders');
  archivePath = path.join(completedDir, `pdd-work-order-${platformWorkOrderId}.json`);
  assert(!fsSync.existsSync(archivePath), 'completed-archive-already-exists');
  const openInterventions = await client.query(`
    SELECT count(*)::int AS count FROM manual_interventions
    WHERE work_order_id = $1::uuid AND status IN ('open','acknowledged')`,
  [workOrder.id]);
  assert(openInterventions.rows[0].count === 0, 'open-intervention-requires-separate-reconciliation');

  const archivedAt = new Date().toISOString();
  const deletedEvidence = (metadata) => metadata ? {
    ...metadata, relativePath: null, status: 'deleted',
    consumedAt: archivedAt, deletedAt: archivedAt,
    reason: '同单提交后精确平台详情核实完结；临时文件移入本地备份',
  } : null;
  const nextProgress = {
    ...progress,
    step: 'requested-order-complete',
    pddResolutionSubmission: completion,
    ...(proactive
      ? { pddProactiveTerminalDetailProof: proof }
      : { pddInterceptTerminalDetailProof: proof }),
    pddResolutionOutcomeMismatch: {
      ...progress.pddResolutionOutcomeMismatch,
      status: 'resolved-by-exact-platform-detail',
      proofSha256: proof.detailResponseSha256,
      resolvedAt: archivedAt,
    },
    pddEvidenceScreenshot: deletedEvidence(progress.pddEvidenceScreenshot),
    tmsEvidenceScreenshot: deletedEvidence(progress.tmsEvidenceScreenshot),
    tmsEvidenceDisposition: progress.tmsEvidenceDisposition ? {
      ...progress.tmsEvidenceDisposition,
      status: 'deleted', deletedAt: archivedAt,
      pddCompletedAt: completion.completedAt,
      reason: '同单提交后精确平台详情核实完结；临时文件移入本地备份',
    } : null,
    manualReview: null,
    error: null,
    completionArchive: {
      shopId, orderNumber, platformWorkOrderId,
      platformCaseKey: workOrder.platform_case_key,
      outcome: completion.outcome,
      confirmationMethod: completion.confirmationMethod,
      recoveredFromCompletedPage: false,
      completedAt: completion.completedAt,
      archivedAt,
    },
  };
  assert(archiveReadiness(nextProgress, completion).ready,
    'archive-readiness-still-blocked');
  const report = {
    shopId, orderNumber, scenarioCode, platformWorkOrderId,
    workOrderId: workOrder.id,
    ordinaryInstanceId: workOrder.current_ordinary_instance_id,
    proofKind: proof.kind,
    proofSha256: proof.detailResponseSha256,
    effectCount: effects.length,
    evidenceFiles: evidence.length,
    archivePath,
  };
  if (!apply) {
    await client.query('ROLLBACK');
    inTransaction = false;
    console.log(JSON.stringify({ applied: false, safe: true, ...report }));
  } else {
    const backupDir = path.resolve(nativeRoot, 'backups',
      `terminal-proof-${new Date().toISOString().replace(/[:.]/gu, '-')}-${platformWorkOrderId}`);
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, 'before.json'), JSON.stringify({
      checkedAt: archivedAt, workOrder, effects,
    }, null, 2), { flag: 'wx', mode: 0o600 });
    for (const item of evidence) {
      const destination = path.join(backupDir, item.name);
      await fs.rename(item.source, destination);
      moved.push({ source: item.source, destination });
    }
    await fs.mkdir(completedDir, { recursive: true });
    await fs.writeFile(archivePath, JSON.stringify(nextProgress, null, 2), {
      flag: 'wx', mode: 0o600,
    });
    createdArchive = true;
    const updatedWork = await client.query(`
      UPDATE work_orders SET status = 'archived', runtime_status = 'archived',
        current_step = 'requested-order-complete', payload = $3::jsonb,
        manual_review_reason = NULL, next_attempt_at = NULL,
        completion_state = 'confirmed',
        completion_confirmation_method = 'detail-completed',
        completion_confirmed_at = now(), updated_at = now()
      WHERE id = $1::uuid AND current_ordinary_instance_id = $2::uuid
        AND status = 'paused' AND completion_state = 'pending'
      RETURNING id`, [workOrder.id, workOrder.current_ordinary_instance_id,
      JSON.stringify(nextProgress)]);
    assert(updatedWork.rowCount === 1, 'work-order-changed-before-commit');
    // The database's work_orders trigger synchronizes the current instance.
    // Verify that authoritative transition instead of racing a second update.
    const updatedInstance = await client.query(`
      SELECT status, runtime_status, current_step, completion_method,
        completed_at, payload->'completionArchive'->>'platformCaseKey' AS archive_case_key
      FROM ordinary_work_order_instances
      WHERE id = $1::uuid AND work_order_id = $2::uuid`,
    [workOrder.current_ordinary_instance_id, workOrder.id]);
    assert(updatedInstance.rowCount === 1
      && updatedInstance.rows[0].status === 'archived'
      && updatedInstance.rows[0].runtime_status === 'archived'
      && updatedInstance.rows[0].current_step === 'requested-order-complete'
      && updatedInstance.rows[0].completion_method === 'detail-completed'
      && updatedInstance.rows[0].completed_at
      && updatedInstance.rows[0].archive_case_key === workOrder.platform_case_key,
    'ordinary-instance-trigger-sync-mismatch');
    await client.query('COMMIT');
    inTransaction = false;
    committed = true;
    console.log(JSON.stringify({ applied: true, safe: true, ...report, backupDir }));
  }
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  if (!committed) {
    if (createdArchive) await fs.rm(archivePath, { force: true }).catch(() => {});
    for (const item of moved.reverse()) {
      await fs.rename(item.destination, item.source).catch(() => {});
    }
  }
  throw error;
} finally {
  await client.end();
}
