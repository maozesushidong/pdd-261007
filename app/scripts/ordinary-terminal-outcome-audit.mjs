import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ordinaryTerminalOutcomeConflicts } from '../workflow-runtime.mjs';
import { verifiedProactiveSummaryMatchesCompletion } from '../packages/adapters/src/pdd/proactive-terminal-proof.mjs';
import { verifiedInterceptSummaryMatchesCompletion } from '../packages/adapters/src/pdd/intercept-terminal-proof.mjs';

const classify = (record) => {
  const archive = record.completionArchive || {};
  const submission = record.pddResolutionSubmission || {};
  const planned = submission.outcome || archive.outcome || null;
  const observed = submission.completionEvidence || null;
  if (!observed) return { kind: 'no-outcome-text', planned, observed };
  if (['refreshed-exact-empty-pending-list', 'exact-order-completed'].includes(planned)) {
    return { kind: 'read-only-outcome-observed', planned, observed };
  }
  if (observed === planned) return { kind: 'exact-match', planned, observed };
  if (planned && observed.includes(planned)) {
    return { kind: 'expanded-platform-text', planned, observed };
  }
  if (verifiedProactiveSummaryMatchesCompletion({
    proof: record.pddProactiveTerminalDetailProof,
    progress: record,
    completion: submission,
    scenarioCode: record.scenarioCode,
    expectedOutcome: planned,
    observedOutcome: observed,
    observedResultOption: submission.completionResultOption,
  })) {
    return { kind: 'verified-platform-detail-hierarchy', planned, observed };
  }
  if (verifiedInterceptSummaryMatchesCompletion({
    proof: record.pddInterceptTerminalDetailProof,
    progress: record,
    completion: submission,
    scenarioCode: record.scenarioCode,
    expectedOutcome: planned,
    observedOutcome: observed,
    observedResultOption: submission.completionResultOption,
  })) {
    return { kind: 'verified-intercept-platform-detail', planned, observed };
  }
  const selectionProof = record.pddSubmitSelectionProof || {};
  const selectionVerified = selectionProof.status === 'verified'
    && Array.isArray(selectionProof.selections)
    && selectionProof.selections.some((selection) => selection.actualLabel === planned)
    && (!selectionProof.missingLabels || selectionProof.missingLabels.length === 0)
    && (!selectionProof.wrongFrameLabels || selectionProof.wrongFrameLabels.length === 0);
  if (submission.submitClicked === true
    && submission.submitReceipt?.success === true
    && submission.transitionConfirmed === true
    && selectionVerified) {
    if (ordinaryTerminalOutcomeConflicts({
      scenarioCode: record.scenarioCode,
      expectedOutcome: planned,
      observedOutcome: observed,
    })) {
      return { kind: 'business-outcome-conflict', planned, observed };
    }
    return { kind: 'confirmed-submit-different-terminal-text', planned, observed };
  }
  return { kind: 'unconfirmed-different-terminal-text', planned, observed };
};

if (process.argv.includes('--self-test')) {
  const record = (planned, observed, submission = {}, selectionProof = null) => ({
    completionArchive: { outcome: planned },
    pddResolutionSubmission: { outcome: planned, completionEvidence: observed, ...submission },
    pddSubmitSelectionProof: selectionProof,
  });
  assert.equal(classify(record('已进行召回', '已进行召回')).kind, 'exact-match');
  assert.equal(classify(record('协商退款重拍', '不同意修改地址；协商退款重拍')).kind,
    'expanded-platform-text');
  assert.equal(classify(record('已进行召回', '已同意退货退款', {
    submitClicked: true, submitReceipt: { success: true }, transitionConfirmed: true,
  }, {
    status: 'verified', selections: [{ actualLabel: '已进行召回' }],
    missingLabels: [], wrongFrameLabels: [],
  })).kind, 'confirmed-submit-different-terminal-text');
  assert.equal(classify(record('已进行召回', '已同意退货退款', {
    submitClicked: true, submitReceipt: { success: true }, transitionConfirmed: true,
  })).kind, 'unconfirmed-different-terminal-text');
  assert.equal(classify(record('已进行召回', '已同意退货退款')).kind,
    'unconfirmed-different-terminal-text');
  assert.equal(classify(record('refreshed-exact-empty-pending-list', '已同意退货退款')).kind,
    'read-only-outcome-observed');
  assert.equal(classify(record('exact-order-completed', '已同意退货退款')).kind,
    'read-only-outcome-observed');
  assert.equal(classify({
    ...record('已进行召回', '已同意退货退款', {
      submitClicked: true, submitReceipt: { success: true }, transitionConfirmed: true,
    }, {
      status: 'verified', selections: [{ actualLabel: '已进行召回' }],
      missingLabels: [], wrongFrameLabels: [],
    }),
    scenarioCode: 'intercept-recall',
  }).kind, 'business-outcome-conflict');
  assert.equal(classify({
    ...record('无法确认快递单号', '未收到退货商品', {
      submitClicked: true, submitReceipt: { success: true }, transitionConfirmed: true,
    }, {
      status: 'verified', selections: [{ actualLabel: '无法确认快递单号' }],
      missingLabels: [], wrongFrameLabels: [],
    }),
    scenarioCode: 'proactive-logistics-service',
  }).kind, 'business-outcome-conflict');
  const hierarchyProof = {
    status: 'verified', kind: 'exact-pdd-completed-detail-flow-after-submit',
    orderNumber: '260904-522495015212028', platformWorkOrderId: '500013405960020',
    scenarioCode: 'proactive-logistics-service', finalOption: '无法确认快递单号',
    resultOption: '未查到退货物流轨迹', completionSummary: '未收到退货商品',
    detailResponseSha256: 'a'.repeat(64),
  };
  const verifiedHierarchyRecord = {
    ...record('无法确认快递单号', '未收到退货商品', {
      orderNumber: hierarchyProof.orderNumber,
      completionResultOption: '未查到退货物流轨迹',
      confirmationMethod: 'detail-completed',
      submitClicked: true, submitReceipt: { success: true, httpStatus: 200 },
      transitionConfirmed: true, platformDetailProof: hierarchyProof,
    }),
    orderNumber: hierarchyProof.orderNumber,
    platformWorkOrderId: hierarchyProof.platformWorkOrderId,
    scenarioCode: hierarchyProof.scenarioCode,
    pddProactiveTerminalDetailProof: hierarchyProof,
    pddSubmitSelectionProof: {
      status: 'verified', selections: [{ actualLabel: '无法确认快递单号' }],
      missingLabels: [], wrongFrameLabels: [],
    },
  };
  assert.equal(classify(verifiedHierarchyRecord).kind, 'verified-platform-detail-hierarchy');
  assert.equal(classify({ ...verifiedHierarchyRecord,
    pddProactiveTerminalDetailProof: null }).kind, 'business-outcome-conflict');
  const interceptProof = {
    status: 'verified', kind: 'exact-pdd-intercept-completed-detail-flow-after-submit',
    orderNumber: '260920-119181228412252', platformWorkOrderId: '500013403310662',
    scenarioCode: 'intercept-recall', finalOption: '消费者已收到货',
    completionSummary: '已同意退货退款', detailResponseSha256: 'b'.repeat(64),
  };
  const verifiedInterceptRecord = {
    ...record('消费者已收到货', '已同意退货退款', {
      orderNumber: interceptProof.orderNumber,
      confirmationMethod: 'detail-completed',
      submitClicked: true, submitReceipt: { success: true, httpStatus: 200 },
      transitionConfirmed: true, platformDetailProof: interceptProof,
    }),
    orderNumber: interceptProof.orderNumber,
    platformWorkOrderId: interceptProof.platformWorkOrderId,
    scenarioCode: interceptProof.scenarioCode,
    pddInterceptTerminalDetailProof: interceptProof,
    pddSubmitSelectionProof: {
      status: 'verified', selections: [{ actualLabel: '消费者已收到货' }],
      missingLabels: [], wrongFrameLabels: [],
    },
  };
  assert.equal(classify(verifiedInterceptRecord).kind, 'verified-intercept-platform-detail');
  assert.equal(classify({ ...verifiedInterceptRecord,
    pddInterceptTerminalDetailProof: null }).kind, 'business-outcome-conflict');
  assert.equal(classify({
    ...record('可以送达', '已同意退货退款', {
      submitClicked: true, submitReceipt: { success: true }, transitionConfirmed: true,
    }, {
      status: 'verified', selections: [{ actualLabel: '可以送达' }],
      missingLabels: [], wrongFrameLabels: [],
    }),
    scenarioCode: 'delivered-not-received',
  }).kind, 'business-outcome-conflict');
  assert.equal(classify({
    ...record('已进行召回', '已同意退货退款'),
    scenarioCode: 'intercept-recall',
  }).kind, 'unconfirmed-different-terminal-text');
  console.log('ordinary terminal outcome audit self-test passed');
  process.exit(0);
}

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const lookbackHours = Number(argument('--lookback-hours') || 24);
if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
  throw new Error('--lookback-hours requires a positive number');
}
const cutoff = Date.now() - lookbackHours * 60 * 60_000;
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shopRoot = path.resolve(appRoot, '..', 'data', 'workflow', 'shops');
const counts = {};
const differences = [];
const otherCandidates = [];
const noOutcomeProof = {
  submitReceiptAndTransition: 0,
  guardedOptionSelection: 0,
  completedPage: 0,
  pendingListAbsence: 0,
  messageStageCompleted: 0,
  legacyDirectSubmitReceiptAndPage: 0,
  feedbackEffectAndCompletedPage: 0,
  other: 0,
  otherSamples: [],
};
let archived = 0;
let identityMismatch = 0;

for (const shop of (await fs.readdir(shopRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())) {
  const completedDirectory = path.join(shopRoot, shop.name, 'state', 'completed-work-orders');
  let names;
  try {
    names = await fs.readdir(completedDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const filename = path.join(completedDirectory, name);
    const stat = await fs.stat(filename).catch(() => null);
    if (!stat || stat.mtimeMs < cutoff) continue;
    let record;
    try {
      record = JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch {
      continue;
    }
    const archive = record.completionArchive || {};
    if (!(Date.parse(archive.archivedAt || '') >= cutoff)) continue;
    archived += 1;
    const platformId = archive.platformCaseKey?.match(/^pdd-work-order:(\d+)$/u)?.[1] || null;
    if (platformId && name !== `pdd-work-order-${platformId}.json`) identityMismatch += 1;
    const result = classify(record);
    counts[result.kind] = (counts[result.kind] || 0) + 1;
    if (result.kind === 'no-outcome-text') {
      const submission = record.pddResolutionSubmission || {};
      const proof = submission.submitClicked === true
        && submission.submitReceipt?.success === true
        && submission.transitionConfirmed === true
        ? 'submitReceiptAndTransition'
        : submission.completedDuringGuardedOptionSelection === true
          ? 'guardedOptionSelection'
        : archive.recoveredFromCompletedPage === true
          && ['detail-completed', 'handover-detail-completed'].includes(archive.confirmationMethod)
          ? 'completedPage'
          : archive.confirmationMethod === 'absent-from-pending-list'
            ? 'pendingListAbsence'
            : 'other';
      noOutcomeProof[proof] += 1;
      if (proof === 'other') {
        otherCandidates.push({
          shopId: shop.name,
          orderNumber: archive.orderNumber || null,
          platformCaseKey: archive.platformCaseKey || null,
          scenarioCode: submission.scenarioCode || null,
          confirmationMethod: archive.confirmationMethod || null,
          recovered: archive.recoveredFromCompletedPage === true,
          submitClicked: submission.submitClicked === true,
          messageStage: record.ordinaryPddMessageStage?.status || null,
          messageOrderCompleted: record.ordinaryPddMessageStage?.orderCompleted === true,
          feedbackClickAttempted: record.ordinaryFeedbackSubmission?.clickAttempted === true,
          feedbackTransitionObserved: record.ordinaryFeedbackSubmission?.postClickTransitionObserved === true,
          archivedAt: archive.archivedAt,
        });
      }
    }
    if (!result.kind.includes('different-terminal-text')
      && result.kind !== 'business-outcome-conflict') continue;
    differences.push({
      shopId: shop.name,
      orderNumber: archive.orderNumber || null,
      platformCaseKey: archive.platformCaseKey || null,
      planned: result.planned,
      observed: result.observed,
      classification: result.kind,
      submitReceiptSuccess: record.pddResolutionSubmission?.submitReceipt?.success === true,
      transitionConfirmed: record.pddResolutionSubmission?.transitionConfirmed === true,
      archivedAt: archive.archivedAt,
    });
  }
}

if (otherCandidates.length) {
  const envFile = await fs.readFile(path.join(appRoot, '.env.native'), 'utf8').catch(() => '');
  const databaseUrl = process.env.DATABASE_URL || envFile.split(/\r?\n/u)
    .find((line) => line.startsWith('DATABASE_URL='))
    ?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
  if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
    application_name: 'ordinary-terminal-outcome-readonly-audit' });
  let effects;
  try {
    effects = (await pool.query(`
      SELECT idempotency_key AS "idempotencyKey", status,
        receipt #>> '{result,isCompleted}' AS "isCompleted",
        receipt #>> '{result,orderMatches}' AS "orderMatches",
        receipt #>> '{result,submitReceipt,success}' AS "submitReceiptSuccess",
        receipt #>> '{result,transitionConfirmed}' AS "transitionConfirmed",
        receipt #>> '{result,orderCompleted}' AS "orderCompleted",
        receipt #>> '{result,responseConfirmed}' AS "responseConfirmed",
        receipt #>> '{result,submittedAt}' AS "submittedAt",
        receipt #>> '{result,postClickTransitionObserved}' AS "postClickTransitionObserved"
      FROM external_effects
      WHERE effect_type = 'pdd-submit'
        AND idempotency_key LIKE ANY($1::text[])
    `, [otherCandidates.map((item) => `pdd-submit:${item.shopId}:${item.platformCaseKey}:%`)]))
      .rows;
  } finally {
    await pool.end();
  }
  for (const item of otherCandidates) {
    const prefix = `pdd-submit:${item.shopId}:${item.platformCaseKey}:`;
    const matching = effects.filter((effect) => effect.idempotencyKey.startsWith(prefix)
      && effect.status === 'succeeded');
    let proof = 'other';
    if (item.messageStage === 'transition-confirmed' && item.messageOrderCompleted
      && matching.some((effect) => effect.idempotencyKey.endsWith('-send-script-v1')
        && effect.orderCompleted === 'true' && effect.responseConfirmed === 'true')) {
      proof = 'messageStageCompleted';
    } else if (matching.some((effect) => effect.isCompleted === 'true'
      && effect.orderMatches === 'true'
      && effect.submitReceiptSuccess === 'true'
      && effect.transitionConfirmed === 'true')) {
      proof = 'legacyDirectSubmitReceiptAndPage';
    } else if (item.scenarioCode === 'product-shortage'
      && item.confirmationMethod === 'detail-completed'
      && matching.some((effect) => effect.idempotencyKey.endsWith('ordinary-product-shortage-no-shortage-feedback')
        && Boolean(effect.submittedAt))) {
      proof = 'feedbackEffectAndCompletedPage';
    }
    if (proof === 'other') {
      if (noOutcomeProof.otherSamples.length < 100) {
        noOutcomeProof.otherSamples.push({ ...item, effectStages: matching.map((effect) =>
          effect.idempotencyKey.slice(prefix.length)) });
      }
    } else {
      noOutcomeProof.other -= 1;
      noOutcomeProof[proof] += 1;
    }
  }
}

differences.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  lookbackHours,
  archived,
  counts,
  noOutcomeProof,
  identityMismatch,
  differences,
}, null, 2));
if (identityMismatch || noOutcomeProof.other
  || (counts['unconfirmed-different-terminal-text'] || 0) > 0
  || (counts['business-outcome-conflict'] || 0) > 0) {
  process.exitCode = 1;
}
