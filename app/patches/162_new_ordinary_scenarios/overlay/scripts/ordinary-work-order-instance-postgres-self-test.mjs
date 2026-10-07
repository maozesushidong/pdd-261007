import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataBackend } from '../apps/api/src/data-backend.mjs';
import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.DATABASE_URL) {
  const envFile = path.join(root, '.env.native');
  try {
    for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
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
  } catch { /* DATABASE_URL validation below provides the actionable failure */ }
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = await createPostgresPool(undefined, { max: 3, applicationName: 'ordinary-instance-self-test' });
const repository = new PostgresWorkflowRepository(pool);
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
const shopId = `ordinary-instance-test-${suffix}`;
const otherShopId = `ordinary-instance-other-${suffix}`;
const reconciliationShopId = `ordinary-reconciliation-${suffix}`;
const shopName = `Ordinary instance test ${suffix}`;
const orderNumber = `ordinary-order-${suffix}`;
const otherWorkOrderId = crypto.randomUUID();
const oldRecoveredWorkOrderId = crypto.randomUUID();
const oldRecoveredInstanceId = crypto.randomUUID();
const oldRecoveredPlatformId = `24${Date.now()}06`;
const firstPlatformId = `23${Date.now()}01`;
const secondPlatformId = `23${Date.now()}02`;
const thirdPlatformId = `23${Date.now()}03`;
const invalidPlatformId = `23${Date.now()}04`;
const fourthPlatformId = `23${Date.now()}05`;
const detailUrl = (platformId) => `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformId}`;

try {
  const schema = await pool.query(`
    SELECT to_regclass('ordinary_work_order_instances') AS instances,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'work_orders'
          AND column_name = 'current_ordinary_instance_id'
      ) AS current_column`);
  assert.equal(schema.rows[0].instances, 'ordinary_work_order_instances', 'migration 059 must be applied');
  assert.equal(schema.rows[0].current_column, true, 'current ordinary instance column is required');

  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,candidate.slot,false,'disabled'
    FROM generate_series(0, 999) candidate(slot)
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = candidate.slot)
    ORDER BY candidate.slot LIMIT 1`, [shopId, shopName]);
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,candidate.slot,false,'disabled'
    FROM generate_series(0, 999) candidate(slot)
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = candidate.slot)
    ORDER BY candidate.slot LIMIT 1`, [otherShopId, `${shopName} other`]);
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,candidate.slot,false,'disabled'
    FROM generate_series(0, 999) candidate(slot)
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = candidate.slot)
    ORDER BY candidate.slot LIMIT 1`, [reconciliationShopId, `${shopName} reconciliation`]);

  const first = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: orderNumber,
    workOrderType: '消费者担忧货物无法送达',
    scenarioCode: 'delivery-risk-concern',
    payload: { detailUrl: detailUrl(firstPlatformId), detectedShopName: shopName },
  });
  assert.equal(first.inserted, true);
  assert.equal(first.instance.platform_case_id, firstPlatformId);

  await pool.query(`
    INSERT INTO shop_runtime_state
      (shop_id, worker_id, status, lease_token, lease_expires_at, current_work_order_id)
    VALUES ($1,$2,'processing',$3,now() + interval '5 minutes',$4)
    ON CONFLICT (shop_id) DO UPDATE SET
      worker_id = EXCLUDED.worker_id,
      status = EXCLUDED.status,
      lease_token = EXCLUDED.lease_token,
      lease_expires_at = EXCLUDED.lease_expires_at,
      current_work_order_id = EXCLUDED.current_work_order_id,
      updated_at = now()`, [
    shopId,
    `ordinary-instance-foreign-worker-${suffix}`,
    crypto.randomUUID(),
    first.workOrder.id,
  ]);
  const activeLeaseEligibility = await repository.getOrdinaryQueueEligibility({ shopId });
  assert.equal(activeLeaseEligibility.active_claim, 1,
    'an active shop lease must prevent discovery while another worker owns the order');
  assert(activeLeaseEligibility.active_claim_expires_at,
    'active queue eligibility must expose the lease expiry time');
  await pool.query(`
    UPDATE shop_runtime_state SET worker_id = NULL, status = 'idle', lease_token = NULL,
      lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
    WHERE shop_id = $1`, [shopId]);

  const duplicate = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: orderNumber,
    workOrderType: '消费者担忧货物无法送达',
    scenarioCode: 'delivery-risk-concern',
    payload: { detailUrl: detailUrl(firstPlatformId), detectedShopName: shopName },
  });
  assert.equal(duplicate.reused, true, 'the same platform case must be idempotent');

  const deferred = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: orderNumber,
    workOrderType: '物流异常主动服务',
    scenarioCode: 'proactive-logistics-service',
    payload: { detailUrl: detailUrl(secondPlatformId), detectedShopName: shopName },
  });
  assert.equal(deferred.deferred, true, 'a new case must wait while the current case is unfinished');
  assert.equal(deferred.instance.status, 'deferred');

  const nextDeferred = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: orderNumber,
    workOrderType: '消费者申请退款后提示拦截',
    scenarioCode: 'intercept-recall',
    payload: { detailUrl: detailUrl(thirdPlatformId), detectedShopName: shopName },
  });
  assert.equal(nextDeferred.deferred, true);

  const beforePromotion = await pool.query(`
    SELECT work_order.id, work_order.current_ordinary_instance_id,
      count(instance.id)::int AS instance_count
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance ON instance.work_order_id = work_order.id
    WHERE work_order.external_order_number = $1
    GROUP BY work_order.id, work_order.current_ordinary_instance_id`, [orderNumber]);
  assert.equal(beforePromotion.rowCount, 1, 'one order number must keep one primary row');
  assert.equal(beforePromotion.rows[0].instance_count, 3);
  assert.equal(beforePromotion.rows[0].current_ordinary_instance_id, first.instance.id);

  await pool.query(`
    UPDATE work_orders SET status = 'completed', runtime_status = 'completed',
      current_step = 'self-test-complete', completion_state = 'confirmed',
      completion_confirmation_method = 'self-test', completion_confirmed_at = now(), updated_at = now()
    WHERE id = $1`, [first.workOrder.id]);

  const promotedClaim = await repository.claimNext({
    shopId,
    workerId: `ordinary-instance-worker-${suffix}`,
    leaseSeconds: 300,
  });
  assert.equal(promotedClaim.id, first.workOrder.id);
  assert.equal(promotedClaim.current_ordinary_instance_id, deferred.instance.id,
    'claim recovery must promote the earliest deferred instance without another PDD discovery');
  const promotedTiming = await pool.query(`
    SELECT first_discovered_at FROM ordinary_work_order_instances WHERE id = $1`, [deferred.instance.id]);
  assert.equal(
    new Date(promotedClaim.ordinary_first_discovered_at).toISOString(),
    new Date(promotedTiming.rows[0].first_discovered_at).toISOString(),
    'a claimed legacy instance must expose its database first-discovered timestamp to the runner',
  );

  assert.equal(await repository.finishClaimed({
    shopId,
    workOrderId: first.workOrder.id,
    leaseToken: promotedClaim.leaseToken,
    status: 'archived',
    currentStep: 'self-test-second-instance-complete',
    payload: {
      pddResolutionSubmission: {
        status: 'succeeded',
        confirmationMethod: 'detail-completed',
        confirmedAt: new Date().toISOString(),
      },
    },
  }), true);

  const afterPromotion = await pool.query(`
    SELECT work_order.current_ordinary_instance_id,
      jsonb_agg(jsonb_build_object(
        'id', instance.id,
        'platformCaseId', instance.platform_case_id,
        'status', instance.status
      ) ORDER BY instance.first_discovered_at) AS instances
    FROM work_orders work_order
    JOIN ordinary_work_order_instances instance ON instance.work_order_id = work_order.id
    WHERE work_order.id = $1
    GROUP BY work_order.current_ordinary_instance_id`, [first.workOrder.id]);
  assert.equal(afterPromotion.rows[0].current_ordinary_instance_id, nextDeferred.instance.id,
    'finishing a claim must immediately promote the next deferred instance');
  assert.deepEqual(afterPromotion.rows[0].instances.map((instance) => instance.status),
    ['completed', 'archived', 'queued']);

  assert.equal(await repository.transitionWorkOrderByCommand({
    workOrderId: first.workOrder.id,
    shopId,
    ordinaryInstanceId: deferred.instance.id,
    status: 'retry-ready',
    currentStep: 'self-test-stale-command',
  }), null, 'an idle command from an older instance must not change the current instance');
  const currentTransition = await repository.transitionWorkOrderByCommand({
    workOrderId: first.workOrder.id,
    shopId,
    ordinaryInstanceId: nextDeferred.instance.id,
    status: 'retry-ready',
    currentStep: 'self-test-current-command',
  });
  assert.equal(currentTransition?.current_ordinary_instance_id, nextDeferred.instance.id);

  const previousDataBackend = process.env.DATA_BACKEND;
  process.env.DATA_BACKEND = 'postgres';
  const apiBackend = await createDataBackend({});
  try {
    const metricWorkOrderId = crypto.randomUUID();
    const metricInstanceId = crypto.randomUUID();
    const metricPlatformId = `25${Date.now()}07`;
    const metricOrderNumber = `metric-manual-${suffix}`;
    await pool.query(`
      INSERT INTO work_orders
        (id, shop_id, external_order_number, work_order_type, scenario_code, status,
         runtime_status, handling_classification, idempotency_key, current_step,
         completion_state, payload)
      VALUES ($1,$2,$3,'商品少发','product-shortage','paused','manual-review','manual',
        $4,'manual-review-blocked','pending','{}'::jsonb)`, [
      metricWorkOrderId,
      reconciliationShopId,
      metricOrderNumber,
      `metric-manual-${suffix}`,
    ]);
    await pool.query(`
      INSERT INTO ordinary_work_order_instances
        (id, work_order_id, shop_id, platform_case_id, platform_case_key, detail_url,
         work_order_type, scenario_code, identity_status, status, runtime_status,
         current_step, manual_review_reason)
      VALUES ($1,$2,$3,$4,$5,$6,'商品少发','product-shortage','verified','paused',
        'manual-review','manual-review-blocked','self-test program-caused manual handoff')`, [
      metricInstanceId,
      metricWorkOrderId,
      reconciliationShopId,
      metricPlatformId,
      `pdd-work-order:${metricPlatformId}`,
      detailUrl(metricPlatformId),
    ]);
    await pool.query(`
      UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
      metricWorkOrderId,
      metricInstanceId,
    ]);
    await pool.query(`
      INSERT INTO oms_analyses (work_order_id, ordinary_instance_id, payload, source_hash)
      VALUES ($1,$2,jsonb_build_object('warehouseStatus','confirmed'),$3)`, [
      metricWorkOrderId,
      metricInstanceId,
      crypto.createHash('sha256').update(`metric-oms-${suffix}`).digest('hex'),
    ]);
    await pool.query(`
      INSERT INTO tms_work_orders
        (id, work_order_id, ordinary_instance_id, scenario_code, external_ticket_id,
         status, request_hash, payload)
      VALUES ($1,$2,$3,'product-shortage',$4,'created',$5,'{}'::jsonb)`, [
      crypto.randomUUID(),
      metricWorkOrderId,
      metricInstanceId,
      `metric-tms-${suffix}`,
      crypto.createHash('sha256').update(`metric-tms-${suffix}`).digest('hex'),
    ]);
    await pool.query(`
      INSERT INTO manual_interventions
        (id, shop_id, work_order_id, ordinary_instance_id, channel, reason_code,
         reason, risk_level, status, deduplication_key)
      VALUES ($1,$2,$3,$4,'dashboard','ordinary-manual-review',
        'self-test program-caused manual handoff','high','open',$5)`, [
      crypto.randomUUID(),
      reconciliationShopId,
      metricWorkOrderId,
      metricInstanceId,
      `metric-manual-intervention-${suffix}`,
    ]);
    const unpushedManualHandoffMetrics = await apiBackend.metricsSummary({ shopId: reconciliationShopId });
    assert.deepEqual({
      total: Number(unpushedManualHandoffMetrics.total),
      autoSuccess: Number(unpushedManualHandoffMetrics.autoSuccess),
      manualReview: Number(unpushedManualHandoffMetrics.manualReview),
      notSuccessful: Number(unpushedManualHandoffMetrics.notSuccessful),
    }, {
      total: 1,
      autoSuccess: 1,
      manualReview: 1,
      notSuccessful: 0,
    }, 'an unpushed pause must not override relaxed OMS/TMS automation success');

    const metricDingTalkInterventionId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO manual_interventions
        (id, shop_id, work_order_id, ordinary_instance_id, channel, reason_code,
         reason, risk_level, status, deduplication_key)
      VALUES ($1,$2,$3,$4,'dingtalk','ordinary-manual-review',
        'self-test delivered automatic DingTalk handoff','high','open',$5)`, [
      metricDingTalkInterventionId,
      reconciliationShopId,
      metricWorkOrderId,
      metricInstanceId,
      `metric-dingtalk-intervention-${suffix}`,
    ]);
    await pool.query(`
      INSERT INTO notification_outbox
        (id, intervention_id, payload, status)
      VALUES ($1,$2,jsonb_build_object('deliverySource','automatic'),'sent')`, [
      crypto.randomUUID(),
      metricDingTalkInterventionId,
    ]);
    apiBackend._metricsSummaryCache.clear();
    const deliveredManualHandoffMetrics = await apiBackend.metricsSummary({ shopId: reconciliationShopId });
    assert.deepEqual({
      total: Number(deliveredManualHandoffMetrics.total),
      autoSuccess: Number(deliveredManualHandoffMetrics.autoSuccess),
      manualReview: Number(deliveredManualHandoffMetrics.manualReview),
      notSuccessful: Number(deliveredManualHandoffMetrics.notSuccessful),
    }, {
      total: 1,
      autoSuccess: 0,
      manualReview: 1,
      notSuccessful: 1,
    }, 'a delivered automatic DingTalk handoff must count as unsuccessful');

    const eventFor = (name, overrides = {}) => ({
      eventKey: `ordinary-instance-event:${suffix}:${name}`,
      shopId,
      orderNumber,
      workOrderType: 'self-test',
      scenarioCode: 'intercept-recall',
      stage: `self-test-${name}`,
      runtimeStatus: 'processing',
      occurredAt: new Date().toISOString(),
      payload: { snapshot: { marker: name } },
      ...overrides,
    });

    const malformedIdentityResult = await apiBackend.ingestWorkerEvents([
      eventFor('malformed-identity', { ordinaryInstanceId: 'not-a-uuid' }),
    ]);
    assert.deepEqual(malformedIdentityResult.accepted, []);
    assert.deepEqual(malformedIdentityResult.rejected, [{
      eventKey: `ordinary-instance-event:${suffix}:malformed-identity`,
      code: 'ORDINARY_INSTANCE_INVALID',
      orderNumber,
    }], 'a malformed identity event must be rejected without rolling back unrelated events');
    assert.equal((await pool.query(
      'SELECT 1 FROM workflow_events WHERE event_key = $1',
      [`ordinary-instance-event:${suffix}:malformed-identity`],
    )).rowCount, 0, 'a malformed identity event must be rejected atomically');

    const unboundAnalysisMarker = `unbound-${suffix}`;
    await apiBackend.ingestWorkerEvents([
      eventFor('missing-identity', {
        payload: { snapshot: { logisticsAnalysis: { marker: unboundAnalysisMarker } } },
      }),
    ]);
    const unboundEvent = await pool.query(`
      SELECT ordinary_instance_id FROM workflow_events WHERE event_key = $1`,
    [`ordinary-instance-event:${suffix}:missing-identity`]);
    assert.equal(unboundEvent.rows[0]?.ordinary_instance_id, null,
      'an event without identity must not bind to the newly promoted current instance');
    assert.equal((await pool.query(`
      SELECT 1 FROM logistics_analyses
      WHERE work_order_id = $1 AND payload->>'marker' = $2`,
    [first.workOrder.id, unboundAnalysisMarker])).rowCount, 0,
    'an unbound event must not write analysis data into an ordinary work order');
    assert.equal((await pool.query('SELECT 1 FROM workflow_checkpoints WHERE shop_id = $1', [shopId])).rowCount, 0,
      'an unbound event must not replace the shop checkpoint');

    const currentVerificationId = crypto.randomUUID();
    const currentVerificationInterventionId = crypto.randomUUID();
    const currentVerificationOutboxId = crypto.randomUUID();
    const currentBusinessInterventionId = crypto.randomUUID();
    await pool.query(`
      UPDATE work_orders SET
        status = 'retry-ready',
        runtime_status = 'verification',
        current_step = 'human-verification-required',
        next_attempt_at = now() + interval '1 hour',
        payload = jsonb_build_object(
          'step', 'human-verification-required',
          'verificationRecovery', jsonb_build_object('count', 3),
          'updatedAt', now()
        )
      WHERE id = $1`, [first.workOrder.id]);
    await pool.query(`
      UPDATE ordinary_work_order_instances SET
        status = 'retry-ready',
        runtime_status = 'verification',
        current_step = 'human-verification-required',
        next_attempt_at = now() + interval '1 hour'
      WHERE id = $1`, [nextDeferred.instance.id]);
    await pool.query(`
      INSERT INTO verification_locations
        (id, shop_id, work_order_id, ordinary_instance_id, system_name, stage, status,
         url, bounding_box, confidence, detected_at)
      VALUES ($1,$2,$3,$4,'pdd','self-test-verification','waiting-human',
        'https://mms.pinduoduo.com/','{}'::jsonb,'high',now())`, [
      currentVerificationId,
      shopId,
      first.workOrder.id,
      nextDeferred.instance.id,
    ]);
    await pool.query(`
      INSERT INTO manual_interventions
        (id, shop_id, work_order_id, ordinary_instance_id, channel,
         reason_code, reason, risk_level, status, deduplication_key, created_at)
      VALUES
        ($1,$3,$4,$5,'dashboard','verification-required',
          'self-test current verification assistance','medium','open',$6,now() - interval '1 second'),
        ($2,$3,$4,$5,'dashboard','warehouse-out-of-scope',
          'self-test current business intervention','high','open',$7,now() - interval '1 second')`, [
      currentVerificationInterventionId,
      currentBusinessInterventionId,
      shopId,
      first.workOrder.id,
      nextDeferred.instance.id,
      `self-test-event-verification-${suffix}`,
      `self-test-event-business-${suffix}`,
    ]);
    await pool.query(`
      INSERT INTO notification_outbox (id, intervention_id, payload)
      VALUES ($1,$2,jsonb_build_object('selfTest',true))`, [
      currentVerificationOutboxId,
      currentVerificationInterventionId,
    ]);
    const oldAnalysisMarker = `old-${suffix}`;
    await apiBackend.ingestWorkerEvents([
      eventFor('old-instance', {
        ordinaryInstanceId: first.instance.id,
        platformCaseKey: `pdd-work-order:${firstPlatformId}`,
        payload: { snapshot: { logisticsAnalysis: { marker: oldAnalysisMarker } } },
      }),
    ]);
    const oldEvent = await pool.query(`
      SELECT ordinary_instance_id FROM workflow_events WHERE event_key = $1`,
    [`ordinary-instance-event:${suffix}:old-instance`]);
    assert.equal(oldEvent.rows[0]?.ordinary_instance_id, first.instance.id,
      'a late event may only append history to its own older instance');
    assert.equal((await pool.query(`
      SELECT 1 FROM logistics_analyses
      WHERE ordinary_instance_id = $1 AND payload->>'marker' = $2`,
    [first.instance.id, oldAnalysisMarker])).rowCount, 1);
    assert.equal((await pool.query(`
      SELECT status FROM verification_locations WHERE id = $1`, [currentVerificationId])).rows[0]?.status,
    'waiting-human', 'an older instance event must not resolve the current instance verification');
    const stateAfterOldEvent = await pool.query(`
      SELECT current_step, next_attempt_at > now() AS future_retry
      FROM work_orders WHERE id = $1`, [first.workOrder.id]);
    assert.equal(stateAfterOldEvent.rows[0]?.current_step, 'human-verification-required',
      'an older instance event must not resume the current verification wait');
    assert.equal(stateAfterOldEvent.rows[0]?.future_retry, true);
    assert.equal((await pool.query('SELECT 1 FROM workflow_checkpoints WHERE shop_id = $1', [shopId])).rowCount, 0,
      'an older instance event must not replace the current shop checkpoint');

    const currentAnalysisMarker = `current-${suffix}`;
    await apiBackend.ingestWorkerEvents([
      eventFor('current-instance', {
        ordinaryInstanceId: nextDeferred.instance.id,
        platformCaseKey: `pdd-work-order:${thirdPlatformId}`,
        payload: { snapshot: { logisticsAnalysis: { marker: currentAnalysisMarker } } },
      }),
    ]);
    const currentEvent = await pool.query(`
      SELECT ordinary_instance_id FROM workflow_events WHERE event_key = $1`,
    [`ordinary-instance-event:${suffix}:current-instance`]);
    assert.equal(currentEvent.rows[0]?.ordinary_instance_id, nextDeferred.instance.id);
    assert.equal((await pool.query(`
      SELECT 1 FROM logistics_analyses
      WHERE ordinary_instance_id = $1 AND payload->>'marker' = $2`,
    [nextDeferred.instance.id, currentAnalysisMarker])).rowCount, 1);
    assert.equal((await pool.query(`
      SELECT ordinary_instance_id FROM workflow_checkpoints WHERE shop_id = $1`, [shopId])).rows[0]?.ordinary_instance_id,
    nextDeferred.instance.id, 'only the current instance may update the shop checkpoint');
    assert.equal((await pool.query(`
      SELECT status FROM verification_locations WHERE id = $1`, [currentVerificationId])).rows[0]?.status,
    'resolved', 'a current instance event may resolve its own verification');
    const resumedVerification = await pool.query(`
      SELECT work_order.status, work_order.runtime_status, work_order.current_step,
        work_order.next_attempt_at <= now() AS retry_due,
        work_order.payload ? 'verificationLocation' AS has_verification_location,
        work_order.payload ? 'verificationRecovery' AS has_verification_recovery,
        work_order.payload->'verificationRecheck'->>'trigger' AS resume_trigger,
        instance.status AS instance_status,
        instance.current_step AS instance_step,
        instance.next_attempt_at <= now() AS instance_retry_due
      FROM work_orders work_order
      JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE work_order.id = $1`, [first.workOrder.id]);
    assert.equal(resumedVerification.rows[0]?.status, 'retry-ready');
    assert.equal(resumedVerification.rows[0]?.runtime_status, 'retry-ready');
    assert.equal(resumedVerification.rows[0]?.current_step, 'verification-cleared-retry-ready');
    assert.equal(resumedVerification.rows[0]?.retry_due, true,
      'a cleared verification must become immediately claimable instead of keeping its backoff');
    assert.equal(resumedVerification.rows[0]?.has_verification_location, false);
    assert.equal(resumedVerification.rows[0]?.has_verification_recovery, false);
    assert.equal(resumedVerification.rows[0]?.resume_trigger, 'worker-event-verification-cleared');
    assert.equal(resumedVerification.rows[0]?.instance_status, 'retry-ready');
    assert.equal(resumedVerification.rows[0]?.instance_step, 'verification-cleared-retry-ready');
    assert.equal(resumedVerification.rows[0]?.instance_retry_due, true);
    const currentInterventions = await pool.query(`
      SELECT id, status, resolved_by
      FROM manual_interventions
      WHERE id = ANY($1::uuid[])`, [[
      currentVerificationInterventionId,
      currentBusinessInterventionId,
    ]]);
    const resolvedVerificationIntervention = currentInterventions.rows.find(
      (row) => row.id === currentVerificationInterventionId,
    );
    const preservedBusinessIntervention = currentInterventions.rows.find(
      (row) => row.id === currentBusinessInterventionId,
    );
    assert.equal(resolvedVerificationIntervention.status, 'resolved');
    assert.equal(resolvedVerificationIntervention.resolved_by,
      'worker-event-verification-cleared');
    assert.equal(preservedBusinessIntervention.status, 'open',
      'a verification-cleared event must not close a business intervention');
    assert.equal((await pool.query(
      'SELECT status FROM notification_outbox WHERE id = $1',
      [currentVerificationOutboxId],
    )).rows[0]?.status, 'cancelled');

    const persistedScenarioTicketId = `persisted-scenario-${suffix}`;
    await apiBackend.ingestWorkerEvents([
      eventFor('tms-persisted-scenario-fallback', {
        scenarioCode: null,
        ordinaryInstanceId: nextDeferred.instance.id,
        platformCaseKey: `pdd-work-order:${thirdPlatformId}`,
        payload: {
          snapshot: {
            tmsWorkOrder: {
              status: 'created',
              ticketId: persistedScenarioTicketId,
              ticketNo: `L-${suffix}`,
              problemType: '拦截退回',
              customerRemark: 'self-test persisted scenario fallback',
            },
          },
        },
      }),
    ]);
    const persistedScenarioMirror = await pool.query(`
      SELECT scenario_code
      FROM tms_work_orders
      WHERE work_order_id = $1
        AND ordinary_instance_id = $2
        AND external_ticket_id = $3`, [
      first.workOrder.id,
      nextDeferred.instance.id,
      persistedScenarioTicketId,
    ]);
    assert.equal(persistedScenarioMirror.rowCount, 1);
    assert.equal(persistedScenarioMirror.rows[0].scenario_code, 'intercept-recall',
      'a TMS worker event without a scenario must reuse its bound ordinary instance scenario');
    assert.equal((await pool.query(`
      SELECT 1 FROM tms_work_orders
      WHERE work_order_id = $1
        AND ordinary_instance_id = $2
        AND external_ticket_id = $3
        AND scenario_code = 'unknown'`, [
      first.workOrder.id,
      nextDeferred.instance.id,
      persistedScenarioTicketId,
    ])).rowCount, 0, 'a known persisted scenario must never create an unknown TMS mirror');

    const causalityInterventionId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO manual_interventions
        (id, shop_id, work_order_id, ordinary_instance_id, channel,
         reason_code, reason, risk_level, status, deduplication_key, created_at)
      VALUES ($1,$2,$3,$4,'dashboard','self-test-event-causality',
        'new intervention must survive an older event','medium','open',$5,now())`, [
      causalityInterventionId,
      shopId,
      first.workOrder.id,
      nextDeferred.instance.id,
      `self-test-event-causality:${suffix}`,
    ]);
    await apiBackend.ingestWorkerEvents([
      eventFor('older-completed-event', {
        ordinaryInstanceId: nextDeferred.instance.id,
        platformCaseKey: `pdd-work-order:${thirdPlatformId}`,
        runtimeStatus: 'completed',
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    const afterOlderEvent = await pool.query(`
      SELECT status, resolved_at FROM manual_interventions WHERE id = $1`,
    [causalityInterventionId]);
    assert.equal(afterOlderEvent.rows[0]?.status, 'open',
      'an older completed event must not resolve an intervention created later');
    assert.equal(afterOlderEvent.rows[0]?.resolved_at, null);

    await apiBackend.ingestWorkerEvents([
      eventFor('newer-completed-event', {
        ordinaryInstanceId: nextDeferred.instance.id,
        platformCaseKey: `pdd-work-order:${thirdPlatformId}`,
        runtimeStatus: 'completed',
        occurredAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    ]);
    const afterNewerEvent = await pool.query(`
      SELECT status, resolved_at >= created_at AS causal_resolution
      FROM manual_interventions WHERE id = $1`,
    [causalityInterventionId]);
    assert.equal(afterNewerEvent.rows[0]?.status, 'resolved',
      'a completed event after intervention creation may resolve it');
    assert.equal(afterNewerEvent.rows[0]?.causal_resolution, true);
  } finally {
    await apiBackend.close();
    if (previousDataBackend === undefined) delete process.env.DATA_BACKEND;
    else process.env.DATA_BACKEND = previousDataBackend;
  }

  await assert.rejects(repository.reserveExternalEffect({
    shopId,
    workOrderId: first.workOrder.id,
    effectType: 'pdd-note',
    idempotencyKey: `instance-effect-missing-identity:${suffix}`,
    requestHash: crypto.createHash('sha256').update(`missing-${suffix}`).digest('hex'),
  }), /external-effect-current-instance-mismatch/u);
  const guardedEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: first.workOrder.id,
    effectType: 'pdd-note',
    idempotencyKey: `instance-effect:${nextDeferred.instance.id}:${suffix}`,
    requestHash: crypto.createHash('sha256').update(`guarded-${suffix}`).digest('hex'),
    ordinaryInstanceId: nextDeferred.instance.id,
    platformCaseKey: `pdd-work-order:${thirdPlatformId}`,
  });
  assert.equal(guardedEffect.reserved, true);
  assert.equal(await repository.completeExternalEffect({
    id: guardedEffect.effect.id,
    status: 'succeeded',
  }), null, 'an instance effect cannot be completed without its instance identity');
  assert.equal((await repository.completeExternalEffect({
    id: guardedEffect.effect.id,
    status: 'succeeded',
    ordinaryInstanceId: nextDeferred.instance.id,
    receipt: { selfTest: true },
  }))?.status, 'succeeded');

  const finalClaim = await repository.claimNext({
    shopId,
    workerId: `ordinary-instance-worker-${suffix}`,
    leaseSeconds: 300,
  });
  assert.equal(finalClaim?.current_ordinary_instance_id, nextDeferred.instance.id);
  assert.equal(finalClaim?.platform_work_order_id, thirdPlatformId);
  assert.equal(finalClaim?.platform_case_key, `pdd-work-order:${thirdPlatformId}`);
  assert.equal(finalClaim?.has_unresolved_external_effects, false);
  await assert.rejects(repository.reconcileCompleted({
    shopId,
    externalOrderNumber: orderNumber,
    currentStep: 'self-test-stale-completion',
    payload: { completionArchive: { orderNumber } },
  }), /reconcile-completed-ordinary-instance-mismatch/u);
  const completionGuard = await repository.reserveExternalEffect({
    shopId,
    workOrderId: first.workOrder.id,
    effectType: 'pdd-note',
    idempotencyKey: `instance-completion-guard:${nextDeferred.instance.id}:${suffix}`,
    requestHash: crypto.createHash('sha256').update(`completion-guard-${suffix}`).digest('hex'),
    ordinaryInstanceId: nextDeferred.instance.id,
    platformCaseKey: `pdd-work-order:${thirdPlatformId}`,
  });
  const exactInstanceCompletion = {
    lastCompletedOrder: {
      orderNumber,
      ordinaryInstanceId: nextDeferred.instance.id,
      outcome: 'self-test-completed',
      confirmationMethod: 'detail-completed',
      completedAt: new Date().toISOString(),
    },
  };
  await assert.rejects(repository.reconcileCompleted({
    shopId,
    externalOrderNumber: orderNumber,
    ordinaryInstanceId: nextDeferred.instance.id,
    currentStep: 'self-test-unresolved-effect-completion',
    payload: exactInstanceCompletion,
  }), /reconcile-completed-ordinary-instance-mismatch/u);
  assert.equal((await repository.completeExternalEffect({
    id: completionGuard.effect.id,
    status: 'failed',
    ordinaryInstanceId: nextDeferred.instance.id,
  }))?.status, 'failed');
  assert.equal(await repository.reconcileCompleted({
    shopId,
    externalOrderNumber: orderNumber,
    ordinaryInstanceId: nextDeferred.instance.id,
    currentStep: 'self-test-exact-instance-completion-recovered',
    payload: exactInstanceCompletion,
  }), true);
  const exactInstanceRecovery = await pool.query(`
    SELECT payload->'lastCompletedOrder'->>'platformCaseKey' AS platform_case_key,
      payload->'completionIdentityRecovery'->>'source' AS recovery_source
    FROM work_orders WHERE id = $1`, [first.workOrder.id]);
  assert.equal(exactInstanceRecovery.rows[0].platform_case_key, `pdd-work-order:${thirdPlatformId}`);
  assert.equal(exactInstanceRecovery.rows[0].recovery_source, 'exact-instance-completion-marker');

  const reconciliationInstance = await repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: orderNumber,
    workOrderType: '物流异常主动服务',
    scenarioCode: 'proactive-logistics-service',
    payload: { detailUrl: detailUrl(fourthPlatformId), detectedShopName: shopName },
  });
  assert.equal(reconciliationInstance.reopened, true);
  const uncertainEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: first.workOrder.id,
    effectType: 'pdd-note',
    idempotencyKey: `instance-reconciliation:${reconciliationInstance.instance.id}:${suffix}`,
    requestHash: crypto.createHash('sha256').update(`reconciliation-${suffix}`).digest('hex'),
    ordinaryInstanceId: reconciliationInstance.instance.id,
    platformCaseKey: `pdd-work-order:${fourthPlatformId}`,
  });
  assert.equal((await repository.completeExternalEffect({
    id: uncertainEffect.effect.id,
    status: 'unknown',
    ordinaryInstanceId: reconciliationInstance.instance.id,
  }))?.status, 'unknown');
  await pool.query(`UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
    current_step = 'external-state-unresolved', recovery_state = 'ready',
    recovery_reason = NULL, recovery_updated_at = now(), updated_at = now()
    WHERE id = $1`, [first.workOrder.id]);
  const reconciliationClaim = await repository.claimNextExternalStateReconciliation({ shopId });
  assert.equal(reconciliationClaim?.current_ordinary_instance_id, reconciliationInstance.instance.id);
  assert.equal(await repository.checkpointExternalStateReconciliation({
    workOrderId: first.workOrder.id,
    shopId,
    ordinaryInstanceId: nextDeferred.instance.id,
    currentStep: 'self-test-stale-reconciliation-checkpoint',
  }), false);
  assert.equal(await repository.completeExternalStateReconciliation({
    workOrderId: first.workOrder.id,
    shopId,
    ordinaryInstanceId: nextDeferred.instance.id,
    observation: { state: 'not-applied', effectType: 'pdd-note' },
  }), null);
  const completedReconciliation = await repository.completeExternalStateReconciliation({
    workOrderId: first.workOrder.id,
    shopId,
    ordinaryInstanceId: reconciliationInstance.instance.id,
    observation: { state: 'not-applied', effectType: 'pdd-note' },
    payload: { externalStateReconciliation: { state: 'not-applied', effectType: 'pdd-note' } },
  });
  assert.equal(completedReconciliation?.current_ordinary_instance_id, reconciliationInstance.instance.id);
  assert.equal(completedReconciliation?.status, 'retry-ready');

  const legacyCompletionClaim = await repository.claimNext({
    shopId,
    workerId: `ordinary-instance-legacy-completion-${suffix}`,
    leaseSeconds: 300,
  });
  assert.equal(legacyCompletionClaim?.current_ordinary_instance_id, reconciliationInstance.instance.id);
  assert.equal(legacyCompletionClaim?.platform_work_order_id, fourthPlatformId);
  assert.equal(legacyCompletionClaim?.platform_case_key, `pdd-work-order:${fourthPlatformId}`);
  const legacyCompletionEffect = await repository.reserveExternalEffect({
    shopId,
    workOrderId: first.workOrder.id,
    effectType: 'pdd-submit',
    idempotencyKey: `instance-legacy-completion:${reconciliationInstance.instance.id}:${suffix}`,
    requestHash: crypto.createHash('sha256').update(`legacy-completion-${suffix}`).digest('hex'),
    ordinaryInstanceId: reconciliationInstance.instance.id,
    platformCaseKey: `pdd-work-order:${fourthPlatformId}`,
  });
  assert.equal((await repository.completeExternalEffect({
    id: legacyCompletionEffect.effect.id,
    status: 'succeeded',
    ordinaryInstanceId: reconciliationInstance.instance.id,
  }))?.status, 'succeeded');
  assert.equal(await repository.reconcileCompleted({
    shopId,
    externalOrderNumber: orderNumber,
    currentStep: 'self-test-legacy-identity-recovered',
    payload: {
      lastCompletedOrder: {
        orderNumber,
        confirmationMethod: 'detail-completed',
        completedAt: new Date().toISOString(),
      },
    },
  }), true, 'a legacy completion may recover only from a succeeded submit effect on the current instance');
  const recoveredCompletion = await pool.query(`
    SELECT payload->>'ordinaryInstanceId' AS instance_id,
      payload->'lastCompletedOrder'->>'platformCaseKey' AS platform_case_key
    FROM work_orders WHERE id = $1`, [first.workOrder.id]);
  assert.equal(recoveredCompletion.rows[0].instance_id, reconciliationInstance.instance.id);
  assert.equal(recoveredCompletion.rows[0].platform_case_key, `pdd-work-order:${fourthPlatformId}`);

  await assert.rejects(repository.enqueueDiscovered({
    shopId,
    externalOrderNumber: `different-order-${suffix}`,
    workOrderType: '物流异常主动服务',
    scenarioCode: 'proactive-logistics-service',
    payload: { detailUrl: detailUrl(secondPlatformId), detectedShopName: shopName },
  }), (error) => error?.code === 'PDD_PLATFORM_CASE_ORDER_MISMATCH');

  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload)
    VALUES ($1,$2,$3,'self-test','delivery-risk-concern','queued','queued',$4,'self-test','{}'::jsonb)`, [
    otherWorkOrderId,
    shopId,
    `ownership-order-${suffix}`,
    `ownership-key-${suffix}`,
  ]);
  await assert.rejects(
    pool.query('UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1', [otherWorkOrderId, first.instance.id]),
    (error) => error?.code === '23514',
  );
  await assert.rejects(
    pool.query(`INSERT INTO audit_events
      (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
      VALUES ($1,$2,$3,'self-test','invalid-instance-owner','{}'::jsonb)`, [shopId, otherWorkOrderId, first.instance.id]),
    (error) => error?.code === '23514',
  );
  await assert.rejects(
    pool.query(`INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key, detail_url,
       work_order_type, scenario_code, identity_status, status, runtime_status)
      VALUES ($1,$2,$3,$4,$5,$6,'self-test','delivery-risk-concern',
        'verified','queued','queued')`, [
      crypto.randomUUID(), otherWorkOrderId, shopId, invalidPlatformId,
      `pdd-work-order:${invalidPlatformId}`,
      `https://example.test/aftersales/work_order/tododetail?id=${invalidPlatformId}`,
    ]),
    (error) => error?.code === '23514',
  );
  await assert.rejects(
    pool.query('UPDATE work_orders SET shop_id = $2 WHERE id = $1', [first.workOrder.id, otherShopId]),
    (error) => error?.code === '23514',
  );

  const tmsRequestHash = crypto.createHash('sha256').update(`tms-${suffix}`).digest('hex');
  for (const status of ['created', 'reused']) {
    await pool.query(`
      INSERT INTO tms_work_orders
        (id, work_order_id, ordinary_instance_id, scenario_code,
         external_ticket_id, status, request_hash, payload)
      VALUES ($1,$2,$3,'intercept-recall',$4,$5,$6,$7::jsonb)
      ON CONFLICT (
        work_order_id,
        coalesce(ordinary_instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
        scenario_code,
        request_hash
      ) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload`, [
      crypto.randomUUID(), first.workOrder.id, deferred.instance.id,
      `tms-${suffix}`, status, tmsRequestHash, JSON.stringify({ status }),
    ]);
  }
  const tmsRows = await pool.query(`
    SELECT status, payload FROM tms_work_orders
    WHERE work_order_id = $1 AND ordinary_instance_id = $2`, [first.workOrder.id, deferred.instance.id]);
  assert.equal(tmsRows.rowCount, 1, 'the expression ON CONFLICT target must match the instance unique index');
  assert.deepEqual(tmsRows.rows[0], { status: 'reused', payload: { status: 'reused' } });

  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
       idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,$4,'pdd-submit',$5,'unknown',$6)`, [
    crypto.randomUUID(), shopId, first.workOrder.id, first.instance.id,
    `old-instance-effect-${suffix}`,
    crypto.createHash('sha256').update(suffix).digest('hex'),
  ]);
  const reconciliation = await repository.getWorkOrderForReconciliation({
    workOrderId: first.workOrder.id,
    shopId,
  });
  assert.deepEqual(reconciliation.unknown_effect_types, [], 'an old instance effect must not block the current instance');

  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code,
       status, runtime_status, idempotency_key, current_step, payload,
       manual_review_reason, completion_state, frontend_visibility, recovery_state,
       recovery_reason, recovery_updated_at, created_at, updated_at)
    VALUES
      ($1,$2,$3,'fixture','intercept-recall','paused','paused',$4,
       'external-state-unresolved',$5::jsonb,$6,'pending','operational','held',
       'external-state-reconciliation-retry-pending',now() - interval '11 minutes',
       now() - interval '20 days',now() - interval '11 minutes')`, [
    oldRecoveredWorkOrderId,
    reconciliationShopId,
    `old-recovered-${suffix}`,
    `fixture:old-recovered:${suffix}`,
    JSON.stringify({ externalStateReconciliationRetry: { attempts: 0, maxAttempts: 3 } }),
    'legacy PDD submit state requires read-only reconciliation',
  ]);
  await pool.query(`
    INSERT INTO ordinary_work_order_instances
      (id, work_order_id, shop_id, platform_case_id, platform_case_key, detail_url,
       work_order_type, scenario_code, identity_status, status, runtime_status,
       current_step, payload, manual_review_reason)
    VALUES
      ($1,$2,$3,$4,$5,$6,'fixture','intercept-recall','verified','paused','paused',
       'external-state-unresolved',$7::jsonb,$8)`, [
    oldRecoveredInstanceId,
    oldRecoveredWorkOrderId,
    reconciliationShopId,
    oldRecoveredPlatformId,
    `pdd-work-order:${oldRecoveredPlatformId}`,
    detailUrl(oldRecoveredPlatformId),
    JSON.stringify({ externalStateReconciliationRetry: { attempts: 0, maxAttempts: 3 } }),
    'legacy PDD submit state requires read-only reconciliation',
  ]);
  await pool.query(`
    UPDATE work_orders SET current_ordinary_instance_id = $2 WHERE id = $1`, [
    oldRecoveredWorkOrderId,
    oldRecoveredInstanceId,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, ordinary_instance_id, effect_type,
       idempotency_key, status, request_hash, receipt)
    VALUES
      ($1,$2,$3,$4,'pdd-submit',$5,'failed',$6,
       jsonb_build_object('clickAttempted',true,'fixture',true))`, [
    crypto.randomUUID(),
    reconciliationShopId,
    oldRecoveredWorkOrderId,
    oldRecoveredInstanceId,
    `old-recovered-submit-${suffix}`,
    crypto.createHash('sha256').update(`old-recovered-${suffix}`).digest('hex'),
  ]);
  const oldRecoveredClaim = await repository.claimNextExternalStateReconciliation({
    shopId: reconciliationShopId,
    retryAfterMs: 600_000,
    retryWindowMs: 172_800_000,
    maxAttempts: 3,
  });
  assert.equal(oldRecoveredClaim?.id, oldRecoveredWorkOrderId,
    'an old work order with a recent recovery timestamp must enter read-only reconciliation');
  assert.equal(oldRecoveredClaim?.current_step, 'external-state-reconciling');
  assert.equal(oldRecoveredClaim?.recovery_state, 'reconciling');

  console.log('ordinary work-order instance PostgreSQL self-test passed');
} finally {
  try {
    await pool.query(`DELETE FROM notification_deliveries WHERE outbox_id IN (
      SELECT outbox.id FROM notification_outbox outbox
      JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id
      WHERE intervention.shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query(`DELETE FROM notification_outbox WHERE intervention_id IN (
      SELECT id FROM manual_interventions WHERE shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query('DELETE FROM verification_locations WHERE shop_id = $1', [shopId]).catch(() => {});
    await pool.query(`DELETE FROM tms_work_orders
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query(`DELETE FROM tms_work_orders
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [reconciliationShopId]).catch(() => {});
    await pool.query('DELETE FROM audit_events WHERE shop_id = ANY($1::text[])', [
      [shopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query('DELETE FROM external_effects WHERE shop_id = $1', [shopId]).catch(() => {});
    await pool.query('DELETE FROM external_effects WHERE shop_id = $1', [reconciliationShopId]).catch(() => {});
    await pool.query('DELETE FROM workflow_events WHERE shop_id = ANY($1::text[])', [
      [shopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query('DELETE FROM workflow_checkpoints WHERE shop_id = ANY($1::text[])', [
      [shopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query(`DELETE FROM classification_history
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query(`DELETE FROM data_corrections
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query(`DELETE FROM logistics_analyses
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query(`DELETE FROM oms_analyses
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query(`DELETE FROM oms_analyses
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [reconciliationShopId]).catch(() => {});
    await pool.query('DELETE FROM operator_commands WHERE shop_id = $1', [shopId]).catch(() => {});
    await pool.query('DELETE FROM manual_interventions WHERE shop_id = $1', [shopId]).catch(() => {});
    await pool.query('DELETE FROM manual_interventions WHERE shop_id = $1', [reconciliationShopId]).catch(() => {});
    await pool.query(`DELETE FROM workflow_runs
      WHERE work_order_id IN (SELECT id FROM work_orders WHERE shop_id = $1)`, [shopId]).catch(() => {});
    await pool.query('DELETE FROM evidence_assets WHERE shop_id = $1', [shopId]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE shop_id = $1', [shopId]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE shop_id = $1', [reconciliationShopId]).catch(() => {});
    await pool.query('DELETE FROM shop_runtime_state WHERE shop_id = ANY($1::text[])', [
      [shopId, otherShopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query('DELETE FROM shop_schedule_state WHERE shop_id = $1', [shopId]).catch(() => {});
    await pool.query('DELETE FROM worker_heartbeats WHERE shop_id = ANY($1::text[])', [
      [shopId, otherShopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query('DELETE FROM sync_cursors WHERE shop_id = ANY($1::text[])', [
      [shopId, otherShopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query('DELETE FROM shop_identity_bindings WHERE shop_id = ANY($1::text[])', [
      [shopId, otherShopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = ANY($1::text[])', [
      [shopId, otherShopId, reconciliationShopId],
    ]).catch(() => {});
    await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
    await pool.query('DELETE FROM shops WHERE id = $1', [otherShopId]).catch(() => {});
    await pool.query('DELETE FROM shops WHERE id = $1', [reconciliationShopId]).catch(() => {});
  } finally {
    await pool.end().catch(() => {});
  }
}
