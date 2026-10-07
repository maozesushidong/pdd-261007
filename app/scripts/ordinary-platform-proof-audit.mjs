import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import pg from 'pg';

const platformCaseMismatch = (observedId, expectedId, declaredMatches) => (
  declaredMatches === 'false'
  || Boolean(observedId && expectedId && observedId !== expectedId)
);

if (process.argv.includes('--self-test')) {
  assert.equal(platformCaseMismatch('500013434467151', '500013434467151', 'true'), false);
  assert.equal(platformCaseMismatch('500013435586822', '500013434467151', 'false'), true);
  assert.equal(platformCaseMismatch('500013435586822', '500013434467151', null), true);
  assert.equal(platformCaseMismatch(null, '500013434467151', null), false);
  console.log('普通工单完成页平台工单身份审计自测通过');
  process.exit(0);
}

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sinceInput = process.argv[process.argv.indexOf('--since') + 1];
if (!sinceInput || Number.isNaN(Date.parse(sinceInput))) {
  throw new Error('--since requires an ISO-8601 timestamp');
}
const since = new Date(sinceInput).toISOString();
const nativeEnvironment = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = nativeEnvironment.split(/\r?\n/u)
  .find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'ordinary-platform-proof-readonly-audit',
});
await client.connect();
try {
  const { rows } = await client.query(`
    SELECT shop.name AS "shopName",
      work_order.external_order_number AS "orderNumber",
      instance.platform_case_id AS "platformCaseId",
      instance.scenario_code AS "scenarioCode",
      instance.current_step AS "currentStep",
      instance.completion_method AS "instanceCompletionMethod",
      instance.completed_at AS "completedAt",
      effect_counts.total_count AS "totalPddEffects",
      effect_counts.succeeded_count AS "succeededPddEffects",
      effect_counts.unresolved_count AS "unresolvedPddEffects",
      effect.receipt #>> '{result,completedOutcome}' AS "effectPageOutcome",
      effect.receipt #>> '{result,isCompleted}' AS "effectPageCompleted",
      effect.receipt #>> '{result,orderMatches}' AS "effectPageOrderMatches",
      effect.receipt #>> '{result,orderNumber}' AS "effectPageOrderNumber",
      effect.receipt #>> '{result,detailReady}' AS "effectDetailReady",
      effect.receipt #>> '{result,workOrderStatus}' AS "effectWorkOrderStatus",
      effect.receipt #>> '{result,isExpectedWorkOrderType}'
        AS "effectExpectedWorkOrderType",
      effect.receipt #>> '{result,selectedPddOutcome}' AS "effectSelectedOutcome",
      effect.receipt #>> '{result,submitClicked}' AS "submitClicked",
      effect.receipt #>> '{result,transitionConfirmed}' AS "transitionConfirmed",
      instance.payload #>> '{pddResolutionSubmission,completionEvidence}' AS "instancePageEvidence",
      instance.payload #>> '{pddResolutionSubmission,confirmationMethod}' AS "instanceConfirmationMethod",
      instance.payload #>> '{pddResolutionSubmission,platformCompletionObservation,isCompleted}'
        AS "instancePageCompleted",
      instance.payload #>> '{pddResolutionSubmission,platformCompletionObservation,orderMatches}'
        AS "instancePageOrderMatches",
      instance.payload #>> '{pddResolutionSubmission,platformCompletionObservation,confirmationMethod}'
        AS "instancePageConfirmationMethod",
      instance.payload #>> '{pddResolutionSubmission,platformCompletionObservation,observedAt}'
        AS "instancePageObservedAt",
      instance.payload #>> '{pddResolutionSubmission,platformCompletionObservation,observedPlatformWorkOrderId}'
        AS "instanceObservedPlatformId",
      instance.payload #>> '{pddResolutionSubmission,platformCompletionObservation,platformCaseMatches}'
        AS "instancePlatformCaseMatches",
      instance.payload #>> '{pddResolutionPendingListPresence,present}' AS "pendingListPresent",
      instance.payload #>> '{pddResolutionPendingListPresence,refreshed}' AS "pendingListRefreshed",
      instance.payload #>> '{pddResolutionPendingListPresence,confirmationMethod}' AS "pendingListConfirmationMethod",
      instance.payload #>> '{pddResolutionPendingListPresence,exactShopIdentity}' AS "pendingListExactShopIdentity",
      instance.payload #>> '{pddResolutionPendingListPresence,confirmedAt}' AS "pendingListConfirmedAt",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,pendingListProof,present}' END
        AS "archivedPendingListPresent",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,pendingListProof,refreshed}' END
        AS "archivedPendingListRefreshed",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,pendingListProof,confirmationMethod}' END
        AS "archivedPendingListConfirmationMethod",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,pendingListProof,exactShopIdentity}' END
        AS "archivedPendingListExactShopIdentity",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,pendingListProof,confirmedAt}' END
        AS "archivedPendingListConfirmedAt",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,completionEvidence}' END
        AS "archivedPageEvidence",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,outcome}' END
        AS "archivedOutcome",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,confirmationMethod}' END
        AS "archivedConfirmationMethod",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,isCompleted}' END
        AS "archivedPageCompleted",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,orderMatches}' END
        AS "archivedPageOrderMatches",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,confirmationMethod}' END
        AS "archivedPageConfirmationMethod",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,observedAt}' END
        AS "archivedPageObservedAt",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,observedPlatformWorkOrderId}' END
        AS "archivedObservedPlatformId",
      CASE WHEN work_order.payload #>> '{lastCompletedOrder,ordinaryInstanceId}' = instance.id::text
        THEN work_order.payload #>> '{lastCompletedOrder,platformCompletionObservation,platformCaseMatches}' END
        AS "archivedPlatformCaseMatches"
    FROM ordinary_work_order_instances instance
    JOIN work_orders work_order ON work_order.id = instance.work_order_id
    JOIN shops shop ON shop.id = instance.shop_id AND shop.enabled = true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total_count,
        count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_count,
        count(*) FILTER (WHERE status IN ('reserved', 'unknown'))::int AS unresolved_count
      FROM external_effects
      WHERE work_order_id = work_order.id
        AND ordinary_instance_id = instance.id
        AND effect_type = 'pdd-submit'
    ) effect_counts ON true
    LEFT JOIN LATERAL (
      SELECT receipt FROM external_effects
      WHERE work_order_id = work_order.id
        AND ordinary_instance_id = instance.id
        AND effect_type = 'pdd-submit'
        AND status = 'succeeded'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    ) effect ON true
    WHERE instance.completed_at >= $1::timestamptz
      AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    ORDER BY instance.completed_at DESC
    LIMIT 200`, [since]);
  const records = rows.map((row) => {
    const pageOutcome = row.effectPageOutcome || row.instancePageEvidence
      || row.archivedPageEvidence || null;
    const pendingListPresent = row.pendingListPresent ?? row.archivedPendingListPresent;
    const pendingListRefreshed = row.pendingListRefreshed ?? row.archivedPendingListRefreshed;
    const pendingListConfirmationMethod = row.pendingListConfirmationMethod
      || row.archivedPendingListConfirmationMethod;
    const pendingListExactShopIdentity = row.pendingListExactShopIdentity
      ?? row.archivedPendingListExactShopIdentity;
    const pendingListConfirmedAt = row.pendingListConfirmedAt
      || row.archivedPendingListConfirmedAt;
    const pageCompleted = row.instancePageCompleted ?? row.archivedPageCompleted;
    const pageOrderMatches = row.instancePageOrderMatches ?? row.archivedPageOrderMatches;
    const pageConfirmationMethod = row.instancePageConfirmationMethod
      || row.archivedPageConfirmationMethod;
    const pageObservedAt = row.instancePageObservedAt || row.archivedPageObservedAt;
    const observedPlatformId = row.instanceObservedPlatformId || row.archivedObservedPlatformId;
    const platformCaseMatches = row.instancePlatformCaseMatches
      ?? row.archivedPlatformCaseMatches;
    const explicitPlatformCaseMismatch = platformCaseMismatch(
      observedPlatformId, row.platformCaseId, platformCaseMatches,
    );
    const exactCompletedDetail = pageCompleted === 'true'
      && pageOrderMatches === 'true'
      && !explicitPlatformCaseMismatch
      && ['detail-completed', 'refreshed-detail-completed',
        'handover-detail-completed', 'recall-status-detail-completed']
        .includes(pageConfirmationMethod)
      && Boolean(pageObservedAt);
    const exactCompletedEffectDetail = row.effectPageCompleted === 'true'
      && row.effectPageOrderMatches === 'true'
      && row.effectPageOrderNumber === row.orderNumber
      && row.effectDetailReady === 'true'
      && row.effectWorkOrderStatus === '已完结'
      && row.effectExpectedWorkOrderType === 'true'
      && Number(row.succeededPddEffects) > 0
      && Number(row.unresolvedPddEffects) === 0;
    const exactCompletedRow = pendingListPresent === 'false'
      && pendingListRefreshed === 'true'
      && pendingListExactShopIdentity === 'true'
      && Boolean(pendingListConfirmedAt)
      && pendingListConfirmationMethod === 'exact-order-completed';
    const exactEmptyPending = pendingListPresent === 'false'
      && pendingListRefreshed === 'true'
      && pendingListExactShopIdentity === 'true'
      && Boolean(pendingListConfirmedAt)
      && ['two-pass-exact-order-query', 'exact-order-zero-result']
        .includes(pendingListConfirmationMethod);
    const proofClass = explicitPlatformCaseMismatch ? 'platform-case-mismatch'
      : pageOutcome ? 'explicit-page-outcome'
      : row.effectSelectedOutcome && row.submitClicked === 'true'
          && row.transitionConfirmed === 'true'
          ? 'submitted-option-and-transition'
        : exactCompletedDetail || exactCompletedEffectDetail
          ? 'exact-completed-detail-no-outcome'
        : exactCompletedRow ? 'exact-completed-row'
          : exactEmptyPending ? 'refreshed-exact-empty-pending-list'
          : row.archivedOutcome ? 'recorded-outcome-only'
            : row.succeededPddEffects > 0 ? 'submit-effect-only'
              : 'no-explicit-platform-outcome';
    return {
      shopName: row.shopName,
      orderNumber: row.orderNumber,
      platformCaseId: row.platformCaseId,
      scenarioCode: row.scenarioCode,
      currentStep: row.currentStep,
      completedAt: row.completedAt,
      instanceCompletionMethod: row.instanceCompletionMethod,
      archivedConfirmationMethod: row.archivedConfirmationMethod,
      instanceConfirmationMethod: row.instanceConfirmationMethod,
      pageOutcome,
      selectedOutcome: row.effectSelectedOutcome || null,
      archivedOutcome: row.archivedOutcome || null,
      totalPddEffects: row.totalPddEffects,
      succeededPddEffects: row.succeededPddEffects,
      unresolvedPddEffects: row.unresolvedPddEffects,
      pendingListPresent,
      pendingListRefreshed,
      pendingListConfirmationMethod,
      pendingListExactShopIdentity,
      pendingListConfirmedAt,
      pageCompleted,
      pageOrderMatches,
      pageConfirmationMethod,
      pageObservedAt,
      observedPlatformId,
      platformCaseMatches,
      explicitPlatformCaseMismatch,
      exactCompletedDetail,
      exactCompletedEffectDetail,
      exactCompletedRow,
      exactEmptyPending,
      proofClass,
    };
  });
  const counts = Object.fromEntries([...new Set(records.map((record) => record.proofClass))]
    .map((proofClass) => [proofClass,
      records.filter((record) => record.proofClass === proofClass).length]));
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    since,
    checked: records.length,
    counts,
    records,
  }, null, 2));
} finally {
  await client.end();
}
