import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

const pool = await createPostgresPool();
const repository = new PostgresWorkflowRepository(pool);
const suffix = crypto.randomUUID().slice(0, 8);
const shopId = `scheduler-test-worker-${suffix}`;
const firstId = crypto.randomUUID();
const secondId = crypto.randomUUID();
const commandId = crypto.randomUUID();
const verificationId = crypto.randomUUID();
const checkpointVerificationInterventionId = crypto.randomUUID();
const checkpointVerificationOutboxId = crypto.randomUUID();
const checkpointBusinessInterventionId = crypto.randomUUID();
const forceClearVerificationId = crypto.randomUUID();
const staleDetachedPddVerificationId = crypto.randomUUID();
const boundStalePddVerificationId = crypto.randomUUID();
const checkpointBoundPddVerificationId = crypto.randomUUID();
const preDetectionAuthPddVerificationId = crypto.randomUUID();
const staleDetachedVerificationInterventionId = crypto.randomUUID();
const staleDetachedVerificationOutboxId = crypto.randomUUID();
const retryTransientInterventionId = crypto.randomUUID();
const retryWaitingInterventionId = crypto.randomUUID();
const remarkRetryId = crypto.randomUUID();
const remarkBlockedId = crypto.randomUUID();
const safePddDetailRecoveryId = crypto.randomUUID();
const safePddDetailRecoveryInstanceId = crypto.randomUUID();
const legacyPddDetailRecoveryId = crypto.randomUUID();
const legacyPddDetailRecoveryInstanceId = crypto.randomUUID();
const conflictingLegacyPddDetailRecoveryId = crypto.randomUUID();
const conflictingLegacyPddDetailRecoveryInstanceId = crypto.randomUUID();
const stalePddDetailRecoveryId = crypto.randomUUID();
const stalePddDetailRecoveryInstanceId = crypto.randomUUID();
const mismatchedPddDetailRecoveryId = crypto.randomUUID();
const mismatchedPddDetailRecoveryInstanceId = crypto.randomUUID();
const reloadPddDetailRecoveryId = crypto.randomUUID();
const reloadPddDetailRecoveryInstanceId = crypto.randomUUID();
const pddSubmitRetryId = crypto.randomUUID();
const pddSubmitEffectId = crypto.randomUUID();
const pddSubmitIdempotencyKey = `pdd-submit:${shopId}:not-applied`;
const omsReissueRetryId = crypto.randomUUID();
const omsReissueRetryInstanceId = crypto.randomUUID();
const omsReissueEffectId = crypto.randomUUID();
const omsReissueIdempotencyKey = `oms-reissue-create:${shopId}:not-applied`;
const omsNullReceiptConfirmedId = crypto.randomUUID();
const omsNullReceiptConfirmedInstanceId = crypto.randomUUID();
const omsNullReceiptConfirmedEffectId = crypto.randomUUID();
const exhaustedOmsUnknownId = crypto.randomUUID();
const exhaustedOmsUnknownInstanceId = crypto.randomUUID();
const exhaustedOmsUnknownEffectId = crypto.randomUUID();
const authenticationBlockedId = crypto.randomUUID();
const authenticationUnknownId = crypto.randomUUID();
const orphanedReservedId = crypto.randomUUID();
const orphanedTmsCreateId = crypto.randomUUID();
const orphanedTmsCreateInstanceId = crypto.randomUUID();
const consumerNegotiationReadyId = crypto.randomUUID();
const consumerNegotiationBlockedId = crypto.randomUUID();
const consumerNegotiationReadyInstanceId = crypto.randomUUID();
const consumerNegotiationBlockedInstanceId = crypto.randomUUID();
const pddIdentityBindingToken = crypto.randomUUID();
const stalePddIdentityBindingToken = crypto.randomUUID();
const pddMallId = `98${crypto.randomInt(10_000_000, 100_000_000)}`;
const testShopName = `Worker self-test ${suffix}`;
const misboundSourceShopId = `scheduler-test-misbound-source-${suffix}`;
const misboundSourceShopName = `Worker misbound source ${suffix}`;

try {
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,slot,true,'ready'
    FROM generate_series(0, 99) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [shopId, testShopName]);
  await pool.query(`
    INSERT INTO pdd_shop_runtime_bindings
      (identity_key, shop_id, actual_shop_name, binding_token, mall_id)
    VALUES ($1,$2,$3,$4,$5)`, [
    `worker-selftest:${suffix}`,
    shopId,
    testShopName,
    pddIdentityBindingToken,
    pddMallId,
  ]);
  await pool.query(`
    INSERT INTO shops
      (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,slot,true,'ready'
    FROM generate_series(0, 99) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [misboundSourceShopId, misboundSourceShopName]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, created_at)
    VALUES
      ($1,$3,$4,'self-test','self-test','queued','queued',$6,'queued','{}'::jsonb,now() - interval '1 second'),
      ($2,$3,$5,'self-test','self-test','queued','queued',$7,'queued','{}'::jsonb,now())`,
  [firstId, secondId, shopId, `test-order-a-${suffix}`, `test-order-b-${suffix}`, `test-a-${suffix}`, `test-b-${suffix}`]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, manual_review_reason)
    VALUES
      ($1,$3,$4,'self-test','self-test','paused','paused',$6,'manual-review-blocked',
        '{"pddOrderRemark":{"status":"failed"},"manualReview":{"stage":"pdd-order-remark"}}'::jsonb,
        '流程需要人工复核（阶段: pdd-order-remark）：拼多多订单详情未在限定时间内完成渲染'),
      ($2,$3,$5,'self-test','self-test','paused','paused',$7,'manual-review-blocked',
        '{"pddOrderRemark":{"status":"failed"}}'::jsonb,
        '流程需要人工复核（阶段: pdd-order-remark）：拼多多订单详情未在限定时间内完成渲染')`,
  [remarkRetryId, remarkBlockedId, shopId, `remark-retry-${suffix}`, `remark-blocked-${suffix}`,
    `remark-retry-key-${suffix}`, `remark-blocked-key-${suffix}`]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,'pdd-note',$4,'unknown','self-test')`,
  [crypto.randomUUID(), shopId, remarkBlockedId, `remark-blocked-effect-${suffix}`]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, recovery_state)
    VALUES ($1,$2,$3,'self-test','abnormal-network-warning','paused','paused',$4,
      'external-state-reconciling',$5::jsonb,'reconciling')`, [
    pddSubmitRetryId,
    shopId,
    `pdd-submit-retry-${suffix}`,
    `pdd-submit-retry-key-${suffix}`,
    JSON.stringify({
      orderNumber: `pdd-submit-retry-${suffix}`,
      pddResolutionSubmission: { status: 'retry-authorized', submitAttemptCount: 1 },
    }),
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash, receipt)
    VALUES ($1,$2,$3,'pdd-submit',$4,'succeeded',$5,'{"clickAttempted":true}'::jsonb)`, [
    pddSubmitEffectId,
    shopId,
    pddSubmitRetryId,
    pddSubmitIdempotencyKey,
    'self-test-not-applied-request',
  ]);
  const omsReissueOrderNumber = `oms-reissue-retry-${suffix}`;
  const omsReissuePlatformCaseId = String(Date.now() + 2);
  const omsOriginalSalesOrderCode = `SO-ORIGINAL-${suffix}`;
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, recovery_state)
    VALUES ($1,$2,$3,'self-test','delivery-risk-concern','paused','paused',$4,
      'external-state-reconciling',$5::jsonb,'reconciling')`, [
    omsReissueRetryId,
    shopId,
    omsReissueOrderNumber,
    `oms-reissue-retry-key-${suffix}`,
    JSON.stringify({ orderNumber: omsReissueOrderNumber }),
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       work_order_type, scenario_code, identity_status, status, runtime_status,
       current_step, payload)
    VALUES ($1,$2,$3,$4,$5,'self-test','delivery-risk-concern','verified',
      'paused','paused','external-state-reconciling',$6::jsonb)`, [
    omsReissueRetryInstanceId,
    omsReissueRetryId,
    shopId,
    omsReissuePlatformCaseId,
    `pdd-work-order:${omsReissuePlatformCaseId}`,
    JSON.stringify({ orderNumber: omsReissueOrderNumber }),
  ]);
  await pool.query(`
    UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
    omsReissueRetryId,
    omsReissueRetryInstanceId,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
       idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,$4,'oms-reissue-create',$5,'unknown',$6)`, [
    omsReissueEffectId,
    shopId,
    omsReissueRetryId,
    omsReissueRetryInstanceId,
    omsReissueIdempotencyKey,
    'self-test-old-oms-request',
  ]);

  const recoveredRemarks = await repository.recoverSafePddRemarkFailures({ shopId });
  assert.deepEqual(recoveredRemarks.map((item) => item.id), [remarkRetryId]);
  const remarkStates = await pool.query(`
    SELECT id, status, runtime_status, current_step, manual_review_reason,
      payload->'pddOrderRemark'->>'status' AS remark_status,
      payload->'pddOrderRemark'->>'autoRecoveryCount' AS recovery_count,
      payload ? 'manualReview' AS has_manual_review
    FROM work_orders WHERE id = ANY($1::uuid[])`, [[remarkRetryId, remarkBlockedId]]);
  const recoveredRemark = remarkStates.rows.find((row) => row.id === remarkRetryId);
  const blockedRemark = remarkStates.rows.find((row) => row.id === remarkBlockedId);
  assert.equal(recoveredRemark.status, 'retry-ready');
  assert.equal(recoveredRemark.runtime_status, 'retry-ready');
  assert.equal(recoveredRemark.current_step, 'pdd-order-remark-retry-ready');
  assert.equal(recoveredRemark.manual_review_reason, null);
  assert.equal(recoveredRemark.remark_status, 'retry-ready');
  assert.equal(recoveredRemark.recovery_count, '1');
  assert.equal(recoveredRemark.has_manual_review, false);
  assert.equal(blockedRemark.status, 'paused', 'an unknown PDD note effect must remain frozen');
  assert.equal((await repository.recoverSafePddRemarkFailures({ shopId })).length, 0);

  const safePddDetailOrderNumber = `safe-pdd-detail-${suffix}`;
  const safePddDetailPlatformCaseId = String(Date.now() + 1);
  const safePddRenderReason = '拼多多requested-ordinary-list-query-controls刷新后等待 30000 毫秒仍未出现有效结果';
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, manual_review_reason)
    VALUES ($1,$2,$3,'self-test','in-transit-refund','paused','paused',$4,
      'flow-paused',$5::jsonb,$6)`, [
    safePddDetailRecoveryId,
    shopId,
    safePddDetailOrderNumber,
    `safe-pdd-detail-${suffix}`,
    JSON.stringify({
      orderNumber: safePddDetailOrderNumber,
      pddMallId,
      shopNameSnapshot: testShopName,
      latestDiscovery: {
        pddIdentityBindingToken,
        pddMallId,
        actualShopName: testShopName,
      },
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${safePddDetailPlatformCaseId}`,
      error: safePddRenderReason,
    }),
    safePddRenderReason,
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       work_order_type, scenario_code, identity_status, status, runtime_status,
       current_step, payload, manual_review_reason)
    VALUES ($1,$2,$3,$4,$5,'self-test','in-transit-refund','verified',
      'paused','paused','flow-paused',$6::jsonb,$7)`, [
    safePddDetailRecoveryInstanceId,
    safePddDetailRecoveryId,
    shopId,
    safePddDetailPlatformCaseId,
    `pdd-work-order:${safePddDetailPlatformCaseId}`,
    JSON.stringify({
      orderNumber: safePddDetailOrderNumber,
      pddMallId,
      shopNameSnapshot: testShopName,
    }),
    safePddRenderReason,
  ]);
  await pool.query(`UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
    safePddDetailRecoveryId,
    safePddDetailRecoveryInstanceId,
  ]);
  const recoveredPddDetail = await repository.recoverSafePddDetailPauses({ shopId });
  assert.deepEqual(recoveredPddDetail.map((item) => item.id), [safePddDetailRecoveryId]);
  const recoveredPddDetailState = (await pool.query(`
    SELECT work_order.status, work_order.current_step,
      work_order.payload#>>'{safePddDetailRecovery,attempts}' AS attempts,
      instance.status AS instance_status, instance.current_step AS instance_step
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [safePddDetailRecoveryId])).rows[0];
  assert.equal(recoveredPddDetailState.status, 'retry-ready');
  assert.equal(recoveredPddDetailState.current_step, 'ordinary-detail-fresh-query-retry-ready');
  assert.equal(recoveredPddDetailState.attempts, '1');
  assert.equal(recoveredPddDetailState.instance_status, 'retry-ready');
  assert.equal(recoveredPddDetailState.instance_step, 'ordinary-detail-fresh-query-retry-ready');
  assert.equal((await repository.recoverSafePddDetailPauses({ shopId })).length, 0);

  const legacyPddDetailOrderNumber = `legacy-pdd-detail-${suffix}`;
  const conflictingLegacyPddDetailOrderNumber = `legacy-pdd-detail-conflict-${suffix}`;
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, manual_review_reason)
    VALUES
      ($1,$3,$4,'self-test','shipped-no-tracking-refund','paused','paused',$6,
       'flow-paused',$8::jsonb,$10),
      ($2,$3,$5,'self-test','shipped-no-tracking-refund','paused','paused',$7,
       'flow-paused',$9::jsonb,$10)`, [
    legacyPddDetailRecoveryId,
    conflictingLegacyPddDetailRecoveryId,
    shopId,
    legacyPddDetailOrderNumber,
    conflictingLegacyPddDetailOrderNumber,
    `legacy-pdd-detail-${suffix}`,
    `legacy-pdd-detail-conflict-${suffix}`,
    JSON.stringify({
      orderNumber: legacyPddDetailOrderNumber,
      pddShopIdentity: { status: 'detected', actualShopName: testShopName },
    }),
    JSON.stringify({
      orderNumber: conflictingLegacyPddDetailOrderNumber,
      pddShopIdentity: { status: 'detected', actualShopName: `Other shop ${suffix}` },
    }),
    '未找到目标待处理工单（已等待 30 秒）: self-test',
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, work_order_type, scenario_code, identity_status,
       status, runtime_status, current_step, payload, manual_review_reason)
    VALUES
      ($1,$3,$5,'self-test','shipped-no-tracking-refund','legacy-unverified',
       'paused','paused','flow-paused',$6::jsonb,$8),
      ($2,$4,$5,'self-test','shipped-no-tracking-refund','legacy-unverified',
       'paused','paused','flow-paused',$7::jsonb,$8)`, [
    legacyPddDetailRecoveryInstanceId,
    conflictingLegacyPddDetailRecoveryInstanceId,
    legacyPddDetailRecoveryId,
    conflictingLegacyPddDetailRecoveryId,
    shopId,
    JSON.stringify({
      orderNumber: legacyPddDetailOrderNumber,
      pddShopIdentity: { status: 'detected', actualShopName: testShopName },
    }),
    JSON.stringify({
      orderNumber: conflictingLegacyPddDetailOrderNumber,
      pddShopIdentity: { status: 'detected', actualShopName: `Other shop ${suffix}` },
    }),
    '未找到目标待处理工单（已等待 30 秒）: self-test',
  ]);
  await pool.query(`
    UPDATE work_orders work_order
    SET current_ordinary_instance_id = fixture.instance_id
    FROM (VALUES ($1::uuid,$3::uuid),($2::uuid,$4::uuid))
      AS fixture(work_order_id, instance_id)
    WHERE work_order.id = fixture.work_order_id`, [
    legacyPddDetailRecoveryId,
    conflictingLegacyPddDetailRecoveryId,
    legacyPddDetailRecoveryInstanceId,
    conflictingLegacyPddDetailRecoveryInstanceId,
  ]);
  const recoveredLegacyPddDetails = await repository.recoverSafePddDetailPauses({ shopId });
  assert.deepEqual(recoveredLegacyPddDetails.map((item) => item.id), [legacyPddDetailRecoveryId]);
  const legacyPddDetailStates = await pool.query(`
    SELECT id, status, current_step,
      payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS binding_token
    FROM work_orders WHERE id = ANY($1::uuid[])`, [[
    legacyPddDetailRecoveryId,
    conflictingLegacyPddDetailRecoveryId,
  ]]);
  const recoveredLegacyState = legacyPddDetailStates.rows
    .find((row) => row.id === legacyPddDetailRecoveryId);
  const conflictingLegacyState = legacyPddDetailStates.rows
    .find((row) => row.id === conflictingLegacyPddDetailRecoveryId);
  assert.equal(recoveredLegacyState.status, 'retry-ready');
  assert.equal(recoveredLegacyState.current_step, 'ordinary-detail-fresh-query-retry-ready');
  assert.equal(recoveredLegacyState.binding_token, pddIdentityBindingToken);
  assert.equal(conflictingLegacyState.status, 'paused',
    'a legacy pause with a conflicting observed shop must remain frozen');
  assert.equal((await repository.recoverSafePddDetailPauses({ shopId })).length, 0);

  const stalePddDetailOrderNumber = `stale-pdd-detail-${suffix}`;
  const stalePddDetailPlatformCaseId = String(Date.now() + 2);
  const mismatchedPddDetailOrderNumber = `mismatch-pdd-detail-${suffix}`;
  const mismatchedPddDetailPlatformCaseId = String(Date.now() + 3);
  const reloadPddDetailOrderNumber = `reload-pdd-detail-${suffix}`;
  const reloadPddDetailPlatformCaseId = String(Date.now() + 4);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, manual_review_reason)
    VALUES
      ($1,$4,$5,'self-test','shipped-no-tracking-refund','paused','paused',$8,
       'flow-paused',$11::jsonb,$14),
      ($2,$4,$6,'self-test','shipped-no-tracking-refund','paused','paused',$9,
       'flow-paused',$12::jsonb,$14),
      ($3,$4,$7,'self-test','in-transit-refund','paused','paused',$10,
       'flow-paused',$13::jsonb,$15)`, [
    stalePddDetailRecoveryId,
    mismatchedPddDetailRecoveryId,
    reloadPddDetailRecoveryId,
    shopId,
    stalePddDetailOrderNumber,
    mismatchedPddDetailOrderNumber,
    reloadPddDetailOrderNumber,
    `stale-pdd-detail-${suffix}`,
    `mismatch-pdd-detail-${suffix}`,
    `reload-pdd-detail-${suffix}`,
    JSON.stringify({
      orderNumber: stalePddDetailOrderNumber,
      pddMallId,
      shopNameSnapshot: testShopName,
      latestDiscovery: {
        pddIdentityBindingToken: stalePddIdentityBindingToken,
        pddMallId,
        actualShopName: testShopName,
      },
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${stalePddDetailPlatformCaseId}`,
      transientWorkflowRecovery: { count: 5, maxAttempts: 5 },
    }),
    JSON.stringify({
      orderNumber: mismatchedPddDetailOrderNumber,
      pddMallId: '999999999',
      shopNameSnapshot: testShopName,
      latestDiscovery: {
        pddIdentityBindingToken: stalePddIdentityBindingToken,
        pddMallId: '999999999',
        actualShopName: testShopName,
      },
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${mismatchedPddDetailPlatformCaseId}`,
      transientWorkflowRecovery: { count: 5, maxAttempts: 5 },
    }),
    JSON.stringify({
      orderNumber: reloadPddDetailOrderNumber,
      pddMallId,
      shopNameSnapshot: testShopName,
      latestDiscovery: {
        pddIdentityBindingToken,
        pddMallId,
        actualShopName: testShopName,
      },
      transientWorkflowRecovery: { count: 1, maxAttempts: 5 },
    }),
    'PDD_DETAIL_TEMPORARILY_UNAVAILABLE: 缺少订单号或工单详情标志',
    `page.reload: Timeout 45000ms exceeded.\nCall log:\n  - navigated to "https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${reloadPddDetailPlatformCaseId}"`,
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       work_order_type, scenario_code, identity_status, status, runtime_status,
       current_step, payload, manual_review_reason)
    VALUES
      ($1,$4,$7,$8,$11,'self-test','shipped-no-tracking-refund','verified',
       'paused','paused','flow-paused',$14::jsonb,$17),
      ($2,$5,$7,$9,$12,'self-test','shipped-no-tracking-refund','verified',
       'paused','paused','flow-paused',$15::jsonb,$17),
      ($3,$6,$7,$10,$13,'self-test','in-transit-refund','verified',
       'paused','paused','flow-paused',$16::jsonb,$18)`, [
    stalePddDetailRecoveryInstanceId,
    mismatchedPddDetailRecoveryInstanceId,
    reloadPddDetailRecoveryInstanceId,
    stalePddDetailRecoveryId,
    mismatchedPddDetailRecoveryId,
    reloadPddDetailRecoveryId,
    shopId,
    stalePddDetailPlatformCaseId,
    mismatchedPddDetailPlatformCaseId,
    reloadPddDetailPlatformCaseId,
    `pdd-work-order:${stalePddDetailPlatformCaseId}`,
    `pdd-work-order:${mismatchedPddDetailPlatformCaseId}`,
    `pdd-work-order:${reloadPddDetailPlatformCaseId}`,
    JSON.stringify({ orderNumber: stalePddDetailOrderNumber, pddMallId, shopNameSnapshot: testShopName }),
    JSON.stringify({ orderNumber: mismatchedPddDetailOrderNumber, pddMallId: '999999999', shopNameSnapshot: testShopName }),
    JSON.stringify({ orderNumber: reloadPddDetailOrderNumber, pddMallId, shopNameSnapshot: testShopName }),
    'PDD_DETAIL_TEMPORARILY_UNAVAILABLE: 缺少订单号或工单详情标志',
    `page.reload: Timeout 45000ms exceeded.\nCall log:\n  - navigated to "https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${reloadPddDetailPlatformCaseId}"`,
  ]);
  await pool.query(`
    UPDATE ordinary_work_order_instances
    SET detail_url = $2
    WHERE id = $1`, [
    reloadPddDetailRecoveryInstanceId,
    `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${reloadPddDetailPlatformCaseId}`,
  ]);
  await pool.query(`
    UPDATE work_orders work_order
    SET current_ordinary_instance_id = fixture.instance_id
    FROM (VALUES ($1::uuid,$4::uuid),($2::uuid,$5::uuid),($3::uuid,$6::uuid))
      AS fixture(work_order_id, instance_id)
    WHERE work_order.id = fixture.work_order_id`, [
    stalePddDetailRecoveryId,
    mismatchedPddDetailRecoveryId,
    reloadPddDetailRecoveryId,
    stalePddDetailRecoveryInstanceId,
    mismatchedPddDetailRecoveryInstanceId,
    reloadPddDetailRecoveryInstanceId,
  ]);
  const recoveredBoundPddDetails = await repository.recoverSafePddDetailPauses({ shopId });
  assert.deepEqual(recoveredBoundPddDetails.map((item) => item.id).sort(),
    [stalePddDetailRecoveryId, reloadPddDetailRecoveryId].sort());
  const reboundPddDetailStates = await pool.query(`
    SELECT work_order.id, work_order.status, work_order.current_step,
      work_order.payload->>'pddIdentityBindingToken' AS current_binding_token,
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS latest_binding_token,
      work_order.payload#>>'{transientWorkflowRecovery,count}' AS transient_count,
      work_order.payload#>>'{safePddDetailRecovery,attempts}' AS safe_attempts,
      work_order.payload#>>'{pddStaleDetailRecovery,bindingRebound}' AS binding_rebound,
      work_order.payload#>>'{pddStaleDetailRecovery,previousDetailUrl}' AS previous_detail_url,
      instance.status AS instance_status,
      instance.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS instance_binding_token
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = ANY($1::uuid[])`, [[
    stalePddDetailRecoveryId,
    mismatchedPddDetailRecoveryId,
    reloadPddDetailRecoveryId,
  ]]);
  const stalePddDetailState = reboundPddDetailStates.rows
    .find((row) => row.id === stalePddDetailRecoveryId);
  const mismatchedPddDetailState = reboundPddDetailStates.rows
    .find((row) => row.id === mismatchedPddDetailRecoveryId);
  const reloadPddDetailState = reboundPddDetailStates.rows
    .find((row) => row.id === reloadPddDetailRecoveryId);
  assert.equal(stalePddDetailState.status, 'retry-ready');
  assert.equal(stalePddDetailState.current_step, 'ordinary-detail-fresh-query-retry-ready');
  assert.equal(stalePddDetailState.current_binding_token, pddIdentityBindingToken);
  assert.equal(stalePddDetailState.latest_binding_token, pddIdentityBindingToken);
  assert.equal(stalePddDetailState.instance_binding_token, pddIdentityBindingToken);
  assert.equal(stalePddDetailState.transient_count, '0');
  assert.equal(stalePddDetailState.safe_attempts, '1');
  assert.equal(stalePddDetailState.binding_rebound, 'true');
  assert.equal(stalePddDetailState.instance_status, 'retry-ready');
  assert.equal(reloadPddDetailState.status, 'retry-ready');
  assert.equal(reloadPddDetailState.transient_count, '0');
  assert.equal(reloadPddDetailState.binding_rebound, 'false');
  assert.equal(reloadPddDetailState.previous_detail_url,
    `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${reloadPddDetailPlatformCaseId}`);
  assert.equal(mismatchedPddDetailState.status, 'paused',
    'a stale binding with a conflicting mall id must remain frozen');
  assert.equal((await repository.recoverSafePddDetailPauses({ shopId })).length, 0);

  const firstClaim = await repository.claimNext({ shopId, workerId: 'worker-a', leaseSeconds: 300 });
  assert.equal(firstClaim?.id, firstId);
  assert.equal(await repository.claimNext({ shopId, workerId: 'worker-b', leaseSeconds: 300 }), null,
    'a second worker must not replace a live shop lease');
  await pool.query(`
    UPDATE work_orders SET status = 'paused', runtime_status = 'verification',
      current_step = 'human-verification-required'
    WHERE id = $1`, [firstId]);
  const recoveredClaim = await repository.claimNext({
    shopId,
    workerId: 'worker-a',
    leaseSeconds: 300,
    recoverOwnedLease: true,
  });
  assert.equal(recoveredClaim?.id, firstId, 'a restarted worker must recover its own unfinished lease');
  assert.equal(recoveredClaim?.recoveredLease, true);
  assert.equal(recoveredClaim?.status, 'processing', 'a recovered verification wait must become processing again');
  assert.equal(recoveredClaim?.runtime_status, 'verification');
  assert.notEqual(recoveredClaim?.leaseToken, firstClaim.leaseToken);
  assert.equal(await repository.hasValidLease({
    shopId,
    workerId: 'worker-a',
    workOrderId: firstId,
    leaseToken: recoveredClaim.leaseToken,
  }), true, 'the current assignment must own a valid database lease');
  assert.equal(await repository.hasValidLease({
    shopId,
    workerId: 'worker-a',
    workOrderId: firstId,
    leaseToken: firstClaim.leaseToken,
  }), false, 'a replaced assignment token must be fenced');
  await pool.query(`
    UPDATE shop_runtime_state SET lease_expires_at = now() - interval '1 second'
    WHERE shop_id = $1 AND lease_token = $2`, [shopId, recoveredClaim.leaseToken]);
  assert.equal(await repository.hasValidLease({
    shopId,
    workerId: 'worker-a',
    workOrderId: firstId,
    leaseToken: recoveredClaim.leaseToken,
  }), false, 'an expired lease must be rejected before an external effect');
  await pool.query(`
    UPDATE shop_runtime_state SET lease_expires_at = now() + interval '5 minutes'
    WHERE shop_id = $1 AND lease_token = $2`, [shopId, recoveredClaim.leaseToken]);

  const firstEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: firstId,
    effectType: 'pdd-submit',
    idempotencyKey: `pdd-submit:${shopId}:resolution`,
    requestHash: 'self-test-request',
  });
  assert.equal(firstEffect.reserved, true);
  const duplicateEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: firstId,
    effectType: 'pdd-submit',
    idempotencyKey: `pdd-submit:${shopId}:resolution`,
    requestHash: 'self-test-request',
  });
  assert.equal(duplicateEffect.reserved, false);
  assert.equal((await repository.completeExternalEffect({
    id: firstEffect.effect.id,
    status: 'succeeded',
    receipt: { selfTest: true },
  }))?.status, 'succeeded');
  const succeededDuplicate = await repository.reserveExternalEffect({
    shopId,
    workOrderId: firstId,
    effectType: 'pdd-submit',
    idempotencyKey: `pdd-submit:${shopId}:resolution`,
    requestHash: 'self-test-request',
  });
  assert.equal(succeededDuplicate.alreadySucceeded, true, 'an exact succeeded effect must be reusable');
  assert.deepEqual(succeededDuplicate.effect.receipt, { selfTest: true });
  const mismatchedDuplicate = await repository.reserveExternalEffect({
    shopId,
    workOrderId: firstId,
    effectType: 'pdd-submit',
    idempotencyKey: `pdd-submit:${shopId}:resolution`,
    requestHash: 'different-request',
  });
  assert.equal(mismatchedDuplicate.reserved, false);
  assert.equal(mismatchedDuplicate.alreadySucceeded, undefined, 'a mismatched request must never reuse the effect');

  const dispatchedRefundEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: firstId,
    effectType: 'pdd-return-refund',
    idempotencyKey: `pdd-return-refund:${shopId}:dispatched-no-replay`,
    requestHash: 'self-test-dispatched-refund',
  });
  assert.equal(dispatchedRefundEffect.reserved, true);
  assert.equal((await repository.completeExternalEffect({
    id: dispatchedRefundEffect.effect.id,
    status: 'failed',
    receipt: { submission: { confirmationDispatchStarted: true } },
  }))?.status, 'failed');
  const blockedDispatchedRefundRetry = await repository.reserveExternalEffect({
    shopId,
    workOrderId: firstId,
    effectType: 'pdd-return-refund',
    idempotencyKey: `pdd-return-refund:${shopId}:dispatched-no-replay`,
    requestHash: 'self-test-dispatched-refund',
  });
  assert.equal(blockedDispatchedRefundRetry.reserved, false,
    'a previously dispatched refund confirmation must never be automatically retried');
  assert.equal(blockedDispatchedRefundRetry.effect.status, 'failed');

  const notAppliedReconciliation = await repository.completeExternalStateReconciliation({
    workOrderId: pddSubmitRetryId,
    shopId,
    observation: {
      state: 'not-applied',
      effectType: 'pdd-submit',
      effectId: pddSubmitEffectId,
      idempotencyKey: pddSubmitIdempotencyKey,
      confirmationMethod: 'present-in-pending-list',
      observedAt: new Date().toISOString(),
    },
    payload: {
      orderNumber: `pdd-submit-retry-${suffix}`,
      pddResolutionSubmission: { status: 'retry-authorized', submitAttemptCount: 1 },
    },
  });
  assert.equal(notAppliedReconciliation?.status, 'retry-ready');
  assert.equal(notAppliedReconciliation?.current_step, 'pdd-submit-not-applied');
  assert.equal(notAppliedReconciliation?.recovery_state, 'ready');
  const correctedPddEffect = await pool.query(
    'SELECT status, error FROM external_effects WHERE work_order_id = $1 AND effect_type = $2',
    [pddSubmitRetryId, 'pdd-submit'],
  );
  assert.equal(correctedPddEffect.rows[0]?.status, 'failed',
    'a definitively not-applied PDD submit must become retryable');
  const authorizedPddRetry = await repository.reserveExternalEffect({
    shopId,
    workOrderId: pddSubmitRetryId,
    effectType: 'pdd-submit',
    idempotencyKey: pddSubmitIdempotencyKey,
    requestHash: 'self-test-not-applied-request',
  });
  assert.equal(authorizedPddRetry.reserved, true);
  assert.equal(authorizedPddRetry.retry, true);
  await repository.completeExternalEffect({
    id: authorizedPddRetry.effect.id,
    status: 'succeeded',
    receipt: { selfTestRetry: true },
  });

  const omsNullReceiptOrderNumber = `oms-null-receipt-confirmed-${suffix}`;
  const omsNullReceiptPlatformCaseId = String(Date.now() + 20);
  const omsNullReceiptSalesOrderCode = `SO-REISSUE-${suffix}`;
  const omsNullReceiptIdempotencyKey = `oms-reissue-create:${shopId}:null-receipt`;
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, recovery_state)
    VALUES ($1,$2,$3,'self-test','delivery-risk-concern','paused','paused',$4,
      'external-state-reconciling',$5::jsonb,'reconciling')`, [
    omsNullReceiptConfirmedId,
    shopId,
    omsNullReceiptOrderNumber,
    `oms-null-receipt-confirmed-${suffix}`,
    JSON.stringify({ orderNumber: omsNullReceiptOrderNumber }),
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       work_order_type, scenario_code, identity_status, status, runtime_status,
       current_step, payload)
    VALUES ($1,$2,$3,$4,$5,'self-test','delivery-risk-concern','verified',
      'paused','paused','external-state-reconciling',$6::jsonb)`, [
    omsNullReceiptConfirmedInstanceId,
    omsNullReceiptConfirmedId,
    shopId,
    omsNullReceiptPlatformCaseId,
    `pdd-work-order:${omsNullReceiptPlatformCaseId}`,
    JSON.stringify({ orderNumber: omsNullReceiptOrderNumber }),
  ]);
  await pool.query(`
    UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
    omsNullReceiptConfirmedId,
    omsNullReceiptConfirmedInstanceId,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
       idempotency_key, status, request_hash, receipt)
    VALUES ($1,$2,$3,$4,'oms-reissue-create',$5,'unknown',$6,'null'::jsonb)`, [
    omsNullReceiptConfirmedEffectId,
    shopId,
    omsNullReceiptConfirmedId,
    omsNullReceiptConfirmedInstanceId,
    omsNullReceiptIdempotencyKey,
    'self-test-null-receipt-request',
  ]);
  const omsNullReceiptConfirmed = await repository.completeExternalStateReconciliation({
    workOrderId: omsNullReceiptConfirmedId,
    shopId,
    ordinaryInstanceId: omsNullReceiptConfirmedInstanceId,
    observation: {
      state: 'confirmed',
      effectType: 'oms-reissue-create',
      effectId: omsNullReceiptConfirmedEffectId,
      idempotencyKey: omsNullReceiptIdempotencyKey,
      orderNumber: omsNullReceiptOrderNumber,
      salesOrderCode: omsNullReceiptSalesOrderCode,
      trackingNumber: null,
      confirmationMethod: 'oms-exact-order-reissue-row-read-back',
      queryPasses: [{ pass: 1, readOnly: true }],
      observedAt: new Date().toISOString(),
      readOnly: true,
      externalActionsReplayed: false,
    },
    payload: { orderNumber: omsNullReceiptOrderNumber },
  });
  assert.equal(omsNullReceiptConfirmed?.status, 'retry-ready');
  assert.equal(omsNullReceiptConfirmed?.current_step, 'oms-reissue-create-reconciled');
  const normalizedOmsReceipt = (await pool.query(`
    SELECT status, jsonb_typeof(receipt) AS receipt_type,
      receipt#>>'{readOnlyReconciliation,state}' AS reconciliation_state,
      receipt#>>'{result,salesOrderCode}' AS sales_order_code
    FROM external_effects WHERE id = $1`, [omsNullReceiptConfirmedEffectId])).rows[0];
  assert.equal(normalizedOmsReceipt.status, 'succeeded');
  assert.equal(normalizedOmsReceipt.receipt_type, 'object',
    'a JSON null receipt must normalize to an object before reconciliation fields are merged');
  assert.equal(normalizedOmsReceipt.reconciliation_state, 'confirmed');
  assert.equal(normalizedOmsReceipt.sales_order_code, omsNullReceiptSalesOrderCode);

  const omsQueryPass = (pass) => ({
    pass,
    apiRows: [{
      tradeId: omsReissueOrderNumber,
      isReissue: false,
      salesOrderCode: omsOriginalSalesOrderCode,
      trackingNumber: null,
    }],
    domRows: [],
    apiTotal: 1,
    readOnly: true,
    observedAt: new Date().toISOString(),
    reissueRows: [],
    queryInputValue: omsReissueOrderNumber,
    queryResponseOk: true,
    queryResponseCaptured: true,
  });
  const omsNotAppliedReconciliation = await repository.completeExternalStateReconciliation({
    workOrderId: omsReissueRetryId,
    shopId,
    ordinaryInstanceId: omsReissueRetryInstanceId,
    observation: {
      state: 'not-applied',
      effectType: 'oms-reissue-create',
      orderNumber: omsReissueOrderNumber,
      originalSalesOrderCode: omsOriginalSalesOrderCode,
      confirmationMethod: 'two-pass-exact-oms-order-query-single-original-row',
      queryPasses: [omsQueryPass(1), omsQueryPass(2)],
      observedAt: new Date().toISOString(),
      readOnly: true,
      externalActionsReplayed: false,
    },
    payload: {
      orderNumber: omsReissueOrderNumber,
      ordinaryReissueCreation: { status: 'retry-authorized' },
    },
  });
  assert.equal(omsNotAppliedReconciliation?.status, 'retry-ready');
  assert.equal(omsNotAppliedReconciliation?.current_step, 'oms-reissue-create-not-applied');
  const blockedSameOmsReissueRetry = await repository.reserveExternalEffect({
    shopId,
    workOrderId: omsReissueRetryId,
    effectType: 'oms-reissue-create',
    idempotencyKey: omsReissueIdempotencyKey,
    requestHash: 'self-test-old-oms-request',
    ordinaryInstanceId: omsReissueRetryInstanceId,
    platformCaseKey: `pdd-work-order:${omsReissuePlatformCaseId}`,
  });
  assert.equal(blockedSameOmsReissueRetry.reserved, false,
    'a two-pass OMS not-applied result must not replay the identical request hash');
  assert.equal(blockedSameOmsReissueRetry.effect.status, 'failed');
  const authorizedOmsReissueRetry = await repository.reserveExternalEffect({
    shopId,
    workOrderId: omsReissueRetryId,
    effectType: 'oms-reissue-create',
    idempotencyKey: omsReissueIdempotencyKey,
    requestHash: 'self-test-refreshed-oms-request',
    ordinaryInstanceId: omsReissueRetryInstanceId,
    platformCaseKey: `pdd-work-order:${omsReissuePlatformCaseId}`,
  });
  assert.equal(authorizedOmsReissueRetry.reserved, true,
    'a two-pass OMS not-applied result must authorize a changed request hash');
  assert.equal(authorizedOmsReissueRetry.retry, true);
  assert.equal(authorizedOmsReissueRetry.reconciledRequestRefresh, true);
  assert.equal(authorizedOmsReissueRetry.effect.request_hash, 'self-test-refreshed-oms-request');
  await repository.completeExternalEffect({
    id: authorizedOmsReissueRetry.effect.id,
    status: 'failed',
    error: { message: 'self-test deterministic OMS failure' },
    ordinaryInstanceId: omsReissueRetryInstanceId,
  });
  const blockedChangedOmsRetry = await repository.reserveExternalEffect({
    shopId,
    workOrderId: omsReissueRetryId,
    effectType: 'oms-reissue-create',
    idempotencyKey: omsReissueIdempotencyKey,
    requestHash: 'self-test-unsafe-changed-oms-request',
    ordinaryInstanceId: omsReissueRetryInstanceId,
    platformCaseKey: `pdd-work-order:${omsReissuePlatformCaseId}`,
  });
  assert.equal(blockedChangedOmsRetry.reserved, false,
    'a normal failed OMS effect must not authorize a changed request hash');

  const exhaustedOmsUnknownOrderNumber = `oms-post-submit-unknown-${suffix}`;
  const exhaustedOmsUnknownPlatformCaseId = `${Date.now()}${crypto.randomInt(100, 1_000)}`;
  const exhaustedOmsUnknownObservedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const exhaustedOmsUnknownPayload = JSON.stringify({
    orderNumber: exhaustedOmsUnknownOrderNumber,
    externalStateReconciliationRetry: {
      attempts: 3,
      maxAttempts: 3,
      claimedAt: exhaustedOmsUnknownObservedAt,
    },
    externalStateReconciliation: {
      state: 'not-applied',
      effectType: 'oms-reissue-create',
      orderNumber: exhaustedOmsUnknownOrderNumber,
      observedAt: exhaustedOmsUnknownObservedAt,
      queryPasses: [{ pass: 1, readOnly: true }, { pass: 2, readOnly: true }],
      confirmationMethod: 'two-pass-exact-oms-order-query-single-original-row',
      readOnly: true,
      externalActionsReplayed: false,
    },
  });
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, recovery_state,
       recovery_reason, recovery_updated_at)
    VALUES ($1,$2,$3,'self-test','delivery-risk-concern','paused','paused',$4,
      'system-shutdown-drained',$5::jsonb,'held','unknown-external-effect',
      now() - interval '1 second')`, [
    exhaustedOmsUnknownId,
    shopId,
    exhaustedOmsUnknownOrderNumber,
    `oms-post-submit-unknown-${suffix}`,
    exhaustedOmsUnknownPayload,
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       work_order_type, scenario_code, identity_status, status, runtime_status,
       current_step, payload)
    VALUES ($1,$2,$3,$4,$5,'self-test','delivery-risk-concern','verified',
      'paused','paused','system-shutdown-drained',$6::jsonb)`, [
    exhaustedOmsUnknownInstanceId,
    exhaustedOmsUnknownId,
    shopId,
    exhaustedOmsUnknownPlatformCaseId,
    `pdd-work-order:${exhaustedOmsUnknownPlatformCaseId}`,
    exhaustedOmsUnknownPayload,
  ]);
  await pool.query(`
    UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
    exhaustedOmsUnknownId,
    exhaustedOmsUnknownInstanceId,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
       idempotency_key, status, request_hash, error)
    VALUES ($1,$2,$3,$4,'oms-reissue-create',$5,'unknown',$6,$7::jsonb)`, [
    exhaustedOmsUnknownEffectId,
    shopId,
    exhaustedOmsUnknownId,
    exhaustedOmsUnknownInstanceId,
    `oms-post-submit-unknown-effect-${suffix}`,
    'self-test-unknown-oms-request',
    JSON.stringify({
      name: 'Error',
      message: 'OMS 补发提交后未回查到新的补发订单标识，结果不确定，禁止重复创建',
    }),
  ]);
  const exhaustedOmsUnknownReconciliation = await repository.claimNextExternalStateReconciliation({
    shopId,
    retryAfterMs: 0,
    retryWindowMs: 86_400_000,
    maxAttempts: 3,
  });
  assert.equal(exhaustedOmsUnknownReconciliation?.id, exhaustedOmsUnknownId,
    'an exhausted OMS post-submit unknown must receive exactly one final read-only check');
  assert.equal(
    exhaustedOmsUnknownReconciliation.payload.externalStateReconciliationRetry.attempts,
    4,
  );
  assert.equal(
    exhaustedOmsUnknownReconciliation.payload.externalStateReconciliationRetry
      .postSubmitUnknownExtensionPurpose,
    'read-only-oms-reconciliation-after-unknown-submit',
  );
  assert.ok(
    exhaustedOmsUnknownReconciliation.payload.externalStateReconciliationRetry
      .postSubmitUnknownExtensionUsedAt,
  );
  await repository.failExternalStateReconciliation({
    workOrderId: exhaustedOmsUnknownId,
    shopId,
    ordinaryInstanceId: exhaustedOmsUnknownInstanceId,
    error: new Error('self-test final read-only check failed'),
  });
  const exhaustedOmsExtensionState = (await pool.query(`
    SELECT payload#>>'{externalStateReconciliationRetry,attempts}' AS attempts,
      payload#>>'{externalStateReconciliationRetry,postSubmitUnknownExtensionUsedAt}'
        AS extension_used_at,
      current_step,
      recovery_state
    FROM work_orders WHERE id = $1`, [exhaustedOmsUnknownId])).rows[0];
  assert.equal(exhaustedOmsExtensionState.attempts, '4');
  assert.ok(exhaustedOmsExtensionState.extension_used_at);
  assert.equal(exhaustedOmsExtensionState.current_step, 'external-state-unresolved');
  assert.equal(exhaustedOmsExtensionState.recovery_state, 'held');

  const omsAllocationEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: firstId,
    effectType: 'oms-manual-allocation',
    idempotencyKey: `oms-manual-allocation:${shopId}:${suffix}`,
    requestHash: 'self-test-oms-allocation',
  });
  assert.equal(omsAllocationEffect.reserved, true,
    'the database constraint must allow an OMS manual-allocation effect');
  assert.equal((await repository.completeExternalEffect({
    id: omsAllocationEffect.effect.id,
    status: 'succeeded',
    receipt: { orderStatus: '已配货', selfTest: true },
  }))?.status, 'succeeded');

  const verificationDetectedAt = new Date().toISOString();
  assert.equal(await repository.checkpointClaimed({
    shopId,
    workOrderId: firstId,
    leaseToken: recoveredClaim.leaseToken,
    currentStep: 'human-verification-required',
    payload: {
      orderNumber: `test-order-a-${suffix}`,
      updatedAt: verificationDetectedAt,
      verificationLocation: {
        id: verificationId,
        shopId,
        system: 'pdd',
        stage: 'self-test-verification',
        status: 'waiting-human',
        url: 'https://example.test/verification',
        selector: '[data-self-test="verification"]',
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
        confidence: 'high',
        detectedAt: verificationDetectedAt,
      },
    },
  }), true);
  const realtimeVerification = await pool.query(`
    SELECT checkpoint.current_step, checkpoint.runtime_status,
      checkpoint.snapshot->'verificationLocation'->>'id' AS checkpoint_verification_id,
      verification.status, verification.stage
    FROM workflow_checkpoints checkpoint
    JOIN verification_locations verification ON verification.shop_id = checkpoint.shop_id
    WHERE checkpoint.shop_id = $1 AND verification.id = $2`, [shopId, verificationId]);
  assert.equal(realtimeVerification.rowCount, 1, 'verification must be visible without worker-sync ingestion');
  assert.equal(realtimeVerification.rows[0].current_step, 'human-verification-required');
  assert.equal(realtimeVerification.rows[0].runtime_status, 'verification');
  assert.equal(realtimeVerification.rows[0].checkpoint_verification_id, verificationId);
  assert.equal(realtimeVerification.rows[0].status, 'waiting-human');

  await pool.query(`
    INSERT INTO manual_interventions
      (id, shop_id, work_order_id, channel, reason_code, reason, risk_level,
       status, deduplication_key, created_at)
    VALUES
      ($1,$3,$4,'dashboard','verification-required','self-test verification assistance',
        'medium','open',$5,now() - interval '1 second'),
      ($2,$3,$4,'dashboard','warehouse-out-of-scope','self-test business intervention',
        'high','open',$6,now() - interval '1 second')`, [
    checkpointVerificationInterventionId,
    checkpointBusinessInterventionId,
    shopId,
    firstId,
    `self-test-checkpoint-verification-${suffix}`,
    `self-test-checkpoint-business-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO notification_outbox (id, intervention_id, payload)
    VALUES ($1,$2,jsonb_build_object('selfTest',true))`, [
    checkpointVerificationOutboxId,
    checkpointVerificationInterventionId,
  ]);

  assert.equal(await repository.checkpointClaimed({
    shopId,
    workOrderId: firstId,
    leaseToken: recoveredClaim.leaseToken,
    currentStep: 'self-test-checkpoint',
    payload: { orderNumber: `test-order-a-${suffix}`, selfTest: true, updatedAt: new Date().toISOString() },
  }), true);
  const checkpoint = await pool.query(
    'SELECT current_step, runtime_status, payload FROM work_orders WHERE id = $1',
    [firstId],
  );
  assert.equal(checkpoint.rows[0].current_step, 'self-test-checkpoint');
  assert.equal(checkpoint.rows[0].runtime_status, 'processing');
  assert.equal(checkpoint.rows[0].payload.selfTest, true);
  const resolvedVerification = await pool.query(
    'SELECT status, resolved_at FROM verification_locations WHERE id = $1', [verificationId],
  );
  assert.equal(resolvedVerification.rows[0].status, 'resolved');
  assert.ok(resolvedVerification.rows[0].resolved_at);
  const checkpointInterventions = await pool.query(`
    SELECT id, status, resolved_by
    FROM manual_interventions
    WHERE id = ANY($1::uuid[])`, [[
    checkpointVerificationInterventionId,
    checkpointBusinessInterventionId,
  ]]);
  const checkpointVerificationIntervention = checkpointInterventions.rows.find(
    (row) => row.id === checkpointVerificationInterventionId,
  );
  const checkpointBusinessIntervention = checkpointInterventions.rows.find(
    (row) => row.id === checkpointBusinessInterventionId,
  );
  assert.equal(checkpointVerificationIntervention.status, 'resolved',
    'a normal checkpoint after plugin resolution must close verification assistance');
  assert.equal(checkpointVerificationIntervention.resolved_by,
    'worker-checkpoint-verification-cleared');
  assert.equal(checkpointBusinessIntervention.status, 'open',
    'verification cleanup must preserve a genuine business intervention');
  assert.equal((await pool.query(
    'SELECT status FROM notification_outbox WHERE id = $1',
    [checkpointVerificationOutboxId],
  )).rows[0]?.status, 'cancelled',
  'a cleared verification must cancel its unsent notification');

  const staleGateResolvedAt = new Date();
  const staleGateDetectedAt = new Date(staleGateResolvedAt.getTime() - 5 * 60_000);
  const staleGateAuthenticatedAt = new Date(staleGateResolvedAt.getTime() - 4 * 60_000);
  const staleGateRuntimeObservedAt = new Date(staleGateResolvedAt.getTime() - 1_000);
  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url,
       bounding_box, confidence, detected_at)
    VALUES ($1,$2,NULL,'pdd','self-test-stale-detached','waiting-human',
      'https://mms.pinduoduo.com/aftersales/work_order/list','{}'::jsonb,'high',$3)`, [
    staleDetachedPddVerificationId,
    shopId,
    staleGateDetectedAt,
  ]);
  await pool.query(`
    INSERT INTO manual_interventions
      (id, shop_id, work_order_id, channel, reason_code, reason, risk_level,
       status, deduplication_key, created_at)
    VALUES ($1,$2,NULL,'dashboard','verification-required',
      'self-test stale detached verification','medium','open',$3,$4)`, [
    staleDetachedVerificationInterventionId,
    shopId,
    `self-test-stale-detached-verification-${suffix}`,
    new Date(staleGateDetectedAt.getTime() + 30_000),
  ]);
  await pool.query(`
    INSERT INTO notification_outbox (id, intervention_id, payload)
    VALUES ($1,$2,jsonb_build_object('selfTest',true))`, [
    staleDetachedVerificationOutboxId,
    staleDetachedVerificationInterventionId,
  ]);
  const externalEffectsBeforeStaleGateRecovery = Number((await pool.query(
    'SELECT count(*)::int AS count FROM external_effects WHERE shop_id = $1',
    [shopId],
  )).rows[0]?.count || 0);
  const staleGateRecovery = await repository.resolveStaleDetachedPddVerificationGate({
    shopId,
    verificationId: staleDetachedPddVerificationId,
    authenticatedAt: staleGateAuthenticatedAt,
    runtimeObservedAt: staleGateRuntimeObservedAt,
    resolvedAt: staleGateResolvedAt,
  });
  assert.equal(staleGateRecovery?.verificationResolved, true);
  assert.equal(staleGateRecovery?.externalActionsReplayed, false);
  assert.equal((await pool.query(
    'SELECT status FROM verification_locations WHERE id = $1',
    [staleDetachedPddVerificationId],
  )).rows[0]?.status, 'resolved');
  assert.equal((await pool.query(
    'SELECT status FROM manual_interventions WHERE id = $1',
    [staleDetachedVerificationInterventionId],
  )).rows[0]?.status, 'resolved');
  assert.equal((await pool.query(
    'SELECT status FROM notification_outbox WHERE id = $1',
    [staleDetachedVerificationOutboxId],
  )).rows[0]?.status, 'cancelled');
  assert.equal((await pool.query(`
    SELECT payload->>'externalActionsReplayed' AS replayed
    FROM audit_events
    WHERE deduplication_key = $1`, [
    `stale-detached-pdd-verification-reconciled:${shopId}:${staleDetachedPddVerificationId}`,
  ])).rows[0]?.replayed, 'false');
  assert.equal(Number((await pool.query(
    'SELECT count(*)::int AS count FROM external_effects WHERE shop_id = $1',
    [shopId],
  )).rows[0]?.count || 0), externalEffectsBeforeStaleGateRecovery,
  'stale gate recovery must not create or replay an external effect');
  assert.equal(await repository.resolveStaleDetachedPddVerificationGate({
    shopId,
    verificationId: staleDetachedPddVerificationId,
    authenticatedAt: staleGateAuthenticatedAt,
    runtimeObservedAt: staleGateRuntimeObservedAt,
    resolvedAt: staleGateResolvedAt,
  }), null, 'stale detached verification recovery must be idempotent');
  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url,
       bounding_box, confidence, detected_at)
    VALUES
      ($1,$4,$5,'pdd','self-test-bound','waiting-human',
        'https://mms.pinduoduo.com/aftersales/work_order/list','{}'::jsonb,'high',$6),
      ($2,$4,NULL,'pdd','self-test-checkpoint-bound','waiting-human',
        'https://mms.pinduoduo.com/aftersales/work_order/list','{}'::jsonb,'high',$6),
      ($3,$4,NULL,'pdd','self-test-pre-detection-auth','waiting-human',
        'https://mms.pinduoduo.com/aftersales/work_order/list','{}'::jsonb,'high',$6)`, [
    boundStalePddVerificationId,
    checkpointBoundPddVerificationId,
    preDetectionAuthPddVerificationId,
    shopId,
    firstId,
    staleGateDetectedAt,
  ]);
  assert.equal(await repository.resolveStaleDetachedPddVerificationGate({
    shopId,
    verificationId: boundStalePddVerificationId,
    authenticatedAt: staleGateAuthenticatedAt,
    runtimeObservedAt: staleGateRuntimeObservedAt,
    resolvedAt: staleGateResolvedAt,
  }), null, 'a work-order-bound verification must remain fenced');
  await pool.query(`
    UPDATE workflow_checkpoints SET snapshot = snapshot || jsonb_build_object(
      'verificationLocation', jsonb_build_object('id', $2::text)
    ) WHERE shop_id = $1`, [shopId, checkpointBoundPddVerificationId]);
  assert.equal(await repository.resolveStaleDetachedPddVerificationGate({
    shopId,
    verificationId: checkpointBoundPddVerificationId,
    authenticatedAt: staleGateAuthenticatedAt,
    runtimeObservedAt: staleGateRuntimeObservedAt,
    resolvedAt: staleGateResolvedAt,
  }), null, 'a verification still referenced by the durable checkpoint must remain fenced');
  await pool.query(`UPDATE workflow_checkpoints
    SET snapshot = snapshot - 'verificationLocation' WHERE shop_id = $1`, [shopId]);
  assert.equal(await repository.resolveStaleDetachedPddVerificationGate({
    shopId,
    verificationId: preDetectionAuthPddVerificationId,
    authenticatedAt: new Date(staleGateDetectedAt.getTime() - 1_000),
    runtimeObservedAt: staleGateRuntimeObservedAt,
    resolvedAt: staleGateResolvedAt,
  }), null, 'pre-detection authentication evidence must not clear the verification');

  await pool.query(`
    INSERT INTO operator_commands (id, shop_id, work_order_id, command_type, requested_by)
    VALUES ($1,$2,$3,'retry-stage','self-test')`, [commandId, shopId, secondId]);
  const command = await repository.claimPendingCommand({ shopId, workerId: 'worker-a' });
  assert.equal(command?.id, commandId);
  assert.equal((await repository.acknowledgeCommand({
    commandId,
    result: { selfTest: true },
  }))?.status, 'acknowledged');

  await pool.query(`
    UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
      recovery_state = 'held', recovery_reason = 'external-state-still-uncertain'
    WHERE id = $1`, [secondId]);
  const retryTransition = await repository.transitionWorkOrderByCommand({
    workOrderId: secondId,
    shopId,
    status: 'retry-ready',
    currentStep: 'operator-retry-requested',
  });
  assert.equal(retryTransition?.status, 'retry-ready');
  assert.equal(retryTransition?.recovery_state, 'ready', 'retry-stage must release a held recovery state');
  assert.equal(retryTransition?.recovery_reason, null);

  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url, bounding_box, confidence, detected_at)
    VALUES ($1,$2,$3,'pdd','self-test-force-clear','waiting-human',
      'https://example.test/verification','{}'::jsonb,'high',now())`,
  [forceClearVerificationId, shopId, firstId]);
  await pool.query(`
    INSERT INTO manual_interventions
      (id, shop_id, work_order_id, channel, reason_code, reason, risk_level,
       status, deduplication_key)
    VALUES
      ($1,$3,$4,'dashboard','manual-review-required','self-test transient issue','medium',
        'open',$5),
      ($2,$3,$4,'dashboard','waiting-consumer-response','self-test business wait','medium',
        'open',$6)`, [
    retryTransientInterventionId,
    retryWaitingInterventionId,
    shopId,
    firstId,
    `self-test-retry-transient-${suffix}`,
    `self-test-retry-waiting-${suffix}`,
  ]);

  assert.equal(await repository.finishClaimed({
    shopId,
    workOrderId: firstId,
    leaseToken: recoveredClaim.leaseToken,
    status: 'retry-ready',
    currentStep: 'operator-verification-force-cleared',
    payload: {
      orderNumber: `test-order-a-${suffix}`,
      step: 'operator-verification-force-cleared',
      verificationLocation: null,
    },
    nextAttemptAt: new Date(),
  }), true);
  assert.equal(await repository.hasValidLease({
    shopId,
    workerId: 'worker-a',
    workOrderId: firstId,
    leaseToken: recoveredClaim.leaseToken,
  }), false, 'a completed assignment must no longer own a lease');
  const forceClearedVerification = await pool.query(
    'SELECT status, resolved_at FROM verification_locations WHERE id = $1', [forceClearVerificationId],
  );
  assert.equal(forceClearedVerification.rows[0].status, 'resolved');
  assert.ok(forceClearedVerification.rows[0].resolved_at);
  const retryInterventions = await pool.query(`
    SELECT id, status, resolved_by FROM manual_interventions
    WHERE id = ANY($1::uuid[])`, [[retryTransientInterventionId, retryWaitingInterventionId]]);
  const transientIntervention = retryInterventions.rows.find(
    (row) => row.id === retryTransientInterventionId,
  );
  const waitingIntervention = retryInterventions.rows.find(
    (row) => row.id === retryWaitingInterventionId,
  );
  assert.equal(transientIntervention.status, 'resolved',
    'retry-ready must close the technical intervention that no longer blocks automation');
  assert.equal(transientIntervention.resolved_by, 'worker-retry-ready-reclassification');
  assert.equal(waitingIntervention.status, 'open',
    'retry-ready must preserve a still-active consumer response wait');

  const secondClaim = await repository.claimNext({ shopId, workerId: 'worker-a', leaseSeconds: 300 });
  assert.ok(secondClaim?.id);
  const leaseExpiryOrderId = secondClaim.id;
  await pool.query(`
    UPDATE work_orders SET status = 'paused', runtime_status = 'verification',
      current_step = 'human-verification-required'
    WHERE id = $1`, [leaseExpiryOrderId]);
  await pool.query(`
    UPDATE shop_runtime_state SET lease_expires_at = now() - interval '1 second'
    WHERE shop_id = $1 AND lease_token = $2`, [shopId, secondClaim.leaseToken]);
  const expiredVerificationRecovery = await repository.claimNext({
    shopId,
    workerId: 'worker-b',
    leaseSeconds: 300,
  });
  assert.equal(expiredVerificationRecovery?.id, leaseExpiryOrderId,
    'an expired verification wait must be retried before a newer order');
  assert.equal(expiredVerificationRecovery?.status, 'processing');
  assert.equal(await repository.finishClaimed({
    shopId,
    workOrderId: leaseExpiryOrderId,
    leaseToken: expiredVerificationRecovery.leaseToken,
    status: 'paused',
    currentStep: 'self-test-finished',
    payload: {},
  }), true);
  await repository.setShopOperatorPaused({ shopId, paused: true, workerId: 'worker-a' });
  assert.equal(await repository.isShopOperatorPaused(shopId), true);
  assert.equal(await repository.claimNext({ shopId, workerId: 'worker-b', leaseSeconds: 300 }), null);
  await repository.setShopOperatorPaused({ shopId, paused: false, workerId: 'worker-a' });
  assert.equal(await repository.isShopOperatorPaused(shopId), false);

  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now() + interval '1 hour'
    WHERE shop_id = $1 AND status IN ('queued', 'retry-ready')`, [shopId]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, recovery_state, created_at)
    VALUES
      ($1,$3,$4,'self-test','self-test','queued','queued',$6,'queued','{}'::jsonb,'ready',
        now() - interval '1 second'),
      ($2,$3,$5,'self-test','self-test','queued','queued',$7,'queued','{}'::jsonb,'ready',now())`, [
    authenticationBlockedId,
    authenticationUnknownId,
    shopId,
    `auth-blocked-${suffix}`,
    `auth-unknown-${suffix}`,
    `auth-blocked-key-${suffix}`,
    `auth-unknown-key-${suffix}`,
  ]);
  const authenticationBlockedClaim = await repository.claimNext({
    shopId,
    workerId: 'worker-a',
    leaseSeconds: 300,
  });
  assert.equal(authenticationBlockedClaim?.id, authenticationBlockedId);
  await pool.query(`
    UPDATE shop_runtime_state SET lease_expires_at = now() - interval '1 second'
    WHERE shop_id = $1 AND lease_token = $2`, [shopId, authenticationBlockedClaim.leaseToken]);
  const authenticationRecovery = await repository.releaseExpiredOwnedClaimForAuthenticationBlock({
    shopId,
    workerId: 'worker-a',
    system: 'pdd',
    observedStatus: 'manual-login-required',
  });
  assert.equal(authenticationRecovery.released, true);
  assert.equal(authenticationRecovery.status, 'retry-ready');
  const authenticationRecoveredOrder = (await pool.query(`
    SELECT status, runtime_status, current_step, recovery_state,
      payload->'authenticationLeaseRecovery'->>'observedStatus' AS observed_status
    FROM work_orders WHERE id = $1`, [authenticationBlockedId])).rows[0];
  assert.equal(authenticationRecoveredOrder.status, 'retry-ready');
  assert.equal(authenticationRecoveredOrder.runtime_status, 'waiting');
  assert.equal(authenticationRecoveredOrder.current_step, 'authentication-blocked-retry-ready');
  assert.equal(authenticationRecoveredOrder.recovery_state, 'ready');
  assert.equal(authenticationRecoveredOrder.observed_status, 'manual-login-required');
  assert.equal((await pool.query(`
    SELECT current_work_order_id FROM shop_runtime_state WHERE shop_id = $1`, [shopId]))
    .rows[0]?.current_work_order_id, null);

  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now() + interval '1 hour'
    WHERE id = $1`, [authenticationBlockedId]);
  const authenticationUnknownClaim = await repository.claimNext({
    shopId,
    workerId: 'worker-a',
    leaseSeconds: 300,
  });
  assert.equal(authenticationUnknownClaim?.id, authenticationUnknownId);
  const authenticationUnknownEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: authenticationUnknownId,
    effectType: 'pdd-note',
    idempotencyKey: `auth-unknown-effect-${suffix}`,
    requestHash: 'auth-unknown-request',
  });
  assert.equal(authenticationUnknownEffect.reserved, true);
  await pool.query(`
    UPDATE shop_runtime_state SET lease_expires_at = now() - interval '1 second'
    WHERE shop_id = $1 AND lease_token = $2`, [shopId, authenticationUnknownClaim.leaseToken]);
  const uncertainAuthenticationRecovery = await repository.releaseExpiredOwnedClaimForAuthenticationBlock({
    shopId,
    workerId: 'worker-a',
    system: 'pdd',
    observedStatus: 'expired',
  });
  assert.equal(uncertainAuthenticationRecovery.released, true);
  assert.equal(uncertainAuthenticationRecovery.status, 'paused');
  assert.equal(uncertainAuthenticationRecovery.unknownExternalEffects, 1);
  assert.equal((await pool.query(`
    SELECT status FROM external_effects WHERE id = $1`, [authenticationUnknownEffect.effect.id]))
    .rows[0]?.status, 'unknown');
  const uncertainAuthenticationOrder = (await pool.query(`
    SELECT status, current_step, recovery_state FROM work_orders WHERE id = $1`,
  [authenticationUnknownId])).rows[0];
  assert.equal(uncertainAuthenticationOrder.status, 'paused');
  assert.equal(uncertainAuthenticationOrder.current_step, 'external-state-unresolved');
  assert.equal(uncertainAuthenticationOrder.recovery_state, 'held');
  await pool.query(`
    UPDATE work_orders SET current_step = 'system-shutdown-drained',
      recovery_reason = 'unknown-external-effect',
      recovery_updated_at = now() - interval '1 second'
    WHERE id = $1`, [authenticationUnknownId]);
  const shutdownDrainedReconciliation = await repository.claimNextExternalStateReconciliation({
    shopId,
    retryAfterMs: 0,
    retryWindowMs: 86_400_000,
    maxAttempts: 3,
  });
  assert.equal(shutdownDrainedReconciliation?.id, authenticationUnknownId,
    'a shutdown-drained unknown effect must resume read-only reconciliation');

  const orphanedSubmitKey = `orphaned-pdd-submit-${suffix}`;
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, recovery_state)
    VALUES ($1,$2,$3,'self-test','self-test','paused','paused',$4,'flow-paused',
      '{"pddResolutionSubmission":{"status":"submitting"}}'::jsonb,'ready')`, [
    orphanedReservedId,
    shopId,
    `orphaned-reserved-${suffix}`,
    `orphaned-reserved-key-${suffix}`,
  ]);
  const orphanedSubmitEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: orphanedReservedId,
    effectType: 'pdd-submit',
    idempotencyKey: orphanedSubmitKey,
    requestHash: 'orphaned-submit-request',
  });
  const orphanedEvidenceEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: orphanedReservedId,
    effectType: 'evidence-upload',
    idempotencyKey: `orphaned-evidence-${suffix}`,
    requestHash: 'orphaned-evidence-request',
  });
  await pool.query(`
    UPDATE external_effects SET updated_at = now() - interval '10 seconds'
    WHERE id = ANY($1::uuid[])`, [[orphanedSubmitEffect.effect.id, orphanedEvidenceEffect.effect.id]]);
  const recoveredOrphanedEffects = await repository.recoverOrphanedReservedExternalEffects({ shopId });
  assert.equal(recoveredOrphanedEffects.length, 2);
  const orphanedUnknownEffects = await pool.query(`
    SELECT effect_type, status FROM external_effects
    WHERE work_order_id = $1 ORDER BY effect_type`, [orphanedReservedId]);
  assert.deepEqual(orphanedUnknownEffects.rows, [
    { effect_type: 'evidence-upload', status: 'unknown' },
    { effect_type: 'pdd-submit', status: 'unknown' },
  ]);
  const orphanedReadyOrder = (await pool.query(`
    SELECT status, current_step, recovery_state FROM work_orders WHERE id = $1`,
  [orphanedReservedId])).rows[0];
  assert.equal(orphanedReadyOrder.status, 'paused');
  assert.equal(orphanedReadyOrder.current_step, 'external-state-reconciliation-ready');
  assert.equal(orphanedReadyOrder.recovery_state, 'ready');
  const orphanedReconciliation = await repository.claimNextExternalStateReconciliation({
    shopId,
    retryAfterMs: 600_000,
    retryWindowMs: 86_400_000,
    maxAttempts: 3,
  });
  assert.equal(orphanedReconciliation?.id, orphanedReservedId);
  const orphanedNotApplied = await repository.completeExternalStateReconciliation({
    workOrderId: orphanedReservedId,
    shopId,
    observation: {
      state: 'not-applied',
      effectType: 'pdd-submit',
      effectId: orphanedSubmitEffect.effect.id,
      idempotencyKey: orphanedSubmitKey,
      confirmationMethod: 'present-in-pending-list',
      observedAt: new Date().toISOString(),
    },
    payload: { orderNumber: `orphaned-reserved-${suffix}` },
  });
  assert.equal(orphanedNotApplied.status, 'retry-ready');
  assert.equal(orphanedNotApplied.current_step, 'pdd-submit-not-applied');
  const orphanedFailedEffects = await pool.query(`
    SELECT effect_type, status FROM external_effects
    WHERE work_order_id = $1 ORDER BY effect_type`, [orphanedReservedId]);
  assert.deepEqual(orphanedFailedEffects.rows, [
    { effect_type: 'evidence-upload', status: 'failed' },
    { effect_type: 'pdd-submit', status: 'failed' },
  ]);

  const orphanedTmsOrderNumber = `orphaned-tms-create-${suffix}`;
  const orphanedTmsPlatformCaseKey = `pdd-work-order:${Date.now()}`;
  const orphanedTmsKey = `tms-create:${shopId}:${suffix}:create-ticket`;
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, recovery_state)
    VALUES ($1,$2,$3,'self-test','in-transit-refund','paused','paused',$4,
      'flow-paused',$5::jsonb,'ready')`, [
    orphanedTmsCreateId,
    shopId,
    orphanedTmsOrderNumber,
    `orphaned-tms-create-key-${suffix}`,
    JSON.stringify({
      orderNumber: orphanedTmsOrderNumber,
      tmsFormDecision: { status: 'ready', problemType: '拦截退回', customerRemark: '测试' },
    }),
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key,
       work_order_type, scenario_code, identity_status, status, runtime_status,
       current_step, payload)
    VALUES ($1,$2,$3,$4,$5,'self-test','in-transit-refund','verified',
      'paused','paused','flow-paused',$6::jsonb)`, [
    orphanedTmsCreateInstanceId,
    orphanedTmsCreateId,
    shopId,
    orphanedTmsPlatformCaseKey.slice('pdd-work-order:'.length),
    orphanedTmsPlatformCaseKey,
    JSON.stringify({ orderNumber: orphanedTmsOrderNumber }),
  ]);
  await pool.query(`
    UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
    orphanedTmsCreateId,
    orphanedTmsCreateInstanceId,
  ]);
  const orphanedTmsEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: orphanedTmsCreateId,
    ordinaryInstanceId: orphanedTmsCreateInstanceId,
    platformCaseKey: orphanedTmsPlatformCaseKey,
    effectType: 'tms-create',
    idempotencyKey: orphanedTmsKey,
    requestHash: 'orphaned-tms-create-request',
  });
  assert.equal(orphanedTmsEffect.reserved, true);
  await pool.query(`
    UPDATE external_effects SET updated_at = now() - interval '10 seconds'
    WHERE id = $1`, [orphanedTmsEffect.effect.id]);
  const recoveredTmsEffects = await repository.recoverOrphanedReservedExternalEffects({ shopId });
  assert.deepEqual(recoveredTmsEffects.map((item) => item.effectType), ['tms-create']);
  const tmsReconciliation = await repository.claimNextExternalStateReconciliation({
    shopId,
    retryAfterMs: 600_000,
    retryWindowMs: 86_400_000,
    maxAttempts: 3,
  });
  assert.equal(tmsReconciliation?.id, orphanedTmsCreateId);
  const tmsNotApplied = await repository.completeExternalStateReconciliation({
    workOrderId: orphanedTmsCreateId,
    shopId,
    ordinaryInstanceId: orphanedTmsCreateInstanceId,
    observation: {
      state: 'not-applied',
      effectType: 'tms-create',
      orderNumber: orphanedTmsOrderNumber,
      confirmationMethod: 'refreshed-two-pass-exact-zero-result',
      observedAt: new Date().toISOString(),
      readOnly: true,
    },
    payload: { orderNumber: orphanedTmsOrderNumber, tmsWorkOrder: null },
  });
  assert.equal(tmsNotApplied.status, 'retry-ready');
  assert.equal(tmsNotApplied.current_step, 'tms-create-not-applied');
  const tmsRecoveryState = (await pool.query(`
    SELECT effect.status AS effect_status, instance.status AS instance_status,
      instance.current_step AS instance_step
    FROM external_effects effect
    JOIN ordinary_work_order_instances instance
      ON instance.id = effect.ordinary_instance_id
    WHERE effect.id = $1`, [orphanedTmsEffect.effect.id])).rows[0];
  assert.equal(tmsRecoveryState.effect_status, 'failed');
  assert.equal(tmsRecoveryState.instance_status, 'retry-ready');
  assert.equal(tmsRecoveryState.instance_step, 'tms-create-not-applied');
  const authorizedTmsRetry = await repository.reserveExternalEffect({
    shopId,
    workOrderId: orphanedTmsCreateId,
    ordinaryInstanceId: orphanedTmsCreateInstanceId,
    platformCaseKey: orphanedTmsPlatformCaseKey,
    effectType: 'tms-create',
    idempotencyKey: orphanedTmsKey,
    requestHash: 'orphaned-tms-create-request',
  });
  assert.equal(authorizedTmsRetry.reserved, true);
  assert.equal(authorizedTmsRetry.retry, true,
    'a refreshed exact zero result must authorize one idempotent TMS retry');
  await repository.completeExternalEffect({
    id: authorizedTmsRetry.effect.id,
    ordinaryInstanceId: orphanedTmsCreateInstanceId,
    status: 'succeeded',
    receipt: { selfTestRetry: true },
  });

  const misboundKinds = [
    'safe',
    'pdd-submit',
    'clicked',
    'reserved',
    'other-unknown',
    'open-conflict',
    'target-duplicate',
  ];
  const misboundFixtures = [];
  for (const [index, kind] of misboundKinds.entries()) {
    const workOrderId = crypto.randomUUID();
    const ordinaryInstanceId = crypto.randomUUID();
    const orderNumber = `misbound-evidence-${kind}-${suffix}`;
    const platformCaseId = `${Date.now()}${index}`;
    const payload = {
      orderNumber,
      pddMallId,
      shopNameSnapshot: testShopName,
      detectedShopName: testShopName,
      latestDiscovery: {
        shopId: misboundSourceShopId,
        actualShopName: testShopName,
        pddMallId,
        pddIdentityBindingToken: stalePddIdentityBindingToken,
      },
      pddEvidenceUpload: {
        status: 'unknown',
        diagnostics: {
          network: [{
            url: 'https://file.pinduoduo.com/v3/store_image',
            status: 200,
            response: JSON.stringify({
              url: `https://pfs.pinduoduo.com/self-test-${kind}-${suffix}.png`,
            }),
          }],
        },
      },
      ...(kind === 'clicked' ? {
        pddResolutionSubmission: {
          lastClickAttemptedAt: new Date().toISOString(),
        },
      } : {}),
    };
    await pool.query(`
      INSERT INTO work_orders
        (id, shop_id, external_order_number, work_order_type, scenario_code,
         status, runtime_status, idempotency_key, current_step, payload,
         manual_review_reason, recovery_state, completion_state, frontend_visibility)
      VALUES ($1,$2,$3,'在途无理由退款处理','in-transit-refund',
        'paused','paused',$4,'manual-review-blocked',$5::jsonb,$6,
        'ready','pending','operational')`, [
      workOrderId,
      misboundSourceShopId,
      orderNumber,
      `misbound-evidence-${kind}-${suffix}`,
      JSON.stringify(payload),
      '拼多多未确认凭证上传成功或提交按钮仍不可用',
    ]);
    await pool.query(`
      INSERT INTO ordinary_work_order_instances
        (id, work_order_id, shop_id, platform_case_id, platform_case_key,
         detail_url, work_order_type, scenario_code, identity_status,
         status, runtime_status, current_step, payload, manual_review_reason)
      VALUES ($1,$2,$3,$4,$5,$6,'在途无理由退款处理','in-transit-refund',
        'verified','paused','paused','manual-review-blocked',$7::jsonb,$8)`, [
      ordinaryInstanceId,
      workOrderId,
      misboundSourceShopId,
      platformCaseId,
      `pdd-work-order:${platformCaseId}`,
      `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformCaseId}`,
      JSON.stringify(payload),
      '拼多多未确认凭证上传成功或提交按钮仍不可用',
    ]);
    await pool.query(`
      UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
      workOrderId,
      ordinaryInstanceId,
    ]);
    await pool.query(`
      INSERT INTO external_effects
        (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
         idempotency_key, status, request_hash)
      VALUES
        ($1,$4,$5,$6,'tms-create',$7,'succeeded','self-test'),
        ($2,$4,$5,$6,'pdd-note',$8,'succeeded','self-test'),
        ($3,$4,$5,$6,'evidence-upload',$9,'unknown','self-test')`, [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      misboundSourceShopId,
      workOrderId,
      ordinaryInstanceId,
      `misbound-tms-${kind}-${suffix}`,
      `misbound-note-${kind}-${suffix}`,
      `misbound-evidence-${kind}-${suffix}`,
    ]);
    if (kind === 'pdd-submit') {
      await pool.query(`
        INSERT INTO external_effects
          (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
           idempotency_key, status, request_hash)
        VALUES ($1,$2,$3,$4,'pdd-submit',$5,'succeeded','self-test')`, [
        crypto.randomUUID(),
        misboundSourceShopId,
        workOrderId,
        ordinaryInstanceId,
        `misbound-submit-${suffix}`,
      ]);
    }
    if (kind === 'reserved') {
      await pool.query(`
        INSERT INTO external_effects
          (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
           idempotency_key, status, request_hash)
        VALUES ($1,$2,$3,$4,'oms-manual-allocation',$5,'reserved','self-test')`, [
        crypto.randomUUID(),
        misboundSourceShopId,
        workOrderId,
        ordinaryInstanceId,
        `misbound-reserved-${suffix}`,
      ]);
    }
    if (kind === 'other-unknown') {
      await pool.query(`
        INSERT INTO external_effects
          (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
           idempotency_key, status, request_hash)
        VALUES ($1,$2,$3,$4,'pdd-note',$5,'unknown','self-test')`, [
        crypto.randomUUID(),
        misboundSourceShopId,
        workOrderId,
        ordinaryInstanceId,
        `misbound-other-unknown-${suffix}`,
      ]);
    }
    if (kind === 'open-conflict') {
      await pool.query(`
        INSERT INTO cross_shop_order_conflicts
          (external_order_number, discovered_shop_id, conflicting_shop_ids,
           status, details)
        VALUES ($1,$2,ARRAY[$3]::text[],'open',$4::jsonb)`, [
        orderNumber,
        misboundSourceShopId,
        shopId,
        JSON.stringify({ selfTest: true, workOrderType: '在途无理由退款处理' }),
      ]);
    }
    if (kind === 'target-duplicate') {
      await pool.query(`
        INSERT INTO work_orders
          (id, shop_id, external_order_number, work_order_type, scenario_code,
           status, runtime_status, idempotency_key, current_step, payload,
           recovery_state, frontend_visibility)
        VALUES ($1,$2,$3,'self-test','in-transit-refund','queued','queued',$4,
          'queued',$5::jsonb,'ready','recovery-audit')`, [
        crypto.randomUUID(),
        shopId,
        orderNumber,
        `misbound-target-duplicate-${suffix}`,
        JSON.stringify({ orderNumber }),
      ]);
    }
    if (kind === 'safe') {
      await pool.query(`
        INSERT INTO manual_interventions
          (id, shop_id, work_order_id, ordinary_instance_id, channel,
           reason_code, reason, risk_level, status, deduplication_key)
        VALUES ($1,$2,$3,$4,'dashboard','image-upload-failed',$5,
          'high','open',$6)`, [
        crypto.randomUUID(),
        misboundSourceShopId,
        workOrderId,
        ordinaryInstanceId,
        '拼多多凭证图片上传结果未确认成功',
        `misbound-safe-intervention-${suffix}`,
      ]);
    }
    misboundFixtures.push({ kind, workOrderId, ordinaryInstanceId, orderNumber, payload });
  }

  const safeMisboundFixture = misboundFixtures.find((fixture) => fixture.kind === 'safe');
  const safeEffectCountBefore = Number((await pool.query(`
    SELECT count(*)::int AS count FROM external_effects WHERE work_order_id = $1`, [
    safeMisboundFixture.workOrderId,
  ])).rows[0].count);
  const recoveredMisboundEvidence = await repository.recoverSafeMisboundPddEvidencePauses({
    shopId,
    identityBindingToken: pddIdentityBindingToken,
    actualShopName: testShopName,
    mallId: pddMallId,
  });
  assert.deepEqual(
    recoveredMisboundEvidence.map((item) => item.id),
    [safeMisboundFixture.workOrderId],
    'only the exact no-click evidence-unknown fixture may be rebound',
  );
  const recoveredMisboundState = (await pool.query(`
    SELECT work_order.shop_id, work_order.status, work_order.runtime_status,
      work_order.current_step, work_order.recovery_state,
      work_order.payload#>>'{crossShopPddEvidenceReadOnlyRecovery,status}' AS recovery_status,
      work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}' AS binding_token,
      instance.shop_id AS instance_shop_id, instance.identity_status,
      (SELECT count(*)::int FROM ordinary_work_order_instances other_instance
       WHERE other_instance.work_order_id = work_order.id
         AND other_instance.shop_id <> work_order.shop_id) AS stale_instance_shops
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [safeMisboundFixture.workOrderId])).rows[0];
  assert.equal(recoveredMisboundState.shop_id, shopId);
  assert.equal(recoveredMisboundState.status, 'paused');
  assert.equal(recoveredMisboundState.runtime_status, 'paused');
  assert.equal(
    recoveredMisboundState.current_step,
    'pdd-detail-read-only-reconciliation-ready',
  );
  assert.equal(recoveredMisboundState.recovery_state, 'ready');
  assert.equal(recoveredMisboundState.recovery_status, 'ready');
  assert.equal(recoveredMisboundState.binding_token, pddIdentityBindingToken);
  assert.equal(recoveredMisboundState.instance_shop_id, shopId);
  assert.equal(recoveredMisboundState.identity_status, 'verified');
  assert.equal(recoveredMisboundState.stale_instance_shops, 0,
    'all ordinary instances must move with their parent work order');
  const blockedMisboundStates = await pool.query(`
    SELECT id, shop_id, status, current_step
    FROM work_orders
    WHERE id = ANY($1::uuid[])
    ORDER BY id`, [misboundFixtures
    .filter((fixture) => fixture.kind !== 'safe')
    .map((fixture) => fixture.workOrderId)]);
  assert.ok(blockedMisboundStates.rows.every((row) => row.shop_id === misboundSourceShopId
    && row.status === 'paused'
    && row.current_step === 'manual-review-blocked'),
  'submit/click/reserved/unknown/conflict/duplicate fixtures must remain frozen');
  const safeEffectCountAfterRelocation = Number((await pool.query(`
    SELECT count(*)::int AS count FROM external_effects WHERE work_order_id = $1`, [
    safeMisboundFixture.workOrderId,
  ])).rows[0].count);
  assert.equal(safeEffectCountAfterRelocation, safeEffectCountBefore,
    'cross-shop relocation must not add or replay an external effect');
  const evidenceReconciliation = await repository.claimNextExternalStateReconciliation({
    shopId,
    retryAfterMs: 600_000,
    retryWindowMs: 86_400_000,
    maxAttempts: 3,
  });
  assert.equal(evidenceReconciliation?.id, safeMisboundFixture.workOrderId,
    'the exact evidence-only recovery must be claimable for read-only reconciliation');
  const evidenceNotApplied = await repository.completeExternalStateReconciliation({
    workOrderId: safeMisboundFixture.workOrderId,
    shopId,
    ordinaryInstanceId: safeMisboundFixture.ordinaryInstanceId,
    observation: {
      state: 'not-applied',
      effectType: 'evidence-upload',
      orderNumber: safeMisboundFixture.orderNumber,
      confirmationMethod: 'present-in-pending-list',
      observedAt: new Date().toISOString(),
      readOnly: true,
    },
    payload: {
      ...safeMisboundFixture.payload,
      pddEvidenceUpload: {
        ...safeMisboundFixture.payload.pddEvidenceUpload,
        status: 'retry-authorized',
      },
    },
  });
  assert.equal(evidenceNotApplied?.status, 'retry-ready');
  assert.equal(evidenceNotApplied?.current_step, 'pdd-evidence-not-applied');
  const safeReconciliationResult = (await pool.query(`
    SELECT effect.status AS effect_status,
      (SELECT count(*)::int FROM external_effects all_effects
       WHERE all_effects.work_order_id = work_order.id) AS effect_count,
      (SELECT count(*)::int FROM external_effects submit_effect
       WHERE submit_effect.work_order_id = work_order.id
         AND submit_effect.effect_type = 'pdd-submit') AS submit_effect_count,
      intervention.status AS intervention_status,
      intervention.shop_id AS intervention_shop_id,
      instance.status AS instance_status,
      instance.current_step AS instance_step
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    JOIN external_effects effect ON effect.work_order_id = work_order.id
      AND effect.effect_type = 'evidence-upload'
    LEFT JOIN manual_interventions intervention
      ON intervention.work_order_id = work_order.id
      AND intervention.ordinary_instance_id = instance.id
    WHERE work_order.id = $1`, [safeMisboundFixture.workOrderId])).rows[0];
  assert.equal(safeReconciliationResult.effect_status, 'failed',
    'a refreshed pending detail must make only the unknown evidence upload retryable');
  assert.equal(safeReconciliationResult.effect_count, safeEffectCountBefore);
  assert.equal(safeReconciliationResult.submit_effect_count, 0,
    'read-only evidence reconciliation must not create a PDD submit effect');
  assert.equal(safeReconciliationResult.intervention_status, 'resolved');
  assert.equal(safeReconciliationResult.intervention_shop_id, shopId);
  assert.equal(safeReconciliationResult.instance_status, 'retry-ready');
  assert.equal(safeReconciliationResult.instance_step, 'pdd-evidence-not-applied');
  assert.equal((await repository.recoverSafeMisboundPddEvidencePauses({
    shopId,
    identityBindingToken: pddIdentityBindingToken,
    actualShopName: testShopName,
    mallId: pddMallId,
  })).length, 0, 'a relocated recovery must be idempotent');

  const readyOrderNumber = `consumer-negotiation-ready-${suffix}`;
  const blockedOrderNumber = `consumer-negotiation-blocked-${suffix}`;
  const consumerNegotiationPayload = (orderNumber) => JSON.stringify({
    orderNumber,
    latestDiscovery: { pddIdentityBindingToken },
    pddResolutionFlow: { flowCode: 'consumer-negotiation-followup' },
    pddResolutionSubmission: {
      orderNumber,
      status: 'followup-waiting',
      interceptProgressOutcome: '快递还在拦截中',
      consumerResponseWaitStartedAt: '2026-08-23T00:00:00.000Z',
    },
    error: '外部操作已存在 succeeded 记录，禁止重复执行',
  });
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, manual_review_reason)
    VALUES
      ($1,$3,$4,'self-test','in-transit-refund','paused','paused',$6,'flow-paused',
       $8::jsonb,$10),
      ($2,$3,$5,'self-test','in-transit-refund','paused','paused',$7,'flow-paused',
       $9::jsonb,$10)`, [
    consumerNegotiationReadyId,
    consumerNegotiationBlockedId,
    shopId,
    readyOrderNumber,
    blockedOrderNumber,
    `consumer-negotiation-ready-${suffix}`,
    `consumer-negotiation-blocked-${suffix}`,
    consumerNegotiationPayload(readyOrderNumber),
    consumerNegotiationPayload(blockedOrderNumber),
    '外部操作已存在 succeeded 记录，禁止重复执行',
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, work_order_type, scenario_code, identity_status,
       status, runtime_status, current_step, payload, manual_review_reason)
    VALUES
      ($1,$3,$5,'self-test','in-transit-refund','legacy-unverified','paused','paused',
       'flow-paused',$6::jsonb,$8),
      ($2,$4,$5,'self-test','in-transit-refund','legacy-unverified','paused','paused',
       'flow-paused',$7::jsonb,$8)`, [
    consumerNegotiationReadyInstanceId,
    consumerNegotiationBlockedInstanceId,
    consumerNegotiationReadyId,
    consumerNegotiationBlockedId,
    shopId,
    consumerNegotiationPayload(readyOrderNumber),
    consumerNegotiationPayload(blockedOrderNumber),
    '外部操作已存在 succeeded 记录，禁止重复执行',
  ]);
  await pool.query(`
    UPDATE work_orders work_order SET current_ordinary_instance_id = fixture.instance_id
    FROM (VALUES ($1::uuid,$3::uuid),($2::uuid,$4::uuid)) fixture(work_order_id, instance_id)
    WHERE work_order.id = fixture.work_order_id`, [
    consumerNegotiationReadyId,
    consumerNegotiationBlockedId,
    consumerNegotiationReadyInstanceId,
    consumerNegotiationBlockedInstanceId,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
       idempotency_key, status, request_hash)
    VALUES
      ($1,$6,$7,$9,'tms-create',$11,'succeeded','self-test'),
      ($2,$6,$7,$9,'pdd-note',$12,'succeeded','self-test'),
      ($3,$6,$8,$10,'tms-create',$13,'succeeded','self-test'),
      ($4,$6,$8,$10,'pdd-note',$14,'succeeded','self-test'),
      ($5,$6,$8,$10,'evidence-upload',$15,'unknown','self-test')`, [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    shopId,
    consumerNegotiationReadyId,
    consumerNegotiationBlockedId,
    consumerNegotiationReadyInstanceId,
    consumerNegotiationBlockedInstanceId,
    `consumer-negotiation-ready-tms-${suffix}`,
    `consumer-negotiation-ready-note-${suffix}`,
    `consumer-negotiation-blocked-tms-${suffix}`,
    `consumer-negotiation-blocked-note-${suffix}`,
    `consumer-negotiation-blocked-unknown-${suffix}`,
  ]);
  const recoveredConsumerNegotiation = await repository.recoverConsumerNegotiationFollowups({
    shopId,
  });
  assert.deepEqual(
    recoveredConsumerNegotiation.map((item) => item.id),
    [consumerNegotiationReadyId],
  );
  const consumerNegotiationStates = await pool.query(`
    SELECT work_order.id, work_order.status, work_order.runtime_status,
      work_order.current_step, work_order.manual_review_reason,
      work_order.payload#>>'{consumerNegotiationFollowupRecovery,strategy}' AS strategy,
      work_order.payload#>>'{consumerNegotiationFollowupRecovery,recoveryAttempts}'
        AS recovery_attempts,
      instance.status AS instance_status,
      instance.current_step AS instance_step,
      (SELECT count(*)::int FROM external_effects effect
       WHERE effect.work_order_id = work_order.id) AS effect_count
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = ANY($1::uuid[])
    ORDER BY work_order.id`, [[consumerNegotiationReadyId, consumerNegotiationBlockedId]]);
  const readyConsumerNegotiation = consumerNegotiationStates.rows
    .find((row) => row.id === consumerNegotiationReadyId);
  const blockedConsumerNegotiation = consumerNegotiationStates.rows
    .find((row) => row.id === consumerNegotiationBlockedId);
  assert.equal(readyConsumerNegotiation.status, 'retry-ready');
  assert.equal(readyConsumerNegotiation.runtime_status, 'retry-ready');
  assert.equal(
    readyConsumerNegotiation.current_step,
    'pdd-consumer-negotiation-followup-retry-ready',
  );
  assert.equal(readyConsumerNegotiation.manual_review_reason, null);
  assert.equal(
    readyConsumerNegotiation.strategy,
    'resume-pdd-followup-without-oms-or-tms-replay',
  );
  assert.equal(readyConsumerNegotiation.recovery_attempts, '1');
  assert.equal(readyConsumerNegotiation.instance_status, 'retry-ready');
  assert.equal(readyConsumerNegotiation.instance_step,
    'pdd-consumer-negotiation-followup-retry-ready');
  assert.equal(readyConsumerNegotiation.effect_count, 2,
    'recovery must not add or replay TMS/PDD-note effects');
  assert.equal(blockedConsumerNegotiation.status, 'paused',
    'an unresolved external effect must keep consumer-negotiation work frozen');
  assert.equal(blockedConsumerNegotiation.effect_count, 3);
  assert.equal((await repository.recoverConsumerNegotiationFollowups({ shopId })).length, 0,
    'a recovered consumer-negotiation wait must not be recovered again while it is ready');

  console.log('PostgreSQL lease, command and external-effect integration test passed');
} finally {
  await pool.query(`DELETE FROM cross_shop_order_conflicts
    WHERE external_order_number LIKE $1`, [`misbound-evidence-%-${suffix}`]).catch(() => {});
  await pool.query('DELETE FROM manual_interventions WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM audit_events WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM workflow_events WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM external_effects WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM operator_commands WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM verification_locations WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM evidence_assets WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM workflow_checkpoints WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM shop_runtime_state WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM worker_heartbeats WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM sync_cursors WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM workflow_runs WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM logistics_analyses WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM oms_analyses WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM tms_work_orders WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM classification_history WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM data_corrections WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM work_orders WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query('DELETE FROM shops WHERE id = $1', [misboundSourceShopId]).catch(() => {});
  await pool.query(`DELETE FROM notification_deliveries WHERE outbox_id IN (
    SELECT outbox.id FROM notification_outbox outbox
    JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id
    WHERE intervention.shop_id = $1
  )`, [shopId]).catch(() => {});
  await pool.query(`DELETE FROM notification_outbox WHERE intervention_id IN (
    SELECT id FROM manual_interventions WHERE shop_id = $1
  )`, [shopId]).catch(() => {});
  await pool.query('DELETE FROM manual_interventions WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM audit_events WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM workflow_events WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM external_effects WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM operator_commands WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM verification_locations WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM evidence_assets WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM workflow_checkpoints WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM shop_runtime_state WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM worker_heartbeats WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM sync_cursors WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM workflow_runs WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [shopId]).catch(() => {});
  await pool.query('DELETE FROM logistics_analyses WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [shopId]).catch(() => {});
  await pool.query('DELETE FROM oms_analyses WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [shopId]).catch(() => {});
  await pool.query('DELETE FROM tms_work_orders WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [shopId]).catch(() => {});
  await pool.query('DELETE FROM classification_history WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [shopId]).catch(() => {});
  await pool.query('DELETE FROM data_corrections WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)', [shopId]).catch(() => {});
  await pool.query('DELETE FROM work_orders WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = $1', [shopId]).catch(() => {});
  await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
  await pool.end();
}
