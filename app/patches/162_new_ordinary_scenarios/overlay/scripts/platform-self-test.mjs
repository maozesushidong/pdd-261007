import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateWarehouseCarrierRule, isValidScenarioDefinition, matchesAlias } from '../packages/domain/src/index.ts';
import { canonicalScenarioCode } from '../packages/domain/src/scenario-code.mjs';
import {
  completionInfoFromPayload,
  derivePublicShopOnboardingStatus,
  hasBusinessHumanReview,
  isActiveVerificationLocation,
  isAuthenticationAssistance,
  isTransientBrowserClosedError,
  mergeLiveHeartbeatShopRuntime,
  parseBeijingDateFilterBoundary,
  remoteDesktopPathForSlot,
  warehouseInfoFromFacts,
  workOrderShopIdentityFromPayload,
  workflowLogPayloadRequested,
  workflowLogTotalRequested,
} from '../apps/api/src/data-backend.mjs';
import { labelShop, pddLoginState } from '../apps/web/src/app/format.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataBackend = await fsp.readFile(path.join(root, 'apps', 'api', 'src', 'data-backend.mjs'), 'utf8');
const apiMain = await fsp.readFile(path.join(root, 'apps', 'api', 'src', 'main.mjs'), 'utf8');
const postgresAdapter = await fsp.readFile(path.join(root, 'packages', 'adapters', 'src', 'postgres', 'index.mjs'), 'utf8');
const workerRunner = await fsp.readFile(path.join(root, 'apps', 'worker', 'src', 'postgres-playwright-runner.mjs'), 'utf8');
const workflow = await fsp.readFile(path.join(root, 'workflow.mjs'), 'utf8');
const completionMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '018_reconcile_completion_evidence.sql'), 'utf8');
const recoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '019_recovery_controls.sql'), 'utf8');
const dynamicSupervisor = await fsp.readFile(path.join(root, 'apps', 'worker', 'src', 'dynamic-supervisor.mjs'), 'utf8');
const dingtalkDispatcher = await fsp.readFile(path.join(root, 'scripts', 'dingtalk-dispatcher.mjs'), 'utf8');
const windowsSync = await fsp.readFile(path.join(root, 'scripts', 'sync-windows-worker-state.mjs'), 'utf8');
const productionCompose = await fsp.readFile(path.join(root, 'infra', 'docker', 'docker-compose.production.yml'), 'utf8');
const logsView = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'features', 'logs', 'LogsView.jsx'), 'utf8');
const workOrderDrawer = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'components', 'WorkOrderDrawer.jsx'), 'utf8');
const dingtalkMessageDialog = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'components', 'DingTalkMessageDialog.jsx'), 'utf8');
const workOrdersView = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'features', 'work-orders', 'WorkOrdersView.jsx'), 'utf8');
const verificationView = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'features', 'verification', 'VerificationView.jsx'), 'utf8');
const shopsView = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'features', 'shops', 'ShopsView.jsx'), 'utf8');
const webApp = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'app', 'App.jsx'), 'utf8');
const webServer = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'server.mjs'), 'utf8');
const latestEventMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '026_backfill_work_order_latest_event.sql'), 'utf8');
const workflowEventFeedIndexMigration = await fsp.readFile(
  path.join(root, 'infra', 'db', 'migrations', '229_add_workflow_event_feed_index.sql'),
  'utf8',
);
const dashboardRelationIndexesMigration = await fsp.readFile(
  path.join(root, 'infra', 'db', 'migrations', '230_add_dashboard_relation_indexes.sql'),
  'utf8',
);
const serverMigrationExport = await fsp.readFile(
  path.join(root, 'patches', 'server_migration_20260821', 'Export-PddServerMigration.ps1'),
  'utf8',
);
const serverMigrationRefresh = await fsp.readFile(
  path.join(root, 'patches', 'server_migration_20260821', 'Refresh-PddServerMigrationBundle.ps1'),
  'utf8',
);
const serverMigrationRestore = await fsp.readFile(
  path.join(root, 'patches', 'server_migration_20260821', 'Restore-PddServerMigration.ps1'),
  'utf8',
);
const serverMigrationVerification = await fsp.readFile(
  path.join(root, 'patches', 'server_migration_20260821', 'Test-PddServerMigration.ps1'),
  'utf8',
);

assert.equal(matchesAlias('筑越仓库', ['筑越仓']), true);
assert.equal(matchesAlias('新 仓', ['新仓']), true);
assert.equal(evaluateWarehouseCarrierRule('筑越仓', '任意快递', [{
  id: 'zhuyue', warehouseAliases: ['筑越仓'], carrierMode: 'any', carriers: [], enabled: true, priority: 100,
}])?.id, 'zhuyue');
assert.equal(isValidScenarioDefinition({
  code: 'in-transit-refund', titlePatterns: ['在途无理由退款处理'], enabled: true, policyVersion: 1,
  requiresOms: true, requiresTms: true, allowAutoSubmit: true,
}), true);
assert.equal(canonicalScenarioCode('in-transit-no-reason-refund'), 'in-transit-refund');
assert.equal(canonicalScenarioCode('in-transit-refund'), 'in-transit-refund');
assert.equal(
  new Date(parseBeijingDateFilterBoundary('2026-08-19')).toISOString(),
  '2026-08-18T16:00:00.000Z',
);
assert.equal(
  new Date(parseBeijingDateFilterBoundary('2026-08-19', { endExclusive: true })).toISOString(),
  '2026-08-19T16:00:00.000Z',
);
assert.equal(
  new Date(parseBeijingDateFilterBoundary('2026-08-19T06:00:00+08:00')).toISOString(),
  '2026-08-18T22:00:00.000Z',
);
assert.equal(workflowLogPayloadRequested({}), false);
assert.equal(workflowLogPayloadRequested({ includePayload: 'false' }), false);
assert.equal(workflowLogPayloadRequested({ includePayload: 'TRUE' }), true);
assert.equal(workflowLogPayloadRequested({ includePayload: 1 }), true);
assert.equal(workflowLogTotalRequested({}), false);
assert.equal(workflowLogTotalRequested({ includeTotal: 'false' }), false);
assert.equal(workflowLogTotalRequested({ includeTotal: 'TRUE' }), true);
assert.equal(workflowLogTotalRequested({ includeTotal: 1 }), true);
assert.equal(
  isTransientBrowserClosedError('page.waitForTimeout: Target page, context or browser has been closed'),
  true,
);
assert.equal(isTransientBrowserClosedError('page.waitForTimeout: Page crashed'), false);
assert.equal(isTransientBrowserClosedError('TMS 查询超时，结果未知'), false);
assert.deepEqual(workOrderShopIdentityFromPayload({
  pddShopIdentity: { actualShopName: '工单确认店铺', mallId: '10001' },
  latestDiscovery: { actualShopName: '发现店铺', mallId: '10002' },
  shopNameSnapshot: '历史快照店铺',
}, { shopName: '当前配置店铺', shopMallId: '10003' }), {
  shopName: '工单确认店铺',
  shopMallId: '10001',
  shopIdentitySource: 'pdd-work-order-identity',
});
assert.deepEqual(workOrderShopIdentityFromPayload({
  latestDiscovery: { actualShopName: '动态新增店铺', mallId: '20001' },
}, { shopName: '当前配置店铺' }), {
  shopName: '动态新增店铺',
  shopMallId: '20001',
  shopIdentitySource: 'pdd-latest-discovery',
});
assert.equal(labelShop({ shopId: 'shop-dynamic', shopName: '动态新增店铺' }), '动态新增店铺');
assert.equal(
  remoteDesktopPathForSlot(7),
  '/remote-desktop/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=1000&resize=scale&path=remote-desktop%2Fwebsockify%3Ftoken%3Dshop-7',
);
assert.match(webServer, /remoteDesktopTargetForUrl/);
assert.match(webServer, /basePort \+ slot/);
assert.equal(warehouseInfoFromFacts({ payload: {} }).status, 'not-applicable');
assert.deepEqual(warehouseInfoFromFacts({
  payload: {
    logisticsAnalysis: { trackingNumber: 'YT123' },
    omsAnalysis: { shippingWarehouse: '代发聚水潭-铭如', warehouseStatus: 'confirmed' },
    omsWarehouseParse: { status: 'confirmed', checkedAt: '2026-07-31T16:00:00.000Z' },
    tmsAutofillVerification: { actual: { warehouse: '铭如仓' }, verifiedAt: '2026-07-31T16:01:00.000Z' },
  },
}).comparison, 'matched');
assert.equal(warehouseInfoFromFacts({
  payload: {
    logisticsAnalysis: { trackingNumber: 'YT123' },
    omsAnalysis: { shippingWarehouse: '登录 用户名 密码' },
  },
}).status, 'read-failed');
assert.equal(completionInfoFromPayload({
  pddResolutionSubmission: {
    status: 'succeeded', confirmationMethod: 'detail-completed', completedAt: '2026-07-31T16:00:00.000Z',
  },
}).state, 'confirmed');
assert.equal(completionInfoFromPayload({
  lastCompletedOrder: {
    orderNumber: '260730-010527710722780',
    confirmationMethod: 'detail-completed',
    completedAt: '2026-07-31T16:00:00.000Z',
  },
}).state, 'confirmed');
assert.equal(completionInfoFromPayload({}, { runtimeStatus: 'archived' }).state, 'reconciliation-required');
assert.equal(isAuthenticationAssistance({ reasonCode: 'verification-required' }), true);
assert.equal(isAuthenticationAssistance({ reason: 'OMS 登录状态已失效，需要重新登录' }), true);
assert.equal(isActiveVerificationLocation({
  location: { id: 'verification-1', stage: 'pdd-detail', status: 'waiting-human' },
  checkpointStep: 'human-verification-required',
  checkpointVerificationId: 'verification-1',
}), true, 'a matching unresolved challenge must remain active in the verification checkpoint');
assert.equal(isActiveVerificationLocation({
  location: { id: 'login-verification-1', stage: 'pdd-manual-login', status: 'waiting-human' },
  checkpointStep: 'manual-login-required',
  checkpointVerificationId: 'login-verification-1',
}), true, 'a matching unresolved PDD login challenge must remain active while login is required');
assert.equal(isActiveVerificationLocation({
  location: { id: 'login-verification-1', stage: 'pdd-manual-login', status: 'waiting-human' },
  checkpointStep: 'manual-login-required',
  checkpointVerificationId: 'stale-verification',
}), false, 'a stale PDD login challenge must not remain active after the checkpoint moves on');
assert.equal(isActiveVerificationLocation({
  location: { id: 'login-verification-1', stage: 'pdd-manual-login', status: 'resolved', resolvedAt: '2026-08-24T04:00:00Z' },
  checkpointStep: 'manual-login-required',
  checkpointVerificationId: 'login-verification-1',
}), false, 'a resolved PDD login challenge must not remain active');
assert.equal(isActiveVerificationLocation({
  location: null,
  checkpointStep: 'manual-login-required',
  checkpointVerificationId: null,
}), false, 'plain login expiry without an unresolved challenge must not be reported as active verification');
assert.equal(hasBusinessHumanReview({
  step: 'human-verification-required',
  manualReview: { reason: 'verification-required' },
  verificationLocation: { status: 'waiting-human' },
}), false);
assert.equal(hasBusinessHumanReview({
  step: 'manual-review-blocked',
  manualReview: { reason: 'OMS 发货仓库无法唯一确认' },
}), true);
assert.deepEqual(mergeLiveHeartbeatShopRuntime({
  step: 'queue-empty',
  currentOrderNumber: null,
  runtimeStatus: 'idle',
  updatedAt: '2026-08-20T02:00:00.000Z',
  heartbeatAt: '2026-08-20T03:00:02.000Z',
  workerOnline: true,
  workerMetadata: {
    state: 'human-verification-required',
    workflowStep: 'human-verification-required',
    currentOrderNumber: '260820-000000000000001',
    progressUpdatedAt: '2026-08-20T03:00:01.000Z',
  },
}), {
  step: 'human-verification-required',
  currentOrderNumber: '260820-000000000000001',
  runtimeStatus: 'verification',
  updatedAt: '2026-08-20T03:00:02.000Z',
  heartbeatAt: '2026-08-20T03:00:02.000Z',
  workerOnline: true,
  workerMetadata: {
    state: 'human-verification-required',
    workflowStep: 'human-verification-required',
    currentOrderNumber: '260820-000000000000001',
    progressUpdatedAt: '2026-08-20T03:00:01.000Z',
  },
});
assert.equal(mergeLiveHeartbeatShopRuntime({
  step: 'queue-empty', runtimeStatus: 'idle', workerOnline: true,
  workerMetadata: { state: 'manual-login-required' },
}).runtimeStatus, 'verification');
assert.equal(derivePublicShopOnboardingStatus({
  onboardingStatus: 'ready',
  authHealth: { pdd: { status: 'expired', checkedAt: '2026-08-22T01:00:00.000Z' } },
}), 'waiting-login', 'confirmed PDD expiry must override a stale ready onboarding row');
assert.equal(derivePublicShopOnboardingStatus({
  onboardingStatus: 'ready',
  step: 'manual-login-required',
  authHealth: { pdd: { status: 'unknown' } },
}), 'waiting-login', 'a live manual-login step must override a stale ready onboarding row');
assert.equal(derivePublicShopOnboardingStatus({
  onboardingStatus: 'identity-mismatch',
  authHealth: { pdd: { status: 'expired' } },
}), 'identity-mismatch', 'login expiry must not hide an identity mismatch');
assert.equal(derivePublicShopOnboardingStatus({
  onboardingStatus: 'ready',
  workerMetadata: { state: 'browser-proxy-unavailable' },
  authHealth: { pdd: { status: 'expired' } },
}), 'ready', 'proxy failure must remain distinct from login expiry');
assert.equal(pddLoginState({
  shopId: 'shop-login-state', onboardingStatus: 'ready',
  authHealth: { pdd: { status: 'expired' } },
}).status, 'waiting-login');
assert.equal(pddLoginState({
  shopId: 'shop-login-state', onboardingStatus: 'ready',
  authHealth: { pdd: { status: 'unreachable' } },
}).status, 'unreachable');
assert.equal(pddLoginState({
  shopId: 'shop-login-state', onboardingStatus: 'ready',
  authHealth: { pdd: { status: 'verification-required' } },
}).status, 'verification');
assert.equal(pddLoginState({
  shopId: 'shop-login-state', onboardingStatus: 'waiting-login', workerOnline: true,
  workerMetadata: { actualShopName: '测试店铺', mallId: '123456' },
  authHealth: { pdd: { status: 'authenticated' } },
}).status, 'authenticated', 'only a confirmed authenticated live identity may recover stale waiting-login UI state');
assert.equal(mergeLiveHeartbeatShopRuntime({
  step: 'queue-empty', runtimeStatus: 'idle', workerOnline: false,
  workerMetadata: { state: 'human-verification-required' },
}).runtimeStatus, 'idle');
assert.match(dataBackend, /mergeAuthHealthMaps\(\s*checkpointAuthHealth,\s*latestHeartbeatAuthHealth,\s*heartbeatAuthHealth,/,
  'shop auth aggregation must merge per-system evidence instead of preferring one stale heartbeat object');
assert.equal(mergeLiveHeartbeatShopRuntime({
  step: 'queue-empty', runtimeStatus: 'idle', workerOnline: true,
  workerMetadata: { state: 'idle', workflowStep: 'queue-empty-waiting' },
}).runtimeStatus, 'idle');
assert.match(dataBackend, /UPDATE verification_locations SET status = 'resolved'/);
assert.match(dataBackend,
  /work_order_id IS NOT DISTINCT FROM \$4::uuid[\s\S]*status IN \('detected', 'waiting-human', 'verification-required'\)[\s\S]*detected_at <= \$2/,
  'verification resolution must include every active status and stay scoped to the current work order');
assert.match(postgresAdapter,
  /resolveClearedVerificationInterventions[\s\S]*'verification-required'[\s\S]*'return-refund-verification-required'[\s\S]*NOT EXISTS \([\s\S]*verification_locations/,
  'resolved challenges must close only their matching authentication-assistance interventions');
assert.match(dataBackend,
  /checkpoint\.current_step = 'manual-login-required'[\s\S]*v\.stage = 'pdd-manual-login'[\s\S]*checkpoint\.snapshot->'verificationLocation'->>'id' = v\.id::text/,
  'PostgreSQL verification reads must retain only the current unresolved PDD login challenge');
assert.match(dataBackend, /SHOP_HAS_BUSINESS_DATA/);
assert.match(dataBackend, /DELETE FROM shops WHERE id = \$1/);
assert.doesNotMatch(dataBackend, /INSERT INTO shops \(id, name\) VALUES \(\$1,\$1\) ON CONFLICT/);
assert.match(dataBackend, /error\.code = 'UNKNOWN_SHOP'/);
assert.match(dataBackend, /strictAutoSuccess/);
assert.match(dataBackend, /AT TIME ZONE 'Asia\/Shanghai'/);
assert.match(dataBackend, /completion_confirmation_method = ANY/);
assert.match(dataBackend, /authenticationAssistanceSql[\s\S]*reason_code IN \([\s\S]*'verification-required',[\s\S]*'login-required',[\s\S]*'return-refund-verification-required'[\s\S]*\)/);
assert.match(dataBackend,
  /actionable_intervention\.status IN \('open', 'acknowledged'\)[\s\S]*nonActionableManualInterventionReasonCodes/,
  'current manual-review metrics must use only active actionable interventions');
assert.match(dataBackend,
  /nonActionableManualInterventionReasonCodes = Object\.freeze\(\[[\s\S]*'waiting-logistics'[\s\S]*'waiting-consumer-response'[\s\S]*'page-render-deferred'[\s\S]*'rate-limited'/,
  'automatic waits and retries must not inflate current manual-review metrics');
assert.match(dataBackend,
  /resolveRecoveredReturnRefundBrowserCloseInterventions[\s\S]*work_order\.scenario_code = 'return-refund'[\s\S]*work_order\.manual_review_reason IS NULL[\s\S]*return-refund-waiting-logistics[\s\S]*effect\.status IN \('reserved', 'unknown'\)/,
  'a closed-browser intervention may be cleared only after a safe automated return-refund state is authoritative');
assert.match(dataBackend,
  /suppressRecoveredReturnRefundBrowserClose[\s\S]*!suppressRecoveredReturnRefundBrowserClose[\s\S]*INSERT INTO manual_interventions/,
  'a controlled browser close must not recreate a dashboard intervention after safe return-refund recovery');
assert.match(dataBackend,
  /manualReviewSql = `\(coalesce\(w\.completion_state, 'pending'\)[\s\S]*NOT IN \('confirmed', 'not-applicable'\)[\s\S]*actionableBusinessInterventionSql/,
  'confirmed work orders and closed historical interventions must not remain current manual reviews');
assert.match(dataBackend, /NOT \$\{historicalBusinessInterventionSql\}/,
  'strict automation must preserve historical business-intervention evidence');
assert.match(dataBackend, /legacyOmsTmsSuccessSql/);
assert.match(dataBackend, /scenario_definition\.config->>'requiresOms'/);
assert.match(dataBackend, /scenario_definition\.config->>'requiresTms'/);
assert.match(dataBackend,
  /omsAllocationSucceededSql[\s\S]*omsManualAllocation'[\s\S]*IN \('succeeded', 'already-allocated'\)[\s\S]*orderNumber'[\s\S]*w\.external_order_number[\s\S]*omsSucceededSql = `\(\$\{omsAllocationSucceededSql\} OR EXISTS/,
  'ordinary-view OMS success must include an order-matched successful allocation without weakening strict success');
assert.match(dataBackend, /count\(\*\) FILTER \(WHERE auto_success\)::int AS "autoSuccess"/);
assert.match(dataBackend,
  /async listWorkOrders\([\s\S]*workOrderFirstDiscoveredAtSql\(scenarioExpression\)[\s\S]*query\.discoveredFrom[\s\S]*query\.discoveredTo[\s\S]*overviewMetricPredicates/,
  'metric drill-down must apply the same first-discovered cohort boundaries as the summary');
assert.match(dataBackend,
  /async listWorkOrders\([\s\S]*const filterJoins = `LEFT JOIN return_refunds refund ON refund\.work_order_id = w\.id`[\s\S]*FROM work_orders w\s*\$\{filterJoins\}\s*\$\{condition\}[\s\S]*WITH page_work_orders[\s\S]*FROM work_orders w\s*\$\{filterJoins\}\s*\$\{condition\}/,
  'first-discovered work-order filters must join the return-refund discovery timestamp in count and page queries');
assert.match(dataBackend, /current_step IN \('external-state-confirmed', 'external-state-unresolved'\)/);
assert.match(dataBackend, /payload->>'frontendVisibility'.*= 'recovery-audit'/);
assert.match(dataBackend, /frontend_visibility.*= 'recovery-audit'/);
assert.match(dataBackend, /scenario_code = 'return-refund'[\s\S]*shop_id \|\| ':' \|\| external_order_number/);
assert.match(dataBackend, /error\.code = 'WORK_ORDER_BLOCKED'/);
assert.match(dataBackend, /async reviewExternalState/);
assert.match(dataBackend, /async createDingTalkNotification/);
assert.match(dataBackend, /automaticDingTalkReasonCodes = new Set\(\['warehouse-out-of-scope', 'unknown-scenario'\]\)/);
assert.match(dataBackend, /hasAutomaticDingTalkEvidence/);
assert.match(dataBackend, /dingtalk:automatic:\$\{workOrderId\}:\$\{ordinaryInstanceId \|\| 'no-instance'\}:\$\{raw\.reasonCode\}/);
assert.match(dataBackend, /existing\.work_order_id = \$3[\s\S]*existing\.ordinary_instance_id IS NOT DISTINCT FROM \$4::uuid[\s\S]*existing\.channel = 'dingtalk'/);
assert.match(dataBackend, /deliverySource: 'owner-manual'/);
assert.match(apiMain, /settings\/dingtalk/);
assert.match(apiMain, /work-orders\/:id\/dingtalk/);
assert.match(apiMain, /work-orders\/bulk-delete/);
assert.match(apiMain, /verification-recheck/);
assert.match(apiMain, /verifications\/screenshots\/bulk-delete/);
assert.match(apiMain, /WORK_ORDER_DELETE_BLOCKED/);
assert.match(apiMain, /owner-login-succeeded/);
assert.match(apiMain, /owner-login-failed/);
assert.match(apiMain, /publicApiPaths/);
assert.match(apiMain, /metricsResponseFor/);
assert.match(apiMain, /X-Robots-Tag/);
assert.match(apiMain, /api\/v1\/audit-events/);
assert.match(windowsSync, /existingPid !== process\.pid/);
assert.match(windowsSync, /fetch\(`\$\{apiUrl\}\/api\/v1\/shops`, \{[\s\S]*authorization: `Bearer \$\{token\}`/);
assert.match(windowsSync, /snapshot\.omsWarehouseParse\?\.status === 'out-of-scope'/);
assert.doesNotMatch(windowsSync, /enabledShops = \(config\.shops \|\| \[\]\)/);
assert.match(productionCompose, /worker-sync:[\s\S]*WORKER_SYNC_SOURCE_ID: production-docker-worker/);
assert.match(dataBackend, /async listAuditEvents/);
assert.match(dataBackend, /workflowLogPayloadRequested\(query\) \? ', e\.payload' : ''/);
assert.match(dataBackend, /oid = 'workflow_events'::regclass/);
assert.match(dataBackend, /latest_event_at = \$2/);
assert.match(logsView, /所有者审计/);
assert.match(logsView, /includeTotal: true/);
assert.match(logsView, /result\.totalIsEstimate \? '约' : '共'/);
assert.match(workOrderDrawer, /events\.length/);
assert.match(workOrderDrawer, /当前工单正在等待页面验证/);
assert.doesNotMatch(workOrderDrawer, /waitingForVerification && <section className="work-order-verification"/);
assert.match(workOrderDrawer, /disabled=\{!isOwner \|\| !waitingForVerification \|\| Boolean\(verificationCommand\)\}/);
assert.match(workOrderDrawer, /requestVerificationCommand\('verification-recheck'\)/);
assert.match(workOrderDrawer, /requestVerificationCommand\('force-clear-verification'\)/);
assert.match(workOrdersView, /DeleteWorkOrdersDialog/);
assert.match(workOrdersView, /删除 \(\{selectedRows\.length\}\)/);
assert.match(workOrdersView, /workOrderRequestTimeoutMs = 15_000/);
assert.match(workOrdersView, /new AbortController\(\)/);
assert.match(workOrdersView, /controller\.signal\.aborted/);
assert.match(workOrdersView, /setInterval\(\(\) => load\(true\), workOrderPollingIntervalMs\)/);
assert.match(workOrdersView, /labelShop\(row\)/);
assert.doesNotMatch(workOrdersView, /labelShop\(row\.shopId\)/);
assert.match(dingtalkMessageDialog, /labelShop\(detail\)/);
assert.doesNotMatch(dingtalkMessageDialog, /labelShop\(detail\.shopId \|\| detail\.shop_id\)/);
assert.match(verificationView, /全选验证截图/);
assert.match(verificationView, /删除全部 \(\{screenshotItems\.length\}\)/);
assert.match(shopsView, /window\.open\('about:blank', '_blank'\)/);
assert.match(shopsView, /window\.open\('about:blank', `pdd-shop-login-\$\{shop\.shopId\}`\)/);
assert.doesNotMatch(shopsView, /window\.open\('about:blank', 'pdd-shop-login'\)/);
assert.match(webApp, /verification\.screenshots-deleted/);
assert.match(webApp, /event\.ctrlKey && event\.altKey && event\.shiftKey && event\.code === 'KeyO'/);
assert.match(webServer, /ownerSessionAuthorized/);
assert.match(dataBackend, /async deleteVerificationScreenshots/);
assert.match(latestEventMigration, /max\(occurred_at\)/);
assert.match(workflowEventFeedIndexMigration,
  /idx_workflow_events_feed_time[\s\S]*occurred_at DESC, received_at DESC/);
assert.match(workflowEventFeedIndexMigration,
  /229_add_workflow_event_feed_index\.sql/);
assert.match(dashboardRelationIndexesMigration,
  /idx_work_orders_return_refund_representative[\s\S]*shop_id, external_order_number, updated_at DESC, id DESC/);
assert.match(dashboardRelationIndexesMigration,
  /idx_manual_interventions_work_order_instance[\s\S]*work_order_id, ordinary_instance_id, created_at DESC/);
assert.match(dashboardRelationIndexesMigration,
  /idx_oms_analyses_work_order_instance_created[\s\S]*work_order_id, ordinary_instance_id, created_at DESC/);
assert.match(dashboardRelationIndexesMigration,
  /idx_logistics_analyses_work_order_instance_created[\s\S]*work_order_id, ordinary_instance_id, created_at DESC/);
assert.match(dashboardRelationIndexesMigration,
  /230_add_dashboard_relation_indexes\.sql/);
assert.match(serverMigrationExport,
  /Get-ChildItem -LiteralPath \$payloadMigrationRoot -File -Filter '\*\.sql'[\s\S]*Add-CriticalFile/u);
assert.match(serverMigrationRefresh,
  /Get-ChildItem -LiteralPath \$payloadMigrationRoot -File -Filter '\*\.sql'[\s\S]*\$criticalPaths\.Add\(\$relativeMigration\)/u);
assert.match(serverMigrationRestore,
  /sc\.exe failure PddCoreService[\s\S]*restart\/5000\/restart\/15000\/restart\/60000/u);
assert.match(serverMigrationRestore, /sc\.exe failureflag PddCoreService 1/u);
assert.match(serverMigrationVerification,
  /missingMigrationCriticalFiles[\s\S]*-not \$missingMigrationCriticalFiles\.Count/u);
assert.match(serverMigrationVerification,
  /restartActionPattern\s*=\s*'[^\r\n]*RESTART/u);
assert.match(serverMigrationVerification,
  /\$coreServiceRecoveryValid\s*=[\s\S]*\$recoveryExitCode -eq 0[\s\S]*\[regex\]::Matches[\s\S]*\$failureFlagExitCode -eq 0/u);
assert.match(serverMigrationVerification,
  /\$failureFlagOutput[\s\S]*-match '\\bTRUE\\b'/u);
assert.match(dingtalkDispatcher, /payload\.deliverySource === 'owner-manual'/);
assert.match(dingtalkDispatcher, /'warehouse-out-of-scope', 'unknown-scenario'/);
assert.match(dingtalkDispatcher, /isDingTalkDeliveryEligible/);
assert.match(dingtalkDispatcher, /isDingTalkDeliveryDateEligible/);
assert.doesNotMatch(dingtalkDispatcher, /FOR UPDATE OF outbox, intervention, work_order/);
assert.match(dingtalkDispatcher, /FOR UPDATE OF notification_outbox/);
assert.match(dingtalkDispatcher, /AbortSignal\.timeout\(requestTimeoutMs\)/);
assert.match(dingtalkDispatcher, /recoverStaleDeliveries/);
assert.match(dingtalkDispatcher, /cancelUndeliverableNotifications/);
assert.match(dingtalkDispatcher, /调度循环异常，将自动退避重试/);
assert.match(windowsSync, /return 'warehouse-out-of-scope'/);
assert.match(windowsSync, /return 'image-upload-failed'/);
assert.match(dataBackend,
  /const uploadFailureReasonCodes = new Set\([\s\S]*image-upload-failed[\s\S]*pdd-upload-authorization-failed/);
assert.match(dataBackend,
  /durableNotifierInterventionReasonCodes = new Set\(uploadFailureReasonCodes\)/);
assert.doesNotMatch(apiMain, /allowed = \[[^\]]*reconcile-external-state/);
assert.match(apiMain, /external-state-review/);
assert.doesNotMatch(apiMain, /'manual-complete'/);
assert.match(postgresAdapter, /recovery_state IN \('ready', 'retry-authorized'\)/);
assert.match(postgresAdapter, /completeExternalStateReconciliation/);
assert.match(workerRunner, /runExternalStateReconciliation/);
assert.doesNotMatch(workerRunner, /command\.command_type === 'reconcile-external-state'/);
assert.match(workerRunner, /progress\.externalStateReconciliation\?\.state/);
assert.match(workerRunner, /child\.kill\('SIGKILL'\)/);
assert.match(workflow, /PDD_RECONCILE_EXTERNAL_STATE/);
assert.match(workflow, /readOnly: true/);
assert.match(workflow, /allowUnresolved: true/);
assert.match(workflow, /readTimeoutMs: 5000/);
assert.match(workflow, /if \(!reconcileExternalStateOnly && !progress\.orderNumber\)/);
assert.equal(
  (workflow.match(/if \(!reconcileExternalStateOnly(?: && !residentSystemsInitialized)?\)(?:\s*\{)?\s*await restoreAndAuthenticateSystemTabs/g) || []).length,
  1,
);
assert.match(workflow, /if \(pddOnlyRecovery\) await initializeResidentSystemsForDiscovery\(\);\s*else await restoreAndAuthenticateSystemTabs/);
assert.match(workflow, /if \(requestedOrderNumber && result\.reconciled\) \{[\s\S]{0,240}?await finishDiscoveryRun\(\)/);
assert.match(completionMigration, /worker-completed-work-order-archive/);
assert.match(completionMigration, /completion_state = 'not-applicable'/);
assert.match(recoveryMigration, /unknown-external-effect/);
assert.match(recoveryMigration, /runtime-recovery-review-required/);
assert.match(dataBackend, /INSERT INTO shop_deletion_requests/);
assert.match(dataBackend, /async deleteWorkOrders/);
assert.match(dataBackend, /frontend_visibility = 'recovery-audit'/);
assert.match(dataBackend, /current_step = 'owner-deleted'/);
assert.match(dataBackend, /work-order-owner-deleted/);
assert.match(dataBackend, /deletionTombstone/);
assert.match(dynamicSupervisor, /removeDeletedShopData/);
assert.match(dynamicSupervisor, /DELETE FROM shop_deletion_requests WHERE shop_id = \$1/);
console.log('platform domain self-test passed');
