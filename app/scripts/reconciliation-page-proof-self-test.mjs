import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import { renderedOrdinaryCompletionObservation } from '../workflow-runtime.mjs';

const workflow = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const start = workflow.indexOf('function buildPddSubmissionReconciliationObservation(');
const end = workflow.indexOf('function protectPddPostSubmitReadOnlyObservation(', start);
assert(start >= 0 && end > start);
const sandbox = { renderedOrdinaryCompletionObservation, Date, Number, Math };
vm.runInNewContext(workflow.slice(start, end) + '\nglobalThis.build = buildPddSubmissionReconciliationObservation;', sandbox);
const orderNumber = '260929-111111111111111';
const platformCaseId = '500013451716163';
const exact = { isCompleted: true, orderMatches: true, detailReady: true,
  isExpectedWorkOrderType: true, completedOutcome: null,
  confirmationMethod: 'refreshed-detail-completed', observedPlatformWorkOrderId: platformCaseId };
const observation = sandbox.build({ pageState: exact, orderNumber, expectedPlatformWorkOrderId: platformCaseId });
assert.equal(observation.platformCompletionObservation.platformCaseMatches, true);
assert.equal(observation.completionEvidence, null, 'a completed page must not invent the result option');
for (const override of [{ confirmationMethod: 'absent-from-pending-list' },
  { observedPlatformWorkOrderId: '500013451716164' }, { observedPlatformWorkOrderId: null },
  { orderMatches: false }, { detailReady: false }, { isExpectedWorkOrderType: false }]) {
  const candidate = sandbox.build({ pageState: { ...exact, ...override }, orderNumber,
    expectedPlatformWorkOrderId: platformCaseId });
  assert.equal(candidate.platformCompletionObservation, undefined);
}
const unknown = sandbox.build({ pageState: { isPending: true, confirmedNotApplied: true },
  orderNumber, previousSubmission: { externalEffectStatus: 'unknown', submitAttemptCount: 1 } });
assert.equal(unknown.state, 'unresolved');
assert.equal(unknown.automaticRetryBlockedByClickAttempt, true);
const reconcile = workflow.indexOf('  const submissionObservation = buildPddSubmissionReconciliationObservation(');
const writeStart = workflow.indexOf('  writeProgress({', reconcile);
const writeEnd = workflow.indexOf("  logRunStep('external-state-reconciled'", writeStart);
assert(reconcile > 0 && writeEnd > writeStart);
let recorded;
Object.assign(sandbox, { observation, pageState: exact, shopId: 'test-shop', orderNumber,
  readProgress: () => ({ pddResolutionDecision: { outcome: '同意退款' } }),
  targetPage: { url: () => `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformCaseId}` },
  writeProgress: (value) => { recorded = value; } });
vm.runInNewContext(workflow.slice(writeStart, writeEnd), sandbox);
assert.equal(recorded.pddResolutionSubmission.platformCompletionObservation,
  observation.platformCompletionObservation, 'the actual progress writer must retain the page proof');

// Exercise the audit's actual SQL predicate against synthetic rows, read-only.
const audit = fs.readFileSync(new URL('./runtime-progress-audit.mjs', import.meta.url), 'utf8');
const predicate = audit.match(/const exactCompletedPageProof = `([\s\S]*?)`;/u)?.[1];
assert(predicate);
const line = fs.readFileSync(new URL('../.env.native', import.meta.url), 'utf8')
  .split(/\r?\n/u).find((value) => value.startsWith('DATABASE_URL='));
const db = new pg.Pool({ connectionString: line.slice(13).trim().replace(/^(['"])(.*)\1$/u, '$2'),
  max: 1, application_name: 'reconciliation-proof-synthetic-readonly-test' });
try {
  const instanceId = '00000000-0000-4000-8000-000000000001';
  const query = `WITH instance AS (SELECT $1::uuid AS id, $2::text AS shop_id, $3::text AS platform_case_id,
      $7::jsonb AS payload),
    work_order AS (SELECT $4::uuid AS current_ordinary_instance_id, $5::text AS external_order_number,
      $6::jsonb AS payload, $8::text AS shop_id)
    SELECT coalesce(${predicate}, false) AS verified FROM instance, work_order`;
  const check = async (submission, expected, currentInstance = instanceId) => {
    const result = await db.query(query, [instanceId, 'test-shop', platformCaseId, currentInstance,
      orderNumber, JSON.stringify({ pddResolutionSubmission: submission }), '{}', 'test-shop']);
    assert.equal(result.rows[0].verified, expected);
  };
  const submission = recorded.pddResolutionSubmission;
  await check(submission, true);
  for (const changed of [{ shopId: 'other' }, { orderNumber: '260929-222222222222222' },
    { confirmationMethod: 'absent-from-pending-list' }, { platformCompletionObservation: null },
    { platformCompletionObservation: { ...submission.platformCompletionObservation,
      observedPlatformWorkOrderId: '500013451716164' } }]) await check({ ...submission, ...changed }, false);
  await check(submission, false, '00000000-0000-4000-8000-000000000002');
  // The next case on an order clears the mutable work_order payload. The
  // previous case's exact page evidence must remain attributable to itself.
  const completed = { ordinaryInstanceId: instanceId, orderNumber,
    platformWorkOrderId: platformCaseId, confirmationMethod: 'detail-completed',
    platformCompletionObservation: submission.platformCompletionObservation };
  const checkStoredInstance = async (proof, expected, shopId = 'test-shop') => {
    const result = await db.query(query, [instanceId, 'test-shop', platformCaseId,
      '00000000-0000-4000-8000-000000000002', orderNumber, '{}',
      JSON.stringify({ lastCompletedOrder: proof }), shopId]);
    assert.equal(result.rows[0].verified, expected);
  };
  await checkStoredInstance(completed, true);
  for (const changed of [{ ordinaryInstanceId: '00000000-0000-4000-8000-000000000002' },
    { orderNumber: '260929-222222222222222' }, { platformWorkOrderId: '500013451716164' },
    { confirmationMethod: 'absent-from-pending-list' }, { platformCompletionObservation: null },
    { platformCompletionObservation: { ...completed.platformCompletionObservation,
      observedPlatformWorkOrderId: '500013451716164' } },
    { platformCompletionObservation: { ...completed.platformCompletionObservation,
      orderMatches: false } }]) await checkStoredInstance({ ...completed, ...changed }, false);
  await checkStoredInstance(completed, false, 'other-shop');
} finally { await db.end(); }
console.log('Reconciliation page proof passed (actual builder/writer, exact identity, no invented outcome, unknown effect protected, read-only SQL audit)');
