import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

const pool = await createPostgresPool();
const repository = new PostgresWorkflowRepository(pool);
const suffix = crypto.randomUUID().slice(0, 8);
const shopId = `identity-queue-test-${suffix}`;
const sourceShopId = `identity-queue-source-${suffix}`;
const identityBindingToken = crypto.randomUUID();
const staleBindingToken = crypto.randomUUID();
const actualShopName = `Identity queue shop ${suffix}`;
const mallId = `61387${String(Date.now()).slice(-4)}`;
const platformIdBase = String(Date.now()).slice(-9);
const platformIds = [
  `501${platformIdBase}01`,
  `501${platformIdBase}02`,
  `501${platformIdBase}03`,
  `501${platformIdBase}04`,
  `501${platformIdBase}05`,
  `501${platformIdBase}06`,
  `501${platformIdBase}07`,
  `501${platformIdBase}08`,
  `501${platformIdBase}09`,
  `501${platformIdBase}10`,
  `501${platformIdBase}11`,
  `501${platformIdBase}12`,
  `501${platformIdBase}13`,
  `501${platformIdBase}14`,
  `501${platformIdBase}15`,
  `501${platformIdBase}16`,
  `501${platformIdBase}17`,
  `501${platformIdBase}18`,
  `501${platformIdBase}19`,
  `501${platformIdBase}20`,
  `501${platformIdBase}21`,
  `501${platformIdBase}22`,
  `501${platformIdBase}23`,
];
const refundId = crypto.randomUUID();
const mismatchedRefundId = crypto.randomUUID();
const relocatedRefundId = crypto.randomUUID();
const relocatedPausedRefundId = crypto.randomUUID();

try {
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,slot,false,'disabled'
    FROM generate_series(0, 999) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [shopId, actualShopName]);
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,slot,false,'disabled'
    FROM generate_series(0, 999) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [sourceShopId, `Legacy source ${suffix}`]);
  await pool.query(`
    INSERT INTO pdd_shop_runtime_bindings
      (identity_key, shop_id, actual_shop_name, mall_id, binding_token)
    VALUES ($1,$2,$3,$4,$5)`, [
    `mall:${mallId}`,
    shopId,
    actualShopName,
    mallId,
    identityBindingToken,
  ]);
  const createOrder = (label, index, payload) => repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: `${label}-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[index]}`,
      platformCaseId: platformIds[index],
      platformCaseKey: `pdd-work-order:${platformIds[index]}`,
      ...payload,
    },
  });
  const matching = await createOrder('matching', 0, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
  });
  const mismatch = await createOrder('mismatch', 1, {
    shopNameSnapshot: `Different shop ${suffix}`,
    detectedShopName: `Different shop ${suffix}`,
  });
  const staleVerified = await createOrder('stale-verified', 2, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: staleBindingToken,
  });
  const staleNameOnly = await createOrder('stale-name-only', 8, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddIdentityBindingToken: staleBindingToken,
  });
  const pageIdentityOnly = await createOrder('page-identity-only', 6, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
  });
  const relocatedOrdinary = await repository.enqueueDiscovered({
    shopId: sourceShopId,
    externalOrderNumber: `ordinary-relocated-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[3]}`,
      platformCaseId: platformIds[3],
      platformCaseKey: `pdd-work-order:${platformIds[3]}`,
      shopNameSnapshot: actualShopName,
      detectedShopName: actualShopName,
      pddIdentityBindingToken: staleBindingToken,
    },
  });
  const relocatedLegacyPageIdentity = await repository.enqueueDiscovered({
    shopId: sourceShopId,
    externalOrderNumber: `ordinary-relocated-page-identity-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[7]}`,
      platformCaseId: platformIds[7],
      platformCaseKey: `pdd-work-order:${platformIds[7]}`,
    },
  });
  const tmsCorrelationPaused = await createOrder('tms-correlation-paused', 4, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const tmsTicketNoOnlySafe = await createOrder('tms-ticket-no-only-safe', 17, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const tmsTicketNoMismatchUnsafe = await createOrder('tms-ticket-no-mismatch-unsafe', 18, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const tmsCandidateCountUnsafe = await createOrder('tms-candidate-count-unsafe', 19, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const tmsDecisionMismatchUnsafe = await createOrder('tms-decision-mismatch-unsafe', 20, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const tmsSuborderMismatchUnsafe = await createOrder('tms-suborder-mismatch-unsafe', 21, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const tmsPendingEffectUnsafe = await createOrder('tms-pending-effect-unsafe', 22, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const tmsEvidenceCompatiblePaused = await createOrder('tms-evidence-compatible-paused', 5, {
    shopNameSnapshot: actualShopName,
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const browserTruthPaused = await repository.enqueueDiscovered({
    shopId: sourceShopId,
    externalOrderNumber: `browser-truth-paused-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[9]}`,
      platformCaseId: platformIds[9],
      platformCaseKey: `pdd-work-order:${platformIds[9]}`,
      shopNameSnapshot: `Wrong historical shop ${suffix}`,
      detectedShopName: `Wrong historical shop ${suffix}`,
      pddIdentityBindingToken: staleBindingToken,
    },
  });
  const unsafeSubmitPaused = await repository.enqueueDiscovered({
    shopId: sourceShopId,
    externalOrderNumber: `unsafe-submit-paused-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[10]}`,
      platformCaseId: platformIds[10],
      platformCaseKey: `pdd-work-order:${platformIds[10]}`,
      detectedShopName: `Wrong historical shop ${suffix}`,
      pddIdentityBindingToken: staleBindingToken,
    },
  });
  const unsafeUploadPaused = await repository.enqueueDiscovered({
    shopId: sourceShopId,
    externalOrderNumber: `unsafe-upload-paused-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[11]}`,
      platformCaseId: platformIds[11],
      platformCaseKey: `pdd-work-order:${platformIds[11]}`,
      detectedShopName: `Wrong historical shop ${suffix}`,
      pddIdentityBindingToken: staleBindingToken,
    },
  });
  const sameShopBrowserTruthPaused = await createOrder('same-shop-browser-truth-paused', 12, {
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const legacySameShopBrowserTruthPaused = await createOrder('legacy-same-shop-browser-truth-paused', 13, {
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const legacyUnsafeBusinessPause = await createOrder('legacy-unsafe-business-pause', 14, {
    detectedShopName: actualShopName,
    pddMallId: mallId,
    pddIdentityBindingToken: identityBindingToken,
  });
  const createLegacyCrossShopReadOnlyPause = (label, index) => repository.enqueueDiscovered({
    shopId: sourceShopId,
    externalOrderNumber: `${label}-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[index]}`,
      platformCaseId: platformIds[index],
      platformCaseKey: `pdd-work-order:${platformIds[index]}`,
      pddShopIdentity: {
        actualShopName,
        mallId,
        profileFingerprint: crypto.randomUUID(),
        status: 'detected',
      },
      derivedTabs: [{
        url: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[index]}`,
        purpose: 'pdd-work-order-detail-resume',
        openedAt: new Date().toISOString(),
      }],
    },
  });
  const legacyCrossShopReadOnlyPause = await createLegacyCrossShopReadOnlyPause(
    'legacy-cross-shop-read-only',
    15,
  );
  const legacyCrossShopPendingReadOnlyPause = await createLegacyCrossShopReadOnlyPause(
    'legacy-cross-shop-pending-read-only',
    16,
  );
  for (const pending of [
    browserTruthPaused,
    unsafeSubmitPaused,
    unsafeUploadPaused,
    sameShopBrowserTruthPaused,
    legacySameShopBrowserTruthPaused,
  ]) {
    await pool.query(`UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
        current_step = 'flow-paused', manual_review_reason = 'read-only page render failed',
        completion_state = 'pending', recovery_state = 'ready', next_attempt_at = NULL
      WHERE id = $1`, [pending.workOrder.id]);
    await pool.query(`UPDATE ordinary_work_order_instances
      SET status = 'paused', runtime_status = 'paused', current_step = 'flow-paused',
        manual_review_reason = 'read-only page render failed', next_attempt_at = NULL
      WHERE id = $1`, [pending.instance.id]);
  }
  await pool.query(`UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
      current_step = 'manual-review-blocked',
      manual_review_reason = '流程需要人工复核（阶段: tms-ticket-recovery）：已有 TMS 工单内容与本次处理要求不一致',
      completion_state = 'pending', recovery_state = 'ready', next_attempt_at = NULL
    WHERE id = $1`, [legacyUnsafeBusinessPause.workOrder.id]);
  await pool.query(`UPDATE ordinary_work_order_instances
    SET status = 'paused', runtime_status = 'paused', current_step = 'manual-review-blocked',
      manual_review_reason = '已有 TMS 工单内容与本次处理要求不一致', next_attempt_at = NULL
    WHERE id = $1`, [legacyUnsafeBusinessPause.instance.id]);
  await pool.query(`UPDATE ordinary_work_order_instances
    SET identity_status = 'legacy-unverified', platform_case_id = NULL,
      platform_case_key = NULL, detail_url = NULL
    WHERE id = ANY($1::uuid[])`, [[
    legacySameShopBrowserTruthPaused.instance.id,
    legacyUnsafeBusinessPause.instance.id,
  ]]);
  for (const pending of [legacyCrossShopReadOnlyPause, legacyCrossShopPendingReadOnlyPause]) {
    await pool.query(`UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
        current_step = 'flow-paused', manual_review_reason = 'read-only page render failed',
        completion_state = 'pending', recovery_state = 'ready', next_attempt_at = NULL
      WHERE id = $1`, [pending.workOrder.id]);
    await pool.query(`UPDATE ordinary_work_order_instances
      SET identity_status = 'legacy-unverified', platform_case_id = NULL,
        platform_case_key = NULL, detail_url = NULL,
        status = 'paused', runtime_status = 'paused', current_step = 'flow-paused',
        manual_review_reason = 'read-only page render failed', next_attempt_at = NULL
      WHERE id = $1`, [pending.instance.id]);
    await pool.query(`
      INSERT INTO cross_shop_order_conflicts
        (external_order_number, discovered_shop_id, conflicting_shop_ids, details)
      VALUES ($1,$2,ARRAY[$3]::text[],jsonb_build_object('test', true))`, [
      pending.workOrder.external_order_number,
      sourceShopId,
      shopId,
    ]);
  }
  const unsafeSubmitEffect = await repository.reserveExternalEffect({
    shopId: sourceShopId,
    workOrderId: unsafeSubmitPaused.workOrder.id,
    ordinaryInstanceId: unsafeSubmitPaused.instance.id,
    platformCaseKey: `pdd-work-order:${platformIds[10]}`,
    effectType: 'pdd-submit',
    idempotencyKey: `unsafe-submit-${suffix}`,
    requestHash: `unsafe-submit-hash-${suffix}`,
  });
  await repository.completeExternalEffect({
    id: unsafeSubmitEffect.effect.id,
    status: 'succeeded',
    receipt: { submitted: true },
    ordinaryInstanceId: unsafeSubmitPaused.instance.id,
  });
  const unsafeUploadEffect = await repository.reserveExternalEffect({
    shopId: sourceShopId,
    workOrderId: unsafeUploadPaused.workOrder.id,
    ordinaryInstanceId: unsafeUploadPaused.instance.id,
    platformCaseKey: `pdd-work-order:${platformIds[11]}`,
    effectType: 'evidence-upload',
    idempotencyKey: `unsafe-upload-${suffix}`,
    requestHash: `unsafe-upload-hash-${suffix}`,
  });
  await repository.completeExternalEffect({
    id: unsafeUploadEffect.effect.id,
    status: 'failed',
    error: { code: 48143 },
    ordinaryInstanceId: unsafeUploadPaused.instance.id,
  });
  await pool.query(`
    UPDATE ordinary_work_order_instances SET identity_status = 'legacy-unverified',
      platform_case_id = NULL, platform_case_key = NULL, detail_url = NULL
    WHERE id = $1`, [mismatch.instance.id]);
  const pageIdentityPayload = JSON.stringify({
    orderNumber: `page-identity-only-${suffix}`,
    pddShopIdentity: { actualShopName, mallId, status: 'detected' },
  });
  const relocatedLegacyPageIdentityPayload = JSON.stringify({
    orderNumber: `ordinary-relocated-page-identity-${suffix}`,
    pddShopIdentity: { actualShopName, mallId, status: 'detected' },
  });
  await pool.query('UPDATE work_orders SET payload = $2::jsonb WHERE id = $1', [
    pageIdentityOnly.workOrder.id,
    pageIdentityPayload,
  ]);
  await pool.query('UPDATE ordinary_work_order_instances SET payload = $2::jsonb WHERE id = $1', [
    pageIdentityOnly.instance.id,
    pageIdentityPayload,
  ]);
  await pool.query('UPDATE work_orders SET payload = $2::jsonb WHERE id = $1', [
    relocatedLegacyPageIdentity.workOrder.id,
    relocatedLegacyPageIdentityPayload,
  ]);
  await pool.query(`UPDATE ordinary_work_order_instances SET
      identity_status = 'legacy-unverified', platform_case_id = NULL,
      platform_case_key = NULL, detail_url = NULL, payload = $2::jsonb
    WHERE id = $1`, [relocatedLegacyPageIdentity.instance.id, relocatedLegacyPageIdentityPayload]);
  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'retry-ready',
      current_step = 'logistics-waiting-released', next_attempt_at = now() - interval '1 minute'
    WHERE id = ANY($1::uuid[])`, [[
      matching.workOrder.id,
      mismatch.workOrder.id,
      staleVerified.workOrder.id,
      staleNameOnly.workOrder.id,
      pageIdentityOnly.workOrder.id,
      relocatedOrdinary.workOrder.id,
      relocatedLegacyPageIdentity.workOrder.id,
    ]]);
  await pool.query(`
    UPDATE ordinary_work_order_instances SET status = 'retry-ready', runtime_status = 'retry-ready',
      current_step = 'logistics-waiting-released', next_attempt_at = now() - interval '1 minute'
    WHERE id = ANY($1::uuid[])`, [[
      matching.instance.id,
      mismatch.instance.id,
      staleVerified.instance.id,
      staleNameOnly.instance.id,
      pageIdentityOnly.instance.id,
      relocatedOrdinary.instance.id,
      relocatedLegacyPageIdentity.instance.id,
    ]]);
  await pool.query(`
    UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
      current_step = 'manual-review-blocked',
      manual_review_reason = '流程需要人工复核（阶段: tms-ticket-recovery）：已保存 TMS 工单标识与页面记录不一致',
      payload = coalesce(payload, '{}'::jsonb)
        || jsonb_build_object(
          'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb)
            || jsonb_build_object('pddIdentityBindingToken', $2::text),
          'tmsWorkOrder', jsonb_build_object(
            'status', 'created', 'ticketId', 'saved-id', 'ticketNo', 'L-SAVED'
          ),
          'tmsDuplicateCheck', jsonb_build_object(
            'status', 'matched', 'ticketId', 'visible-id', 'ticketNo', 'L-VISIBLE',
            'candidateCount', 1, 'selectionStrategy', 'only-row'
          ),
          'manualReview', jsonb_build_object('status', 'blocked')
        )
    WHERE id = $1`, [tmsCorrelationPaused.workOrder.id, identityBindingToken]);
  const setTicketNoOnlyCorrelationPause = (candidate, {
    savedTicketNo = 'L00039737',
    observedTicketNo = savedTicketNo,
    candidateCount = 1,
    decisionMatches = true,
    suborderProvablyDifferent = false,
  } = {}) => pool.query(`
    UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
      current_step = 'manual-review-blocked',
      manual_review_reason = '流程需要人工复核（阶段: tms-ticket-recovery）：已保存 TMS 工单标识与页面记录不一致',
      payload = coalesce(payload, '{}'::jsonb)
        || jsonb_build_object(
          'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb)
            || jsonb_build_object('pddIdentityBindingToken', $2::text),
          'tmsWorkOrder', jsonb_build_object(
            'status', 'created', 'ticketId', '39820', 'ticketNo', $3::text
          ),
          'tmsDuplicateCheck', jsonb_build_object(
            'status', 'matched', 'ticketId', $4::text, 'ticketNo', $4::text,
            'candidateCount', $5::int,
            'selectionStrategy', 'saved-ticket-identifier-only-row',
            'decisionComparison', jsonb_build_object(
              'required', true, 'matches', $6::boolean
            ),
            'suborderComparison', jsonb_build_object(
              'provablyDifferent', $7::boolean
            )
          ),
          'manualReview', jsonb_build_object('status', 'blocked')
        )
    WHERE id = $1`, [
    candidate.workOrder.id,
    identityBindingToken,
    savedTicketNo,
    observedTicketNo,
    candidateCount,
    decisionMatches,
    suborderProvablyDifferent,
  ]);
  await setTicketNoOnlyCorrelationPause(tmsTicketNoOnlySafe);
  await setTicketNoOnlyCorrelationPause(tmsTicketNoMismatchUnsafe, {
    observedTicketNo: 'L00039738',
  });
  await setTicketNoOnlyCorrelationPause(tmsCandidateCountUnsafe, { candidateCount: 2 });
  await setTicketNoOnlyCorrelationPause(tmsDecisionMismatchUnsafe, { decisionMatches: false });
  await setTicketNoOnlyCorrelationPause(tmsSuborderMismatchUnsafe, {
    suborderProvablyDifferent: true,
  });
  await setTicketNoOnlyCorrelationPause(tmsPendingEffectUnsafe);
  await pool.query(`
    INSERT INTO external_effects
      (id,shop_id,work_order_id,effect_type,idempotency_key,status,request_hash)
    VALUES ($1,$2,$3,'tms-create',$4,'reserved',$5)`, [
    crypto.randomUUID(),
    shopId,
    tmsPendingEffectUnsafe.workOrder.id,
    `tms-pending-effect-${suffix}`,
    crypto.createHash('sha256').update(`tms-pending-effect-${suffix}`).digest('hex'),
  ]);
  await pool.query(`
    UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
      current_step = 'flow-paused',
      manual_review_reason = 'TMS 截图克隆区域的物流问题或客服备注与本次要求不匹配',
      payload = coalesce(payload, '{}'::jsonb)
        || jsonb_build_object(
          'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb)
            || jsonb_build_object('pddIdentityBindingToken', $2::text),
          'error', 'TMS 截图克隆区域的物流问题或客服备注与本次要求不匹配: test',
          'tmsWorkOrder', jsonb_build_object(
            'status', 'created', 'ticketId', 'visible-id', 'ticketNo', 'L-VISIBLE',
            'problemType', '拦截退回'
          ),
          'tmsDuplicateCheck', jsonb_build_object(
            'status', 'matched', 'recovery', 'unique-visible-ticket-rebound',
            'identity', jsonb_build_object('values', jsonb_build_object(
              '物流问题', '拒收',
              '客服备注', '拒收，麻烦尽快召回此件，24小时超时未处理我司记丢件退款'
            ))
          ),
          'tmsEvidenceScreenshot', jsonb_build_object('status', 'failed')
        )
    WHERE id = $1`, [tmsEvidenceCompatiblePaused.workOrder.id, identityBindingToken]);
  await pool.query(`
    INSERT INTO work_orders
      (id,shop_id,external_order_number,work_order_type,scenario_code,status,runtime_status,
       idempotency_key,current_step,payload,next_attempt_at)
    VALUES
      ($1,$3,$4,'return refund','return-refund','queued','queued',$6,'return-refund-ready','{}'::jsonb,now()),
      ($2,$3,$5,'return refund','return-refund','queued','queued',$7,'return-refund-ready','{}'::jsonb,now())`, [
    refundId,
    mismatchedRefundId,
    shopId,
    `refund-matching-${suffix}`,
    `refund-mismatch-${suffix}`,
    `refund-matching-key-${suffix}`,
    `refund-mismatch-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id,shop_id,external_order_number,aftersale_number,decision,action_state,evidence)
    VALUES
      ($1,$3,$4,$6,'auto-refund','ready',$8::jsonb),
      ($2,$3,$5,$7,'auto-refund','ready',$9::jsonb)`, [
    refundId,
    mismatchedRefundId,
    shopId,
    `refund-matching-${suffix}`,
    `refund-mismatch-${suffix}`,
    `aftersale-matching-${suffix}`,
    `aftersale-mismatch-${suffix}`,
    JSON.stringify({ detectedShopName: actualShopName, pddMallId: mallId, pddIdentityBindingToken: staleBindingToken }),
    JSON.stringify({ detectedShopName: `Different shop ${suffix}`, pddIdentityBindingToken: staleBindingToken }),
  ]);
  await pool.query(`
    INSERT INTO work_orders
      (id,shop_id,external_order_number,work_order_type,scenario_code,status,runtime_status,
       idempotency_key,current_step,payload,next_attempt_at)
    VALUES ($1,$2,$3,'return refund','return-refund','retry-ready','waiting',$4,
      'return-refund-waiting-logistics','{}'::jsonb,now() - interval '1 minute')`, [
    relocatedRefundId,
    sourceShopId,
    `refund-relocated-${suffix}`,
    `refund-relocated-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id,shop_id,external_order_number,aftersale_number,decision,action_state,
       evidence,next_check_at,last_scanned_at)
    VALUES ($1,$2,$3,$4,'wait-logistics','waiting-logistics',$5::jsonb,
      now() - interval '1 minute',now() - interval '5 hours')`, [
    relocatedRefundId,
    sourceShopId,
    `refund-relocated-${suffix}`,
    `aftersale-relocated-${suffix}`,
    JSON.stringify({ detectedShopName: actualShopName, pddMallId: mallId, pddIdentityBindingToken: staleBindingToken }),
  ]);
  await pool.query(`
    INSERT INTO work_orders
      (id,shop_id,external_order_number,work_order_type,scenario_code,status,runtime_status,
       idempotency_key,current_step,payload)
    VALUES ($1,$2,$3,'return refund','return-refund','paused','manual-review',$4,
      'return-refund-manual-review','{}'::jsonb)`, [
    relocatedPausedRefundId,
    sourceShopId,
    `refund-relocated-paused-${suffix}`,
    `refund-relocated-paused-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id,shop_id,external_order_number,aftersale_number,decision,action_state,evidence)
    VALUES ($1,$2,$3,$4,'manual-review','manual-review',$5::jsonb)`, [
    relocatedPausedRefundId,
    sourceShopId,
    `refund-relocated-paused-${suffix}`,
    `aftersale-relocated-paused-${suffix}`,
    JSON.stringify({ detectedShopName: actualShopName, pddMallId: mallId, pddIdentityBindingToken: staleBindingToken }),
  ]);

  const rebound = await repository.bindLegacyPendingOrdersToIdentity({
    shopId,
    identityBindingToken,
    actualShopName,
    mallId,
  });
  assert.deepEqual(
    new Set(rebound.map((row) => row.id)),
    new Set([
      matching.workOrder.id,
      staleVerified.workOrder.id,
      staleNameOnly.workOrder.id,
      pageIdentityOnly.workOrder.id,
      relocatedOrdinary.workOrder.id,
      relocatedLegacyPageIdentity.workOrder.id,
      legacyCrossShopReadOnlyPause.workOrder.id,
      legacyCrossShopPendingReadOnlyPause.workOrder.id,
      refundId,
      relocatedRefundId,
      relocatedPausedRefundId,
      tmsCorrelationPaused.workOrder.id,
      tmsTicketNoOnlySafe.workOrder.id,
      tmsEvidenceCompatiblePaused.workOrder.id,
    ]),
  );
  await pool.query(`
    UPDATE work_orders SET updated_at = CASE
      WHEN id = $1 THEN now()
      WHEN id = $2 THEN now() - interval '1 second'
      ELSE updated_at END
    WHERE id IN ($1,$2)`, [
    legacyCrossShopReadOnlyPause.workOrder.id,
    legacyCrossShopPendingReadOnlyPause.workOrder.id,
  ]);

  const reboundInstances = await pool.query(`
    SELECT id, payload->'latestDiscovery'->>'pddIdentityBindingToken' AS binding_token
    FROM ordinary_work_order_instances WHERE id = ANY($1::uuid[])`, [
    [matching.instance.id, staleVerified.instance.id, staleNameOnly.instance.id, pageIdentityOnly.instance.id],
  ]);
  assert.equal(reboundInstances.rows.length, 4);
  assert(reboundInstances.rows.every((row) => row.binding_token === identityBindingToken),
    'the primary work order and current verified instance must receive the same binding token');
  const relocatedOrdinaryState = await pool.query(`
    SELECT work_order.shop_id, instance.shop_id AS instance_shop_id,
      work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' AS binding_token
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [relocatedOrdinary.workOrder.id]);
  assert.deepEqual(relocatedOrdinaryState.rows[0], {
    shop_id: shopId,
    instance_shop_id: shopId,
    binding_token: identityBindingToken,
  }, 'a verified ordinary case with exact shop identity must move to the confirmed shop');
  const relocatedLegacyState = await pool.query(`
    SELECT work_order.shop_id, instance.shop_id AS instance_shop_id,
      instance.identity_status,
      work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' AS binding_token
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [relocatedLegacyPageIdentity.workOrder.id]);
  assert.deepEqual(relocatedLegacyState.rows[0], {
    shop_id: shopId,
    instance_shop_id: shopId,
    identity_status: 'legacy-unverified',
    binding_token: identityBindingToken,
  }, 'a legacy case with a unique exact page identity must move to the confirmed shop');
  const legacyCrossShopReadOnlyState = await pool.query(`
    SELECT work_order.shop_id, work_order.status, work_order.current_step,
      work_order.payload->'crossShopLegacyPddReadOnlyRecovery'->>'status' AS recovery_status,
      work_order.payload->'crossShopLegacyPddReadOnlyRecovery'->>'externalActionsReplayed'
        AS external_actions_replayed,
      instance.shop_id AS instance_shop_id, instance.identity_status,
      instance.platform_case_id, instance.platform_case_key, instance.detail_url,
      conflict.status AS conflict_status, conflict.resolved_shop_id
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    LEFT JOIN cross_shop_order_conflicts conflict
      ON conflict.external_order_number = work_order.external_order_number
    WHERE work_order.id = $1`, [legacyCrossShopReadOnlyPause.workOrder.id]);
  assert.deepEqual(legacyCrossShopReadOnlyState.rows[0], {
    shop_id: shopId,
    status: 'paused',
    current_step: 'pdd-detail-read-only-reconciliation-ready',
    recovery_status: 'ready',
    external_actions_replayed: 'false',
    instance_shop_id: shopId,
    identity_status: 'verified',
    platform_case_id: platformIds[15],
    platform_case_key: `pdd-work-order:${platformIds[15]}`,
    detail_url: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[15]}`,
    conflict_status: 'resolved',
    resolved_shop_id: shopId,
  }, 'a legacy cross-shop render pause must be relocated only for a state-only readback');
  const legacyReadOnlyClaim = await repository.claimNextExternalStateReconciliation({ shopId });
  assert.equal(legacyReadOnlyClaim?.id, legacyCrossShopReadOnlyPause.workOrder.id,
    'the relocated legacy pause must enter the read-only reconciliation queue');
  const legacyReadOnlyWorkOrder = await repository.getWorkOrderForReconciliation({
    workOrderId: legacyReadOnlyClaim.id,
    shopId,
  });
  assert.deepEqual(legacyReadOnlyWorkOrder.unknown_effect_types, [],
    'state-only reconciliation must not fabricate an unknown external effect');
  const legacyReadOnlyCompleted = await repository.completeExternalStateReconciliation({
    workOrderId: legacyReadOnlyClaim.id,
    shopId,
    ordinaryInstanceId: legacyReadOnlyClaim.current_ordinary_instance_id,
    observation: {
      state: 'confirmed',
      effectType: 'pdd-state',
      orderNumber: legacyReadOnlyClaim.external_order_number,
      confirmationMethod: 'detail-completed',
      observedAt: new Date().toISOString(),
      readOnly: true,
    },
    payload: legacyReadOnlyWorkOrder.payload,
  });
  assert.equal(legacyReadOnlyCompleted.status, 'archived');
  assert.equal(legacyReadOnlyCompleted.completion_state, 'confirmed');
  const legacyReadOnlyCompletedInstance = await pool.query(`
    SELECT status, runtime_status, current_step, completion_method,
      completed_at IS NOT NULL AS completed
    FROM ordinary_work_order_instances WHERE id = $1`, [
    legacyReadOnlyClaim.current_ordinary_instance_id,
  ]);
  assert.deepEqual(legacyReadOnlyCompletedInstance.rows[0], {
    status: 'archived',
    runtime_status: 'archived',
    current_step: 'external-state-confirmed',
    completion_method: 'detail-completed',
    completed: true,
  }, 'a confirmed state-only readback must archive the current ordinary instance atomically');
  const legacyReadOnlyEffects = await pool.query(`
    SELECT count(*)::int AS count FROM external_effects WHERE work_order_id = $1`, [
    legacyCrossShopReadOnlyPause.workOrder.id,
  ]);
  assert.equal(legacyReadOnlyEffects.rows[0].count, 0,
    'state-only reconciliation must not add or replay an external effect');
  const legacyPendingReadOnlyClaim = await repository.claimNextExternalStateReconciliation({ shopId });
  assert.equal(legacyPendingReadOnlyClaim?.id, legacyCrossShopPendingReadOnlyPause.workOrder.id,
    'the second relocated legacy pause must also enter the read-only reconciliation queue');
  const legacyPendingReadOnlyWorkOrder = await repository.getWorkOrderForReconciliation({
    workOrderId: legacyPendingReadOnlyClaim.id,
    shopId,
  });
  const pendingObservedAt = new Date().toISOString();
  const legacyPendingReadOnlyResult = await repository.completeExternalStateReconciliation({
    workOrderId: legacyPendingReadOnlyClaim.id,
    shopId,
    ordinaryInstanceId: legacyPendingReadOnlyClaim.current_ordinary_instance_id,
    observation: {
      state: 'not-applied',
      effectType: 'pdd-state',
      orderNumber: legacyPendingReadOnlyClaim.external_order_number,
      confirmationMethod: 'pending-list-exact-match',
      observedAt: pendingObservedAt,
      readOnly: true,
    },
    payload: {
      ...legacyPendingReadOnlyWorkOrder.payload,
      pddResolutionSubmission: null,
      crossShopLegacyPddReadOnlyRecovery: {
        ...(legacyPendingReadOnlyWorkOrder.payload.crossShopLegacyPddReadOnlyRecovery || {}),
        status: 'pending-page-confirmed',
        confirmationMethod: 'pending-list-exact-match',
        observedAt: pendingObservedAt,
        externalActionsReplayed: false,
      },
      manualReview: null,
    },
  });
  assert.equal(legacyPendingReadOnlyResult.status, 'retry-ready');
  const legacyPendingReadOnlyState = await pool.query(`
    SELECT work_order.status, work_order.runtime_status, work_order.current_step,
      work_order.recovery_state, work_order.payload->'pddResolutionSubmission' AS pdd_submission,
      work_order.payload#>>'{crossShopLegacyPddReadOnlyRecovery,status}' AS recovery_status,
      instance.status AS instance_status, instance.runtime_status AS instance_runtime_status
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [legacyCrossShopPendingReadOnlyPause.workOrder.id]);
  assert.deepEqual(legacyPendingReadOnlyState.rows[0], {
    status: 'retry-ready',
    runtime_status: 'retry-ready',
    current_step: 'pdd-state-not-applied',
    recovery_state: 'ready',
    pdd_submission: null,
    recovery_status: 'pending-page-confirmed',
    instance_status: 'retry-ready',
    instance_runtime_status: 'retry-ready',
  }, 'a confirmed pending page must resume the original workflow without a fabricated submit');
  const legacyPendingReadOnlyEffects = await pool.query(`
    SELECT count(*)::int AS count FROM external_effects WHERE work_order_id = $1`, [
    legacyCrossShopPendingReadOnlyPause.workOrder.id,
  ]);
  assert.equal(legacyPendingReadOnlyEffects.rows[0].count, 0,
    'pending state-only reconciliation must not add or replay an external effect');
  const reboundRefunds = await pool.query(`
    SELECT work_order_id, evidence->>'pddIdentityBindingToken' AS binding_token
    FROM return_refunds WHERE work_order_id = ANY($1::uuid[]) ORDER BY work_order_id`, [
    [refundId, mismatchedRefundId],
  ]);
  assert.equal(reboundRefunds.rows.find((row) => row.work_order_id === refundId)?.binding_token,
    identityBindingToken, 'a same-shop pending refund must receive the current binding token');
  assert.equal(reboundRefunds.rows.find((row) => row.work_order_id === mismatchedRefundId)?.binding_token,
    staleBindingToken, 'a refund whose detected shop name differs must remain fenced');
  const relocatedRefund = await pool.query(`
    SELECT work_order.shop_id, refund.shop_id AS refund_shop_id,
      refund.evidence->>'pddIdentityBindingToken' AS binding_token
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    WHERE work_order.id = $1`, [relocatedRefundId]);
  assert.deepEqual(relocatedRefund.rows[0], {
    shop_id: shopId,
    refund_shop_id: shopId,
    binding_token: identityBindingToken,
  }, 'a pending refund with a uniquely confirmed shop name must move to that shop');
  const relocatedPausedRefund = await pool.query(`
    SELECT work_order.shop_id, work_order.status,
      refund.shop_id AS refund_shop_id, refund.action_state
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    WHERE work_order.id = $1`, [relocatedPausedRefundId]);
  assert.deepEqual(relocatedPausedRefund.rows[0], {
    shop_id: shopId,
    status: 'paused',
    refund_shop_id: shopId,
    action_state: 'manual-review',
  }, 'a relocated manual-review refund must remain paused');
  const recoveredTmsCorrelation = await pool.query(`
    SELECT status, runtime_status, current_step, manual_review_reason,
      payload->'manualReview' AS manual_review,
      payload->'tmsTicketRecordCorrelationRecovery'->>'reason' AS recovery_reason
    FROM work_orders WHERE id = $1`, [tmsCorrelationPaused.workOrder.id]);
  assert.deepEqual(recoveredTmsCorrelation.rows[0], {
    status: 'retry-ready',
    runtime_status: 'retry-ready',
    current_step: 'tms-ticket-record-correlation-retry-ready',
    manual_review_reason: null,
    manual_review: null,
    recovery_reason: 'tms-ticket-record-correlation-fixed',
  }, 'only an exact safe TMS ticket-correlation pause must be released');
  const strictTicketNoRecoveryStates = await pool.query(`
    SELECT id, status, current_step,
      payload->'tmsTicketRecordCorrelationRecovery'->>'reason' AS recovery_reason
    FROM work_orders WHERE id = ANY($1::uuid[])
    ORDER BY id`, [[
    tmsTicketNoOnlySafe.workOrder.id,
    tmsTicketNoMismatchUnsafe.workOrder.id,
    tmsCandidateCountUnsafe.workOrder.id,
    tmsDecisionMismatchUnsafe.workOrder.id,
    tmsSuborderMismatchUnsafe.workOrder.id,
    tmsPendingEffectUnsafe.workOrder.id,
  ]]);
  const strictTicketNoRecoveryById = new Map(
    strictTicketNoRecoveryStates.rows.map((row) => [row.id, row]),
  );
  assert.deepEqual(strictTicketNoRecoveryById.get(tmsTicketNoOnlySafe.workOrder.id), {
    id: tmsTicketNoOnlySafe.workOrder.id,
    status: 'retry-ready',
    current_step: 'tms-ticket-record-correlation-retry-ready',
    recovery_reason: 'tms-ticket-record-correlation-fixed',
  }, 'a sole visible row with the same saved ticket number and matching business identity must resume');
  for (const unsafeCandidate of [
    tmsTicketNoMismatchUnsafe,
    tmsCandidateCountUnsafe,
    tmsDecisionMismatchUnsafe,
    tmsSuborderMismatchUnsafe,
    tmsPendingEffectUnsafe,
  ]) {
    assert.deepEqual(strictTicketNoRecoveryById.get(unsafeCandidate.workOrder.id), {
      id: unsafeCandidate.workOrder.id,
      status: 'paused',
      current_step: 'manual-review-blocked',
      recovery_reason: null,
    }, 'ticket-number-only correlation recovery must remain blocked when any safety proof is missing');
  }
  const recoveredCompatibleEvidence = await pool.query(`
    SELECT status, runtime_status, current_step, manual_review_reason,
      payload->'tmsEvidenceScreenshot' AS tms_evidence,
      payload->'tmsEvidenceCompatibilityRecovery'->>'reason' AS recovery_reason
    FROM work_orders WHERE id = $1`, [tmsEvidenceCompatiblePaused.workOrder.id]);
  assert.deepEqual(recoveredCompatibleEvidence.rows[0], {
    status: 'retry-ready',
    runtime_status: 'retry-ready',
    current_step: 'tms-evidence-compatible-retry-ready',
    manual_review_reason: null,
    tms_evidence: null,
    recovery_reason: 'tms-refusal-recall-evidence-compatible',
  }, 'a verified refusal-recall row must be recaptured after a unique-ticket rebind');

  const browserTruthRecovery = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: `browser-truth-paused-${suffix}`,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[9]}`,
      platformCaseId: platformIds[9],
      platformCaseKey: `pdd-work-order:${platformIds[9]}`,
      detectedShopName: actualShopName,
      shopNameSnapshot: actualShopName,
      pddMallId: mallId,
      pddIdentityBindingToken: identityBindingToken,
    },
  });
  assert.equal(browserTruthRecovery.browserTruthRecovered, true);
  const browserTruthState = await pool.query(`
    SELECT work_order.shop_id, work_order.status, work_order.current_step,
      work_order.manual_review_reason,
      work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' AS binding_token,
      instance.shop_id AS instance_shop_id, instance.status AS instance_status
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [browserTruthPaused.workOrder.id]);
  assert.deepEqual(browserTruthState.rows[0], {
    shop_id: shopId,
    status: 'retry-ready',
    current_step: 'pdd-browser-truth-identity-retry-ready',
    manual_review_reason: null,
    binding_token: identityBindingToken,
    instance_shop_id: shopId,
    instance_status: 'retry-ready',
  }, 'an exact browser rediscovery must relocate and resume a safe cross-shop pause');
  const sameShopBrowserTruthRecovery = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: sameShopBrowserTruthPaused.workOrder.external_order_number,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[12]}`,
      platformCaseId: platformIds[12],
      platformCaseKey: `pdd-work-order:${platformIds[12]}`,
      detectedShopName: actualShopName,
      pddMallId: mallId,
      pddIdentityBindingToken: identityBindingToken,
    },
  });
  assert.equal(sameShopBrowserTruthRecovery.browserTruthRecovered, true,
    'an exact same-shop rediscovery must resume a safe render pause');
  const legacySameShopRecovery = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: legacySameShopBrowserTruthPaused.workOrder.external_order_number,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[13]}`,
      platformCaseId: platformIds[13],
      platformCaseKey: `pdd-work-order:${platformIds[13]}`,
      detectedShopName: actualShopName,
      pddMallId: mallId,
      pddIdentityBindingToken: identityBindingToken,
    },
  });
  assert.equal(legacySameShopRecovery.browserTruthRecovered, true,
    'an exact same-shop rediscovery must promote and resume a safe legacy instance');
  const legacySameShopState = await pool.query(`
    SELECT work_order.status, work_order.current_ordinary_instance_id,
      instance.identity_status, instance.platform_case_id, instance.platform_case_key,
      (SELECT count(*)::int FROM ordinary_work_order_instances sibling
        WHERE sibling.work_order_id = work_order.id) AS instance_count
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [legacySameShopBrowserTruthPaused.workOrder.id]);
  assert.deepEqual(legacySameShopState.rows[0], {
    status: 'retry-ready',
    current_ordinary_instance_id: legacySameShopBrowserTruthPaused.instance.id,
    identity_status: 'verified',
    platform_case_id: platformIds[13],
    platform_case_key: `pdd-work-order:${platformIds[13]}`,
    instance_count: 1,
  }, 'legacy identity promotion must preserve the original instance instead of creating a deferred duplicate');
  const unsafeBusinessRediscovery = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: legacyUnsafeBusinessPause.workOrder.external_order_number,
    workOrderType: 'self-test',
    scenarioCode: 'abnormal-network-warning',
    payload: {
      detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[14]}`,
      platformCaseId: platformIds[14],
      platformCaseKey: `pdd-work-order:${platformIds[14]}`,
      detectedShopName: actualShopName,
      pddMallId: mallId,
      pddIdentityBindingToken: identityBindingToken,
    },
  });
  assert.equal(unsafeBusinessRediscovery.browserTruthRecovered, undefined,
    'browser truth must not clear a deterministic TMS business conflict');
  const unsafeBusinessState = await pool.query(`
    SELECT work_order.status, current_instance.identity_status,
      current_instance.platform_case_key,
      count(all_instances.id)::int AS instance_count
    FROM work_orders work_order
    JOIN ordinary_work_order_instances current_instance
      ON current_instance.id = work_order.current_ordinary_instance_id
    JOIN ordinary_work_order_instances all_instances ON all_instances.work_order_id = work_order.id
    WHERE work_order.id = $1
    GROUP BY work_order.status, current_instance.identity_status, current_instance.platform_case_key`, [
    legacyUnsafeBusinessPause.workOrder.id,
  ]);
  assert.deepEqual(unsafeBusinessState.rows[0], {
    status: 'paused',
    identity_status: 'legacy-unverified',
    platform_case_key: null,
    instance_count: 2,
  }, 'business conflicts must remain paused and retain their unverified current instance');
  for (const unsafe of [
    { record: unsafeSubmitPaused, index: 10 },
    { record: unsafeUploadPaused, index: 11 },
  ]) {
    await assert.rejects(repository.enqueueDiscovered({
      shopId,
      externalOrderNumber: unsafe.record.workOrder.external_order_number,
      workOrderType: 'self-test',
      scenarioCode: 'abnormal-network-warning',
      payload: {
        detailUrl: `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformIds[unsafe.index]}`,
        platformCaseId: platformIds[unsafe.index],
        platformCaseKey: `pdd-work-order:${platformIds[unsafe.index]}`,
        detectedShopName: actualShopName,
        pddMallId: mallId,
        pddIdentityBindingToken: identityBindingToken,
      },
    }), (error) => error?.code === 'PDD_CROSS_SHOP_REDISCOVERY_UNSAFE');
  }
  const unsafeStates = await pool.query(`
    SELECT id, shop_id, status FROM work_orders WHERE id = ANY($1::uuid[]) ORDER BY id`, [[
    unsafeSubmitPaused.workOrder.id,
    unsafeUploadPaused.workOrder.id,
  ]]);
  assert.equal(unsafeStates.rows.length, 2);
  assert(unsafeStates.rows.every((row) => row.shop_id === sourceShopId && row.status === 'paused'),
    'unsafe external-effect states must stay paused under their original assignment');

  const refundClaim = await repository.claimNext({
    shopId,
    workerId: `identity-refund-worker-${suffix}`,
    identityBindingToken,
    scenarioCodes: ['return-refund'],
    leaseSeconds: 60,
  });
  assert.equal(refundClaim?.id, refundId,
    'a safely rebound refund must become claimable by the current shop identity');
  await repository.finishClaimed({
    shopId,
    workOrderId: refundClaim.id,
    leaseToken: refundClaim.leaseToken,
    status: 'completed',
    currentStep: 'self-test-refund-complete',
    payload: refundClaim.payload,
  });
  const relocatedRefundClaim = await repository.claimNext({
    shopId,
    workerId: `identity-relocated-refund-worker-${suffix}`,
    identityBindingToken,
    scenarioCodes: ['return-refund'],
    leaseSeconds: 60,
  });
  assert.equal(relocatedRefundClaim?.id, relocatedRefundId,
    'a relocated due refund must become claimable by the confirmed shop identity');
  await repository.finishClaimed({
    shopId,
    workOrderId: relocatedRefundClaim.id,
    leaseToken: relocatedRefundClaim.leaseToken,
    status: 'completed',
    currentStep: 'self-test-relocated-refund-complete',
    payload: relocatedRefundClaim.payload,
  });

  const eligibility = await repository.getOrdinaryQueueEligibility({ shopId, identityBindingToken });
  assert.equal(eligibility.due, 15);
  assert.equal(eligibility.claimable, 14);
  assert.equal(eligibility.identity_blocked, 1);

  const expectedClaimIds = new Set([
    matching.workOrder.id,
    staleVerified.workOrder.id,
    staleNameOnly.workOrder.id,
    pageIdentityOnly.workOrder.id,
    relocatedOrdinary.workOrder.id,
    relocatedLegacyPageIdentity.workOrder.id,
    tmsCorrelationPaused.workOrder.id,
    tmsTicketNoOnlySafe.workOrder.id,
    tmsEvidenceCompatiblePaused.workOrder.id,
    browserTruthPaused.workOrder.id,
    sameShopBrowserTruthPaused.workOrder.id,
    legacySameShopBrowserTruthPaused.workOrder.id,
    legacyUnsafeBusinessPause.workOrder.id,
    legacyCrossShopPendingReadOnlyPause.workOrder.id,
  ]);
  while (expectedClaimIds.size > 0) {
    const claim = await repository.claimNext({
      shopId,
      workerId: `identity-queue-worker-${suffix}`,
      identityBindingToken,
      leaseSeconds: 60,
    });
    assert(expectedClaimIds.delete(claim?.id), 'each safely rebound ordinary case must become claimable once');
    if (claim.id === pageIdentityOnly.workOrder.id) {
      const sparseProgress = {
        orderNumber: claim.external_order_number,
        pddShopIdentity: { actualShopName, mallId, status: 'detected' },
        updatedAt: new Date().toISOString(),
      };
      assert.equal(await repository.checkpointClaimed({
        shopId,
        workOrderId: claim.id,
        leaseToken: claim.leaseToken,
        currentStep: 'self-test-sparse-checkpoint',
        payload: sparseProgress,
      }), true);
      const checkpointIdentity = await pool.query(`
        SELECT work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' AS work_token,
          instance.payload->'latestDiscovery'->>'pddIdentityBindingToken' AS instance_token
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
        WHERE work_order.id = $1`, [claim.id]);
      assert.equal(checkpointIdentity.rows[0]?.work_token, identityBindingToken,
        'a sparse workflow checkpoint must preserve the work-order discovery identity');
      assert.equal(checkpointIdentity.rows[0]?.instance_token, identityBindingToken,
        'a sparse workflow checkpoint must preserve the instance discovery identity');
      await repository.finishClaimed({
        shopId,
        workOrderId: claim.id,
        leaseToken: claim.leaseToken,
        status: 'completed',
        currentStep: 'self-test-sparse-complete',
        payload: sparseProgress,
      });
      const completedIdentity = await pool.query(`
        SELECT payload->'latestDiscovery'->>'pddIdentityBindingToken' AS binding_token
        FROM work_orders WHERE id = $1`, [claim.id]);
      assert.equal(completedIdentity.rows[0]?.binding_token, identityBindingToken,
        'finishing with a sparse workflow payload must preserve the discovery identity');
      continue;
    }
    await repository.finishClaimed({
      shopId,
      workOrderId: claim.id,
      leaseToken: claim.leaseToken,
      status: 'completed',
      currentStep: 'self-test-complete',
      payload: claim.payload,
    });
  }
  assert.equal(expectedClaimIds.size, 0);
  assert.equal(await repository.claimNext({
    shopId,
    workerId: `identity-queue-worker-${suffix}`,
    identityBindingToken,
    leaseSeconds: 60,
  }), null);
  console.log('ordinary work-order identity queue self-test passed');
} finally {
  const cleanupShopIds = [shopId, sourceShopId];
  const cleanup = await pool.connect();
  try {
    await cleanup.query('BEGIN');
    await cleanup.query(`
      UPDATE work_orders SET current_ordinary_instance_id = NULL
      WHERE shop_id = ANY($1::text[])`, [cleanupShopIds]);
    await cleanup.query(`
      DELETE FROM notification_outbox
      WHERE intervention_id IN (
        SELECT id FROM manual_interventions WHERE shop_id = ANY($1::text[])
      )`, [cleanupShopIds]);
    await cleanup.query('DELETE FROM manual_interventions WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('DELETE FROM audit_events WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('DELETE FROM workflow_checkpoints WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('DELETE FROM shop_runtime_state WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('DELETE FROM external_effects WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query(`DELETE FROM cross_shop_order_conflicts
      WHERE discovered_shop_id = ANY($1::text[]) OR resolved_shop_id = ANY($1::text[])`, [cleanupShopIds]);
    await cleanup.query('DELETE FROM return_refunds WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('DELETE FROM work_orders WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('DELETE FROM shops WHERE id = ANY($1::text[])', [cleanupShopIds]);
    await cleanup.query('COMMIT');
  } catch (error) {
    await cleanup.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    cleanup.release();
    await pool.end();
  }
}
