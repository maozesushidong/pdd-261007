import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresPool } from '../packages/adapters/src/postgres/index.mjs';
import { schedulerConfigFromEnv } from '../apps/worker/src/scheduler-policy.mjs';
import { ShopSchedulerRepository } from '../apps/worker/src/scheduler-repository.mjs';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = await createPostgresPool(undefined, { max: 12, applicationName: 'scheduler-self-test' });
const prefix = `scheduler-test-${crypto.randomUUID().slice(0, 8)}`;
const shopIds = Array.from({ length: 100 }, (_, index) => `${prefix}-${String(index).padStart(3, '0')}`);
const verificationIds = [];
const refundExecutionWorkOrderId = crypto.randomUUID();
const activeRuntimeWorkOrderId = crypto.randomUUID();
const heldOrdinaryWorkOrderId = crypto.randomUUID();
const identityBlockedWorkOrderId = crypto.randomUUID();
const schedulerBindingToken = crypto.randomUUID();
const schedulerBindingIdentityKey = `${prefix}-identity`;
const config = { ...schedulerConfigFromEnv(), hardSlotLimit: 100, launchIntervalMs: 1 };
const repositories = Array.from({ length: 8 }, (_, index) => new ShopSchedulerRepository(pool, {
  config,
  supervisorId: `scheduler-self-test-${index}`,
}));

try {
  const schema = await pool.query(`
    SELECT to_regclass('shop_schedule_state') AS schedule,
      to_regclass('browser_slots') AS slots`);
  assert.equal(schema.rows[0].schedule, 'shop_schedule_state');
  assert.equal(schema.rows[0].slots, 'browser_slots');

  const available = await pool.query(`
    SELECT candidate.slot
    FROM generate_series(700, 999) candidate(slot)
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = candidate.slot)
    ORDER BY candidate.slot LIMIT 100`);
  assert.equal(available.rowCount, 100, '100 free display slots are required for the isolated test');

  for (let index = 0; index < shopIds.length; index += 1) {
    await pool.query(`
      INSERT INTO shops (
        id, name, enabled, expected_shop_name, onboarding_status, display_slot
      ) VALUES ($1,$2,true,$2,'ready',$3)`,
    [shopIds[index], `${prefix}-name-${index}`, available.rows[index].slot]);
  }
  await pool.query(`
    UPDATE shop_schedule_state SET next_ordinary_scan_at = now() - interval '1 minute',
      next_refund_scan_at = now() + interval '1 day', queue_entered_at = now() - interval '1 hour'
    WHERE shop_id = ANY($1::text[])`, [shopIds]);

  const legacyRetryShopId = shopIds.at(-1);
  await pool.query(`
    UPDATE shop_schedule_state SET retry_at = now() + interval '1 hour',
      failure_count = 3, last_failure = 'legacy-runner-backoff'
    WHERE shop_id = $1`, [legacyRetryShopId]);
  await repositories[0].initialize();
  const clearedLegacyRetry = await pool.query(`
    SELECT retry_at, failure_count, last_failure
    FROM shop_schedule_state WHERE shop_id = $1`, [legacyRetryShopId]);
  assert.equal(clearedLegacyRetry.rows[0].retry_at, null,
    'scheduler startup must remove retry delays left by older versions');
  assert.equal(Number(clearedLegacyRetry.rows[0].failure_count), 3,
    'removing a retry delay must retain diagnostic failure count');
  assert.equal(clearedLegacyRetry.rows[0].last_failure, 'legacy-runner-backoff',
    'removing a retry delay must retain the diagnostic failure reason');

  const peek = await repositories[0].peek({
    limit: 100,
    shopIds,
    allowedKinds: ['ordinary'],
  });
  assert.equal(peek.length, 100);

  const assignments = (await Promise.all(repositories.map((repository) => repository.claim({
    shopIds,
    allowedKinds: ['ordinary'],
  })))).filter(Boolean);
  assert.equal(assignments.length, 8);
  assert.equal(new Set(assignments.map((assignment) => assignment.shopId)).size, 8,
    'SKIP LOCKED must prevent two supervisors from claiming one shop');
  assert.equal(new Set(assignments.map((assignment) => assignment.slotIndex)).size, 8);

  const residentLeaseBefore = assignments[1].leaseExpiresAt.getTime();
  assert.equal(await repositories[1].heartbeat({
    slotId: assignments[1].slotId,
    leaseToken: assignments[1].leaseToken,
    leaseExtensionMs: 60 * 60_000,
  }), true);
  const residentLease = await pool.query(`
    SELECT slot.lease_expires_at AS slot_lease, schedule.assignment_expires_at AS schedule_lease
    FROM browser_slots slot
    JOIN shop_schedule_state schedule ON schedule.assigned_slot_id = slot.id
    WHERE slot.id = $1`, [assignments[1].slotId]);
  assert.ok(new Date(residentLease.rows[0].slot_lease).getTime() > residentLeaseBefore,
    'resident business heartbeat must extend the browser-slot lease');
  assert.equal(
    new Date(residentLease.rows[0].slot_lease).getTime(),
    new Date(residentLease.rows[0].schedule_lease).getTime(),
  );

  const originalLease = assignments[0].leaseExpiresAt.getTime();
  assert.equal(await repositories[0].heartbeat({
    slotId: assignments[0].slotId,
    leaseToken: assignments[0].leaseToken,
    externalEffectActive: true,
  }), true);
  const extendedLease = await pool.query(`
    SELECT slot.lease_expires_at AS slot_lease, schedule.assignment_expires_at AS schedule_lease
    FROM browser_slots slot
    JOIN shop_schedule_state schedule ON schedule.assigned_slot_id = slot.id
    WHERE slot.id = $1`, [assignments[0].slotId]);
  assert.ok(new Date(extendedLease.rows[0].slot_lease).getTime() >= originalLease);
  assert.equal(
    new Date(extendedLease.rows[0].slot_lease).getTime(),
    new Date(extendedLease.rows[0].schedule_lease).getTime(),
  );

  assert.deepEqual(
    await repositories[0].recoverOrphanedAssignments([assignments[0].slotId]),
    [],
    'an external operation must fence orphan recovery',
  );
  assert.equal(await repositories[0].heartbeat({
    slotId: assignments[0].slotId,
    leaseToken: assignments[0].leaseToken,
    externalEffectActive: false,
  }), true);
  const recovered = await repositories[0].recoverOrphanedAssignments([assignments[0].slotId]);
  assert.equal(recovered.length, 1, 'an inactive orphaned slot must return to the queue immediately');

  const waitingLoginShopId = (await pool.query(`
    SELECT shop_id FROM shop_schedule_state
    WHERE shop_id = ANY($1::text[]) AND assigned_slot_id IS NULL
    ORDER BY shop_id LIMIT 1`, [shopIds])).rows[0].shop_id;
  await pool.query(`
    UPDATE shops SET onboarding_status = 'waiting-login',
      login_requested_at = date_trunc('milliseconds', now()) + interval '0.000939 seconds'
    WHERE id = $1`, [waitingLoginShopId]);
  await pool.query(`
    UPDATE shop_schedule_state schedule SET
      last_login_request_at = date_trunc('milliseconds', shop.login_requested_at),
      next_ordinary_scan_at = now() - interval '1 hour',
      next_refund_scan_at = now() - interval '1 hour',
      metadata = metadata - 'manualSessionKind'
    FROM shops shop WHERE schedule.shop_id = shop.id AND schedule.shop_id = $1`, [waitingLoginShopId]);
  const residentLoginCandidates = await repositories[0].peek({
    limit: 10,
    shopIds: [waitingLoginShopId],
    allowedKinds: ['login'],
  });
  assert.equal(residentLoginCandidates.length, 1,
    'a resident waiting-login shop must reopen automatically after restart');
  const loginAssignment = await repositories[0].claim({
    shopIds: [waitingLoginShopId],
    allowedKinds: ['login'],
  });
  assert.equal(loginAssignment.assignmentKind, 'login');
  const exactLoginRequest = await pool.query(`
    SELECT shop.login_requested_at = schedule.last_login_request_at AS exact
    FROM shops shop JOIN shop_schedule_state schedule ON schedule.shop_id = shop.id
    WHERE shop.id = $1`, [waitingLoginShopId]);
  assert.equal(exactLoginRequest.rows[0].exact, true,
    'claiming a login slot must retain the database timestamp without losing microseconds');
  assert.equal(await repositories[0].transitionResidentSlot({
    shopId: waitingLoginShopId,
    slotId: loginAssignment.slotId,
    leaseToken: loginAssignment.leaseToken,
    slotKind: 'business',
    assignmentKind: 'ordinary',
  }), true, 'the same resident slot must switch from login to business');
  const transitionedSlot = await pool.query(`
    SELECT slot.kind, schedule.schedule_state, schedule.assignment_kind
    FROM browser_slots slot
    JOIN shop_schedule_state schedule ON schedule.assigned_slot_id = slot.id
    WHERE slot.id = $1`, [loginAssignment.slotId]);
  assert.deepEqual(transitionedSlot.rows[0], {
    kind: 'business',
    schedule_state: 'running',
    assignment_kind: 'ordinary',
  });
  const ordinaryScan = await repositories[0].recordOrdinaryScan({
    shopId: waitingLoginShopId,
    leaseToken: loginAssignment.leaseToken,
    outcome: 'verification-required',
  });
  assert.equal(ordinaryScan.shop_id, waitingLoginShopId);
  const recordedOrdinaryScan = await pool.query(`
    SELECT last_ordinary_scan_at IS NOT NULL AS recorded,
      extract(epoch FROM (next_ordinary_scan_at - last_ordinary_scan_at))::int AS retry_seconds,
      metadata->>'lastOrdinaryScanOutcome' AS outcome
    FROM shop_schedule_state WHERE shop_id = $1`, [waitingLoginShopId]);
  assert.equal(recordedOrdinaryScan.rows[0].recorded, true);
  assert.equal(recordedOrdinaryScan.rows[0].retry_seconds, 600);
  assert.equal(recordedOrdinaryScan.rows[0].outcome, 'verification-required');
  const discoveredScan = await repositories[0].recordOrdinaryScan({
    shopId: waitingLoginShopId,
    leaseToken: loginAssignment.leaseToken,
    outcome: 'discovered',
  });
  assert.equal(discoveredScan.shop_id, waitingLoginShopId);
  const recordedDiscoveredScan = await pool.query(`
    SELECT next_ordinary_scan_at IS NOT NULL AS scheduled,
      extract(epoch FROM (next_ordinary_scan_at - last_ordinary_scan_at))::int AS retry_seconds,
      metadata->>'lastOrdinaryScanOutcome' AS outcome
    FROM shop_schedule_state WHERE shop_id = $1`, [waitingLoginShopId]);
  assert.equal(recordedDiscoveredScan.rows[0].scheduled, true);
  assert.equal(recordedDiscoveredScan.rows[0].retry_seconds, Math.round(config.hotOrdinaryIntervalMs / 1000));
  assert.equal(recordedDiscoveredScan.rows[0].outcome, 'discovered');
  await repositories[0].complete({ assignment: loginAssignment, exitCode: 0 });
  await pool.query("UPDATE shops SET onboarding_status = 'ready' WHERE id = $1", [waitingLoginShopId]);

  await Promise.all(assignments.slice(1).map((assignment, index) => repositories[index + 1].complete({
    assignment,
    exitCode: 0,
  })));

  const verificationShopIds = shopIds.slice(10, 15);
  for (const verificationShopId of verificationShopIds) {
    const verificationId = crypto.randomUUID();
    verificationIds.push(verificationId);
    await pool.query(`
      INSERT INTO verification_locations (
        id, shop_id, system_name, stage, status, url, bounding_box, confidence, detected_at
      ) VALUES ($1,$2,'pdd','scheduler-test','waiting-human',$3,'{}'::jsonb,'high',now())`, [
      verificationId,
      verificationShopId,
      `https://example.test/verification/${verificationShopId}`,
    ]);
  }
  await pool.query(`
    UPDATE shop_schedule_state SET next_ordinary_scan_at = now() + interval '1 day',
      next_refund_scan_at = now() + interval '1 day', retry_at = NULL,
      queue_entered_at = now() - interval '1 hour'
    WHERE shop_id = ANY($1::text[])`, [verificationShopIds]);

  const residentVerificationRepository = new ShopSchedulerRepository(pool, {
    config: { ...config, capacityMode: 'unbounded', keepEnabledShopsResident: true },
    supervisorId: 'scheduler-self-test-resident-verification',
  });
  const verificationAssignments = [];
  for (let index = 0; index < verificationShopIds.length; index += 1) {
    const assignment = await residentVerificationRepository.claim({
      shopIds: verificationShopIds,
      allowedKinds: residentVerificationRepository.allowedKinds({
        verificationSlots: index,
        loginSlots: 0,
      }),
    });
    assert.equal(assignment?.assignmentKind, 'verification');
    verificationAssignments.push(assignment);
  }
  assert.equal(new Set(verificationAssignments.map((assignment) => assignment.shopId)).size, 5,
    'unbounded resident mode must assign browsers to all five verification shops');

  const resourceVerificationRepository = new ShopSchedulerRepository(pool, {
    config: { ...config, capacityMode: 'resource', keepEnabledShopsResident: false, verificationSlots: 1 },
    supervisorId: 'scheduler-self-test-resource-verification',
  });
  const resourceCandidates = await resourceVerificationRepository.peek({
    shopIds: verificationShopIds,
    allowedKinds: resourceVerificationRepository.allowedKinds({ verificationSlots: 1, loginSlots: 0 }),
  });
  assert.equal(resourceCandidates.length, 0,
    'resource mode must not admit another verification browser after its single slot is occupied');
  await Promise.all(verificationAssignments.map((assignment) => residentVerificationRepository.complete({
    assignment,
    exitCode: 0,
  })));

  const refundShopId = (await pool.query(`
    SELECT schedule.shop_id
    FROM shop_schedule_state schedule
    JOIN shops shop ON shop.id = schedule.shop_id
    WHERE schedule.shop_id = ANY($1::text[])
      AND schedule.assigned_slot_id IS NULL
      AND shop.login_requested_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM verification_locations verification
        WHERE verification.shop_id = schedule.shop_id
          AND verification.status IN ('detected','waiting-human','verification-required')
      )
    ORDER BY schedule.shop_id LIMIT 1`, [shopIds])).rows[0].shop_id;
  const transientRepository = new ShopSchedulerRepository(pool, {
    config: { ...config, keepEnabledShopsResident: false },
    supervisorId: 'scheduler-self-test-transient',
  });
  await pool.query(`
    INSERT INTO work_orders (
      id, shop_id, external_order_number, work_order_type, scenario_code,
      status, runtime_status, idempotency_key, current_step, payload
    ) VALUES ($1,$2,$3,'ordinary','in-transit-refund','processing','processing',$4,
      'scheduler-active-runtime-test','{}'::jsonb)`, [
    activeRuntimeWorkOrderId,
    refundShopId,
    `active-runtime-${prefix}`,
    `active-runtime-key-${prefix}`,
  ]);
  await pool.query(`
    INSERT INTO shop_runtime_state (
      shop_id, worker_id, status, lease_token, lease_expires_at, current_work_order_id
    ) VALUES ($1,$2,'processing',$3,now() + interval '5 minutes',$4)
    ON CONFLICT (shop_id) DO UPDATE SET
      worker_id = EXCLUDED.worker_id, status = EXCLUDED.status,
      lease_token = EXCLUDED.lease_token, lease_expires_at = EXCLUDED.lease_expires_at,
      current_work_order_id = EXCLUDED.current_work_order_id`, [
    refundShopId,
    `active-runtime-worker-${prefix}`,
    crypto.randomUUID(),
    activeRuntimeWorkOrderId,
  ]);
  const activeRuntimeCandidates = await transientRepository.peek({
    shopIds: [refundShopId],
    allowedKinds: ['recovery', 'ordinary', 'refund-execution', 'refund-scan'],
  });
  assert.equal(activeRuntimeCandidates.length, 0,
    'a live runtime lease must fence scheduler reassignment after a supervisor restart');
  await pool.query(`
    UPDATE shop_runtime_state SET lease_expires_at = now() - interval '1 second'
    WHERE shop_id = $1`, [refundShopId]);
  const expiredRuntimeAssignment = await transientRepository.claim({
    shopIds: [refundShopId],
    allowedKinds: ['recovery'],
  });
  assert.equal(expiredRuntimeAssignment?.assignmentKind, 'recovery',
    'an expired runtime lease must release the processing order for recovery');
  await transientRepository.complete({ assignment: expiredRuntimeAssignment, exitCode: 0 });
  await pool.query(`
    UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
      lease_expires_at = NULL, current_work_order_id = NULL
    WHERE shop_id = $1`, [refundShopId]);
  await pool.query('DELETE FROM work_orders WHERE id = $1', [activeRuntimeWorkOrderId]);
  await pool.query(`
    INSERT INTO work_orders (
      id, shop_id, external_order_number, work_order_type, scenario_code,
      status, runtime_status, idempotency_key, current_step, payload, next_attempt_at
    ) VALUES ($1,$2,$3,'return refund','return-refund','retry-ready','waiting',$4,
      'return-refund-page-retry-ready','{}'::jsonb,now() - interval '1 minute')`, [
    refundExecutionWorkOrderId,
    refundShopId,
    `refund-execution-${prefix}`,
    `refund-execution-key-${prefix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds (
      work_order_id, shop_id, external_order_number, aftersale_number,
      decision, action_state, evidence
    ) VALUES ($1,$2,$3,$4,'page-error','page-error','{}'::jsonb)`, [
    refundExecutionWorkOrderId,
    refundShopId,
    `refund-execution-${prefix}`,
    `aftersale-execution-${prefix}`,
  ]);
  await pool.query(`
    UPDATE shop_schedule_state SET next_ordinary_scan_at = now() - interval '1 minute',
      next_refund_scan_at = now() + interval '1 day', queue_entered_at = now() - interval '1 hour',
      retry_at = NULL, metadata = metadata - 'manualSessionKind'
    WHERE shop_id = $1`, [refundShopId]);
  const refundExecutionAssignment = await transientRepository.claim({
    shopIds: [refundShopId],
    allowedKinds: ['ordinary', 'refund-execution'],
  });
  assert.equal(refundExecutionAssignment?.assignmentKind, 'refund-execution',
    'a due refund execution must outrank an ordinary scan when no ordinary order is queued');
  await transientRepository.complete({ assignment: refundExecutionAssignment, exitCode: 0 });
  await pool.query('DELETE FROM return_refunds WHERE work_order_id = $1', [refundExecutionWorkOrderId]);
  await pool.query('DELETE FROM work_orders WHERE id = $1', [refundExecutionWorkOrderId]);
  await pool.query(`
    UPDATE shop_schedule_state SET next_ordinary_scan_at = now() + interval '1 day',
      next_refund_scan_at = now() - interval '1 minute', queue_entered_at = now() - interval '1 hour',
      retry_at = NULL, metadata = metadata - 'manualSessionKind'
    WHERE shop_id = $1`, [refundShopId]);
  const refundAssignment = await transientRepository.claim({
    shopIds: [refundShopId],
    allowedKinds: ['refund-scan'],
  });
  assert.equal(refundAssignment?.assignmentKind, 'refund-scan');
  assert.equal(await transientRepository.recordRefundCursor({
    shopId: refundShopId,
    leaseToken: refundAssignment.leaseToken,
    cursor: { page: 3, itemOffset: 7 },
    fullScanCompleted: false,
    totals: { scannedItems: 27, persistedItems: 9, examinedItems: 30 },
  }), true);
  await transientRepository.complete({ assignment: refundAssignment, exitCode: 0 });
  const cursor = await pool.query(`
    SELECT refund_scan_cursor, refund_scan_in_progress, refund_cycle_totals
    FROM shop_schedule_state WHERE shop_id = $1`, [refundShopId]);
  assert.deepEqual(cursor.rows[0].refund_scan_cursor, { page: 3, itemOffset: 7 });
  assert.equal(cursor.rows[0].refund_scan_in_progress, true);
  assert.equal(Number(cursor.rows[0].refund_cycle_totals.scannedItems), 27);

  await pool.query(`
    UPDATE shop_schedule_state SET next_ordinary_scan_at = now() + interval '1 day',
      next_refund_scan_at = now() + interval '1 day', retry_at = NULL,
      metadata = metadata - 'manualSessionKind'
    WHERE shop_id = $1`, [refundShopId]);
  await pool.query(`
    INSERT INTO pdd_shop_runtime_bindings (
      identity_key, shop_id, actual_shop_name, binding_token
    ) VALUES ($1,$2,$3,$4)`, [
    schedulerBindingIdentityKey,
    refundShopId,
    `${prefix}-bound-shop`,
    schedulerBindingToken,
  ]);
  await pool.query(`
    INSERT INTO work_orders (
      id, shop_id, external_order_number, work_order_type, scenario_code,
      status, runtime_status, recovery_state, idempotency_key, current_step,
      payload, next_attempt_at
    ) VALUES
      ($1,$3,$4,'ordinary','in-transit-refund','retry-ready','retry-ready','held',$5,
        'scheduler-held-test',jsonb_build_object('latestDiscovery',jsonb_build_object(
          'pddIdentityBindingToken',$6::text)),now() - interval '1 minute'),
      ($2,$3,$7,'ordinary','abnormal-network-warning','retry-ready','retry-ready','ready',$8,
        'scheduler-identity-test',jsonb_build_object('latestDiscovery',jsonb_build_object(
          'pddIdentityBindingToken',$9::text)),now() - interval '1 minute')`, [
    heldOrdinaryWorkOrderId,
    identityBlockedWorkOrderId,
    refundShopId,
    `held-ordinary-${prefix}`,
    `held-ordinary-key-${prefix}`,
    schedulerBindingToken,
    `identity-blocked-${prefix}`,
    `identity-blocked-key-${prefix}`,
    crypto.randomUUID(),
  ]);
  const unclaimableCandidates = await transientRepository.peek({
    shopIds: [refundShopId],
    allowedKinds: ['recovery', 'ordinary', 'refund-execution', 'refund-scan'],
  });
  assert.equal(unclaimableCandidates.length, 0,
    'held and wrong-identity ordinary orders must not start unclaimable runner sessions');
  await pool.query(`
    UPDATE work_orders SET payload = jsonb_set(
      payload, '{latestDiscovery,pddIdentityBindingToken}', to_jsonb($2::text)
    ) WHERE id = $1`, [identityBlockedWorkOrderId, schedulerBindingToken]);
  const claimableIdentityCandidate = await transientRepository.peek({
    shopIds: [refundShopId],
    allowedKinds: ['ordinary'],
  });
  assert.equal(claimableIdentityCandidate.length, 1,
    'an otherwise eligible order with the current PDD identity must remain schedulable');

  console.log('shop scheduler PostgreSQL self-test passed');
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query('BEGIN');
    await cleanup.query('DELETE FROM return_refunds WHERE work_order_id = $1', [refundExecutionWorkOrderId]);
    await cleanup.query('DELETE FROM work_orders WHERE id = $1', [refundExecutionWorkOrderId]);
    await cleanup.query(`
      UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
        lease_expires_at = NULL, current_work_order_id = NULL
      WHERE current_work_order_id = $1`, [activeRuntimeWorkOrderId]);
    await cleanup.query('DELETE FROM work_orders WHERE id = $1', [activeRuntimeWorkOrderId]);
    await cleanup.query('DELETE FROM work_orders WHERE id = ANY($1::uuid[])', [[
      heldOrdinaryWorkOrderId,
      identityBlockedWorkOrderId,
    ]]);
    await cleanup.query('DELETE FROM pdd_shop_runtime_bindings WHERE identity_key = $1', [
      schedulerBindingIdentityKey,
    ]);
    await cleanup.query('UPDATE shops SET enabled = false WHERE id = ANY($1::text[])', [shopIds]);
    if (verificationIds.length) {
      await cleanup.query('DELETE FROM verification_locations WHERE id = ANY($1::uuid[])', [verificationIds]);
    }
    await cleanup.query(`
      UPDATE shop_schedule_state SET assigned_slot_id = NULL, assignment_token = NULL,
        assignment_kind = NULL, assignment_started_at = NULL, assignment_expires_at = NULL
      WHERE shop_id = ANY($1::text[])`, [shopIds]);
    await cleanup.query('DELETE FROM browser_slots WHERE shop_id = ANY($1::text[])', [shopIds]);
    await cleanup.query('DELETE FROM worker_heartbeats WHERE shop_id = ANY($1::text[])', [shopIds]);
    await cleanup.query('DELETE FROM shop_runtime_state WHERE shop_id = ANY($1::text[])', [shopIds]);
    await cleanup.query('DELETE FROM shops WHERE id = ANY($1::text[])', [shopIds]);
    await cleanup.query('COMMIT');
  } catch (error) {
    await cleanup.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    cleanup.release();
    await pool.end().catch(() => {});
  }
}
