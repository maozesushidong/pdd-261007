import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ordinaryPlatformCaseIdentity } from '../packages/adapters/src/postgres/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validId = '23901876543210';
const validUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${validId}`;

assert.deepEqual(ordinaryPlatformCaseIdentity({ detailUrl: validUrl }), {
  platformCaseKey: `pdd-work-order:${validId}`,
  platformCaseId: validId,
});
assert.deepEqual(ordinaryPlatformCaseIdentity({ platformCaseId: validId }), {
  platformCaseKey: null,
  platformCaseId: null,
});
assert.deepEqual(ordinaryPlatformCaseIdentity({
  detailUrl: validUrl,
  platformCaseId: validId,
  platformCaseKey: `pdd-work-order:${validId}`,
}), {
  platformCaseKey: `pdd-work-order:${validId}`,
  platformCaseId: validId,
});
assert.deepEqual(ordinaryPlatformCaseIdentity({
  detailUrl: validUrl,
  platformCaseId: '23901876543211',
}), {
  platformCaseKey: null,
  platformCaseId: null,
});
for (const detailUrl of [
  `https://example.com/aftersales/work_order/tododetail?id=${validId}`,
  `https://mms.pinduoduo.com/aftersales/work_order/list?id=${validId}`,
  'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=not-a-number',
]) {
  assert.deepEqual(ordinaryPlatformCaseIdentity({ detailUrl }), {
    platformCaseKey: null,
    platformCaseId: null,
  });
}

const [
  migration,
  repository,
  apiBackend,
  drawer,
  dashboard,
  workerSync,
  scenarioConfigText,
  tmsCreatedRowRecoveryMigration,
  tmsCreatedRowRequeryMigration,
  pddOrderRemarkReloadAbortRecoveryMigration,
  prefilledReplySubmitRecoveryMigration,
  pddEvidenceOrderParsingRecoveryMigration,
  uploadInterventionDedupMigration,
  deliveredAddressNoClickRecoveryMigration,
  legacyUnclickedSecondAttemptRecoveryMigration,
  lateUploadInterventionDedupMigration,
] = await Promise.all([
  fsp.readFile(path.join(root, 'infra/db/migrations/059_ordinary_work_order_instances.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'packages/adapters/src/postgres/index.mjs'), 'utf8'),
  fsp.readFile(path.join(root, 'apps/api/src/data-backend.mjs'), 'utf8'),
  fsp.readFile(path.join(root, 'apps/web/src/components/WorkOrderDrawer.jsx'), 'utf8'),
  fsp.readFile(path.join(root, 'apps/web/src/features/dashboard/DashboardView.jsx'), 'utf8'),
  fsp.readFile(path.join(root, 'scripts/sync-windows-worker-state.mjs'), 'utf8'),
  fsp.readFile(path.join(root, 'config/scenarios.json'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/165_recover_api_created_tms_row_verification.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/166_requery_api_created_tms_rows.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/167_recover_pdd_order_remark_reload_abort.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/168_recover_prefilled_reply_submit_form.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/169_recover_pdd_evidence_order_parsing.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/174_resolve_duplicate_upload_interventions.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/178_recover_delivered_address_no_click_submit.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/179_recover_legacy_unclicked_second_submit_attempts.sql'), 'utf8'),
  fsp.readFile(path.join(root, 'infra/db/migrations/180_resolve_late_duplicate_upload_interventions.sql'), 'utf8'),
]);

assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_ordinary_instances_platform_case/);
assert.match(migration, /trg_enforce_current_ordinary_instance_ownership/);
assert.match(migration, /trg_enforce_ordinary_instance_ownership/);
assert.match(migration, /trg_sync_current_ordinary_instance/);
assert.match(migration, /trg_enforce_ordinary_instance_shop_ownership/);
assert.match(migration, /identityBackfillConflict/);
assert.match(migration, /'oms-reissue-create'/);
assert.match(repository, /ordinary-work-order-instance-deferred/);
assert.match(repository, /ordinary-work-order-instance-promoted/);
assert.match(repository, /promoteNextDeferredOrdinaryInstance/);
assert.match(repository, /paused-ordinary-instance-yielded/);
assert.match(repository, /lower\(current_instance\.status\) = 'paused'/);
assert.match(repository, /status = 'deferred', runtime_status = 'waiting'/);
assert.match(repository, /effect\.status IN \('reserved','unknown'\)/);
assert.match(repository, /ordinary_instance_id IS NOT DISTINCT FROM work_order\.current_ordinary_instance_id/);
assert.match(tmsCreatedRowRecoveryMigration, /api-created-tms-row-verification-recovered/);
assert.match(tmsCreatedRowRecoveryMigration, /lastObservedCount/);
assert.match(tmsCreatedRowRecoveryMigration, /effect\.effect_type = 'tms-create'/);
assert.match(tmsCreatedRowRecoveryMigration, /effect\.status = 'succeeded'/);
assert.match(tmsCreatedRowRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(tmsCreatedRowRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(tmsCreatedRowRequeryMigration, /api-created-tms-row-requery-recovered/);
assert.match(tmsCreatedRowRequeryMigration, /lastObservedCount'\s+IS DISTINCT FROM '1'/);
assert.match(tmsCreatedRowRequeryMigration, /work_order\.recovery_state <> 'held'/);
assert.match(tmsCreatedRowRequeryMigration, /effect\.effect_type = 'tms-create'/);
assert.match(tmsCreatedRowRequeryMigration, /effect\.status = 'succeeded'/);
assert.match(tmsCreatedRowRequeryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(tmsCreatedRowRequeryMigration, /requery-existing-api-created-ticket/);
assert.match(tmsCreatedRowRequeryMigration, /INSERT INTO schema_migrations/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /pdd-order-remark-reload-abort-recovered/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /page\.reload: net::ERR_ABORTED/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /effect\.effect_type IN \('pdd-note', 'pdd-submit'\)[\s\S]*effect\.status = 'succeeded'/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(pddOrderRemarkReloadAbortRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /260818-633948127562264/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /bc4065a4-1986-42ea-a8d3-141b07acb68c/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /confirmedNotApplied/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /提交后，此话术将自动发送给消费者/u);
assert.match(prefilledReplySubmitRecoveryMigration,
  /effect\.status = 'unknown'/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /succeeded\.status = 'succeeded'/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(prefilledReplySubmitRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(pddEvidenceOrderParsingRecoveryMigration,
  /260809-319396309370679/);
assert.match(pddEvidenceOrderParsingRecoveryMigration,
  /pddEvidenceScreenshot,status/);
assert.match(pddEvidenceOrderParsingRecoveryMigration,
  /locator\.innerText: Timeout 10000ms exceeded/);
assert.match(pddEvidenceOrderParsingRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(pddEvidenceOrderParsingRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(pddEvidenceOrderParsingRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(pddEvidenceOrderParsingRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(uploadInterventionDedupMigration, /reason_code = 'external-system-error'/);
assert.match(uploadInterventionDedupMigration, /reason_code = 'image-upload-failed'/);
assert.match(uploadInterventionDedupMigration, /ordinary_instance_id IS NOT DISTINCT FROM/);
assert.match(uploadInterventionDedupMigration, /specific-upload-failure-superseded/);
assert.match(uploadInterventionDedupMigration, /INSERT INTO schema_migrations/);
assert.match(lateUploadInterventionDedupMigration,
  /reason_code IN \([\s\S]*'image-upload-failed'[\s\S]*'pdd-upload-authorization-failed'/);
assert.match(lateUploadInterventionDedupMigration,
  /ordinary_instance_id IS NOT DISTINCT FROM/);
assert.match(lateUploadInterventionDedupMigration,
  /specific-upload-failure-superseded/);
assert.match(lateUploadInterventionDedupMigration, /INSERT INTO schema_migrations/);
assert.match(deliveredAddressNoClickRecoveryMigration, /260819-138590349682279/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /a57ed69d-56a0-48b4-a3b8-c354466b3b40/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /externalStateReconciliation,pageState,confirmedNotApplied/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /audit\.payload->>'state' = 'not-applied'/);
assert.match(deliveredAddressNoClickRecoveryMigration, /'clickAttempted', false/);
assert.match(deliveredAddressNoClickRecoveryMigration, /'submitAttemptCount', 0/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /22821432-6eb1-4b00-9d72-84740f1fb621/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /ebb7567e-700f-4903-a6b0-6150f69f2162/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /currentReservationClickAttempted', false/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /priorActualSubmitAttemptCount', 1/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(apiBackend,
  /const uploadFailureReasonCodes = new Set\([\s\S]*pdd-upload-authorization-failed/);
assert.match(apiBackend,
  /uploadFailureReasonCodes\.has\(raw\.reasonCode\)/);
assert.match(apiBackend,
  /\$5 = 'external-system-error'[\s\S]*specific\.reason_code IN \([\s\S]*pdd-upload-authorization-failed/);
assert.match(apiBackend, /AS "ordinaryInstances"/);
assert.match(apiBackend, /currentPlatformCaseId/);
assert.match(apiBackend, /worker-asset-ordinary-instance-mismatch/);
assert.match(apiBackend, /ORDINARY_INSTANCE_ORDER_REQUIRED/);
assert.match(apiBackend, /rejected\.push\(\{/);
assert.match(apiBackend, /WHERE external_order_number = \$1 AND shop_id = \$2/);
assert.match(apiBackend, /return \{ accepted, duplicates, rejected \}/);
assert.match(drawer, /同订单平台工单记录/);
assert.match(drawer, /instance\.events/);
assert.doesNotMatch(dashboard, /dashboardScenarioCodes/);
assert.match(workerSync, /ordinaryInstanceId: snapshot\.ordinaryInstanceId/);
assert.match(workerSync, /platformCaseKey: snapshot\.platformCaseKey/);

const scenarioConfig = JSON.parse(scenarioConfigText);
const expectedCodes = [
  'in-transit-refund',
  'shipped-no-tracking-refund',
  'abnormal-network-warning',
  'return-refund',
  'delivery-risk-concern',
  'proactive-logistics-service',
  'reverse-logistics-signed-refund',
  'intercept-recall',
  'good-deed-expedited-shipping',
  'delivered-not-received',
  'consumer-refusal',
  'product-shortage',
];
assert.deepEqual(scenarioConfig.scenarios.map((scenario) => scenario.code), expectedCodes);
assert.ok(scenarioConfig.scenarios.every((scenario) => (
  scenario.displayName
  && Number.isFinite(scenario.displayOrder)
  && typeof scenario.requiresPdd === 'boolean'
  && typeof scenario.requiresOms === 'boolean'
  && typeof scenario.requiresTms === 'boolean'
)));
assert.deepEqual(
  scenarioConfig.scenarios.map((scenario) => scenario.displayOrder),
  [...scenarioConfig.scenarios.map((scenario) => scenario.displayOrder)].sort((left, right) => left - right),
);

console.log('ordinary work-order instance contract self-test passed');
