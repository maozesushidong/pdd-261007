import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresPool, PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';
import { resolveRecoveredReturnRefundBrowserCloseInterventions } from '../apps/api/src/data-backend.mjs';

const pool = await createPostgresPool();
const repository = new PostgresWorkflowRepository(pool);
const suffix = crypto.randomUUID().slice(0, 8);
const shopId = `refund-claim-test-${suffix}`;
const blockedId = crypto.randomUUID();
const readyId = crypto.randomUUID();
const reconciliationId = crypto.randomUUID();
const scanReconciliationId = crypto.randomUUID();
const staleReservedReconciliationId = crypto.randomUUID();
const dueWaitingId = crypto.randomUUID();
const futureWaitingId = crypto.randomUUID();
const recentWaitingId = crypto.randomUUID();
const dueVerificationId = crypto.randomUUID();
const clearedVerificationId = crypto.randomUUID();
const retryPageErrorId = crypto.randomUUID();
const dueManualReviewId = crypto.randomUUID();
const futureManualReviewId = crypto.randomUUID();
const terminalReviewId = crypto.randomUUID();
const automaticTerminalScanOrderNumber = `refund-auto-terminal-${suffix}`;
const automaticTerminalScanAftersaleNumber = `aftersale-auto-terminal-${suffix}`;
const terminalResidueVerificationId = crypto.randomUUID();
const terminalResidueInterventionId = crypto.randomUUID();
const terminalResidueOutboxId = crypto.randomUUID();
const terminalResidueEffectId = crypto.randomUUID();
const shopLevelVerificationId = crypto.randomUUID();
const genuineManualCompletionId = crypto.randomUUID();
const genuineManualCompletionOrderNumber = `refund-manual-terminal-${suffix}`;
const genuineManualCompletionAftersaleNumber = `aftersale-manual-terminal-${suffix}`;
const genuineManualCompletionVerificationId = crypto.randomUUID();
const recoveredBrowserCloseId = crypto.randomUUID();
const pausedBrowserCloseId = crypto.randomUUID();
const unknownEffectBrowserCloseId = crypto.randomUUID();
const recoveredBrowserCloseInterventionId = crypto.randomUUID();
const pausedBrowserCloseInterventionId = crypto.randomUUID();
const unknownEffectBrowserCloseInterventionId = crypto.randomUUID();
const recoveredBrowserCloseOutboxId = crypto.randomUUID();
const detachedVerificationRefundId = crypto.randomUUID();
const detachedVerificationAssignmentId = crypto.randomUUID();
const detachedVerificationId = crypto.randomUUID();
const detachedVerificationBlockerId = crypto.randomUUID();
const detachedVerificationInterventionId = crypto.randomUUID();
const detachedVerificationOutboxId = crypto.randomUUID();

try {
  await pool.query(`
    INSERT INTO shops (id, name, expected_shop_name, display_slot, enabled, onboarding_status)
    SELECT $1,$2,$2,slot,false,'disabled'
    FROM generate_series(0, 99) slot
    WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = slot)
    ORDER BY slot LIMIT 1`, [shopId, `Refund claim self-test ${suffix}`]);
  const terminalCapturedAt = new Date().toISOString();
  const automaticTerminalScan = await repository.enqueueReturnRefunds({
    shopId,
    autoApproveEnabled: true,
    items: [{
      orderNumber: automaticTerminalScanOrderNumber,
      aftersaleNumber: automaticTerminalScanAftersaleNumber,
      aftersaleType: '退货退款',
      aftersaleStatus: '商家同意退款,本单退款成功',
      actionButtonVisible: false,
      pageIndicatesCompleted: true,
      hasReturnLogistics: false,
      evidence: {
        capturedAt: terminalCapturedAt,
        fieldSources: {
          orderNumber: {
            source: 'label-following-line',
            value: automaticTerminalScanOrderNumber,
          },
          aftersaleNumber: {
            source: 'label-following-line',
            value: automaticTerminalScanAftersaleNumber,
          },
          aftersaleStatus: {
            source: 'label-following-line',
            value: '商家同意退款,本单退款成功',
          },
        },
      },
    }],
  });
  assert.equal(automaticTerminalScan[0]?.outcome, 'manual-completed');
  const automaticTerminalScanRow = await pool.query(`
    SELECT work_order.id AS work_order_id,
      work_order.status, work_order.runtime_status, work_order.current_step,
      work_order.handling_classification, work_order.classification_source,
      work_order.completion_state, work_order.completion_confirmation_method,
      refund.action_state, refund.completion_method
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    WHERE work_order.shop_id = $1 AND refund.aftersale_number = $2`, [
    shopId,
    automaticTerminalScanAftersaleNumber,
  ]);
  const {
    work_order_id: automaticTerminalScanWorkOrderId,
    ...automaticTerminalScanState
  } = automaticTerminalScanRow.rows[0];
  assert.deepEqual(automaticTerminalScanState, {
    status: 'completed',
    runtime_status: 'completed',
    current_step: 'return-refund-read-only-complete',
    handling_classification: 'automated',
    classification_source: 'system',
    completion_state: 'confirmed',
    completion_confirmation_method: 'return-refund-read-only-page-completed',
    action_state: 'manual-completed',
    completion_method: 'return-refund-read-only-page-completed',
  }, 'an initial PDD terminal-page scan must persist as an automated read-only completion');

  const laterCapturedAt = new Date(Date.parse(terminalCapturedAt) + 60_000).toISOString();
  await repository.enqueueReturnRefunds({
    shopId,
    autoApproveEnabled: true,
    items: [{
      orderNumber: automaticTerminalScanOrderNumber,
      aftersaleNumber: automaticTerminalScanAftersaleNumber,
      aftersaleType: '退货退款',
      aftersaleStatus: '商家同意退款,本单退款成功',
      actionButtonVisible: false,
      pageIndicatesCompleted: true,
      hasReturnLogistics: false,
      evidence: { capturedAt: laterCapturedAt, pageTextSha256: 'b'.repeat(64) },
    }],
  });
  const terminalEvidence = await pool.query(`
    SELECT action_state, evidence->>'capturedAt' AS captured_at,
      evidence->>'pageTextSha256' AS later_page_hash
    FROM return_refunds WHERE work_order_id = $1`, [automaticTerminalScanWorkOrderId]);
  assert.deepEqual(terminalEvidence.rows[0], {
    action_state: 'manual-completed',
    captured_at: terminalCapturedAt,
    later_page_hash: null,
  }, 'a later discovery must not replace the page evidence of a completed refund');

  const heldOrderNumber = `refund-dispatched-hold-${suffix}`;
  const heldAftersaleNumber = `aftersale-dispatched-hold-${suffix}`;
  const heldRefund = {
    orderNumber: heldOrderNumber,
    aftersaleNumber: heldAftersaleNumber,
    aftersaleType: '退货退款',
    aftersaleStatus: '买家已发货,待商家处理',
    actionButtonVisible: true,
    decision: { outcome: 'auto-refund', reasons: [], rules: {} },
    evidence: { capturedAt: new Date().toISOString() },
  };
  const [initialHeldRefund] = await repository.enqueueReturnRefunds({
    shopId, autoApproveEnabled: true, items: [heldRefund],
  });
  const holdUntil = '2099-01-01T00:00:00Z';
  await pool.query(`
    UPDATE work_orders SET status='paused', runtime_status='manual-review',
      current_step='return-refund-dispatched-unknown-manual-review', next_attempt_at=NULL
    WHERE id=$1`, [initialHeldRefund.workOrderId]);
  await pool.query(`
    UPDATE return_refunds SET action_state='manual-review', next_check_at=$2
    WHERE work_order_id=$1`, [initialHeldRefund.workOrderId, holdUntil]);
  await pool.query(`
    INSERT INTO external_effects
      (id,shop_id,work_order_id,effect_type,idempotency_key,status,request_hash,receipt)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'failed','dispatched-hold-test',$5::jsonb)`, [
    crypto.randomUUID(), shopId, initialHeldRefund.workOrderId,
    `pdd-return-refund:${shopId}:${heldAftersaleNumber}`,
    JSON.stringify({ submission: { confirmationDispatchStarted: true } }),
  ]);
  const [rediscoveredHeldRefund] = await repository.enqueueReturnRefunds({
    shopId, autoApproveEnabled: true, items: [heldRefund],
  });
  assert.equal(rediscoveredHeldRefund.protectedDispatchedHold, true,
    'a scan must not requeue a dispatched uncertain refund held for manual review');
  const heldState = await pool.query(`
    SELECT work_order.status,work_order.current_step,refund.action_state,refund.next_check_at
    FROM work_orders work_order JOIN return_refunds refund ON refund.work_order_id=work_order.id
    WHERE work_order.id=$1`, [initialHeldRefund.workOrderId]);
  assert.equal(heldState.rows[0]?.status, 'paused');
  assert.equal(heldState.rows[0]?.action_state, 'manual-review');
  assert.equal(heldState.rows[0]?.next_check_at?.toISOString(), '2099-01-01T00:00:00.000Z');
  await repository.enqueueReturnRefunds({
    shopId,
    autoApproveEnabled: true,
    items: [{
      orderNumber: heldOrderNumber,
      aftersaleNumber: heldAftersaleNumber,
      aftersaleType: '退货退款',
      aftersaleStatus: '商家同意退款,本单退款成功',
      actionButtonVisible: false,
      pageIndicatesCompleted: true,
      hasReturnLogistics: false,
      evidence: {
        capturedAt: new Date().toISOString(),
        fieldSources: {
          orderNumber: { source: 'label-following-line', value: heldOrderNumber },
          aftersaleNumber: { source: 'label-following-line', value: heldAftersaleNumber },
          aftersaleStatus: { source: 'label-following-line', value: '商家同意退款,本单退款成功' },
        },
      },
    }],
  });
  const terminalHeldState = await pool.query(`
    SELECT work_order.status,refund.action_state,effect.status AS effect_status
    FROM work_orders work_order JOIN return_refunds refund ON refund.work_order_id=work_order.id
    JOIN external_effects effect ON effect.work_order_id=work_order.id
      AND effect.effect_type='pdd-return-refund'
    WHERE work_order.id=$1`, [initialHeldRefund.workOrderId]);
  assert.equal(terminalHeldState.rows[0]?.status, 'completed',
    'an exact terminal page can still resolve a manually held refund read-only');
  assert.equal(terminalHeldState.rows[0]?.effect_status, 'failed',
    'a terminal scan must not replay or rewrite the previous failed effect');

  const uncertainOrderNumber = `refund-dispatched-unknown-${suffix}`;
  const uncertainAftersaleNumber = `aftersale-dispatched-unknown-${suffix}`;
  const [uncertainRefund] = await repository.enqueueReturnRefunds({
    shopId,
    autoApproveEnabled: true,
    items: [{ ...heldRefund,
      orderNumber: uncertainOrderNumber,
      aftersaleNumber: uncertainAftersaleNumber,
    }],
  });
  await pool.query(`
    INSERT INTO external_effects
      (id,shop_id,work_order_id,effect_type,idempotency_key,status,request_hash,receipt)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'unknown','dispatched-unknown-test',$5::jsonb)`, [
    crypto.randomUUID(), shopId, uncertainRefund.workOrderId,
    `pdd-return-refund:${shopId}:${uncertainAftersaleNumber}`,
    JSON.stringify({ submission: { confirmationDispatchStarted: true } }),
  ]);
  const uncertainLeaseToken = crypto.randomUUID();
  await pool.query(`
    INSERT INTO shop_runtime_state
      (shop_id,worker_id,status,lease_token,lease_expires_at,current_work_order_id)
    VALUES ($1,$2,'processing',$3,now() + interval '5 minutes',$4)
    ON CONFLICT (shop_id) DO UPDATE SET
      worker_id=EXCLUDED.worker_id,status=EXCLUDED.status,
      lease_token=EXCLUDED.lease_token,lease_expires_at=EXCLUDED.lease_expires_at,
      current_work_order_id=EXCLUDED.current_work_order_id,updated_at=now()`, [
    shopId, `refund-unknown-worker-${suffix}`, uncertainLeaseToken, uncertainRefund.workOrderId,
  ]);
  assert.equal(await repository.finishReturnRefundClaim({
    shopId,
    workOrderId: uncertainRefund.workOrderId,
    leaseToken: uncertainLeaseToken,
    result: {
      outcome: 'manual-review',
      reasons: ['确认已发出但无终态证明'],
      facts: {
        orderNumber: uncertainOrderNumber,
        aftersaleNumber: uncertainAftersaleNumber,
        aftersaleStatus: '买家已发货,待商家处理',
        actionButtonVisible: true,
        evidence: { capturedAt: new Date().toISOString() },
      },
      rules: {},
      existingEffectResolution: {
        effectStatus: 'unknown', retryable: false,
        disposition: 'manual-review',
        reason: 'pdd-dispatched-confirmation-still-pending-manual-review',
      },
    },
  }), true);
  const uncertainHoldState = await pool.query(`
    SELECT work_order.status,work_order.current_step,refund.action_state,
      refund.next_check_at,effect.status AS effect_status
    FROM work_orders work_order JOIN return_refunds refund ON refund.work_order_id=work_order.id
    JOIN external_effects effect ON effect.work_order_id=work_order.id
      AND effect.effect_type='pdd-return-refund'
    WHERE work_order.id=$1`, [uncertainRefund.workOrderId]);
  assert.equal(uncertainHoldState.rows[0]?.status, 'paused');
  assert.equal(uncertainHoldState.rows[0]?.current_step,
    'return-refund-dispatched-unknown-manual-review');
  assert.equal(uncertainHoldState.rows[0]?.action_state, 'manual-review');
  assert.equal(uncertainHoldState.rows[0]?.next_check_at?.toISOString(),
    '2099-01-01T00:00:00.000Z');
  assert.equal(uncertainHoldState.rows[0]?.effect_status, 'unknown',
    'manual hold must preserve the uncertain effect for read-only resolution');

  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url,
       bounding_box, confidence, detected_at)
    VALUES
      ($1,$2,$3,'pdd','return-refund-close-detail-before','waiting-human',
       'https://mms.pinduoduo.com/aftersales-ssr/detail',
       '{}'::jsonb,'high',now() - interval '2 minutes'),
      ($4,$2,NULL,'pdd','return-refund-list-before','waiting-human',
       'https://mms.pinduoduo.com/aftersales-ssr/list',
       '{}'::jsonb,'high',now() - interval '1 minute')`, [
    terminalResidueVerificationId,
    shopId,
    automaticTerminalScanWorkOrderId,
    shopLevelVerificationId,
  ]);
  // Recreate the production race: the assistance record is opened before the
  // browser confirms the terminal refund page, then the business row closes.
  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      completion_state = 'pending', completion_confirmation_method = NULL
    WHERE id = $1`, [automaticTerminalScanWorkOrderId]);
  await pool.query(`
    UPDATE return_refunds SET action_state = 'verification-required', completed_at = NULL
    WHERE work_order_id = $1`, [automaticTerminalScanWorkOrderId]);
  await pool.query(`
    INSERT INTO manual_interventions
      (id, shop_id, work_order_id, channel, reason_code, reason,
       risk_level, deduplication_key)
    VALUES ($1,$2,$3,'dashboard','return-refund-verification-required',
      '终态退款残留验证码','high',$4)`, [
    terminalResidueInterventionId,
    shopId,
    automaticTerminalScanWorkOrderId,
    `dashboard:terminal-refund-verification:${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO notification_outbox (id, intervention_id, payload, next_attempt_at)
    VALUES ($1,$2,'{}'::jsonb,now() + interval '1 hour')`, [
    terminalResidueOutboxId,
    terminalResidueInterventionId,
  ]);
  await pool.query(`
    UPDATE work_orders SET status = 'completed', runtime_status = 'completed',
      completion_state = 'confirmed',
      completion_confirmation_method = 'return-refund-read-only-page-completed'
    WHERE id = $1`, [automaticTerminalScanWorkOrderId]);
  await pool.query(`
    UPDATE return_refunds SET action_state = 'manual-completed', completed_at = now()
    WHERE work_order_id = $1`, [automaticTerminalScanWorkOrderId]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'reserved','terminal-residue-test')`, [
    terminalResidueEffectId,
    shopId,
    automaticTerminalScanWorkOrderId,
    `terminal-residue-effect:${suffix}`,
  ]);
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
    `terminal-residue-worker-${suffix}`,
    crypto.randomUUID(),
    automaticTerminalScanWorkOrderId,
  ]);
  assert.deepEqual(await repository.resolveTerminalReturnRefundVerifications({
    shopId,
    workOrderId: automaticTerminalScanWorkOrderId,
  }), [], 'a valid lease and unresolved effect must preserve the verification gate');
  await pool.query(`
    UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
      lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
    WHERE shop_id = $1`, [shopId]);
  assert.deepEqual(await repository.resolveTerminalReturnRefundVerifications({
    shopId,
    workOrderId: automaticTerminalScanWorkOrderId,
  }), [], 'an unresolved external effect must preserve the verification gate after lease release');
  await pool.query('DELETE FROM external_effects WHERE id = $1', [terminalResidueEffectId]);
  const terminalVerificationRecovery =
    await repository.resolveTerminalReturnRefundVerifications({
      shopId,
      workOrderId: automaticTerminalScanWorkOrderId,
    });
  assert.deepEqual(terminalVerificationRecovery.map((row) => row.id), [
    terminalResidueVerificationId,
  ]);
  assert.deepEqual(await repository.resolveTerminalReturnRefundVerifications({
    shopId,
    workOrderId: automaticTerminalScanWorkOrderId,
  }), [], 'terminal verification reconciliation must be idempotent');
  const terminalVerificationState = await pool.query(`
    SELECT verification.status, verification.resolved_at IS NOT NULL AS resolved,
      intervention.status AS intervention_status,
      intervention.resolved_by, outbox.status AS outbox_status,
      (SELECT count(*)::int FROM audit_events audit
       WHERE audit.deduplication_key = $4) AS audit_count,
      (SELECT status FROM verification_locations WHERE id = $5) AS shop_level_status
    FROM verification_locations verification
    LEFT JOIN manual_interventions intervention ON intervention.id = $2
    LEFT JOIN notification_outbox outbox ON outbox.intervention_id = intervention.id
    WHERE verification.id = $1 AND verification.work_order_id = $3`, [
    terminalResidueVerificationId,
    terminalResidueInterventionId,
    automaticTerminalScanWorkOrderId,
    `terminal-return-refund-verification:${terminalResidueVerificationId}`,
    shopLevelVerificationId,
  ]);
  const {
    resolved_by: terminalVerificationResolvedBy,
    ...terminalVerificationFields
  } = terminalVerificationState.rows[0];
  assert.deepEqual(terminalVerificationFields, {
    status: 'resolved',
    resolved: true,
    intervention_status: 'resolved',
    outbox_status: 'cancelled',
    audit_count: 1,
    shop_level_status: 'waiting-human',
  }, 'only the terminal work-order verification may be reconciled');
  assert.ok([
    'work-order-completion-trigger',
    'worker-terminal-return-refund-reconciliation',
  ].includes(terminalVerificationResolvedBy));

  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, completion_state, created_at)
    VALUES ($1,$2,$3,'退货退款','return-refund','processing','processing',$4,
      'return-refund-manual-review','{}'::jsonb,'pending',now())`, [
    genuineManualCompletionId,
    shopId,
    genuineManualCompletionOrderNumber,
    `refund-manual-completion-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       aftersale_type, decision, action_state, logistics_contains_changsha)
    VALUES ($1,$2,$3,$4,'退货退款','manual-review','manual-review',false)`, [
    genuineManualCompletionId,
    shopId,
    genuineManualCompletionOrderNumber,
    genuineManualCompletionAftersaleNumber,
  ]);
  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url,
       bounding_box, confidence, detected_at)
    VALUES ($1,$2,$3,'pdd','return-refund-close-detail-before','waiting-human',
      'https://mms.pinduoduo.com/aftersales-ssr/detail',
      '{}'::jsonb,'high',now() - interval '1 minute')`, [
    genuineManualCompletionVerificationId,
    shopId,
    genuineManualCompletionId,
  ]);
  const genuineManualLeaseToken = crypto.randomUUID();
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
    `refund-manual-completion-worker-${suffix}`,
    genuineManualLeaseToken,
    genuineManualCompletionId,
  ]);
  assert.equal(await repository.finishReturnRefundClaim({
    shopId,
    workOrderId: genuineManualCompletionId,
    leaseToken: genuineManualLeaseToken,
    result: {
      outcome: 'manual-completed',
      readOnlyReview: false,
      completionMethod: 'return-refund-manual-completed',
      reasons: ['人工已在平台完成该售后'],
      facts: {
        orderNumber: genuineManualCompletionOrderNumber,
        aftersaleNumber: genuineManualCompletionAftersaleNumber,
        aftersaleType: '退货退款',
        aftersaleStatus: '商家同意退款,本单退款成功',
        actionButtonVisible: false,
        evidence: { capturedAt: new Date().toISOString() },
      },
      rules: {},
    },
  }), true);
  const genuineManualCompletion = await pool.query(`
    SELECT work_order.current_step, work_order.handling_classification,
      work_order.completion_confirmation_method, refund.completion_method
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    WHERE work_order.id = $1`, [genuineManualCompletionId]);
  assert.deepEqual(genuineManualCompletion.rows[0], {
    current_step: 'return-refund-manual-completed',
    handling_classification: 'manual',
    completion_confirmation_method: 'return-refund-manual-completed',
    completion_method: 'return-refund-manual-completed',
  }, 'an explicit operator-completed result must remain manual');
  const genuineManualCompletionVerification = await pool.query(`
    SELECT status, resolved_at IS NOT NULL AS resolved
    FROM verification_locations WHERE id = $1`, [genuineManualCompletionVerificationId]);
  assert.deepEqual(genuineManualCompletionVerification.rows[0], {
    status: 'resolved',
    resolved: true,
  }, 'finishing a terminal refund must clear its exact verification under the owned lease');
  await pool.query(`
    UPDATE shop_runtime_state SET worker_id = NULL, status = 'idle', lease_token = NULL,
      lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
    WHERE shop_id = $1`, [shopId]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, created_at)
    VALUES
      ($1,$3,$4,'退货退款','return-refund','paused','manual-review',$6,
       'return-refund-page-error','{}'::jsonb,now() - interval '1 second'),
      ($2,$3,$5,'退货退款','return-refund','queued','queued',$7,
       'return-refund-ready','{}'::jsonb,now()),
      ($8,$3,$9,'退货退款','return-refund','retry-ready','waiting',$10,
       'return-refund-verification-required','{}'::jsonb,now() - interval '2 seconds')`, [
    blockedId, readyId, shopId,
    `refund-blocked-${suffix}`, `refund-ready-${suffix}`,
    `refund-blocked-key-${suffix}`, `refund-ready-key-${suffix}`,
    reconciliationId, `refund-reconcile-${suffix}`, `refund-reconcile-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       decision, action_state, logistics_contains_changsha)
    VALUES
      ($1,$3,$4,$6,'page-error','page-error',false),
      ($2,$3,$5,$7,'auto-refund','ready',true),
      ($8,$3,$9,$10,'verification-required','verification-required',true)`, [
    blockedId, readyId, shopId,
    `refund-blocked-${suffix}`, `refund-ready-${suffix}`,
    `aftersale-blocked-${suffix}`, `aftersale-ready-${suffix}`,
    reconciliationId, `refund-reconcile-${suffix}`, `aftersale-reconcile-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'unknown',$5)`, [
    crypto.randomUUID(), shopId, reconciliationId,
    `pdd-return-refund:aftersale-reconcile-${suffix}`,
    crypto.createHash('sha256').update(`refund-reconcile-${suffix}`).digest('hex'),
  ]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, next_attempt_at, created_at)
    VALUES
      ($1,$5,$6,'退货退款','return-refund','retry-ready','waiting',$10,
       'return-refund-waiting-logistics','{}'::jsonb,now() + interval '1 day',now() - interval '6 minutes'),
      ($2,$5,$7,'退货退款','return-refund','retry-ready','waiting',$11,
       'return-refund-waiting-logistics','{}'::jsonb,now() - interval '1 minute',now() - interval '7 minutes'),
      ($3,$5,$8,'退货退款','return-refund','retry-ready','waiting',$12,
       'return-refund-verification-required','{}'::jsonb,now() - interval '1 minute',now() - interval '5 minutes'),
      ($4,$5,$9,'退货退款','return-refund','retry-ready','waiting',$13,
       'return-refund-page-error','{}'::jsonb,now() - interval '1 minute',now() - interval '3 minutes')`, [
    dueWaitingId, futureWaitingId, dueVerificationId, retryPageErrorId, shopId,
    `refund-waiting-due-${suffix}`, `refund-waiting-future-${suffix}`,
    `refund-verification-due-${suffix}`, `refund-page-retry-${suffix}`,
    `refund-waiting-due-key-${suffix}`, `refund-waiting-future-key-${suffix}`,
    `refund-verification-due-key-${suffix}`, `refund-page-retry-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       decision, action_state, logistics_contains_changsha, next_check_at)
    VALUES
      ($1,$5,$6,$10,'wait-logistics','waiting-logistics',false,now() - interval '1 minute'),
      ($2,$5,$7,$11,'wait-logistics','waiting-logistics',false,now() + interval '1 hour'),
      ($3,$5,$8,$12,'verification-required','verification-required',true,now() - interval '1 minute'),
      ($4,$5,$9,$13,'page-error','page-error',false,NULL)`, [
    dueWaitingId, futureWaitingId, dueVerificationId, retryPageErrorId, shopId,
    `refund-waiting-due-${suffix}`, `refund-waiting-future-${suffix}`,
    `refund-verification-due-${suffix}`, `refund-page-retry-${suffix}`,
    `aftersale-waiting-due-${suffix}`, `aftersale-waiting-future-${suffix}`,
    `aftersale-verification-due-${suffix}`, `aftersale-page-retry-${suffix}`,
  ]);
  await pool.query(`
    UPDATE return_refunds SET last_scanned_at = now() - interval '5 hours'
    WHERE work_order_id = $1`, [dueWaitingId]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, created_at)
    VALUES ($1,$2,$3,'退货退款','return-refund','retry-ready','waiting',$4,
      'return-refund-verification-required','{}'::jsonb,now())`, [
    scanReconciliationId, shopId, `refund-scan-reconcile-${suffix}`,
    `pdd-return-refund:${shopId}:aftersale-scan-reconcile-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       aftersale_type, decision, action_state, logistics_contains_changsha)
    VALUES ($1,$2,$3,$4,'退货退款','verification-required','verification-required',true)`, [
    scanReconciliationId, shopId, `refund-scan-reconcile-${suffix}`,
    `aftersale-scan-reconcile-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'unknown',$5)`, [
    crypto.randomUUID(), shopId, scanReconciliationId,
    `pdd-return-refund:aftersale-scan-reconcile-${suffix}`,
      crypto.createHash('sha256').update(`refund-scan-reconcile-${suffix}`).digest('hex'),
  ]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, next_attempt_at, created_at)
    VALUES ($1,$2,$3,'退货退款','return-refund','retry-ready','waiting',$4,
      'return-refund-page-error','{}'::jsonb,now() + interval '1 day',now() - interval '2 hours')`, [
    staleReservedReconciliationId, shopId, `refund-stale-reserved-${suffix}`,
    `pdd-return-refund:${shopId}:aftersale-stale-reserved-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number, detail_url,
       aftersale_type, aftersale_status, refund_amount, decision, action_state,
       action_button_visible, logistics_contains_changsha, next_check_at)
    VALUES ($1,$2,$3,$4,$5,'退货退款','待消费者寄出退货',88,'page-error','page-error',
      true,false,now() + interval '1 day')`, [
    staleReservedReconciliationId, shopId, `refund-stale-reserved-${suffix}`,
    `aftersale-stale-reserved-${suffix}`,
    `https://mms.pinduoduo.com/aftersales-ssr/detail?id=stale-reserved-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status,
       request_hash, receipt, reserved_at, updated_at)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'reserved',$5,$6::jsonb,
      now() - interval '2 hours',now() - interval '2 hours')`, [
    crypto.randomUUID(), shopId, staleReservedReconciliationId,
    `pdd-return-refund:aftersale-stale-reserved-${suffix}`,
    crypto.createHash('sha256').update(`refund-stale-reserved-${suffix}`).digest('hex'),
    JSON.stringify({ aftersaleNumber: `aftersale-stale-reserved-${suffix}` }),
  ]);
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, next_attempt_at, created_at)
    VALUES
      ($1,$3,$4,'退货退款','return-refund','paused','manual-review',$6,
       'return-refund-manual-review','{}'::jsonb,now() - interval '1 minute',now() - interval '4 minutes'),
      ($2,$3,$5,'退货退款','return-refund','paused','manual-review',$7,
       'return-refund-manual-review','{}'::jsonb,now() + interval '1 hour',now() - interval '8 minutes')`, [
    dueManualReviewId, futureManualReviewId, shopId,
    `refund-manual-due-${suffix}`, `refund-manual-future-${suffix}`,
    `refund-manual-due-key-${suffix}`, `refund-manual-future-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       decision, action_state, logistics_contains_changsha, next_check_at, last_scanned_at)
    VALUES
      ($1,$3,$4,$6,'manual-review','manual-review',false,now() - interval '1 minute',now() - interval '31 minutes'),
      ($2,$3,$5,$7,'manual-review','manual-review',false,now() + interval '1 hour',now())`, [
    dueManualReviewId, futureManualReviewId, shopId,
    `refund-manual-due-${suffix}`, `refund-manual-future-${suffix}`,
    `aftersale-manual-due-${suffix}`, `aftersale-manual-future-${suffix}`,
  ]);
  await pool.query(`
    UPDATE work_orders
    SET manual_review_reason = '首次发现超过72小时仍未产生有效退货物流'
    WHERE id = $1`, [dueManualReviewId]);
  await pool.query(`
    INSERT INTO manual_interventions
      (id, shop_id, work_order_id, channel, reason_code, reason, risk_level,
       status, deduplication_key)
    VALUES ($1,$2,$3,'dashboard','return-refund-no-logistics-over-72-hours',
      '首次发现超过72小时仍未产生有效退货物流','high','open',$4)`, [
    crypto.randomUUID(), shopId, dueManualReviewId,
    `refund-no-logistics-review-${suffix}`,
  ]);
  const noLogisticsReview = await repository.getReturnRefundForClaim({
    workOrderId: dueManualReviewId,
    shopId,
  });
  assert.equal(
    noLogisticsReview?.active_manual_reason_code,
    'return-refund-no-logistics-over-72-hours',
    'the runner must receive the precise intervention code before allowing executable reevaluation',
  );
  assert.equal(
    noLogisticsReview?.manual_review_reason,
    '首次发现超过72小时仍未产生有效退货物流',
  );
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, next_attempt_at, created_at)
    VALUES ($1,$2,$3,'退货退款','return-refund','retry-ready','retry-ready',$4,
      'return-refund-terminal-reconciliation-ready','{}'::jsonb,now(),now() - interval '1 day')`, [
    terminalReviewId, shopId, `refund-terminal-review-${suffix}`,
    `refund-terminal-review-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number, detail_url,
       aftersale_type, aftersale_status, decision, action_state,
       action_button_visible, logistics_contains_changsha, next_check_at)
    VALUES ($1,$2,$3,$4,$5,'退货退款','退款成功','manual-review','manual-review',
      false,false,now())`, [
    terminalReviewId, shopId, `refund-terminal-review-${suffix}`,
    `aftersale-terminal-review-${suffix}`,
    `https://mms.pinduoduo.com/aftersales-ssr/detail?id=terminal-${suffix}`,
  ]);
  const reconciledFromScan = await repository.enqueueReturnRefunds({
    shopId,
    autoApproveEnabled: true,
    items: [{
      orderNumber: `refund-scan-reconcile-${suffix}`,
      aftersaleNumber: `aftersale-scan-reconcile-${suffix}`,
      aftersaleType: '退货退款',
      aftersaleStatus: '退款中',
      actionButtonVisible: false,
      pageIndicatesCompleted: false,
      pageIndicatesPendingMerchant: true,
      hasReturnLogistics: true,
      evidence: { capturedAt: new Date().toISOString() },
    }],
  });
  assert.equal(reconciledFromScan[0]?.outcome, 'page-error',
    'a disappeared approve button with a pending status must remain unresolved');
  const scanReconciled = await pool.query(`
    SELECT work_order.completion_state, work_order.completion_confirmation_method,
      refund.action_state, effect.status AS effect_status
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    JOIN external_effects effect ON effect.work_order_id = work_order.id
      AND effect.effect_type = 'pdd-return-refund'
    WHERE work_order.id = $1`, [scanReconciliationId]);
  assert.deepEqual(scanReconciled.rows[0], {
    completion_state: 'pending',
    completion_confirmation_method: null,
    action_state: 'page-error',
    effect_status: 'unknown',
  });

  const releaseClaim = async (workOrderId) => {
    await pool.query(`
      UPDATE shop_runtime_state SET status='idle', lease_token=NULL,
        lease_expires_at=NULL, current_work_order_id=NULL
      WHERE shop_id=$1`, [shopId]);
    await pool.query(`
      UPDATE work_orders SET status='completed', runtime_status='completed'
      WHERE id=$1`, [workOrderId]);
  };
  const claimNextRefund = (options = {}) => repository.claimNext({
    shopId,
    workerId: `refund-claim-worker-${suffix}`,
    leaseSeconds: 300,
    scenarioCodes: ['return-refund'],
    ...options,
  });

  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now() + interval '1 hour'
    WHERE id = ANY($1::uuid[])`, [[reconciliationId, scanReconciliationId]]);
  const reconciliationClaim = await claimNextRefund({ unresolvedEffectsOnly: true });
  assert.equal(reconciliationClaim, null,
    'an uncertain external effect must respect its delayed retry before read-only reconciliation');
  await pool.query(`
    UPDATE shop_runtime_state
    SET status = 'idle', metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object('operatorPaused', true)
    WHERE shop_id = $1`, [shopId]);
  assert.equal(await claimNextRefund(), null,
    'a maintenance drain marker must block a late claim even before runtime status becomes operator-paused');
  await pool.query(`
    UPDATE shop_runtime_state
    SET metadata = metadata || jsonb_build_object(
      'maintenanceDrain', jsonb_build_object('active', true)
    ) WHERE shop_id = $1`, [shopId]);
  assert.equal(await claimNextRefund({ allowOperatorPaused: true }), null,
    'a maintenance drain must also block a refund-only claim that normally bypasses operator pause');
  await pool.query(`
    UPDATE shop_runtime_state
    SET metadata = (coalesce(metadata, '{}'::jsonb) - 'maintenanceDrain')
      || jsonb_build_object('operatorPaused', false)
    WHERE shop_id = $1`, [shopId]);
  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now()
    WHERE id = $1`, [reconciliationId]);
  const dueReconciliationClaim = await claimNextRefund({ unresolvedEffectsOnly: true });
  assert.equal(dueReconciliationClaim?.id, reconciliationId,
    'an uncertain external effect must remain eligible for read-only reconciliation once due');
  await releaseClaim(reconciliationId);
  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now()
    WHERE id = $1`, [scanReconciliationId]);

  const scanReconciliationClaim = await claimNextRefund();
  assert.equal(scanReconciliationClaim?.id, scanReconciliationId,
    'a pending status must preserve its uncertain external effect for read-only reconciliation');
  await releaseClaim(scanReconciliationId);

  const terminalReviewClaim = await claimNextRefund();
  assert.equal(terminalReviewClaim?.id, terminalReviewId,
    'an explicit terminal-status recovery must be rechecked before the routine refund backlog');
  await releaseClaim(terminalReviewId);

  const readyClaim = await claimNextRefund();
  assert.equal(readyClaim?.id, readyId,
    'action_state=ready must outrank page recovery and routine logistics rechecks');
  await releaseClaim(readyId);

  const retryPageErrorClaim = await claimNextRefund();
  assert.equal(retryPageErrorClaim?.id, retryPageErrorId,
    'an explicitly retry-ready page-error must outrank routine logistics rechecks');
  await releaseClaim(retryPageErrorId);

  const dueVerificationClaim = await claimNextRefund();
  assert.equal(dueVerificationClaim?.id, dueVerificationId,
    'an overdue verification-required refund must be eligible for safe recheck');
  await releaseClaim(dueVerificationId);

  const dueWaitingClaim = await claimNextRefund();
  assert.equal(dueWaitingClaim?.id, dueWaitingId,
    'the authoritative refund schedule must override a stale future work-order retry time');
  await releaseClaim(dueWaitingId);

  const dueManualReviewClaim = await claimNextRefund();
  assert.equal(dueManualReviewClaim?.id, dueManualReviewId,
    'an overdue manual-review refund must enter the safe read-only recheck queue');
  await releaseClaim(dueManualReviewId);

  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      next_attempt_at = now(),
      current_step = CASE WHEN id = $2 THEN 'verification-cleared-retry-ready'
        ELSE current_step END
    WHERE id = ANY($1::uuid[])`, [[dueVerificationId, dueWaitingId], dueVerificationId]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = now() - interval '45 minutes'
    WHERE work_order_id = $1`, [dueWaitingId]);
  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url,
       bounding_box, confidence, detected_at, resolved_at)
    VALUES ($1,$2,$3,'pdd','return-refund-detail-load-initial','resolved',
      'https://mms.pinduoduo.com/aftersales-ssr/detail',
      '{}'::jsonb,'high',now() - interval '20 minutes',now() - interval '15 minutes')`, [
    clearedVerificationId, shopId, dueVerificationId,
  ]);
  const clearedVerificationClaim = await claimNextRefund();
  assert.equal(clearedVerificationClaim?.id, dueVerificationId,
    'a human-cleared verification must receive its guarded recheck before overdue logistics waits');
  await releaseClaim(dueVerificationId);
  const oldWaitingClaim = await claimNextRefund();
  assert.equal(oldWaitingClaim?.id, dueWaitingId,
    'the overdue logistics wait must remain eligible after the cleared verification');
  await releaseClaim(dueWaitingId);

  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      next_attempt_at = CASE WHEN id = $1 THEN now() - interval '3 hours'
        ELSE now() - interval '45 minutes' END
    WHERE id = ANY($2::uuid[])`, [retryPageErrorId,
    [retryPageErrorId, dueWaitingId]]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = CASE WHEN work_order_id = $1
      THEN now() - interval '3 hours' ELSE now() - interval '45 minutes' END
    WHERE work_order_id = ANY($2::uuid[])`, [retryPageErrorId,
    [retryPageErrorId, dueWaitingId]]);
  const agedPageErrorClaim = await claimNextRefund();
  assert.equal(agedPageErrorClaim?.id, retryPageErrorId,
    'a page error overdue for hours must get one retry despite aged logistics waits');
  await releaseClaim(retryPageErrorId);
  const waitingAfterPageErrorClaim = await claimNextRefund();
  assert.equal(waitingAfterPageErrorClaim?.id, dueWaitingId,
    'the logistics wait remains eligible after an aged page error is claimed');
  await releaseClaim(dueWaitingId);

  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      next_attempt_at = now() - interval '10 minutes'
    WHERE id = $1`, [retryPageErrorId]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = now() - interval '10 minutes'
    WHERE work_order_id = $1`, [retryPageErrorId]);
  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      next_attempt_at = now() - interval '45 minutes'
    WHERE id = $1`, [dueWaitingId]);
  const waitingBeforeFreshPageErrorClaim = await claimNextRefund();
  assert.equal(waitingBeforeFreshPageErrorClaim?.id, dueWaitingId,
    'a recent page error must remain behind aged logistics waits');
  await releaseClaim(dueWaitingId);
  const freshPageErrorClaim = await claimNextRefund();
  assert.equal(freshPageErrorClaim?.id, retryPageErrorId);
  await releaseClaim(retryPageErrorId);

  await pool.query(`
    UPDATE verification_locations SET status = 'resolved', resolved_at = now()
    WHERE id = $1`, [shopLevelVerificationId]);
  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      current_step = CASE WHEN id = $1 THEN 'return-refund-verification-required'
        ELSE current_step END,
      next_attempt_at = now() - interval '45 minutes'
    WHERE id = ANY($2::uuid[])`, [dueVerificationId,
    [dueVerificationId, dueWaitingId]]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = CASE WHEN work_order_id = $1
      THEN now() - interval '5 hours' ELSE now() - interval '45 minutes' END
    WHERE work_order_id = ANY($2::uuid[])`, [dueVerificationId,
    [dueVerificationId, dueWaitingId]]);
  const agedVerificationClaim = await claimNextRefund();
  assert.equal(agedVerificationClaim?.id, dueVerificationId,
    'a verification retry waiting for hours may get one guarded turn ahead of logistics');
  await releaseClaim(dueVerificationId);
  const waitingAfterAgedVerificationClaim = await claimNextRefund();
  assert.equal(waitingAfterAgedVerificationClaim?.id, dueWaitingId);
  await releaseClaim(dueWaitingId);

  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      next_attempt_at = now() - interval '45 minutes'
    WHERE id = ANY($1::uuid[])`, [[dueVerificationId, dueWaitingId]]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = CASE WHEN work_order_id = $1
      THEN now() - interval '10 minutes' ELSE now() - interval '45 minutes' END
    WHERE work_order_id = ANY($2::uuid[])`, [dueVerificationId,
    [dueVerificationId, dueWaitingId]]);
  const waitingBeforeRecentVerificationClaim = await claimNextRefund();
  assert.equal(waitingBeforeRecentVerificationClaim?.id, dueWaitingId,
    'a recent verification retry must not displace overdue logistics work');
  await releaseClaim(dueWaitingId);
  const recentVerificationClaim = await claimNextRefund();
  assert.equal(recentVerificationClaim?.id, dueVerificationId);
  await releaseClaim(dueVerificationId);

  await pool.query(`
    UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
      next_attempt_at = now() - interval '45 minutes'
    WHERE id = ANY($1::uuid[])`, [[dueVerificationId, dueWaitingId]]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = CASE WHEN work_order_id = $1
      THEN now() - interval '5 hours' ELSE now() - interval '45 minutes' END
    WHERE work_order_id = ANY($2::uuid[])`, [dueVerificationId,
    [dueVerificationId, dueWaitingId]]);
  await pool.query(`
    UPDATE verification_locations SET status = 'waiting-human', resolved_at = NULL
    WHERE id = $1`, [shopLevelVerificationId]);
  const waitingDuringActiveVerificationClaim = await claimNextRefund();
  assert.equal(waitingDuringActiveVerificationClaim?.id, dueWaitingId,
    'an active shop challenge must suppress the aged verification priority');
  await releaseClaim(dueWaitingId);
  await pool.query(`
    UPDATE verification_locations SET status = 'resolved', resolved_at = now()
    WHERE id = $1`, [shopLevelVerificationId]);
  const verificationAfterChallengeClearsClaim = await claimNextRefund();
  assert.equal(verificationAfterChallengeClearsClaim?.id, dueVerificationId);
  await releaseClaim(dueVerificationId);

  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now() + interval '1 hour'
    WHERE id = $1`, [futureWaitingId]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = now() - interval '1 minute',
      last_scanned_at = now() - interval '2 minutes'
    WHERE work_order_id = $1`, [futureWaitingId]);
  const reachedDeadlineClaim = await claimNextRefund();
  assert.equal(reachedDeadlineClaim?.id, futureWaitingId,
    'a deadline reached shortly after the prior scan must not wait another full recheck interval');
  await releaseClaim(futureWaitingId);

  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now() WHERE id = $1`, [
    staleReservedReconciliationId,
  ]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = now() WHERE work_order_id = $1`, [
    staleReservedReconciliationId,
  ]);
  const firstReservedReconciliationClaim = await claimNextRefund({ unresolvedEffectsOnly: true });
  assert.equal(firstReservedReconciliationClaim?.id, staleReservedReconciliationId,
    'a due stale reserved effect must enter read-only reconciliation');
  const firstProofObservedAt = new Date().toISOString();
  const firstPendingProof = {
    strategy: 'exact-merchant-pending-after-unknown',
    orderNumber: `refund-stale-reserved-${suffix}`,
    aftersaleNumber: `aftersale-stale-reserved-${suffix}`,
    observedStatus: '待消费者寄出退货',
    firstObservedAt: firstProofObservedAt,
    observedAt: firstProofObservedAt,
    recheckAfterAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const reservedFacts = {
    detailUrl: `https://mms.pinduoduo.com/aftersales-ssr/detail?id=stale-reserved-${suffix}`,
    orderNumber: `refund-stale-reserved-${suffix}`,
    aftersaleNumber: `aftersale-stale-reserved-${suffix}`,
    aftersaleType: '退货退款',
    aftersaleStatus: '待消费者寄出退货',
    refundAmount: 88,
    actionButtonVisible: true,
    evidence: { capturedAt: firstProofObservedAt },
  };
  assert.equal(await repository.finishReturnRefundClaim({
    shopId,
    workOrderId: staleReservedReconciliationId,
    leaseToken: firstReservedReconciliationClaim.leaseToken,
    result: {
      outcome: 'page-error',
      reasons: ['等待第二次精确只读证据'],
      facts: reservedFacts,
      rules: {},
      existingEffectResolution: {
        effectStatus: 'unknown',
        retryable: false,
        reason: 'pdd-exact-pending-proof-waiting',
        pendingProof: firstPendingProof,
      },
    },
  }), true);
  const reservedAfterFirstProof = await pool.query(`
    SELECT status, receipt->'reconciliationProof' AS proof
    FROM external_effects WHERE work_order_id = $1`, [staleReservedReconciliationId]);
  assert.equal(reservedAfterFirstProof.rows[0]?.status, 'reserved',
    'the first proof must preserve the stale reservation');
  assert.deepEqual(reservedAfterFirstProof.rows[0]?.proof, firstPendingProof,
    'the first proof must be persisted on a reserved effect');

  await pool.query(`
    UPDATE work_orders SET next_attempt_at = now() WHERE id = $1`, [
    staleReservedReconciliationId,
  ]);
  await pool.query(`
    UPDATE return_refunds SET next_check_at = now() WHERE work_order_id = $1`, [
    staleReservedReconciliationId,
  ]);
  const secondReservedReconciliationClaim = await claimNextRefund({ unresolvedEffectsOnly: true });
  assert.equal(secondReservedReconciliationClaim?.id, staleReservedReconciliationId);
  assert.equal(await repository.finishReturnRefundClaim({
    shopId,
    workOrderId: staleReservedReconciliationId,
    leaseToken: secondReservedReconciliationClaim.leaseToken,
    result: {
      outcome: 'ready',
      reasons: ['双重精确证据已确认旧退款未生效'],
      facts: {
        ...reservedFacts,
        evidence: { capturedAt: new Date().toISOString() },
      },
      rules: {},
      existingEffectResolution: {
        effectStatus: 'failed',
        retryable: true,
        reason: 'pdd-exact-pending-after-unknown-confirmed',
        pendingProof: firstPendingProof,
      },
    },
  }), true);
  const releasedReservedEffect = await pool.query(`
    SELECT status, receipt#>>'{reconciliation,status}' AS reconciliation_status
    FROM external_effects WHERE work_order_id = $1`, [staleReservedReconciliationId]);
  assert.deepEqual(releasedReservedEffect.rows[0], {
    status: 'failed',
    reconciliation_status: 'safe-retry-released',
  }, 'only the second exact observation may release a stale reserved effect');

  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, next_attempt_at, created_at)
    VALUES ($1,$2,$3,'退货退款','return-refund','retry-ready','waiting',$4,
      'return-refund-waiting-logistics','{}'::jsonb,now() - interval '1 minute',now())`, [
    recentWaitingId, shopId, `refund-waiting-recent-${suffix}`,
    `refund-waiting-recent-key-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       decision, action_state, logistics_contains_changsha, next_check_at, last_scanned_at)
    VALUES ($1,$2,$3,$4,'wait-logistics','waiting-logistics',false,
      now() - interval '1 minute',now())`, [
    recentWaitingId, shopId, `refund-waiting-recent-${suffix}`,
    `aftersale-waiting-recent-${suffix}`,
  ]);

  assert.equal(await claimNextRefund(), null,
    'recent logistics scans, future manual rechecks and operator-paused page errors must remain outside the execution queue');

  const browserCloseReason = 'page.waitForTimeout: Target page, context or browser has been closed';
  const recoveredBrowserCloseOrderNumber = `refund-browser-close-recovered-${suffix}`;
  const pausedBrowserCloseOrderNumber = `refund-browser-close-paused-${suffix}`;
  const unknownEffectBrowserCloseOrderNumber = `refund-browser-close-effect-${suffix}`;
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, handling_classification, classification_source, idempotency_key,
       current_step, payload, manual_review_reason, next_attempt_at)
    VALUES
      ($1,$4,$5,'退货退款','return-refund','retry-ready','waiting','automated','system',$8,
       'return-refund-waiting-logistics','{}'::jsonb,NULL,now() + interval '1 day'),
      ($2,$4,$6,'退货退款','return-refund','paused','paused','automated','system',$9,
       'return-refund-waiting-logistics','{}'::jsonb,'业务人工暂停',now() + interval '1 day'),
      ($3,$4,$7,'退货退款','return-refund','retry-ready','waiting','automated','system',$10,
       'return-refund-waiting-logistics','{}'::jsonb,NULL,now() + interval '1 day')`, [
    recoveredBrowserCloseId,
    pausedBrowserCloseId,
    unknownEffectBrowserCloseId,
    shopId,
    recoveredBrowserCloseOrderNumber,
    pausedBrowserCloseOrderNumber,
    unknownEffectBrowserCloseOrderNumber,
    `refund-browser-close-recovered-${suffix}`,
    `refund-browser-close-paused-${suffix}`,
    `refund-browser-close-effect-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       decision, action_state, logistics_contains_changsha, next_check_at, last_scanned_at)
    VALUES
      ($1,$4,$5,$8,'wait-logistics','waiting-logistics',false,now() + interval '1 day',now()),
      ($2,$4,$6,$9,'wait-logistics','waiting-logistics',false,now() + interval '1 day',now()),
      ($3,$4,$7,$10,'wait-logistics','waiting-logistics',false,now() + interval '1 day',now())`, [
    recoveredBrowserCloseId,
    pausedBrowserCloseId,
    unknownEffectBrowserCloseId,
    shopId,
    recoveredBrowserCloseOrderNumber,
    pausedBrowserCloseOrderNumber,
    unknownEffectBrowserCloseOrderNumber,
    `aftersale-browser-close-recovered-${suffix}`,
    `aftersale-browser-close-paused-${suffix}`,
    `aftersale-browser-close-effect-${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO manual_interventions
      (id, shop_id, work_order_id, channel, reason_code, reason,
       risk_level, deduplication_key)
    VALUES
      ($1,$4,$5,'dashboard','external-system-error',$8,'high',$9),
      ($2,$4,$6,'dashboard','external-system-error',$8,'high',$10),
      ($3,$4,$7,'dashboard','external-system-error',$8,'high',$11)`, [
    recoveredBrowserCloseInterventionId,
    pausedBrowserCloseInterventionId,
    unknownEffectBrowserCloseInterventionId,
    shopId,
    recoveredBrowserCloseId,
    pausedBrowserCloseId,
    unknownEffectBrowserCloseId,
    browserCloseReason,
    `dashboard:browser-close-recovered:${suffix}`,
    `dashboard:browser-close-paused:${suffix}`,
    `dashboard:browser-close-effect:${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO notification_outbox (id, intervention_id, payload, next_attempt_at)
    VALUES ($1,$2,'{}'::jsonb,now() + interval '1 hour')`, [
    recoveredBrowserCloseOutboxId,
    recoveredBrowserCloseInterventionId,
  ]);
  await pool.query(`
    INSERT INTO external_effects
      (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
    VALUES ($1,$2,$3,'pdd-return-refund',$4,'unknown','self-test')`, [
    crypto.randomUUID(),
    shopId,
    unknownEffectBrowserCloseId,
    `refund-browser-close-effect-${suffix}`,
  ]);

  const browserCloseRecovery = await resolveRecoveredReturnRefundBrowserCloseInterventions(pool, {
    resolvedAt: new Date().toISOString(),
  });
  assert.equal(browserCloseRecovery.eligibleWorkOrderIds.includes(recoveredBrowserCloseId), true);
  assert.equal(browserCloseRecovery.resolvedIds.includes(recoveredBrowserCloseInterventionId), true);
  assert.equal(browserCloseRecovery.resolvedIds.includes(pausedBrowserCloseInterventionId), false,
    'a business-paused return/refund must keep its intervention');
  assert.equal(browserCloseRecovery.resolvedIds.includes(unknownEffectBrowserCloseInterventionId), false,
    'an unresolved external effect must keep its intervention');
  const browserCloseStates = await pool.query(`
    SELECT intervention.id, intervention.status, intervention.resolved_by,
      outbox.status AS outbox_status
    FROM manual_interventions intervention
    LEFT JOIN notification_outbox outbox ON outbox.intervention_id = intervention.id
    WHERE intervention.id = ANY($1::uuid[])
    ORDER BY intervention.id`, [[
    recoveredBrowserCloseInterventionId,
    pausedBrowserCloseInterventionId,
    unknownEffectBrowserCloseInterventionId,
  ]]);
  const recoveredBrowserClose = browserCloseStates.rows
    .find((row) => row.id === recoveredBrowserCloseInterventionId);
  const pausedBrowserClose = browserCloseStates.rows
    .find((row) => row.id === pausedBrowserCloseInterventionId);
  const unknownEffectBrowserClose = browserCloseStates.rows
    .find((row) => row.id === unknownEffectBrowserCloseInterventionId);
  assert.equal(recoveredBrowserClose.status, 'resolved');
  assert.equal(recoveredBrowserClose.resolved_by, 'return-refund-browser-close-auto-recovery');
  assert.equal(recoveredBrowserClose.outbox_status, 'cancelled');
  assert.equal(pausedBrowserClose.status, 'open');
  assert.equal(unknownEffectBrowserClose.status, 'open');
  const recoveredWithoutExistingIntervention = await resolveRecoveredReturnRefundBrowserCloseInterventions(pool, {
    workOrderId: recoveredBrowserCloseId,
    resolvedAt: new Date().toISOString(),
  });
  assert.deepEqual(recoveredWithoutExistingIntervention.eligibleWorkOrderIds, [recoveredBrowserCloseId],
    'safe authoritative state must suppress a newly arriving closed-browser intervention');
  assert.deepEqual(recoveredWithoutExistingIntervention.resolvedIds, []);

  const detachedVerificationOrderNumber = `refund-detached-verification-${suffix}`;
  const detachedVerificationAftersaleNumber = `aftersale-detached-verification-${suffix}`;
  const detachedVerificationPayload = {
    residentCommand: { assignmentId: detachedVerificationAssignmentId },
    returnRefundResult: { outcome: 'verification-required' },
    verificationLocation: { id: detachedVerificationId },
  };
  await pool.query(`
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status,
       runtime_status, idempotency_key, current_step, payload, next_attempt_at)
    VALUES ($1,$2,$3,'退货退款','return-refund','retry-ready','waiting',$4,
      'return-refund-verification-required',$5::jsonb,now() + interval '1 hour')`, [
    detachedVerificationRefundId,
    shopId,
    detachedVerificationOrderNumber,
    `refund-detached-verification-${suffix}`,
    JSON.stringify(detachedVerificationPayload),
  ]);
  await pool.query(`
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number,
       decision, action_state, logistics_contains_changsha, next_check_at)
    VALUES ($1,$2,$3,$4,'verification-required','verification-required',false,
      now() + interval '1 hour')`, [
    detachedVerificationRefundId,
    shopId,
    detachedVerificationOrderNumber,
    detachedVerificationAftersaleNumber,
  ]);
  await pool.query(`
    INSERT INTO verification_locations
      (id, shop_id, work_order_id, system_name, stage, status, url,
       bounding_box, confidence, detected_at)
    VALUES
      ($1,$3,$4,'pdd','return-refund-detail-ready-before','waiting-human',
       'https://mms.pinduoduo.com/aftersales-ssr/detail',
       '{}'::jsonb,'high',now() - interval '2 minutes'),
      ($2,$3,$4,'pdd','return-refund-detail-ready-before','waiting-human',
       'https://mms.pinduoduo.com/aftersales-ssr/detail',
       '{}'::jsonb,'high',now() - interval '1 minute')`, [
    detachedVerificationId,
    detachedVerificationBlockerId,
    shopId,
    detachedVerificationRefundId,
  ]);
  await pool.query(`
    INSERT INTO manual_interventions
      (id, shop_id, work_order_id, channel, reason_code, reason,
       risk_level, deduplication_key)
    VALUES ($1,$2,$3,'dashboard','return-refund-verification-required',
      '退款页面等待人工验证','high',$4)`, [
    detachedVerificationInterventionId,
    shopId,
    detachedVerificationRefundId,
    `dashboard:detached-verification:${suffix}`,
  ]);
  await pool.query(`
    INSERT INTO notification_outbox (id, intervention_id, payload, next_attempt_at)
    VALUES ($1,$2,'{}'::jsonb,now() + interval '1 hour')`, [
    detachedVerificationOutboxId,
    detachedVerificationInterventionId,
  ]);

  assert.equal(await repository.resolveDetachedClearedReturnRefundVerification({
    shopId,
    assignmentId: crypto.randomUUID(),
    verificationId: detachedVerificationId,
    commandCompletedAt: new Date(Date.now() - 5_000).toISOString(),
    resolvedAt: new Date().toISOString(),
  }), null, 'a mismatched resident assignment must not release the refund');
  const detachedCommandCompletedAt = new Date(Date.now() - 5_000).toISOString();
  const firstDetachedClear = await repository.resolveDetachedClearedReturnRefundVerification({
    shopId,
    assignmentId: detachedVerificationAssignmentId,
    verificationId: detachedVerificationId,
    commandCompletedAt: detachedCommandCompletedAt,
    resolvedAt: new Date().toISOString(),
  });
  assert.deepEqual(firstDetachedClear, {
    workOrderId: detachedVerificationRefundId,
    verificationResolved: true,
    requeued: false,
  }, 'another unresolved verification must keep the refund deferred');
  const deferredState = await pool.query(`
    SELECT next_attempt_at > now() + interval '30 minutes' AS order_deferred,
      refund.next_check_at > now() + interval '30 minutes' AS refund_deferred
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    WHERE work_order.id = $1`, [detachedVerificationRefundId]);
  assert.deepEqual(deferredState.rows[0], {
    order_deferred: true,
    refund_deferred: true,
  });
  const detachedResolvedAt = new Date(Date.now() - 10_000).toISOString();
  const detachedPostCommandObservedAt = new Date().toISOString();
  await pool.query(`
    UPDATE verification_locations SET status = 'expired', resolved_at = $2::timestamptz
    WHERE id = $1`, [detachedVerificationBlockerId, detachedResolvedAt]);
  const finalDetachedClear = await repository.resolveDetachedClearedReturnRefundVerification({
    shopId,
    assignmentId: detachedVerificationAssignmentId,
    verificationId: detachedVerificationBlockerId,
    commandCompletedAt: detachedCommandCompletedAt,
    resolvedAt: detachedPostCommandObservedAt,
  });
  assert.deepEqual(finalDetachedClear, {
    workOrderId: detachedVerificationRefundId,
    verificationResolved: true,
    requeued: true,
  });
  const detachedState = await pool.query(`
    SELECT work_order.status, work_order.runtime_status, work_order.current_step,
      work_order.next_attempt_at <= $2::timestamptz AS order_due,
      refund.next_check_at <= $2::timestamptz AS refund_due,
      intervention.status AS intervention_status,
      intervention.resolved_by, outbox.status AS outbox_status,
      (SELECT count(*)::int FROM external_effects effect
       WHERE effect.work_order_id = work_order.id) AS effect_count
    FROM work_orders work_order
    JOIN return_refunds refund ON refund.work_order_id = work_order.id
    LEFT JOIN manual_interventions intervention ON intervention.id = $3::uuid
    LEFT JOIN notification_outbox outbox ON outbox.intervention_id = intervention.id
    WHERE work_order.id = $1`, [
    detachedVerificationRefundId,
    detachedPostCommandObservedAt,
    detachedVerificationInterventionId,
  ]);
  assert.deepEqual(detachedState.rows[0], {
    status: 'retry-ready',
    runtime_status: 'waiting',
    current_step: 'return-refund-verification-required',
    order_due: true,
    refund_due: true,
    intervention_status: 'resolved',
    resolved_by: 'resident-return-refund-verification-cleared',
    outbox_status: 'cancelled',
    effect_count: 0,
  }, 'an exact post-command authenticated observation must requeue a verification cleared before command completion');
  console.log('return-refund claim eligibility self-test passed');
} finally {
  try {
    await pool.query('BEGIN');
    await pool.query(`
      DELETE FROM notification_deliveries
      WHERE outbox_id IN (
        SELECT outbox.id FROM notification_outbox outbox
        JOIN manual_interventions intervention ON intervention.id = outbox.intervention_id
        WHERE intervention.shop_id = $1
      )`, [shopId]);
    await pool.query(`
      DELETE FROM notification_outbox
      WHERE intervention_id IN (
        SELECT id FROM manual_interventions WHERE shop_id = $1
      )`, [shopId]);
    await pool.query('DELETE FROM shop_runtime_state WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM manual_interventions WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM external_effects WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM verification_locations WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM audit_events WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM workflow_events WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM return_refunds WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM work_orders WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM shop_schedule_state WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM shops WHERE id=$1', [shopId]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
}
