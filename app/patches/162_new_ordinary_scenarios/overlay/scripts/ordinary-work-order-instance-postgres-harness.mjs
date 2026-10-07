import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pgPackage from 'pg';

const { Client } = pgPackage;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.DATABASE_URL) {
  for (const rawLine of readFileSync(path.join(root, '.env.native'), 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const sourceUrl = new URL(process.env.DATABASE_URL);
const testDatabase = `pdd_instance_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
assert.match(testDatabase, /^pdd_instance_test_[a-f0-9]{12}$/u);
const quotedTestDatabase = `"${testDatabase}"`;
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${testDatabase}`;
testUrl.search = '';
const backfillShopId = `ordinary-backfill-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
const operationalWorkOrderId = crypto.randomUUID();
const recoveryAuditWorkOrderId = crypto.randomUUID();
const duplicatePlatformCaseId = '500012760087350';
const terminalMismatchWorkOrderId = crypto.randomUUID();
const terminalMismatchInstanceId = crypto.randomUUID();
const terminalMismatchInterventionId = crypto.randomUUID();
const terminalMismatchOutboxId = crypto.randomUUID();
const terminalMismatchOrderNumber = '260803-099709161860253';
const terminalMismatchPlatformCaseId = '500012760087351';
const uploadNotificationWorkOrderId = crypto.randomUUID();
const uploadNotificationInstanceId = crypto.randomUUID();
const uploadNotificationGenericInterventionId = crypto.randomUUID();
const automaticTerminalScanWorkOrderId = crypto.randomUUID();
const genuineManualTerminalWorkOrderId = crypto.randomUUID();
const abnormalWarehouseWorkOrderId = crypto.randomUUID();
const abnormalWarehouseInstanceId = crypto.randomUUID();
const abnormalWarehouseInterventionId = crypto.randomUUID();
const abnormalWarehouseOutboxId = crypto.randomUUID();
const abnormalWarehouseOrderNumber = '260824-540310311353216';
const abnormalWarehousePlatformCaseId = '500013036381351';
const remarkColorWorkOrderId = crypto.randomUUID();
const remarkColorInstanceId = crypto.randomUUID();
const remarkColorInterventionId = crypto.randomUUID();
const remarkColorOutboxId = crypto.randomUUID();
const remarkColorOrderNumber = '260819-577104791100244';
const remarkColorPlatformCaseId = '500013036802664';
const remarkColorBlockedWorkOrderId = crypto.randomUUID();
const remarkColorBlockedInstanceId = crypto.randomUUID();
const remarkColorBlockedOrderNumber = '260819-577104791100245';
const remarkColorBlockedPlatformCaseId = '500013036802665';
const omsRowSelectionWorkOrderId = crypto.randomUUID();
const omsRowSelectionInstanceId = crypto.randomUUID();
const omsRowSelectionInterventionId = crypto.randomUUID();
const omsRowSelectionOrderNumber = '260817-211707574683652';
const omsRowSelectionPlatformCaseId = '500013036802666';
const omsRowSelectionBlockedWorkOrderId = crypto.randomUUID();
const omsRowSelectionBlockedInstanceId = crypto.randomUUID();
const omsRowSelectionBlockedOrderNumber = '260817-211707574683653';
const omsRowSelectionBlockedPlatformCaseId = '500013036802667';
const duplicateTmsReconciliationWorkOrderId = crypto.randomUUID();
const duplicateTmsReconciliationInstanceId = crypto.randomUUID();
const duplicateTmsReconciliationOrderNumber = '260803-142784653640659';
const duplicateTmsReconciliationPlatformCaseId = '500013036802668';
const duplicateTmsReconciliationBlockedWorkOrderId = crypto.randomUUID();
const duplicateTmsReconciliationBlockedInstanceId = crypto.randomUUID();
const duplicateTmsReconciliationBlockedOrderNumber = '260803-142784653640660';
const duplicateTmsReconciliationBlockedPlatformCaseId = '500013036802669';
const consumerResponseWaitWorkOrderId = crypto.randomUUID();
const consumerResponseWaitInstanceId = crypto.randomUUID();
const consumerResponseWaitOrderNumber = '260823-490198822501127';
const consumerResponseWaitPlatformCaseId = '500013036802670';
const warehouseScopeFixtures = [
  { warehouse: '代发聚水潭-迅发', orderNumber: '260815-649655796051551', platformCaseId: '500012760087361', allowed: true },
  { warehouse: '代发聚水潭-品动工贸', orderNumber: '260815-191700692481455', platformCaseId: '500012760087362', allowed: true },
  { warehouse: '代发聚水潭-祺迦工贸', orderNumber: '260824-219000000000003', platformCaseId: '500012760087363', allowed: true },
  { warehouse: '代发聚水潭-久伴体育', orderNumber: '260815-081684150570891', platformCaseId: '500012760087364', allowed: false },
].map((fixture, index) => ({
  ...fixture,
  workOrderId: crypto.randomUUID(),
  instanceId: crypto.randomUUID(),
  ticketNo: `L219000${index + 1}`,
}));

const admin = new Client({ connectionString: sourceUrl.toString(), application_name: 'ordinary-instance-test-harness' });
let created = false;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quotedTestDatabase} TEMPLATE template0 ENCODING 'UTF8'`);
  created = true;

  const migrationClient = new Client({ connectionString: testUrl.toString(), application_name: 'ordinary-instance-migrations' });
  try {
    await migrationClient.connect();
    const migrationFiles = readdirSync(path.join(root, 'infra/db/migrations'))
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
      .sort((left, right) => left.localeCompare(right));
    const migrationCatalog = JSON.parse(readFileSync(
      path.join(root, 'infra/db/migration-catalog.json'),
      'utf8',
    ));
    assert.equal(migrationFiles.length, migrationCatalog.migrationCount);
    assert.equal(migrationFiles.at(-1), migrationCatalog.latestMigration);
    for (const migrationFile of migrationFiles) {
      if (migrationFile === '059_ordinary_work_order_instances.sql') {
        const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${duplicatePlatformCaseId}`;
        await migrationClient.query(`
          INSERT INTO shops
            (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
          VALUES ($1,$2,$2,10001,false,'disabled')`, [
          backfillShopId,
          `Ordinary backfill fixture ${backfillShopId}`,
        ]);
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             completion_state, frontend_visibility, created_at, updated_at)
          VALUES
            ($1,$3,'backfill-operational-order','fixture','delivery-risk-concern',
             'queued','queued','pdd-discovered:backfill:operational','pdd-discovered',
             jsonb_build_object('detailUrl',$4::text),'pending','operational',
             now() - interval '1 day',now()),
            ($2,$3,'backfill-recovery-order','fixture','delivery-risk-concern',
             'archived','archived','recovery-audit:backfill:hidden','superseded-duplicate',
             jsonb_build_object('detailUrl',$4::text),'confirmed','recovery-audit',
             now() - interval '2 days',now() - interval '1 hour')`, [
          operationalWorkOrderId,
          recoveryAuditWorkOrderId,
          backfillShopId,
          detailUrl,
        ]);
      }
      if (migrationFile === '192_recover_remaining_deterministic_ordinary_pauses.sql') {
        const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${terminalMismatchPlatformCaseId}`;
        const reason = '平台已完结但选项错误：预期“已按照建议快递发货”，实际“无法按照建议快递发货”。';
        const payload = {
          detailUrl,
          pddResolutionSubmission: {
            status: 'succeeded',
            orderNumber: terminalMismatchOrderNumber,
            recoveredFromCompletedPage: true,
            confirmationMethod: 'detail-completed',
          },
          pddResolutionOutcomeMismatch: {
            expectedOutcome: '已按照建议快递发货',
            completedOutcome: '无法按照建议快递发货',
          },
          pddEvidenceScreenshot: { status: 'deleted' },
          tmsEvidenceScreenshot: { status: 'deleted' },
          tmsEvidenceDisposition: { status: 'deleted' },
          manualReview: { stage: 'pdd-resolution-outcome-mismatch', reason },
          error: reason,
        };
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             manual_review_reason, completion_state, completion_confirmation_method,
             completion_confirmed_at, frontend_visibility, recovery_state,
             recovery_reason, created_at, updated_at)
          VALUES
            ($1,$2,$3,'fixture','delivery-risk-concern','paused','paused',$4,
             'pdd-resolution-outcome-mismatch',$5::jsonb,$6,'confirmed',
             'detail-completed',now() - interval '1 day','operational','held',$6,
             now() - interval '20 days',now())`, [
          terminalMismatchWorkOrderId,
          backfillShopId,
          terminalMismatchOrderNumber,
          `fixture:terminal-mismatch:${terminalMismatchOrderNumber}`,
          JSON.stringify(payload),
          reason,
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, manual_review_reason)
          VALUES
            ($1,$2,$3,$4,$5,$6,'fixture','delivery-risk-concern','verified',
             'paused','paused','pdd-resolution-outcome-mismatch',$7::jsonb,$8)`, [
          terminalMismatchInstanceId,
          terminalMismatchWorkOrderId,
          backfillShopId,
          terminalMismatchPlatformCaseId,
          `pdd-work-order:${terminalMismatchPlatformCaseId}`,
          detailUrl,
          JSON.stringify(payload),
          reason,
        ]);
        await migrationClient.query(`
          UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
          terminalMismatchWorkOrderId,
          terminalMismatchInstanceId,
        ]);
        await migrationClient.query(`
          INSERT INTO external_effects
            (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
             idempotency_key, status, request_hash, receipt)
          VALUES
            (gen_random_uuid(),$1,$2,$3,'tms-create',$4,'succeeded',$5,
             jsonb_build_object('ticketId','34877','ticketNo','L00034797'))`, [
          backfillShopId,
          terminalMismatchWorkOrderId,
          terminalMismatchInstanceId,
          `fixture:tms-create:${terminalMismatchOrderNumber}`,
          `fixture-hash:${terminalMismatchOrderNumber}`,
        ]);
        await migrationClient.query(`
          INSERT INTO manual_interventions
            (id, shop_id, work_order_id, ordinary_instance_id, channel,
             reason_code, reason, risk_level, status, deduplication_key)
          VALUES
            ($1,$2,$3,$4,'dingtalk','pdd-resolution-outcome-mismatch',$5,
             'high','open',$6)`, [
          terminalMismatchInterventionId,
          backfillShopId,
          terminalMismatchWorkOrderId,
          terminalMismatchInstanceId,
          reason,
          `fixture:terminal-mismatch-intervention:${terminalMismatchOrderNumber}`,
        ]);
        await migrationClient.query(`
          INSERT INTO notification_outbox (id, intervention_id, payload)
          VALUES ($1,$2,jsonb_build_object('fixture',true))`, [
          terminalMismatchOutboxId,
          terminalMismatchInterventionId,
        ]);
      }
      if (migrationFile === '218_enforce_oms_warehouse_scope.sql') {
        for (const fixture of warehouseScopeFixtures) {
          const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${fixture.platformCaseId}`;
          const payload = {
            orderNumber: fixture.orderNumber,
            detailUrl,
            omsAnalysis: {
              orderNumber: fixture.orderNumber,
              shippingWarehouse: fixture.warehouse,
              warehouseStatus: 'confirmed',
            },
            omsWarehouseParse: {
              status: 'confirmed',
              orderNumber: fixture.orderNumber,
              parsedValue: fixture.warehouse,
            },
            tmsWorkOrder: {
              status: 'created',
              orderNumber: fixture.orderNumber,
              ticketId: fixture.ticketNo,
              ticketNo: fixture.ticketNo,
            },
          };
          await migrationClient.query(`
            INSERT INTO work_orders
              (id, shop_id, external_order_number, work_order_type, scenario_code,
               status, runtime_status, idempotency_key, current_step, payload,
               completion_state, frontend_visibility, recovery_state, created_at, updated_at)
            VALUES
              ($1,$2,$3,'fixture','delivery-risk-concern','queued','queued',$4,
               'oms-analysis-complete',$5::jsonb,'pending','operational','ready',now(),now())`, [
            fixture.workOrderId,
            backfillShopId,
            fixture.orderNumber,
            `fixture:warehouse-scope:${fixture.orderNumber}`,
            JSON.stringify(payload),
          ]);
          await migrationClient.query(`
            INSERT INTO ordinary_work_order_instances
              (id, work_order_id, shop_id, platform_case_id, platform_case_key,
               detail_url, work_order_type, scenario_code, identity_status, status,
               runtime_status, current_step, payload)
            VALUES
              ($1,$2,$3,$4,$5,$6,'fixture','delivery-risk-concern','verified',
               'queued','queued','oms-analysis-complete',$7::jsonb)`, [
            fixture.instanceId,
            fixture.workOrderId,
            backfillShopId,
            fixture.platformCaseId,
            `pdd-work-order:${fixture.platformCaseId}`,
            detailUrl,
            JSON.stringify(payload),
          ]);
          await migrationClient.query(
            'UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1',
            [fixture.workOrderId, fixture.instanceId],
          );
        }
      }
      if (migrationFile === '222_backfill_current_pdd_upload_authorization_notifications.sql') {
        const orderNumber = '260824-481430000000001';
        const platformCaseId = '500013048143001';
        const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformCaseId}`;
        const uploadFailure = {
          error: '拼多多凭证上传授权失败（48143）：非法请求',
          status: 'failed',
          orderNumber,
          diagnostics: {
            authorizationFailure: {
              code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
              errorCode: 48143,
              errorMessage: '非法请求',
            },
          },
        };
        const recovery = {
          error: uploadFailure.error,
          status: 'exhausted',
          attempt: 1,
          attempts: 1,
          maxAttempts: 1,
          orderNumber,
          updatedAt: new Date().toISOString(),
          definitiveAuthorizationFailure: true,
          failures: [{
            code: 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED',
            message: uploadFailure.error,
            uploadAuthorizationFailure: uploadFailure.diagnostics.authorizationFailure,
          }],
        };
        const payload = {
          detailUrl,
          orderNumber,
          workOrderType: '消费者担忧货物无法送达',
          ordinaryEvidenceUpload: uploadFailure,
          ordinaryEvidenceUploadRecovery: recovery,
          omsAnalysis: { shippingWarehouse: '筑越仓-拼多多仓-共享' },
        };
        await migrationClient.query(`
          UPDATE system_settings SET value = 'true'::jsonb, updated_at = now()
          WHERE key = 'dingtalk-automatic-enabled'`);
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             manual_review_reason, completion_state, frontend_visibility, created_at, updated_at)
          VALUES
            ($1,$2,$3,$4,'delivery-risk-concern','paused','paused',$5,
             'flow-paused',$6::jsonb,$7,'pending','operational',now(),now())`, [
          uploadNotificationWorkOrderId,
          backfillShopId,
          orderNumber,
          payload.workOrderType,
          `fixture:upload-notification:${orderNumber}`,
          JSON.stringify(payload),
          uploadFailure.error,
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, manual_review_reason)
          VALUES
            ($1,$2,$3,$4,$5,$6,$7,'delivery-risk-concern','verified','paused',
             'paused','flow-paused',$8::jsonb,$9)`, [
          uploadNotificationInstanceId,
          uploadNotificationWorkOrderId,
          backfillShopId,
          platformCaseId,
          `pdd-work-order:${platformCaseId}`,
          detailUrl,
          payload.workOrderType,
          JSON.stringify(payload),
          uploadFailure.error,
        ]);
        await migrationClient.query(
          'UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1',
          [uploadNotificationWorkOrderId, uploadNotificationInstanceId],
        );
        await migrationClient.query(`
          INSERT INTO manual_interventions
            (id, shop_id, work_order_id, ordinary_instance_id, channel,
             reason_code, reason, risk_level, status, resolved_at, resolved_by,
             deduplication_key)
          VALUES
            ($1,$2,$3,$4,'dashboard','external-system-error',$5,'high','resolved',
             now(),'specific-upload-failure-superseded',$6)`, [
          uploadNotificationGenericInterventionId,
          backfillShopId,
          uploadNotificationWorkOrderId,
          uploadNotificationInstanceId,
          uploadFailure.error,
          `fixture:generic-upload:${orderNumber}`,
        ]);
      }
      if (migrationFile === '223_reclassify_automatic_return_refund_terminal_scans.sql') {
        const automaticOrderNumber = '260824-308920993382937';
        const automaticAftersaleNumber = '22389765628758';
        const manualOrderNumber = '260824-308920993382938';
        const manualAftersaleNumber = '22389765628759';
        const makeReturnRefund = (orderNumber, aftersaleNumber) => ({
          orderNumber,
          aftersaleNumber,
          aftersaleType: '退货退款',
          aftersaleStatus: '商家同意退款,本单退款成功',
          actionButtonVisible: false,
          pageIndicatesCompleted: true,
          decision: { outcome: 'manual-completed', reasons: [], rules: {} },
          evidence: {
            capturedAt: new Date().toISOString(),
            fieldSources: {
              orderNumber: { source: 'label-following-line', value: orderNumber },
              aftersaleNumber: { source: 'label-following-line', value: aftersaleNumber },
              aftersaleStatus: {
                source: 'label-following-line',
                value: '商家同意退款,本单退款成功',
              },
            },
          },
        });
        const automaticReturnRefund = makeReturnRefund(automaticOrderNumber, automaticAftersaleNumber);
        const manualReturnRefund = makeReturnRefund(manualOrderNumber, manualAftersaleNumber);
        const automaticPayload = { returnRefund: automaticReturnRefund };
        const manualPayload = {
          returnRefund: manualReturnRefund,
          returnRefundResult: {
            outcome: 'manual-completed',
            readOnlyReview: false,
            completionMethod: 'return-refund-manual-completed',
          },
        };
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, handling_classification, classification_source,
             classification_reason, idempotency_key, current_step, payload,
             completion_state, completion_confirmation_method,
             completion_confirmed_at, frontend_visibility, created_at, updated_at)
          VALUES
            ($1,$3,$4,'退货退款','return-refund','completed','completed','manual','system',
             'legacy-terminal-scan',$6,'return-refund-manual-completed',$8::jsonb,
             'confirmed','return-refund-manual-completed',now(),'operational',now(),now()),
            ($2,$3,$5,'退货退款','return-refund','completed','completed','manual','system',
             'operator-completed',$7,'return-refund-manual-completed',$9::jsonb,
             'confirmed','return-refund-manual-completed',now(),'operational',now(),now())`, [
          automaticTerminalScanWorkOrderId,
          genuineManualTerminalWorkOrderId,
          backfillShopId,
          automaticOrderNumber,
          manualOrderNumber,
          `fixture:return-refund-terminal-scan:${automaticAftersaleNumber}`,
          `fixture:return-refund-manual-terminal:${manualAftersaleNumber}`,
          JSON.stringify(automaticPayload),
          JSON.stringify(manualPayload),
        ]);
        await migrationClient.query(`
          INSERT INTO return_refunds
            (work_order_id, shop_id, external_order_number, aftersale_number,
             aftersale_type, aftersale_status, evidence, decision, risk_level,
             action_state, action_button_visible, completed_at, completion_method)
          VALUES
            ($1,$3,$4,$6,'退货退款','商家同意退款,本单退款成功',$8::jsonb,
             'manual-completed',NULL,'manual-completed',false,now(),
             'return-refund-manual-completed'),
            ($2,$3,$5,$7,'退货退款','商家同意退款,本单退款成功',$9::jsonb,
             'manual-completed',NULL,'manual-completed',false,now(),
             'return-refund-manual-completed')`, [
          automaticTerminalScanWorkOrderId,
          genuineManualTerminalWorkOrderId,
          backfillShopId,
          automaticOrderNumber,
          manualOrderNumber,
          automaticAftersaleNumber,
          manualAftersaleNumber,
          JSON.stringify(automaticReturnRefund.evidence),
          JSON.stringify(manualReturnRefund.evidence),
        ]);
      }
      if (migrationFile === '224_recover_abnormal_network_warehouse_guard.sql') {
        const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${abnormalWarehousePlatformCaseId}`;
        const reason = 'OMS_WAREHOUSE_TEMPORARILY_UNAVAILABLE: OMS 发货仓库尚未可靠读取，禁止执行OMS 配货操作';
        const payload = {
          orderNumber: abnormalWarehouseOrderNumber,
          scenarioCode: 'abnormal-network-warning',
          detailUrl,
          logisticsAnalysis: {
            orderNumber: abnormalWarehouseOrderNumber,
            abnormalNetworkShipmentState: 'unshipped',
            hasMerchantShippedText: false,
            hasLogisticsInformation: false,
          },
          omsAnalysis: {
            orderNumber: abnormalWarehouseOrderNumber,
            orderStatus: '已审核',
            shippingWarehouse: null,
            warehouseStatus: 'not-applicable',
          },
          omsWarehouseParse: {
            orderNumber: abnormalWarehouseOrderNumber,
            parsedValue: null,
            status: 'not-applicable',
          },
          transientWorkflowFailure: {
            stage: 'oms-order-analysis',
            code: 'OMS_WAREHOUSE_TEMPORARILY_UNAVAILABLE',
            reason: 'OMS 发货仓库尚未可靠读取，禁止执行OMS 配货操作',
          },
          transientWorkflowRecovery: { count: 5 },
          manualReview: { stage: 'oms-order-analysis', reason },
          error: reason,
        };
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             manual_review_reason, completion_state, frontend_visibility,
             recovery_state, created_at, updated_at)
          VALUES
            ($1,$2,$3,'异常网点预警','abnormal-network-warning','paused','paused',$4,
             'flow-paused',$5::jsonb,$6,'pending','operational','ready',now(),now())`, [
          abnormalWarehouseWorkOrderId,
          backfillShopId,
          abnormalWarehouseOrderNumber,
          `fixture:abnormal-network-warehouse:${abnormalWarehouseOrderNumber}`,
          JSON.stringify(payload),
          reason,
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, manual_review_reason)
          VALUES
            ($1,$2,$3,$4,$5,$6,'异常网点预警','abnormal-network-warning','verified',
             'paused','paused','flow-paused',$7::jsonb,$8)`, [
          abnormalWarehouseInstanceId,
          abnormalWarehouseWorkOrderId,
          backfillShopId,
          abnormalWarehousePlatformCaseId,
          `pdd-work-order:${abnormalWarehousePlatformCaseId}`,
          detailUrl,
          JSON.stringify(payload),
          reason,
        ]);
        await migrationClient.query(
          'UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1',
          [abnormalWarehouseWorkOrderId, abnormalWarehouseInstanceId],
        );
        await migrationClient.query(`
          INSERT INTO manual_interventions
            (id, shop_id, work_order_id, ordinary_instance_id, channel,
             reason_code, reason, risk_level, status, deduplication_key)
          VALUES
            ($1,$2,$3,$4,'dashboard','external-system-error',$5,'high','open',$6)`, [
          abnormalWarehouseInterventionId,
          backfillShopId,
          abnormalWarehouseWorkOrderId,
          abnormalWarehouseInstanceId,
          reason,
          `fixture:abnormal-network-warehouse-intervention:${abnormalWarehouseOrderNumber}`,
        ]);
        await migrationClient.query(`
          INSERT INTO notification_outbox (id, intervention_id, payload)
          VALUES ($1,$2,jsonb_build_object('fixture',true))`, [
          abnormalWarehouseOutboxId,
          abnormalWarehouseInterventionId,
        ]);
      }
      if (migrationFile === '225_recover_pdd_remark_color_rerender.sql') {
        const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${remarkColorPlatformCaseId}`;
        const reason = '流程需要人工复核（阶段: pdd-order-remark）：拼多多备注红色标记选择后未保持选中';
        const payload = {
          orderNumber: remarkColorOrderNumber,
          scenarioCode: 'delivered-not-received',
          detailUrl,
          pddOrderRemark: {
            orderNumber: remarkColorOrderNumber,
            text: '自动化',
            color: '红色',
            status: 'failed',
            reason: '拼多多备注红色标记选择后未保持选中',
          },
          existingTmsWorkOrder: {
            orderNumber: remarkColorOrderNumber,
            ticketNo: 'L00037422',
            status: 'created',
          },
          manualReview: { stage: 'pdd-order-remark', reason },
          error: reason,
        };
        const blockedDetailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${remarkColorBlockedPlatformCaseId}`;
        const blockedPayload = {
          ...payload,
          orderNumber: remarkColorBlockedOrderNumber,
          detailUrl: blockedDetailUrl,
          pddOrderRemark: {
            ...payload.pddOrderRemark,
            orderNumber: remarkColorBlockedOrderNumber,
          },
        };
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             manual_review_reason, completion_state, frontend_visibility,
             recovery_state, created_at, updated_at)
          VALUES
            ($1,$2,$3,'消费者反馈未收到货','delivered-not-received','paused','paused',$4,
             'manual-review-blocked',$5::jsonb,$6,'pending','operational','ready',now(),now())`, [
          remarkColorWorkOrderId,
          backfillShopId,
          remarkColorOrderNumber,
          `fixture:pdd-remark-color:${remarkColorOrderNumber}`,
          JSON.stringify(payload),
          reason,
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, manual_review_reason)
          VALUES
            ($1,$2,$3,$4,$5,$6,'消费者反馈未收到货','delivered-not-received','verified',
             'paused','paused','manual-review-blocked',$7::jsonb,$8)`, [
          remarkColorInstanceId,
          remarkColorWorkOrderId,
          backfillShopId,
          remarkColorPlatformCaseId,
          `pdd-work-order:${remarkColorPlatformCaseId}`,
          detailUrl,
          JSON.stringify(payload),
          reason,
        ]);
        await migrationClient.query(
          'UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1',
          [remarkColorWorkOrderId, remarkColorInstanceId],
        );
        await migrationClient.query(`
          INSERT INTO external_effects
            (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
             idempotency_key, status, request_hash, receipt)
          VALUES
            (gen_random_uuid(),$1,$2,$3,'tms-create',$4,'succeeded',$5,
             jsonb_build_object('ticketId','37505','ticketNo','L00037422'))`, [
          backfillShopId,
          remarkColorWorkOrderId,
          remarkColorInstanceId,
          `fixture:tms-create:${remarkColorOrderNumber}`,
          `fixture-hash:${remarkColorOrderNumber}`,
        ]);
        await migrationClient.query(`
          INSERT INTO manual_interventions
            (id, shop_id, work_order_id, ordinary_instance_id, channel,
             reason_code, reason, risk_level, status, deduplication_key)
          VALUES
            ($1,$2,$3,$4,'dashboard','manual-review-required',$5,'high','open',$6)`, [
          remarkColorInterventionId,
          backfillShopId,
          remarkColorWorkOrderId,
          remarkColorInstanceId,
          reason,
          `fixture:pdd-remark-color-intervention:${remarkColorOrderNumber}`,
        ]);
        await migrationClient.query(`
          INSERT INTO notification_outbox (id, intervention_id, payload)
          VALUES ($1,$2,jsonb_build_object('fixture',true))`, [
          remarkColorOutboxId,
          remarkColorInterventionId,
        ]);
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             manual_review_reason, completion_state, frontend_visibility,
             recovery_state, created_at, updated_at)
          VALUES
            ($1,$2,$3,'消费者反馈未收到货','delivered-not-received','paused','paused',$4,
             'manual-review-blocked',$5::jsonb,$6,'pending','operational','ready',now(),now())`, [
          remarkColorBlockedWorkOrderId,
          backfillShopId,
          remarkColorBlockedOrderNumber,
          `fixture:pdd-remark-color-blocked:${remarkColorBlockedOrderNumber}`,
          JSON.stringify(blockedPayload),
          reason,
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, manual_review_reason)
          VALUES
            ($1,$2,$3,$4,$5,$6,'消费者反馈未收到货','delivered-not-received','verified',
             'paused','paused','manual-review-blocked',$7::jsonb,$8)`, [
          remarkColorBlockedInstanceId,
          remarkColorBlockedWorkOrderId,
          backfillShopId,
          remarkColorBlockedPlatformCaseId,
          `pdd-work-order:${remarkColorBlockedPlatformCaseId}`,
          blockedDetailUrl,
          JSON.stringify(blockedPayload),
          reason,
        ]);
        await migrationClient.query(
          'UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1',
          [remarkColorBlockedWorkOrderId, remarkColorBlockedInstanceId],
        );
        await migrationClient.query(`
          INSERT INTO external_effects
            (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
             idempotency_key, status, request_hash, error)
          VALUES
            (gen_random_uuid(),$1,$2,$3,'pdd-note',$4,'failed',$5,
             jsonb_build_object('fixture',true))`, [
          backfillShopId,
          remarkColorBlockedWorkOrderId,
          remarkColorBlockedInstanceId,
          `fixture:pdd-note:${remarkColorBlockedOrderNumber}`,
          `fixture-hash:${remarkColorBlockedOrderNumber}`,
        ]);
      }
      if (migrationFile === '226_recover_oms_order_row_selection_rerender.sql') {
        const reason = 'OMS 目标订单行选择框勾选后未生效';
        const detailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${omsRowSelectionPlatformCaseId}`;
        const payload = {
          orderNumber: omsRowSelectionOrderNumber,
          scenarioCode: 'delivery-risk-concern',
          detailUrl,
          error: reason,
          tmsWorkOrder: {
            orderNumber: omsRowSelectionOrderNumber,
            ticketNo: 'L00037437',
            status: 'created',
          },
          omsAnalysis: { orderStatus: '已发货' },
        };
        const blockedDetailUrl = `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${omsRowSelectionBlockedPlatformCaseId}`;
        const blockedPayload = {
          ...payload,
          orderNumber: omsRowSelectionBlockedOrderNumber,
          detailUrl: blockedDetailUrl,
          tmsWorkOrder: {
            orderNumber: omsRowSelectionBlockedOrderNumber,
            ticketNo: 'L00037438',
            status: 'created',
          },
        };
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             manual_review_reason, completion_state, frontend_visibility,
             recovery_state, created_at, updated_at)
          VALUES
            ($1,$2,$3,'消费者担忧货物未送达','delivery-risk-concern','paused','paused',$4,
             'flow-paused',$5::jsonb,$6,'pending','operational','ready',now(),now()),
            ($7,$2,$8,'消费者担忧货物未送达','delivery-risk-concern','paused','paused',$9,
             'flow-paused',$10::jsonb,$6,'pending','operational','ready',now(),now())`, [
          omsRowSelectionWorkOrderId,
          backfillShopId,
          omsRowSelectionOrderNumber,
          `fixture:oms-row-selection:${omsRowSelectionOrderNumber}`,
          JSON.stringify(payload),
          reason,
          omsRowSelectionBlockedWorkOrderId,
          omsRowSelectionBlockedOrderNumber,
          `fixture:oms-row-selection-blocked:${omsRowSelectionBlockedOrderNumber}`,
          JSON.stringify(blockedPayload),
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, manual_review_reason)
          VALUES
            ($1,$2,$3,$4,$5,$6,'消费者担忧货物未送达','delivery-risk-concern','verified',
             'paused','paused','flow-paused',$7::jsonb,$8),
            ($9,$10,$3,$11,$12,$13,'消费者担忧货物未送达','delivery-risk-concern','verified',
             'paused','paused','flow-paused',$14::jsonb,$8)`, [
          omsRowSelectionInstanceId,
          omsRowSelectionWorkOrderId,
          backfillShopId,
          omsRowSelectionPlatformCaseId,
          `pdd-work-order:${omsRowSelectionPlatformCaseId}`,
          detailUrl,
          JSON.stringify(payload),
          reason,
          omsRowSelectionBlockedInstanceId,
          omsRowSelectionBlockedWorkOrderId,
          omsRowSelectionBlockedPlatformCaseId,
          `pdd-work-order:${omsRowSelectionBlockedPlatformCaseId}`,
          blockedDetailUrl,
          JSON.stringify(blockedPayload),
        ]);
        await migrationClient.query(`
          UPDATE work_orders
          SET current_ordinary_instance_id = CASE id
            WHEN $1 THEN $2::uuid
            WHEN $3 THEN $4::uuid
          END
          WHERE id IN ($1,$3)`, [
          omsRowSelectionWorkOrderId,
          omsRowSelectionInstanceId,
          omsRowSelectionBlockedWorkOrderId,
          omsRowSelectionBlockedInstanceId,
        ]);
        await migrationClient.query(`
          INSERT INTO external_effects
            (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
             idempotency_key, status, request_hash, receipt)
          VALUES
            (gen_random_uuid(),$1,$2,$3,'tms-create',$4,'succeeded',$5,
             jsonb_build_object('ticketNo','L00037437')),
            (gen_random_uuid(),$1,$6,$7,'oms-reissue-create',$8,'reserved',$9,
             '{}'::jsonb)`, [
          backfillShopId,
          omsRowSelectionWorkOrderId,
          omsRowSelectionInstanceId,
          `fixture:tms-create:${omsRowSelectionOrderNumber}`,
          `fixture-hash:${omsRowSelectionOrderNumber}`,
          omsRowSelectionBlockedWorkOrderId,
          omsRowSelectionBlockedInstanceId,
          `fixture:oms-reissue:${omsRowSelectionBlockedOrderNumber}`,
          `fixture-hash:${omsRowSelectionBlockedOrderNumber}`,
        ]);
        await migrationClient.query(`
          INSERT INTO manual_interventions
            (id, shop_id, work_order_id, ordinary_instance_id, channel,
             reason_code, reason, risk_level, status, deduplication_key)
          VALUES
            ($1,$2,$3,$4,'dashboard','oms-query-miss',$5,'medium','open',$6)`, [
          omsRowSelectionInterventionId,
          backfillShopId,
          omsRowSelectionWorkOrderId,
          omsRowSelectionInstanceId,
          reason,
          `fixture:oms-row-selection-intervention:${omsRowSelectionOrderNumber}`,
        ]);
      }
      if (migrationFile === '227_reconcile_duplicate_tms_rows_by_first_match.sql') {
        const reason = 'TMS 精确查询到 2 条同订单记录，无法唯一核对中断前的创建结果';
        const makePayload = (orderNumber, platformCaseId) => ({
          orderNumber,
          scenarioCode: 'in-transit-refund',
          platformCaseKey: `pdd-work-order:${platformCaseId}`,
          detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformCaseId}`,
          externalStateReconciliation: {
            state: 'unresolved',
            effectType: 'tms-create',
            candidateCount: 2,
            reason,
          },
          externalStateReconciliationRetry: { attempts: 6, maxAttempts: 6 },
          tmsCreateReconciliation: { status: 'unresolved', candidateCount: 2, reason },
        });
        const payload = makePayload(
          duplicateTmsReconciliationOrderNumber,
          duplicateTmsReconciliationPlatformCaseId,
        );
        const blockedPayload = makePayload(
          duplicateTmsReconciliationBlockedOrderNumber,
          duplicateTmsReconciliationBlockedPlatformCaseId,
        );
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             manual_review_reason, completion_state, frontend_visibility,
             recovery_state, recovery_reason, created_at, updated_at)
          VALUES
            ($1,$2,$3,'在途无理由退款处理','in-transit-refund','paused','paused',$4,
             'external-state-unresolved',$5::jsonb,'等待只读核对 TMS 建单结果，禁止重复建单',
             'pending','operational','held','external-state-reconciliation-retry-pending',now(),now()),
            ($6,$2,$7,'在途无理由退款处理','in-transit-refund','paused','paused',$8,
             'external-state-unresolved',$9::jsonb,'等待只读核对 TMS 建单结果，禁止重复建单',
             'pending','operational','held','external-state-reconciliation-retry-pending',now(),now())`, [
          duplicateTmsReconciliationWorkOrderId,
          backfillShopId,
          duplicateTmsReconciliationOrderNumber,
          `fixture:duplicate-tms-reconciliation:${duplicateTmsReconciliationOrderNumber}`,
          JSON.stringify(payload),
          duplicateTmsReconciliationBlockedWorkOrderId,
          duplicateTmsReconciliationBlockedOrderNumber,
          `fixture:duplicate-tms-reconciliation-blocked:${duplicateTmsReconciliationBlockedOrderNumber}`,
          JSON.stringify(blockedPayload),
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, manual_review_reason)
          VALUES
            ($1,$2,$3,$4,$5,$6,'在途无理由退款处理','in-transit-refund','verified',
             'paused','paused','external-state-unresolved',$7::jsonb,
             '等待只读核对 TMS 建单结果，禁止重复建单'),
            ($8,$9,$3,$10,$11,$12,'在途无理由退款处理','in-transit-refund','verified',
             'paused','paused','external-state-unresolved',$13::jsonb,
             '等待只读核对 TMS 建单结果，禁止重复建单')`, [
          duplicateTmsReconciliationInstanceId,
          duplicateTmsReconciliationWorkOrderId,
          backfillShopId,
          duplicateTmsReconciliationPlatformCaseId,
          `pdd-work-order:${duplicateTmsReconciliationPlatformCaseId}`,
          payload.detailUrl,
          JSON.stringify(payload),
          duplicateTmsReconciliationBlockedInstanceId,
          duplicateTmsReconciliationBlockedWorkOrderId,
          duplicateTmsReconciliationBlockedPlatformCaseId,
          `pdd-work-order:${duplicateTmsReconciliationBlockedPlatformCaseId}`,
          blockedPayload.detailUrl,
          JSON.stringify(blockedPayload),
        ]);
        await migrationClient.query(`
          UPDATE work_orders
          SET current_ordinary_instance_id = CASE id
            WHEN $1 THEN $2::uuid
            WHEN $3 THEN $4::uuid
          END
          WHERE id IN ($1,$3)`, [
          duplicateTmsReconciliationWorkOrderId,
          duplicateTmsReconciliationInstanceId,
          duplicateTmsReconciliationBlockedWorkOrderId,
          duplicateTmsReconciliationBlockedInstanceId,
        ]);
        await migrationClient.query(`
          INSERT INTO external_effects
            (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
             idempotency_key, status, request_hash, error)
          VALUES
            (gen_random_uuid(),$1,$2,$3,'tms-create',$4,'unknown',$5,
             jsonb_build_object('fixture',true)),
            (gen_random_uuid(),$1,$6,$7,'tms-create',$8,'unknown',$9,
             jsonb_build_object('fixture',true)),
            (gen_random_uuid(),$1,$6,$7,'pdd-submit',$10,'succeeded',$11,NULL)`, [
          backfillShopId,
          duplicateTmsReconciliationWorkOrderId,
          duplicateTmsReconciliationInstanceId,
          `fixture:tms-create:${duplicateTmsReconciliationOrderNumber}`,
          `fixture-hash:tms-create:${duplicateTmsReconciliationOrderNumber}`,
          duplicateTmsReconciliationBlockedWorkOrderId,
          duplicateTmsReconciliationBlockedInstanceId,
          `fixture:tms-create:${duplicateTmsReconciliationBlockedOrderNumber}`,
          `fixture-hash:tms-create:${duplicateTmsReconciliationBlockedOrderNumber}`,
          `fixture:pdd-submit:${duplicateTmsReconciliationBlockedOrderNumber}`,
          `fixture-hash:pdd-submit:${duplicateTmsReconciliationBlockedOrderNumber}`,
        ]);
      }
      if (migrationFile === '228_reclassify_consumer_response_waits.sql') {
        const startedAt = '2026-08-24T14:04:48.161Z';
        const nextAttemptAt = '2026-08-25T02:04:48.161Z';
        const waitReason = '拼多多正在等待消费者确认拦截后退款方案，满 12 小时仍无回复后再自动处理';
        const payload = {
          orderNumber: consumerResponseWaitOrderNumber,
          scenarioCode: 'in-transit-refund',
          platformCaseKey: `pdd-work-order:${consumerResponseWaitPlatformCaseId}`,
          detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${consumerResponseWaitPlatformCaseId}`,
          step: 'logistics-waiting-released',
          pddResolutionFlow: { flowCode: 'consumer-negotiation-followup' },
          pddResolutionSubmission: {
            orderNumber: consumerResponseWaitOrderNumber,
            status: 'followup-waiting',
            interceptProgressOutcome: '快递还在拦截中',
            consumerResponseWaitStartedAt: startedAt,
            consumerResponseNextAttemptAt: nextAttemptAt,
          },
          logisticsWait: {
            orderNumber: consumerResponseWaitOrderNumber,
            reason: waitReason,
            retryAfterAt: nextAttemptAt,
            lastCheckedAt: startedAt,
          },
          updatedAt: startedAt,
        };
        await migrationClient.query(`
          INSERT INTO work_orders
            (id, shop_id, external_order_number, work_order_type, scenario_code,
             status, runtime_status, idempotency_key, current_step, payload,
             next_attempt_at, completion_state, frontend_visibility,
             recovery_state, created_at, updated_at)
          VALUES
            ($1,$2,$3,'在途无理由退款处理','in-transit-refund',
             'retry-ready','retry-ready',$4,'logistics-waiting-released',$5::jsonb,
             $6::timestamptz,'pending','operational','ready',now(),now())`, [
          consumerResponseWaitWorkOrderId,
          backfillShopId,
          consumerResponseWaitOrderNumber,
          `fixture:consumer-response-wait:${consumerResponseWaitOrderNumber}`,
          JSON.stringify(payload),
          nextAttemptAt,
        ]);
        await migrationClient.query(`
          INSERT INTO ordinary_work_order_instances
            (id, work_order_id, shop_id, platform_case_id, platform_case_key,
             detail_url, work_order_type, scenario_code, identity_status, status,
             runtime_status, current_step, payload, next_attempt_at)
          VALUES
            ($1,$2,$3,$4,$5,$6,'在途无理由退款处理','in-transit-refund','verified',
             'retry-ready','retry-ready','logistics-waiting-released',$7::jsonb,
             $8::timestamptz)`, [
          consumerResponseWaitInstanceId,
          consumerResponseWaitWorkOrderId,
          backfillShopId,
          consumerResponseWaitPlatformCaseId,
          `pdd-work-order:${consumerResponseWaitPlatformCaseId}`,
          payload.detailUrl,
          JSON.stringify(payload),
          nextAttemptAt,
        ]);
        await migrationClient.query(`
          UPDATE work_orders SET current_ordinary_instance_id = $2
          WHERE id = $1`, [
          consumerResponseWaitWorkOrderId,
          consumerResponseWaitInstanceId,
        ]);
      }
      const sql = readFileSync(path.join(root, 'infra/db/migrations', migrationFile), 'utf8')
        .replace(/^\s*\\encoding\s+\S+\s*$/gmu, '');
      await migrationClient.query(sql);
    }
    const duplicateTmsReconciliation = await migrationClient.query(`
      SELECT work_order.status, work_order.runtime_status, work_order.current_step,
        work_order.recovery_state, work_order.recovery_reason,
        work_order.payload#>>'{externalStateReconciliationTarget,strategy}' AS strategy,
        work_order.payload#>>'{externalStateReconciliationRetry,attempts}' AS attempts,
        work_order.payload#>>'{tmsDuplicateRecordRecovery227,selectedIndex}' AS selected_index,
        work_order.payload#>>'{tmsDuplicateRecordRecovery227,externalEffectPreserved}'
          AS external_effect_preserved,
        instance.current_step AS instance_step,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_order.id
           AND effect.effect_type = 'tms-create'
           AND effect.status = 'unknown') AS unknown_tms_count,
        (SELECT count(*)::int FROM audit_events event
         WHERE event.work_order_id = work_order.id
           AND event.event_type = 'duplicate-tms-first-row-reconciliation-ready') AS audit_count
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE work_order.id = $1`, [duplicateTmsReconciliationWorkOrderId]);
    assert.deepEqual(duplicateTmsReconciliation.rows[0], {
      status: 'paused',
      runtime_status: 'paused',
      current_step: 'external-state-reconciliation-ready',
      recovery_state: 'ready',
      recovery_reason: null,
      strategy: 'read-only-first-exact-order-user-authorized',
      attempts: '0',
      selected_index: '0',
      external_effect_preserved: 'true',
      instance_step: 'external-state-reconciliation-ready',
      unknown_tms_count: 1,
      audit_count: 1,
    }, 'migration 227 must resume duplicate TMS rows for read-only first-row reconciliation');
    const blockedDuplicateTmsReconciliation = await migrationClient.query(`
      SELECT status, runtime_status, current_step, recovery_state,
        payload ? 'tmsDuplicateRecordRecovery227' AS has_recovery,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_orders.id
           AND effect.effect_type = 'pdd-submit'
           AND effect.status = 'succeeded') AS succeeded_pdd_count
      FROM work_orders WHERE id = $1`, [duplicateTmsReconciliationBlockedWorkOrderId]);
    assert.deepEqual(blockedDuplicateTmsReconciliation.rows[0], {
      status: 'paused',
      runtime_status: 'paused',
      current_step: 'external-state-unresolved',
      recovery_state: 'held',
      has_recovery: false,
      succeeded_pdd_count: 1,
    }, 'migration 227 must preserve a duplicate TMS row after a succeeded PDD submit');
    const migration227 = await migrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = '227_reconcile_duplicate_tms_rows_by_first_match.sql'",
    );
    assert.equal(migration227.rowCount, 1, 'migration 227 must record its schema version');
    const consumerResponseWaitReclassification = await migrationClient.query(`
      SELECT
        work_order.status,
        work_order.runtime_status,
        work_order.current_step,
        work_order.next_attempt_at::text AS work_order_next_attempt_at,
        work_order.payload#>>'{logisticsWait,waitKind}' AS wait_kind,
        work_order.payload#>>'{consumerResponseWait,timerPreserved}' AS timer_preserved,
        work_order.payload#>>'{consumerResponseWaitReclassification228,externalActionsReplayed}'
          AS external_actions_replayed,
        instance.status AS instance_status,
        instance.runtime_status AS instance_runtime_status,
        instance.current_step AS instance_step,
        instance.next_attempt_at::text AS instance_next_attempt_at,
        instance.payload#>>'{logisticsWait,waitKind}' AS instance_wait_kind,
        (SELECT count(*)::int
         FROM audit_events event
         WHERE event.work_order_id = work_order.id
           AND event.event_type = 'consumer-response-wait-reclassified') AS audit_count,
        (SELECT count(*)::int
         FROM external_effects effect
         WHERE effect.work_order_id = work_order.id) AS external_effect_count
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE work_order.id = $1`, [consumerResponseWaitWorkOrderId]);
    const consumerResponseWaitRow = consumerResponseWaitReclassification.rows[0];
    assert.equal(consumerResponseWaitRow.status, 'retry-ready');
    assert.equal(consumerResponseWaitRow.runtime_status, 'retry-ready');
    assert.equal(consumerResponseWaitRow.current_step, 'consumer-response-waiting-released');
    assert.equal(consumerResponseWaitRow.wait_kind, 'consumer-response');
    assert.equal(consumerResponseWaitRow.timer_preserved, 'true');
    assert.equal(consumerResponseWaitRow.external_actions_replayed, 'false');
    assert.equal(consumerResponseWaitRow.instance_status, 'retry-ready');
    assert.equal(consumerResponseWaitRow.instance_runtime_status, 'retry-ready');
    assert.equal(consumerResponseWaitRow.instance_step, 'consumer-response-waiting-released');
    assert.equal(consumerResponseWaitRow.instance_wait_kind, 'consumer-response');
    assert.equal(
      Date.parse(consumerResponseWaitRow.work_order_next_attempt_at),
      Date.parse('2026-08-25T02:04:48.161Z'),
      'migration 228 must preserve the work-order retry deadline exactly',
    );
    assert.equal(
      Date.parse(consumerResponseWaitRow.instance_next_attempt_at),
      Date.parse('2026-08-25T02:04:48.161Z'),
      'migration 228 must preserve the instance retry deadline exactly',
    );
    assert.equal(consumerResponseWaitRow.audit_count, 1,
      'migration 228 must create exactly one reclassification audit event');
    assert.equal(consumerResponseWaitRow.external_effect_count, 0,
      'migration 228 must not replay any OMS, TMS, or PDD external action');
    const migration228 = await migrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = '228_reclassify_consumer_response_waits.sql'",
    );
    assert.equal(migration228.rowCount, 1, 'migration 228 must record its schema version');
    const omsRowSelectionRecovery = await migrationClient.query(`
      SELECT
        work_order.status,
        work_order.runtime_status,
        work_order.current_step,
        work_order.manual_review_reason,
        work_order.payload#>>'{tmsWorkOrder,ticketNo}' AS ticket_no,
        work_order.payload#>>'{omsOrderRowSelectionRecovery226,strategy}' AS strategy,
        work_order.payload#>>'{omsOrderRowSelectionRecovery226,existingTmsEffectPreserved}'
          AS existing_tms_effect_preserved,
        instance.status AS instance_status,
        instance.current_step AS instance_step,
        intervention.status AS intervention_status,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_order.id
           AND effect.effect_type = 'tms-create'
           AND effect.status = 'succeeded') AS succeeded_tms_count,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_order.id
           AND effect.effect_type IN ('oms-manual-allocation','oms-reissue-create','pdd-note','pdd-submit'))
          AS mutation_effect_count
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN manual_interventions intervention
        ON intervention.id = $2
      WHERE work_order.id = $1`, [
      omsRowSelectionWorkOrderId,
      omsRowSelectionInterventionId,
    ]);
    assert.deepEqual(omsRowSelectionRecovery.rows[0], {
      status: 'retry-ready',
      runtime_status: 'retry-ready',
      current_step: 'oms-order-row-selection-retry-ready',
      manual_review_reason: null,
      ticket_no: 'L00037437',
      strategy: 'reacquire-row-checkbox-after-oms-rerender',
      existing_tms_effect_preserved: 'true',
      instance_status: 'retry-ready',
      instance_step: 'oms-order-row-selection-retry-ready',
      intervention_status: 'resolved',
      succeeded_tms_count: 1,
      mutation_effect_count: 0,
    }, 'migration 226 must resume the OMS row rerender failure without replaying the TMS ticket');
    const blockedOmsRowSelectionRecovery = await migrationClient.query(`
      SELECT status, runtime_status, current_step, manual_review_reason,
        payload ? 'omsOrderRowSelectionRecovery226' AS has_recovery,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_orders.id
           AND effect.effect_type = 'oms-reissue-create') AS reissue_effect_count
      FROM work_orders
      WHERE id = $1`, [omsRowSelectionBlockedWorkOrderId]);
    assert.deepEqual(blockedOmsRowSelectionRecovery.rows[0], {
      status: 'paused',
      runtime_status: 'paused',
      current_step: 'flow-paused',
      manual_review_reason: 'OMS 目标订单行选择框勾选后未生效',
      has_recovery: false,
      reissue_effect_count: 1,
    }, 'migration 226 must not resume a row with a potentially applied OMS reissue mutation');
    const remarkColorRecovery = await migrationClient.query(`
      SELECT
        work_order.status,
        work_order.runtime_status,
        work_order.current_step,
        work_order.manual_review_reason,
        work_order.payload#>>'{pddOrderRemark,status}' AS remark_status,
        work_order.payload#>>'{pddOrderRemark,reasonCode}' AS remark_reason_code,
        work_order.payload#>>'{pddRemarkColorRecovery225,strategy}' AS strategy,
        work_order.payload#>>'{pddRemarkColorRecovery225,existingTmsEffectPreserved}'
          AS existing_tms_effect_preserved,
        instance.status AS instance_status,
        instance.current_step AS instance_step,
        intervention.status AS intervention_status,
        outbox.status AS outbox_status,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_order.id
           AND effect.effect_type = 'tms-create'
           AND effect.status = 'succeeded') AS succeeded_tms_count,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_order.id
           AND effect.effect_type IN ('pdd-note', 'pdd-submit')) AS pdd_effect_count
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN manual_interventions intervention
        ON intervention.id = $2
      JOIN notification_outbox outbox
        ON outbox.id = $3
      WHERE work_order.id = $1`, [
      remarkColorWorkOrderId,
      remarkColorInterventionId,
      remarkColorOutboxId,
    ]);
    assert.equal(remarkColorRecovery.rowCount, 1);
    assert.deepEqual(remarkColorRecovery.rows[0], {
      status: 'retry-ready',
      runtime_status: 'retry-ready',
      current_step: 'pdd-order-remark-color-retry-ready',
      manual_review_reason: null,
      remark_status: 'retry-ready',
      remark_reason_code: 'transient-color-rerender',
      strategy: 're-resolve-color-after-pdd-rerender',
      existing_tms_effect_preserved: 'true',
      instance_status: 'retry-ready',
      instance_step: 'pdd-order-remark-color-retry-ready',
      intervention_status: 'resolved',
      outbox_status: 'cancelled',
      succeeded_tms_count: 1,
      pdd_effect_count: 0,
    }, 'migration 225 must resume the pre-save remark race without replaying the successful TMS effect');
    const blockedRemarkColorRecovery = await migrationClient.query(`
      SELECT status, runtime_status, current_step, manual_review_reason,
        payload#>>'{pddOrderRemark,status}' AS remark_status,
        payload ? 'pddRemarkColorRecovery225' AS has_recovery,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_orders.id
           AND effect.effect_type IN ('pdd-note', 'pdd-submit')) AS pdd_effect_count
      FROM work_orders
      WHERE id = $1`, [remarkColorBlockedWorkOrderId]);
    assert.deepEqual(blockedRemarkColorRecovery.rows[0], {
      status: 'paused',
      runtime_status: 'paused',
      current_step: 'manual-review-blocked',
      manual_review_reason: '流程需要人工复核（阶段: pdd-order-remark）：拼多多备注红色标记选择后未保持选中',
      remark_status: 'failed',
      has_recovery: false,
      pdd_effect_count: 1,
    }, 'migration 225 must not resume any row that already reserved a PDD mutation');
    const abnormalWarehouseRecovery = await migrationClient.query(`
      SELECT
        work_order.status,
        work_order.runtime_status,
        work_order.current_step,
        work_order.manual_review_reason,
        work_order.payload ? 'omsAnalysis' AS has_oms_analysis,
        work_order.payload ? 'transientWorkflowRecovery' AS has_transient_recovery,
        work_order.payload#>>'{abnormalNetworkWarehouseRecovery224,strategy}' AS strategy,
        work_order.payload#>>'{abnormalNetworkWarehouseRecovery224,externalActionsReplayed}'
          AS external_actions_replayed,
        instance.status AS instance_status,
        instance.current_step AS instance_step,
        intervention.status AS intervention_status,
        outbox.status AS outbox_status,
        (SELECT count(*)::int FROM external_effects effect
         WHERE effect.work_order_id = work_order.id) AS effect_count
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN manual_interventions intervention
        ON intervention.id = $2
      JOIN notification_outbox outbox
        ON outbox.id = $3
      WHERE work_order.id = $1`, [
      abnormalWarehouseWorkOrderId,
      abnormalWarehouseInterventionId,
      abnormalWarehouseOutboxId,
    ]);
    assert.equal(abnormalWarehouseRecovery.rowCount, 1);
    assert.deepEqual(abnormalWarehouseRecovery.rows[0], {
      status: 'retry-ready',
      runtime_status: 'retry-ready',
      current_step: 'oms-warehouse-analysis-retry-ready',
      manual_review_reason: null,
      has_oms_analysis: false,
      has_transient_recovery: false,
      strategy: 're-read-warehouse-before-oms-allocation',
      external_actions_replayed: 'false',
      instance_status: 'retry-ready',
      instance_step: 'oms-warehouse-analysis-retry-ready',
      intervention_status: 'resolved',
      outbox_status: 'cancelled',
      effect_count: 0,
    }, 'migration 224 must safely resume the contradiction without replaying an external action');
    const backfill = await migrationClient.query(`
      SELECT work_order.id, work_order.current_ordinary_instance_id,
        instance.identity_status, instance.platform_case_id, instance.platform_case_key,
        instance.payload->'identityBackfillConflict' AS conflict
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE work_order.id = ANY($1::uuid[])
      ORDER BY work_order.id`, [[operationalWorkOrderId, recoveryAuditWorkOrderId]]);
    assert.equal(backfill.rowCount, 2, 'every duplicate backfill row must retain an explicit current instance');
    const operational = backfill.rows.find((row) => row.id === operationalWorkOrderId);
    const recoveryAudit = backfill.rows.find((row) => row.id === recoveryAuditWorkOrderId);
    assert.equal(operational.identity_status, 'verified', 'the operational row must own the platform identity');
    assert.equal(operational.platform_case_id, duplicatePlatformCaseId);
    assert.equal(operational.platform_case_key, `pdd-work-order:${duplicatePlatformCaseId}`);
    assert.equal(recoveryAudit.identity_status, 'legacy-unverified');
    assert.equal(recoveryAudit.platform_case_id, null);
    assert.equal(recoveryAudit.platform_case_key, null);
    assert.equal(recoveryAudit.conflict.reason, 'duplicate-platform-case-id');
    assert.equal(recoveryAudit.conflict.authoritativeWorkOrderId, operationalWorkOrderId);
    const terminalMismatch = await migrationClient.query(`
      SELECT work_order.status, work_order.runtime_status, work_order.current_step,
        work_order.recovery_state, work_order.manual_review_reason,
        work_order.payload #>> '{pddResolutionSubmission,recoveredFromCompletedPage}'
          AS recovered_from_completed_page,
        work_order.payload #>> '{deterministicOrdinaryRecovery192,strategy}'
          AS recovery_strategy,
        instance.status AS instance_status,
        instance.current_step AS instance_step,
        intervention.status AS intervention_status,
        outbox.status AS outbox_status,
        count(effect.id)::int AS effect_count,
        count(effect.id) FILTER (WHERE effect.effect_type = 'pdd-submit')::int
          AS pdd_submit_effect_count
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      JOIN manual_interventions intervention
        ON intervention.id = $2
      JOIN notification_outbox outbox
        ON outbox.id = $3
      LEFT JOIN external_effects effect
        ON effect.work_order_id = work_order.id
      WHERE work_order.id = $1
      GROUP BY work_order.id, instance.id, intervention.id, outbox.id`, [
      terminalMismatchWorkOrderId,
      terminalMismatchInterventionId,
      terminalMismatchOutboxId,
    ]);
    assert.equal(terminalMismatch.rowCount, 1);
    assert.deepEqual(terminalMismatch.rows[0], {
      status: 'retry-ready',
      runtime_status: 'retry-ready',
      current_step: 'confirmed-terminal-archive-retry-ready',
      recovery_state: 'ready',
      manual_review_reason: null,
      recovered_from_completed_page: 'true',
      recovery_strategy: 'archive-confirmed-platform-terminal-state',
      instance_status: 'retry-ready',
      instance_step: 'confirmed-terminal-archive-retry-ready',
      intervention_status: 'resolved',
      outbox_status: 'cancelled',
      effect_count: 1,
      pdd_submit_effect_count: 0,
    }, 'a verified terminal mismatch must enter read-only archival without another submit');
    const warehouseScopeRows = await migrationClient.query(`
      SELECT
        work_order.id,
        work_order.status,
        work_order.runtime_status,
        work_order.current_step,
        work_order.recovery_state,
        work_order.recovery_reason,
        work_order.manual_review_reason,
        work_order.payload#>>'{omsAnalysis,warehouseStatus}' AS warehouse_status,
        work_order.payload#>>'{omsWarehouseParse,status}' AS parse_status,
        work_order.payload#>>'{tmsWorkOrder,status}' AS tms_status,
        work_order.payload#>>'{tmsWorkOrder,ticketNo}' AS ticket_no,
        work_order.payload ? 'warehouseScopeGuard' AS has_scope_guard,
        instance.status AS instance_status,
        instance.runtime_status AS instance_runtime_status,
        instance.current_step AS instance_step,
        (SELECT intervention.status
         FROM manual_interventions intervention
         WHERE intervention.work_order_id = work_order.id
           AND intervention.reason_code = 'warehouse-out-of-scope'
         ORDER BY intervention.created_at DESC
         LIMIT 1) AS intervention_status,
        (SELECT count(*)::int
         FROM audit_events event
         WHERE event.work_order_id = work_order.id
           AND event.event_type = 'oms-warehouse-scope-expanded-retry-ready') AS expansion_audit_count
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE work_order.id = ANY($1::uuid[])`, [
      warehouseScopeFixtures.map((fixture) => fixture.workOrderId),
    ]);
    assert.equal(warehouseScopeRows.rowCount, warehouseScopeFixtures.length);
    for (const fixture of warehouseScopeFixtures) {
      const row = warehouseScopeRows.rows.find(({ id }) => id === fixture.workOrderId);
      assert.ok(row, `warehouse scope fixture must remain queryable: ${fixture.warehouse}`);
      assert.equal(row.tms_status, 'created', 'migration 219 must preserve existing TMS status');
      assert.equal(row.ticket_no, fixture.ticketNo, 'migration 219 must preserve the exact TMS ticket');
      if (fixture.allowed) {
        assert.equal(row.status, 'retry-ready');
        assert.equal(row.runtime_status, 'retry-ready');
        assert.equal(row.current_step, 'oms-warehouse-scope-expanded-retry-ready');
        assert.equal(row.recovery_state, 'ready');
        assert.equal(row.recovery_reason, null);
        assert.equal(row.manual_review_reason, null);
        assert.equal(row.warehouse_status, 'confirmed');
        assert.equal(row.parse_status, 'confirmed');
        assert.equal(row.has_scope_guard, false);
        assert.equal(row.instance_status, 'retry-ready');
        assert.equal(row.instance_runtime_status, 'retry-ready');
        assert.equal(row.instance_step, 'oms-warehouse-scope-expanded-retry-ready');
        assert.equal(row.intervention_status, 'resolved');
        assert.equal(row.expansion_audit_count, 1);
      } else {
        assert.equal(row.status, 'paused');
        assert.equal(row.runtime_status, 'paused');
        assert.equal(row.current_step, 'oms-warehouse-out-of-scope');
        assert.equal(row.recovery_state, 'held');
        assert.equal(row.recovery_reason, 'oms-warehouse-out-of-scope-hard-stop');
        assert.equal(row.warehouse_status, 'out-of-scope');
        assert.equal(row.parse_status, 'out-of-scope');
        assert.equal(row.has_scope_guard, true);
        assert.equal(row.intervention_status, 'open');
        assert.equal(row.expansion_audit_count, 0);
      }
    }
    const migration219 = await migrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = '219_expand_oms_warehouse_scope.sql'",
    );
    assert.equal(migration219.rowCount, 1, 'migration 219 must record its schema version');
    const uploadNotification = await migrationClient.query(`
      SELECT intervention.reason_code, intervention.status AS intervention_status,
        outbox.status AS outbox_status, outbox.payload->>'deliverySource' AS delivery_source,
        outbox.payload->>'orderNumber' AS order_number,
        outbox.payload->>'problemZh' AS problem_zh
      FROM manual_interventions intervention
      JOIN notification_outbox outbox ON outbox.intervention_id = intervention.id
      WHERE intervention.work_order_id = $1
        AND intervention.reason_code = 'pdd-upload-authorization-failed'`, [
      uploadNotificationWorkOrderId,
    ]);
    assert.equal(uploadNotification.rowCount, 1, 'migration 222 must create exactly one durable upload notification');
    assert.deepEqual(uploadNotification.rows[0], {
      reason_code: 'pdd-upload-authorization-failed',
      intervention_status: 'open',
      outbox_status: 'pending',
      delivery_source: 'automatic',
      order_number: '260824-481430000000001',
      problem_zh: '拼多多凭证图片上传失败：上传授权接口返回 48143 非法请求，自动重试已结束',
    });
    const migration222 = await migrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = '222_backfill_current_pdd_upload_authorization_notifications.sql'",
    );
    assert.equal(migration222.rowCount, 1, 'migration 222 must record its schema version');
    const terminalClassifications = await migrationClient.query(`
      SELECT work_order.id, work_order.current_step,
        work_order.handling_classification, work_order.classification_source,
        work_order.classification_reason, work_order.completion_confirmation_method,
        work_order.payload#>>'{returnRefund,decision,readOnlyReview}' AS read_only_review,
        work_order.payload#>>'{returnRefund,decision,completionMethod}' AS payload_completion_method,
        refund.completion_method AS refund_completion_method,
        count(audit.id)::int AS audit_count
      FROM work_orders work_order
      JOIN return_refunds refund ON refund.work_order_id = work_order.id
      LEFT JOIN audit_events audit ON audit.work_order_id = work_order.id
        AND audit.event_type = 'return-refund-terminal-scan-classified-automated'
      WHERE work_order.id = ANY($1::uuid[])
      GROUP BY work_order.id, refund.completion_method
      ORDER BY work_order.id`, [[
      automaticTerminalScanWorkOrderId,
      genuineManualTerminalWorkOrderId,
    ]]);
    assert.equal(terminalClassifications.rowCount, 2);
    const automaticTerminal = terminalClassifications.rows.find(
      ({ id }) => id === automaticTerminalScanWorkOrderId,
    );
    assert.deepEqual(automaticTerminal, {
      id: automaticTerminalScanWorkOrderId,
      current_step: 'return-refund-read-only-complete',
      handling_classification: 'automated',
      classification_source: 'system',
      classification_reason: 'automated-read-only-terminal-scan',
      completion_confirmation_method: 'return-refund-read-only-page-completed',
      read_only_review: 'true',
      payload_completion_method: 'return-refund-read-only-page-completed',
      refund_completion_method: 'return-refund-read-only-page-completed',
      audit_count: 1,
    }, 'migration 223 must recover only a structurally proven automatic terminal scan');
    const genuineManualTerminal = terminalClassifications.rows.find(
      ({ id }) => id === genuineManualTerminalWorkOrderId,
    );
    assert.deepEqual(genuineManualTerminal, {
      id: genuineManualTerminalWorkOrderId,
      current_step: 'return-refund-manual-completed',
      handling_classification: 'manual',
      classification_source: 'system',
      classification_reason: 'operator-completed',
      completion_confirmation_method: 'return-refund-manual-completed',
      read_only_review: null,
      payload_completion_method: null,
      refund_completion_method: 'return-refund-manual-completed',
      audit_count: 0,
    }, 'migration 223 must preserve a genuine manual completion result');
    const migration223 = await migrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = '223_reclassify_automatic_return_refund_terminal_scans.sql'",
    );
    assert.equal(migration223.rowCount, 1, 'migration 223 must record its schema version');
  } finally {
    await migrationClient.end().catch(() => {});
  }

  process.env.DATABASE_URL = testUrl.toString();
  const testScript = pathToFileURL(path.join(root, 'scripts/ordinary-work-order-instance-postgres-self-test.mjs'));
  testScript.searchParams.set('run', Date.now().toString());
  await import(testScript.href);
  const dailySummaryTest = pathToFileURL(path.join(root, 'scripts/dingtalk-daily-summary-postgres-self-test.mjs'));
  dailySummaryTest.searchParams.set('run', Date.now().toString());
  await import(dailySummaryTest.href);
  const returnRefundClaimTest = pathToFileURL(path.join(root, 'scripts/return-refund-claim-self-test.mjs'));
  returnRefundClaimTest.searchParams.set('run', Date.now().toString());
  await import(returnRefundClaimTest.href);
} finally {
  if (created) {
    await admin.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [testDatabase]);
    await admin.query(`DROP DATABASE IF EXISTS ${quotedTestDatabase}`);
    const remaining = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDatabase]);
    assert.equal(remaining.rowCount, 0, 'isolated PostgreSQL test database must be removed');
  }
  await admin.end().catch(() => {});
}

console.log('ordinary work-order isolated PostgreSQL harness passed');
