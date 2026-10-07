import crypto from 'node:crypto';
import {
  claimUnverifiedListCompletion, completeListCompletionProof, LIST_COMPLETION_PROOF_EFFECT,
} from './ordinary-list-completion-reconciliation.mjs';
import {
  confirmsReturnRefundCompletion,
  evaluateReturnRefundRules,
  isAutomatedReturnRefundCompletion,
  returnRefundCursorActionScope,
  RETURN_REFUND_MANUAL_REVIEW_RECHECK_MS,
  RETURN_REFUND_PAGE_ERROR_RECHECK_MS,
  RETURN_REFUND_UNKNOWN_RECHECK_MS,
  RETURN_REFUND_VERIFICATION_RECHECK_MS,
  RETURN_REFUND_WAIT_RECHECK_MS,
} from '../pdd/return-refund.mjs';

export const sanitizeUnicodeText = (value) => {
  const text = String(value);
  let sanitized = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0) {
      sanitized += '\uFFFD';
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        sanitized += text[index] + text[index + 1];
        index++;
      } else {
        sanitized += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      sanitized += '\uFFFD';
    } else {
      sanitized += text[index];
    }
  }
  return sanitized;
};

export const stringifyJsonb = (value) => JSON.stringify(value, (_key, item) => (
  typeof item === 'string' ? sanitizeUnicodeText(item) : item
));

// Native Worker checkpoints do not pass through the API event ingester. Keep
// the structured TMS row in sync only after the matching external create
// effect has succeeded for the current verified ordinary instance.
export async function materializeConfirmedTmsTicket(client, {
  shopId, workOrderId, payload = {},
} = {}) {
  const ticket = payload?.tmsWorkOrder;
  const orderNumber = String(ticket?.orderNumber || '').trim();
  const scenarioCode = String(payload?.latestDiscovery?.scenarioCode || '').trim();
  const ticketNo = String(ticket?.ticketNo || '').trim();
  if (ticket?.status !== 'created' || !orderNumber || !scenarioCode || !ticketNo) return false;
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    orderNumber, scenarioCode,
    problemType: ticket.problemType,
    customerRemark: ticket.customerRemark,
  })).digest('hex');
  const createdAtMs = Date.parse(String(ticket.createdAt || ''));
  const createdAt = Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : null;
  const result = await client.query(`
    INSERT INTO tms_work_orders
      (id, work_order_id, ordinary_instance_id, scenario_code,
       external_ticket_id, status, request_hash, payload, created_at)
    SELECT $1, w.id, w.current_ordinary_instance_id, w.scenario_code,
      $6, 'created', $7, $8::jsonb, coalesce($9::timestamptz, now())
    FROM work_orders w
    JOIN ordinary_work_order_instances instance
      ON instance.id = w.current_ordinary_instance_id
      AND instance.work_order_id = w.id
      AND instance.shop_id = w.shop_id
    WHERE w.id = $2 AND w.shop_id = $3 AND w.external_order_number = $4
      AND w.scenario_code = $5 AND instance.identity_status = 'verified'
      AND EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = w.id
          AND effect.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
          AND effect.effect_type = 'tms-create' AND effect.status = 'succeeded'
          AND effect.receipt #>> '{result,data,ticketNo}' = $6
      )
      AND NOT EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = w.id
          AND effect.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
          AND effect.effect_type = 'tms-create'
          AND effect.status IN ('reserved','unknown')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tms_work_orders existing
        WHERE existing.work_order_id = w.id
          AND existing.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
          AND existing.external_ticket_id = $6
      )
    ON CONFLICT DO NOTHING
    RETURNING id`, [crypto.randomUUID(), workOrderId, shopId, orderNumber,
    scenarioCode, ticketNo, requestHash, stringifyJsonb(ticket), createdAt]);
  return result.rowCount === 1;
}

// Native Worker checkpoints bypass the legacy API event ingester. Persist only
// analyses that still belong to the verified current PDD case and exact order.
export async function materializeVerifiedAnalysisSnapshots(client, {
  shopId, workOrderId, payload = {},
} = {}) {
  const inserted = { oms: false, logistics: false };
  for (const [kind, key, table] of [
    ['oms', 'omsAnalysis', 'oms_analyses'],
    ['logistics', 'logisticsAnalysis', 'logistics_analyses'],
  ]) {
    const analysis = payload?.[key];
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) continue;
    const orderNumber = String(analysis.orderNumber || '').trim();
    if (!orderNumber) continue;
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify(analysis)).digest('hex');
    const result = await client.query(`
      INSERT INTO ${table} (work_order_id, ordinary_instance_id, payload, source_hash)
      SELECT w.id, w.current_ordinary_instance_id, $4::jsonb, $5
      FROM work_orders w
      JOIN ordinary_work_order_instances instance
        ON instance.id = w.current_ordinary_instance_id
        AND instance.work_order_id = w.id
        AND instance.shop_id = w.shop_id
      WHERE w.id = $1 AND w.shop_id = $2 AND w.external_order_number = $3
        AND w.scenario_code IS DISTINCT FROM 'return-refund'
        AND w.frontend_visibility = 'operational'
        AND instance.identity_status = 'verified'
        AND nullif(instance.platform_case_id, '') IS NOT NULL
        AND w.payload #>> '{latestDiscovery,platformCaseId}' = instance.platform_case_id
        AND w.payload->'${key}' = $4::jsonb
      ON CONFLICT DO NOTHING
      RETURNING id`, [workOrderId, shopId, orderNumber,
      stringifyJsonb(analysis), sourceHash]);
    inserted[kind] = result.rowCount === 1;
  }
  return inserted;
}

// workflow_checkpoints is keyed by shop, not by work order. During a verified
// cross-shop correction, moving a source checkpoint directly can collide with
// the target shop's live checkpoint and abort the entire worker startup. Keep
// the target snapshot authoritative; only move the newest source snapshot when
// the target has none, then discard stale source snapshots for the moved order.
const relocateWorkflowCheckpoint = async (client, { workOrderId, shopId }) => {
  await client.query(`
    WITH candidate AS (
      SELECT checkpoint.shop_id
      FROM workflow_checkpoints checkpoint
      WHERE checkpoint.work_order_id = $1 AND checkpoint.shop_id <> $2
      ORDER BY checkpoint.source_updated_at DESC, checkpoint.synchronized_at DESC
      LIMIT 1
    )
    UPDATE workflow_checkpoints checkpoint SET shop_id = $2
    WHERE checkpoint.shop_id = (SELECT shop_id FROM candidate)
      AND NOT EXISTS (
        SELECT 1 FROM workflow_checkpoints target WHERE target.shop_id = $2
      )`, [workOrderId, shopId]);
  await client.query(`
    DELETE FROM workflow_checkpoints
    WHERE work_order_id = $1 AND shop_id <> $2`, [workOrderId, shopId]);
};

const hasVerifiedOmsReissueNotAppliedEvidence = (effect) => {
  if (effect?.effect_type !== 'oms-reissue-create' || effect?.status !== 'failed') return false;
  const reconciliation = effect?.error?.readOnlyReconciliation;
  const orderNumber = String(reconciliation?.orderNumber || '').trim();
  const originalSalesOrderCode = String(reconciliation?.originalSalesOrderCode || '').trim();
  const passes = Array.isArray(reconciliation?.queryPasses)
    ? reconciliation.queryPasses
    : [];
  if (reconciliation?.state !== 'not-applied'
    || reconciliation?.effectType !== 'oms-reissue-create'
    || reconciliation?.readOnly !== true
    || reconciliation?.externalActionsReplayed !== false
    || reconciliation?.confirmationMethod
      !== 'two-pass-exact-oms-order-query-single-original-row'
    || !orderNumber
    || !originalSalesOrderCode
    || passes.length !== 2) {
    return false;
  }
  return passes.every((pass) => {
    const apiRows = Array.isArray(pass?.apiRows) ? pass.apiRows : [];
    const reissueRows = Array.isArray(pass?.reissueRows) ? pass.reissueRows : [];
    return pass?.queryResponseCaptured === true
      && pass?.queryResponseOk === true
      && String(pass?.queryInputValue || '').trim() === orderNumber
      && Number(pass?.apiTotal) === 1
      && apiRows.length === 1
      && reissueRows.length === 0
      && String(apiRows[0]?.salesOrderCode || '').trim() === originalSalesOrderCode
      && apiRows[0]?.isReissue === false;
  });
};

export const ordinaryPlatformCaseIdentity = (payload = {}) => {
  const explicitKey = String(payload.platformCaseKey || '').trim();
  const explicitId = String(payload.platformCaseId || '').trim();
  const candidates = [
    payload.detailUrl,
    payload.latestDiscovery?.detailUrl,
    payload.checkpoint?.detailUrl,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const id = String(url.searchParams.get('id') || '').trim();
      if (url.hostname.toLowerCase() === 'mms.pinduoduo.com'
        && /^[0-9]{6,30}$/u.test(id)
        && /\/aftersales\/work_order\/tododetail\/?$/u.test(url.pathname)) {
        const platformCaseKey = `pdd-work-order:${id}`;
        const explicitKeyIsValid = !explicitKey || explicitKey === platformCaseKey;
        const explicitIdIsValid = !explicitId || explicitId === id;
        if (explicitKeyIsValid && explicitIdIsValid) return { platformCaseKey, platformCaseId: id };
      }
    } catch { /* malformed legacy URL */ }
  }
  return { platformCaseKey: null, platformCaseId: null };
};

const terminalOrdinaryInstanceStatuses = new Set([
  'completed',
  'archived',
  'resolved',
  'manual-completed',
]);

const retryReclassifiedInterventionReasonCodes = Object.freeze([
  'manual-review-required',
  'external-system-error',
  'page-render-deferred',
  'verification-required',
  'login-required',
]);

const verificationInterventionReasonCodes = Object.freeze([
  'verification-required',
  'return-refund-verification-required',
]);

const verificationBlockingSteps = new Set([
  'human-verification-required',
  'manual-login-required',
  'required-login',
]);

const activeVerificationStatuses = new Set([
  'detected',
  'waiting-human',
  'verification-required',
]);

// Keep a timed-out challenge from being reinserted when a stale browser
// checkpoint arrives after the timeout transaction. The workflow persists the
// same fingerprint and cooldown window for this exact page/challenge.
const verificationTimeoutSuppressesSnapshot = (payload = {}, verification = null) => {
  const timeout = payload?.verificationTimeout;
  if (!verification || timeout?.status !== 'closed' || !timeout.fingerprint) return false;
  if (timeout.system && timeout.system !== (verification.system || 'pdd')) return false;
  const suppressUntilMs = Date.parse(String(timeout.suppressUntil || ''));
  if (!Number.isFinite(suppressUntilMs) || Date.now() >= suppressUntilMs) return false;
  const fingerprint = JSON.stringify([
    String(verification.system || 'pdd'),
    String(verification.url || payload.currentUrl || ''),
    String(verification.pageRole || ''),
    String(verification.frameUrl || ''),
    String(verification.selector || ''),
  ]);
  return timeout.fingerprint === fingerprint;
};

// Older browser observers could persist a PDD verification row while they
// were actually looking at an OMS/TMS page. Such a row is not evidence of a
// live PDD challenge and must not hold the shop's scheduler indefinitely.
const resolveMisboundVerificationLocations = async (client, {
  shopId,
  resolvedBy = 'misbound-verification-reconciliation',
} = {}) => {
  if (!client?.query || !shopId) return [];
  const result = await client.query(`
    WITH candidates AS MATERIALIZED (
      SELECT id, shop_id, work_order_id, system_name, stage, url, detected_at
      FROM verification_locations
      WHERE shop_id = $1
        AND status IN ('detected', 'waiting-human', 'verification-required')
        AND resolved_at IS NULL
        AND (
          (lower(system_name) = 'pdd'
            AND (url ILIKE '%jeoms.com%' OR url ILIKE '%tms.aipro123.top%'))
          OR (lower(system_name) = 'oms' AND url ILIKE '%mms.pinduoduo.com%')
          OR (lower(system_name) = 'tms' AND url ILIKE '%mms.pinduoduo.com%')
        )
      FOR UPDATE SKIP LOCKED
    ), resolved AS (
      UPDATE verification_locations verification SET
        status = 'resolved',
        resolved_at = coalesce(verification.resolved_at, now())
      FROM candidates candidate
      WHERE verification.id = candidate.id
      RETURNING verification.id, verification.shop_id, verification.work_order_id,
        verification.system_name, verification.stage, verification.url,
        verification.detected_at, verification.resolved_at
    ), audited AS (
      INSERT INTO audit_events
        (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
      SELECT resolved.shop_id, resolved.work_order_id, $2,
        'misbound-verification-resolved',
        jsonb_build_object(
          'verificationId', resolved.id,
          'systemName', resolved.system_name,
          'stage', resolved.stage,
          'url', resolved.url,
          'detectedAt', resolved.detected_at,
          'resolvedAt', resolved.resolved_at,
          'externalActionsReplayed', false
        ),
        'misbound-verification:' || resolved.id::text
      FROM resolved
      ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
      RETURNING work_order_id
    )
    SELECT * FROM resolved ORDER BY detected_at`, [
    shopId,
    String(resolvedBy || 'misbound-verification-reconciliation'),
  ]);
  const resolvedWorkOrderIds = [...new Set(
    result.rows.map((row) => row.work_order_id).filter(Boolean),
  )];
  for (const workOrderId of resolvedWorkOrderIds) {
    await resolveClearedVerificationInterventions(client, {
      shopId,
      workOrderId,
      resolvedBy,
    });
  }
  return result.rows;
};

export const resolveClearedVerificationInterventions = async (client, {
  shopId,
  workOrderId,
  resolvedAt = new Date().toISOString(),
  resolvedBy = 'verification-cleared',
} = {}) => {
  if (!client?.query || !shopId || !workOrderId) return [];
  const parsedResolvedAt = Date.parse(String(resolvedAt || ''));
  const resolutionTimestamp = Number.isFinite(parsedResolvedAt)
    ? new Date(parsedResolvedAt).toISOString()
    : new Date().toISOString();
  const result = await client.query(`
    WITH target AS MATERIALIZED (
      SELECT current_ordinary_instance_id
      FROM work_orders
      WHERE id = $2 AND shop_id = $1
    ), resolved AS (
      UPDATE manual_interventions intervention SET
        status = 'resolved',
        resolved_at = coalesce(intervention.resolved_at, $4::timestamptz),
        resolved_by = coalesce(intervention.resolved_by, $5)
      FROM target
      WHERE intervention.shop_id = $1
        AND intervention.work_order_id = $2
        AND intervention.status IN ('open', 'acknowledged')
        AND intervention.reason_code = ANY($3::text[])
        AND intervention.created_at <= $4::timestamptz
        AND (
          intervention.ordinary_instance_id IS NULL
          OR intervention.ordinary_instance_id IS NOT DISTINCT FROM
            target.current_ordinary_instance_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM verification_locations verification
          WHERE verification.shop_id = $1
            AND verification.work_order_id = $2
            AND verification.status IN ('detected', 'waiting-human', 'verification-required')
            AND verification.resolved_at IS NULL
            AND (
              verification.ordinary_instance_id IS NULL
              OR verification.ordinary_instance_id IS NOT DISTINCT FROM
                target.current_ordinary_instance_id
            )
        )
      RETURNING intervention.id
    ), cancelled AS (
      UPDATE notification_outbox outbox SET
        status = 'cancelled',
        updated_at = now(),
        last_error = jsonb_build_object('reason', 'verification-resolved-auto-close')
      FROM resolved
      WHERE outbox.intervention_id = resolved.id
        AND outbox.status IN ('pending', 'sending', 'failed')
      RETURNING outbox.id
    )
    SELECT id FROM resolved`, [
    shopId,
    workOrderId,
    verificationInterventionReasonCodes,
    resolutionTimestamp,
    String(resolvedBy || 'verification-cleared'),
  ]);
  return result.rows.map((row) => row.id);
};

const resolveTerminalReturnRefundVerifications = async (client, {
  shopId,
  workOrderId = null,
  allowActiveLease = false,
  resolvedBy = 'terminal-return-refund-reconciliation',
} = {}) => {
  if (!client?.query || !shopId) return [];
  const result = await client.query(`
    WITH candidates AS MATERIALIZED (
      SELECT verification.id, verification.shop_id, verification.work_order_id,
        verification.ordinary_instance_id, verification.stage,
        verification.detected_at, work_order.external_order_number,
        refund.aftersale_number, refund.action_state, refund.completed_at
      FROM verification_locations verification
      JOIN work_orders work_order
        ON work_order.id = verification.work_order_id
        AND work_order.shop_id = verification.shop_id
      JOIN return_refunds refund
        ON refund.work_order_id = work_order.id
        AND refund.shop_id = work_order.shop_id
      WHERE verification.shop_id = $1
        AND ($2::uuid IS NULL OR verification.work_order_id = $2)
        AND verification.work_order_id IS NOT NULL
        AND verification.status IN ('detected', 'waiting-human', 'verification-required')
        AND verification.resolved_at IS NULL
        AND work_order.scenario_code = 'return-refund'
        AND work_order.status IN ('completed', 'archived')
        AND work_order.runtime_status IN ('completed', 'archived')
        AND work_order.completion_state IN ('confirmed', 'not-applicable')
        AND work_order.completion_confirmation_method IS NOT NULL
        AND refund.action_state IN ('auto-refunded', 'manual-completed', 'skipped-not-found')
        AND refund.completed_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved', 'unknown')
        )
        AND ($3::boolean OR NOT EXISTS (
          SELECT 1 FROM shop_runtime_state runtime
          WHERE runtime.shop_id = work_order.shop_id
            AND runtime.current_work_order_id = work_order.id
            AND runtime.lease_token IS NOT NULL
            AND runtime.lease_expires_at > now()
        ))
      FOR UPDATE OF verification SKIP LOCKED
    ), resolved AS (
      UPDATE verification_locations verification SET
        status = 'resolved',
        resolved_at = coalesce(verification.resolved_at, now())
      FROM candidates candidate
      WHERE verification.id = candidate.id
      RETURNING verification.id, verification.shop_id, verification.work_order_id,
        verification.ordinary_instance_id, verification.stage,
        verification.detected_at, verification.resolved_at
    ), audited AS (
      INSERT INTO audit_events
        (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
         payload, deduplication_key)
      SELECT candidate.shop_id, candidate.work_order_id,
        candidate.ordinary_instance_id, $4,
        'terminal-return-refund-verification-resolved',
        jsonb_build_object(
          'verificationId', candidate.id,
          'orderNumber', candidate.external_order_number,
          'aftersaleNumber', candidate.aftersale_number,
          'stage', candidate.stage,
          'detectedAt', candidate.detected_at,
          'refundActionState', candidate.action_state,
          'refundCompletedAt', candidate.completed_at,
          'strategy', 'terminal-business-state-with-no-unresolved-effect'
        ),
        'terminal-return-refund-verification:' || candidate.id::text
      FROM candidates candidate
      JOIN resolved ON resolved.id = candidate.id
      ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
      RETURNING work_order_id
    )
    SELECT * FROM resolved ORDER BY detected_at`, [
    shopId,
    workOrderId,
    Boolean(allowActiveLease),
    String(resolvedBy || 'terminal-return-refund-reconciliation'),
  ]);
  const resolvedWorkOrderIds = [...new Set(
    result.rows.map((row) => row.work_order_id).filter(Boolean),
  )];
  for (const resolvedWorkOrderId of resolvedWorkOrderIds) {
    await resolveClearedVerificationInterventions(client, {
      shopId,
      workOrderId: resolvedWorkOrderId,
      resolvedBy,
    });
  }
  return result.rows;
};

// A terminal work order is authoritative only after its completion fields are
// persisted. Reconcile any challenge rows left behind by a terminal payload,
// but never clear a row while an external effect is still uncertain.
const resolveTerminalWorkOrderVerifications = async (client, {
  shopId,
  workOrderId = null,
  allowActiveLease = false,
  resolvedBy = 'terminal-work-order-verification-reconciliation',
} = {}) => {
  if (!client?.query || !shopId) return [];
  const result = await client.query(`
    WITH candidates AS MATERIALIZED (
      SELECT verification.id, verification.shop_id, verification.work_order_id,
        verification.ordinary_instance_id, verification.stage,
        verification.detected_at, work_order.external_order_number
      FROM verification_locations verification
      JOIN work_orders work_order
        ON work_order.id = verification.work_order_id
        AND work_order.shop_id = verification.shop_id
      WHERE verification.shop_id = $1
        AND ($2::uuid IS NULL OR verification.work_order_id = $2)
        AND verification.status IN ('detected', 'waiting-human', 'verification-required')
        AND verification.resolved_at IS NULL
        AND work_order.status IN ('completed', 'archived')
        AND work_order.runtime_status IN ('completed', 'archived')
        AND work_order.completion_state IN ('confirmed', 'not-applicable')
        AND work_order.completion_confirmation_method IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved', 'unknown')
        )
        AND ($3::boolean OR NOT EXISTS (
          SELECT 1 FROM shop_runtime_state runtime
          WHERE runtime.shop_id = work_order.shop_id
            AND runtime.current_work_order_id = work_order.id
            AND runtime.lease_token IS NOT NULL
            AND runtime.lease_expires_at > now()
        ))
      FOR UPDATE OF verification SKIP LOCKED
    ), resolved AS (
      UPDATE verification_locations verification SET
        status = 'resolved',
        resolved_at = coalesce(verification.resolved_at, now())
      FROM candidates candidate
      WHERE verification.id = candidate.id
      RETURNING verification.id, verification.shop_id, verification.work_order_id,
        verification.ordinary_instance_id, verification.stage,
        verification.detected_at, verification.resolved_at
    ), audited AS (
      INSERT INTO audit_events
        (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
         payload, deduplication_key)
      SELECT candidate.shop_id, candidate.work_order_id,
        candidate.ordinary_instance_id, $4,
        'terminal-work-order-verification-resolved',
        jsonb_build_object(
          'verificationId', candidate.id,
          'orderNumber', candidate.external_order_number,
          'stage', candidate.stage,
          'detectedAt', candidate.detected_at,
          'resolvedAt', resolved.resolved_at,
          'externalActionsReplayed', false,
          'strategy', 'terminal-work-order-state-with-no-unresolved-effect'
        ),
        'terminal-work-order-verification:' || candidate.id::text
      FROM candidates candidate
      JOIN resolved ON resolved.id = candidate.id
      ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
      RETURNING work_order_id
    )
    SELECT * FROM resolved ORDER BY detected_at`, [
    shopId,
    workOrderId,
    Boolean(allowActiveLease),
    String(resolvedBy || 'terminal-work-order-verification-reconciliation'),
  ]);
  const resolvedWorkOrderIds = [...new Set(
    result.rows.map((row) => row.work_order_id).filter(Boolean),
  )];
  for (const resolvedWorkOrderId of resolvedWorkOrderIds) {
    await resolveClearedVerificationInterventions(client, {
      shopId,
      workOrderId: resolvedWorkOrderId,
      resolvedBy,
    });
  }
  return result.rows;
};

const ordinaryInstanceIsTerminal = (instance) => Boolean(
  instance?.completed_at
  || terminalOrdinaryInstanceStatuses.has(String(instance?.status || '').toLowerCase())
  || terminalOrdinaryInstanceStatuses.has(String(instance?.runtime_status || '').toLowerCase()),
);

const isRecoverableBrowserTruthPause = (workOrder) => {
  if (String(workOrder?.status || '').toLowerCase() !== 'paused'
    || workOrder?.completion_state !== 'pending'
    || !['ready', 'retry-authorized'].includes(workOrder?.recovery_state)
    || workOrder?.frontend_visibility !== 'operational') return false;
  const reason = String(workOrder?.manual_review_reason || '').normalize('NFKC');
  return /(?:未找到目标待处理工单|目标待处理工单[^，。；;]*未找到|普通工单详情订单号[^，。；;]*(?:渲染|加载|读取)[^，。；;]*(?:超时|失败|未出现|为空)|页面\s*body[^，。；;]*(?:超时|失败|未出现|为空)|read-only page render failed)/iu.test(reason);
};

const promoteNextDeferredOrdinaryInstance = async (client, { workOrderId = null, shopId = null } = {}) => {
  const eligible = await client.query(`
    SELECT work_order.id, work_order.current_ordinary_instance_id
    FROM ordinary_work_order_instances deferred
    JOIN work_orders work_order ON work_order.id = deferred.work_order_id
    WHERE deferred.status = 'deferred'
      AND deferred.identity_status = 'verified'
      AND work_order.frontend_visibility = 'operational'
      AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
      AND ($1::uuid IS NULL OR work_order.id = $1)
      AND ($2::text IS NULL OR work_order.shop_id = $2)
      AND (
        work_order.current_ordinary_instance_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM ordinary_work_order_instances current_instance
          WHERE current_instance.id = work_order.current_ordinary_instance_id
            AND current_instance.work_order_id = work_order.id
            AND (
              current_instance.completed_at IS NOT NULL
              OR lower(current_instance.status) IN ('completed','archived','resolved','manual-completed')
              OR lower(current_instance.runtime_status) IN ('completed','archived','resolved','manual-completed')
              OR (
                lower(current_instance.status) = 'paused'
                AND lower(current_instance.runtime_status) = 'paused'
              )
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM shop_runtime_state runtime
        WHERE runtime.current_work_order_id = work_order.id
          AND runtime.lease_token IS NOT NULL
          AND runtime.lease_expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.status IN ('reserved','unknown')
          AND (
            effect.ordinary_instance_id IS NULL
            OR effect.ordinary_instance_id = work_order.current_ordinary_instance_id
          )
      )
    ORDER BY deferred.first_discovered_at, deferred.last_discovered_at, deferred.id
    FOR UPDATE OF work_order SKIP LOCKED
    LIMIT 1`, [workOrderId, shopId]);
  if (!eligible.rowCount) return null;

  const selectedWorkOrderId = eligible.rows[0].id;
  const previousCurrentInstanceId = eligible.rows[0].current_ordinary_instance_id;
  const candidate = await client.query(`
    SELECT instance.*
    FROM ordinary_work_order_instances instance
    WHERE instance.work_order_id = $1
      AND instance.status = 'deferred'
      AND instance.identity_status = 'verified'
    ORDER BY instance.first_discovered_at, instance.last_discovered_at, instance.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1`, [selectedWorkOrderId]);
  if (!candidate.rowCount) return null;

  const instance = candidate.rows[0];
  if (previousCurrentInstanceId && previousCurrentInstanceId !== instance.id) {
    const yielded = await client.query(`
      UPDATE ordinary_work_order_instances SET
        status = 'deferred', runtime_status = 'waiting',
        next_attempt_at = coalesce(next_attempt_at, now() + interval '2 minutes'),
        updated_at = now()
      WHERE id = $1 AND work_order_id = $2
        AND lower(status) = 'paused' AND lower(runtime_status) = 'paused'
      RETURNING id, current_step, manual_review_reason`, [previousCurrentInstanceId, selectedWorkOrderId]);
    if (yielded.rowCount) {
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
        VALUES ($1,$2,$3,'system','paused-ordinary-instance-yielded',$4::jsonb,$5)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        instance.shop_id,
        selectedWorkOrderId,
        previousCurrentInstanceId,
        stringifyJsonb({
          yieldedToOrdinaryInstanceId: instance.id,
          previousStep: yielded.rows[0].current_step || null,
          previousReason: yielded.rows[0].manual_review_reason || null,
          yieldedAt: new Date().toISOString(),
        }),
        `paused-ordinary-instance-yielded:${previousCurrentInstanceId}:${instance.id}`,
      ]);
    }
  }
  await client.query(`
    UPDATE ordinary_work_order_instances SET
      status = 'queued', runtime_status = 'queued', current_step = 'pdd-discovered',
      next_attempt_at = NULL, started_at = NULL, completed_at = NULL,
      completion_method = NULL, manual_review_reason = NULL, updated_at = now()
    WHERE id = $1 AND work_order_id = $2`, [instance.id, selectedWorkOrderId]);
  const promoted = await client.query(`
    UPDATE work_orders SET
      shop_id = $2,
      work_order_type = $3,
      scenario_code = $4,
      status = 'queued',
      runtime_status = 'queued',
      current_step = 'pdd-discovered',
      current_ordinary_instance_id = $5,
      payload = $6::jsonb,
      manual_review_reason = NULL,
      next_attempt_at = NULL,
      completion_state = 'pending',
      completion_confirmation_method = NULL,
      completion_confirmed_at = NULL,
      handling_classification = 'automated',
      classification_source = 'system',
      classification_reason = NULL,
      classification_updated_at = now(),
      recovery_state = 'ready',
      recovery_reason = NULL,
      recovery_version = recovery_version + 1,
      recovery_updated_at = now(),
      updated_at = now()
    WHERE id = $1
    RETURNING id, shop_id, external_order_number, work_order_type, status,
      current_ordinary_instance_id`, [
    selectedWorkOrderId,
    instance.shop_id,
    instance.work_order_type,
    instance.scenario_code,
    instance.id,
    stringifyJsonb(instance.payload || {}),
  ]);
  if (!promoted.rowCount) return null;
  await client.query(`
    INSERT INTO audit_events
      (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
    VALUES ($1,$2,$3,'system','ordinary-work-order-instance-promoted',$4::jsonb,$5)
    ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
    instance.shop_id,
    selectedWorkOrderId,
    instance.id,
    stringifyJsonb({
      orderNumber: promoted.rows[0].external_order_number,
      platformCaseKey: instance.platform_case_key,
      workOrderType: instance.work_order_type,
      scenarioCode: instance.scenario_code,
      promotionSource: 'deferred-queue',
      promotedAt: new Date().toISOString(),
    }),
    `ordinary-instance-promoted:${instance.id}`,
  ]);
  return { workOrder: promoted.rows[0], instance: { ...instance, status: 'queued', runtime_status: 'queued' } };
};

const completionConfirmationMethods = new Set([
  'address-change-completed-with-both-service-records',
  'detail-completed',
  'absent-from-pending-list',
  'recovery-delayed-detail-check',
  'handover-detail-completed',
  'handover-absent-from-pending-list',
]);

const completionTruth = (payload = {}, status = null) => {
  const submission = payload?.pddResolutionSubmission || {};
  const archive = payload?.completionArchive || {};
  const completedOrder = payload?.lastCompletedOrder || {};
  const method = submission.confirmationMethod || archive.confirmationMethod
    || completedOrder.confirmationMethod || null;
  const confirmed = (submission.status === 'succeeded'
    || Boolean(archive.orderNumber)
    || Boolean(completedOrder.orderNumber))
    && completionConfirmationMethods.has(method);
  return {
    state: confirmed ? 'confirmed'
      : ['archived', 'completed'].includes(status) ? 'reconciliation-required' : 'pending',
    method,
    confirmedAt: confirmed
      ? submission.completedAt || archive.completedAt || completedOrder.completedAt || null
      : null,
  };
};

const selectClaimedWorkOrder = async (client, workOrderId) => {
  const result = await client.query(`
    SELECT work_order.*,
      instance.platform_case_id AS platform_work_order_id,
      instance.platform_case_key,
      instance.first_discovered_at AS ordinary_first_discovered_at,
      checkpoint.snapshot AS browser_checkpoint,
      checkpoint.source_updated_at AS browser_checkpoint_updated_at,
      EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = work_order.id
          AND effect.status IN ('reserved','unknown')
          AND (
            effect.ordinary_instance_id IS NULL
            OR effect.ordinary_instance_id = work_order.current_ordinary_instance_id
          )
      ) AS has_unresolved_external_effects
      ,(
        SELECT to_jsonb(tms)
        FROM tms_work_orders tms
        WHERE tms.work_order_id = work_order.id
          AND tms.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
          AND tms.status IN ('created', 'succeeded')
        ORDER BY tms.created_at DESC
        LIMIT 1
      ) AS persisted_tms_work_order
    FROM work_orders work_order
    LEFT JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    LEFT JOIN workflow_checkpoints checkpoint
      ON checkpoint.shop_id = work_order.shop_id
      AND checkpoint.work_order_id = work_order.id
      AND checkpoint.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
    WHERE work_order.id = $1`, [workOrderId]);
  return result.rows[0] || null;
};

export async function createPostgresPool(
  connectionString = process.env.DATABASE_URL,
  options = {},
) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  let pg;
  try { pg = await import('pg'); } catch (error) {
    throw new Error('PostgreSQL adapter requires the pg package', { cause: error });
  }
  const { Pool } = pg.default || pg;
  const configuredMax = Number(options.max ?? process.env.WORKER_DB_POOL_MAX ?? 0);
  const pool = new Pool({
    connectionString,
    ...(Number.isFinite(configuredMax) && configuredMax > 0 ? { max: Math.floor(configuredMax) } : {}),
    ...(options.applicationName ? { application_name: String(options.applicationName) } : {}),
  });
  await pool.query('SELECT 1');
  return pool;
}

export class PostgresWorkflowRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async countRecentResolvedPddVerificationsForWorkOrder({
    shopId,
    workOrderId,
    ordinaryInstanceId = null,
    stage,
    since,
  }) {
    if (!shopId || !workOrderId || !stage || !Number.isFinite(Date.parse(since))) {
      throw new Error('Exact work order, verification stage and time are required');
    }
    const result = await this.pool.query(`
      SELECT count(*)::int AS total
      FROM verification_locations
      WHERE shop_id = $1 AND work_order_id = $2
        AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
        AND system_name = 'pdd' AND stage = $4
        AND status = 'resolved' AND resolved_at IS NOT NULL
        AND detected_at >= $5::timestamptz
    `, [shopId, workOrderId, ordinaryInstanceId, stage, since]);
    return Number(result.rows[0]?.total || 0);
  }

  async resolveMisboundVerificationLocations({ shopId } = {}) {
    if (!shopId) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const resolved = await resolveMisboundVerificationLocations(client, {
        shopId,
        resolvedBy: 'worker-misbound-verification-reconciliation',
      });
      await client.query('COMMIT');
      return resolved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveTerminalReturnRefundVerifications({ shopId, workOrderId = null } = {}) {
    if (!shopId) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const resolved = await resolveTerminalReturnRefundVerifications(client, {
        shopId,
        workOrderId,
        resolvedBy: 'worker-terminal-return-refund-reconciliation',
      });
      await client.query('COMMIT');
      return resolved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveTerminalWorkOrderVerifications({ shopId, workOrderId = null } = {}) {
    if (!shopId) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const resolved = await resolveTerminalWorkOrderVerifications(client, {
        shopId,
        workOrderId,
        resolvedBy: 'worker-terminal-work-order-verification-reconciliation',
      });
      await client.query('COMMIT');
      return resolved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // A browser can finish a challenge and persist the verification row before
  // the worker process is restarted or loses its resident-command heartbeat.
  // In that case the work order remains in a verification step even though no
  // active verification row or lease exists. Requeue only that exact safe
  // state; uncertain external effects, active leases, held recovery rows and
  // terminal work orders are deliberately excluded.
  async requeueResolvedVerificationWorkOrders({
    shopId,
    workOrderId = null,
    lookbackMs = 24 * 60 * 60_000,
    limit = 100,
  } = {}) {
    const normalizedShopId = String(shopId || '').trim();
    if (!normalizedShopId) return [];
    const normalizedWorkOrderId = workOrderId == null ? null : String(workOrderId).trim();
    if (normalizedWorkOrderId
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(normalizedWorkOrderId)) return [];
    const boundedLookbackMs = Math.min(
      7 * 24 * 60 * 60_000,
      Math.max(60_000, Number(lookbackMs) || 24 * 60 * 60_000),
    );
    const boundedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH latest AS MATERIALIZED (
          SELECT DISTINCT ON (verification.work_order_id)
            verification.id AS verification_id,
            verification.work_order_id,
            verification.ordinary_instance_id,
            verification.stage,
            verification.detected_at,
            verification.resolved_at
          FROM verification_locations verification
          WHERE verification.shop_id = $1
            AND ($4::uuid IS NULL OR verification.work_order_id = $4::uuid)
            AND lower(verification.system_name) = 'pdd'
            AND verification.work_order_id IS NOT NULL
            AND verification.status = 'resolved'
            AND verification.resolved_at IS NOT NULL
            AND verification.resolved_at >= now()
              - ($2::bigint * interval '1 millisecond')
          ORDER BY verification.work_order_id,
            verification.resolved_at DESC, verification.detected_at DESC
        ), candidates AS MATERIALIZED (
          SELECT latest.*, work_order.scenario_code,
            work_order.status AS work_order_status,
            work_order.runtime_status,
            work_order.current_step,
            work_order.recovery_state
          FROM latest
          JOIN work_orders work_order
            ON work_order.id = latest.work_order_id
            AND work_order.shop_id = $1
          WHERE work_order.current_step IN (
              'return-refund-verification-required',
              'human-verification-required'
            )
            AND work_order.status IN ('paused', 'retry-ready', 'processing')
            AND work_order.runtime_status IN ('waiting', 'verification', 'retry-ready', 'processing')
            AND coalesce(work_order.completion_state, 'pending') = 'pending'
            AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
            AND coalesce(work_order.recovery_state, 'ready') IN ('ready', 'retry-authorized')
            -- A previous clear is a one-shot wakeup, not perpetual permission
            -- to erase backoff after a newer verification failure.
            AND NOT EXISTS (
              SELECT 1 FROM audit_events consumed_clear
              WHERE consumed_clear.deduplication_key = 'resolved-verification-requeue:'
                || work_order.id::text || ':' || latest.verification_id::text
            )
            AND (work_order.scenario_code IS DISTINCT FROM 'return-refund' OR NOT EXISTS (
              SELECT 1 FROM return_refunds newer_check
              WHERE newer_check.work_order_id = work_order.id
                -- Finishing the same verification-blocked claim writes its
                -- scan timestamp shortly after the browser cleared the gate.
                -- Only a later check should invalidate this one-shot clear.
                AND newer_check.last_scanned_at > latest.resolved_at + interval '30 seconds'
            ))
            AND NOT EXISTS (
              SELECT 1
              FROM verification_locations active_verification
              WHERE active_verification.shop_id = work_order.shop_id
                AND active_verification.work_order_id = work_order.id
                AND active_verification.status IN ('detected', 'waiting-human', 'verification-required')
                AND active_verification.resolved_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM shop_runtime_state runtime
              WHERE runtime.shop_id = work_order.shop_id
                AND runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
            AND NOT EXISTS (
              SELECT 1
              FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.status IN ('reserved', 'unknown')
            )
          ORDER BY latest.resolved_at ASC
          LIMIT $3
        ), requeued AS (
          UPDATE work_orders work_order SET
            status = 'retry-ready',
            runtime_status = 'waiting',
            current_step = 'verification-cleared-retry-ready',
            next_attempt_at = least(coalesce(work_order.next_attempt_at, now()), now()),
            payload = (
              coalesce(work_order.payload, '{}'::jsonb)
                - 'verificationLocation'
                - 'verificationStage'
                - 'verificationFocus'
                - 'error'
                - 'manualReview'
            ) || jsonb_build_object(
              'verificationRecovery', jsonb_build_object(
                'trigger', 'resolved-verification-reconciliation',
                'status', 'cleared',
                'verificationId', candidates.verification_id::text,
                'completedAt', candidates.resolved_at,
                'externalActionsReplayed', false
              ),
              'updatedAt', now()::text
            ),
            updated_at = now()
          FROM candidates
          WHERE work_order.id = candidates.work_order_id
            AND work_order.shop_id = $1
          RETURNING work_order.id, work_order.scenario_code,
            work_order.current_ordinary_instance_id,
            candidates.verification_id, candidates.ordinary_instance_id,
            candidates.stage, candidates.detected_at, candidates.resolved_at
        )
        SELECT * FROM requeued`, [
        normalizedShopId,
        boundedLookbackMs,
        boundedLimit,
        normalizedWorkOrderId,
      ]);

      for (const row of result.rows) {
        if (row.current_ordinary_instance_id || row.ordinary_instance_id) {
          const instanceId = row.current_ordinary_instance_id || row.ordinary_instance_id;
          await client.query(`
            UPDATE ordinary_work_order_instances SET
              status = 'retry-ready', runtime_status = 'waiting',
              current_step = 'verification-cleared-retry-ready',
              next_attempt_at = least(coalesce(next_attempt_at, now()), now()),
              updated_at = now()
            WHERE id = $1 AND shop_id = $2`, [instanceId, normalizedShopId]);
        }
        if (row.scenario_code === 'return-refund') {
          await client.query(`
            UPDATE return_refunds SET
              next_check_at = least(coalesce(next_check_at, now()), now()),
              updated_at = now()
            WHERE work_order_id = $1 AND shop_id = $2`, [row.id, normalizedShopId]);
        }
        await resolveClearedVerificationInterventions(client, {
          shopId: normalizedShopId,
          workOrderId: row.id,
          resolvedAt: row.resolved_at || new Date().toISOString(),
          resolvedBy: 'worker-resolved-verification-reconciliation',
        });
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id,
             event_type, payload, deduplication_key)
          VALUES ($1, $2::uuid, $3::uuid, 'worker-verification-reconciliation',
            'resolved-verification-work-order-requeued',
            jsonb_build_object(
              'verificationId', $4::text,
              'stage', $5::text,
              'detectedAt', $6::timestamptz,
              'resolvedAt', $7::timestamptz,
              'externalActionsReplayed', false
            ),
            'resolved-verification-requeue:' || ($2::uuid)::text || ':' || $4::text)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          normalizedShopId,
          row.id,
          row.current_ordinary_instance_id || row.ordinary_instance_id || null,
          row.verification_id,
          row.stage || null,
          row.detected_at || null,
          row.resolved_at || null,
        ]);
      }
      await client.query('COMMIT');
      return result.rows.map((row) => ({
        workOrderId: row.id,
        scenarioCode: row.scenario_code,
        verificationId: row.verification_id,
        stage: row.stage,
        detectedAt: row.detected_at,
        resolvedAt: row.resolved_at,
        requeued: true,
        externalActionsReplayed: false,
      }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getReturnRefundRuntimeSettings() {
    const result = await this.pool.query(`
      SELECT key, value FROM system_settings
      WHERE key IN ('return-refund-scan-enabled', 'return-refund-auto-approve-enabled')`);
    const settings = new Map(result.rows.map((row) => [row.key, row.value]));
    return {
      scanEnabled: settings.has('return-refund-scan-enabled')
        ? settings.get('return-refund-scan-enabled') === true : null,
      autoApproveEnabled: settings.has('return-refund-auto-approve-enabled')
        ? settings.get('return-refund-auto-approve-enabled') === true : null,
    };
  }

  async getQueueSnapshot(shopId = null) {
    const params = shopId ? [shopId] : [];
    const filter = shopId ? 'WHERE shop_id = $1' : '';
    const result = await this.pool.query(`
      SELECT
        count(*) FILTER (WHERE status IN ('queued','retry-ready'))::int AS queued,
        count(*) FILTER (WHERE status IN ('queued','retry-ready')
          AND recovery_state IN ('ready','retry-authorized')
          AND (next_attempt_at IS NULL OR next_attempt_at <= now()))::int AS due,
        count(*) FILTER (WHERE status IN ('queued','retry-ready')
          AND recovery_state IN ('ready','retry-authorized')
          AND next_attempt_at > now())::int AS scheduled,
        count(*) FILTER (WHERE status IN ('queued','retry-ready')
          AND coalesce(recovery_state, '') NOT IN ('ready','retry-authorized'))::int AS held,
        min(next_attempt_at) FILTER (WHERE status IN ('queued','retry-ready')
          AND recovery_state IN ('ready','retry-authorized')
          AND next_attempt_at > now()) AS "nextScheduledAt",
        count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status NOT IN ('archived','completed'))::int AS active
      FROM work_orders ${filter}`, params);
    return result.rows[0];
  }

  async releaseExpiredOwnedClaimForAuthenticationBlock({
    shopId,
    workerId,
    system = 'pdd',
    observedStatus = 'authentication-required',
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const runtime = await client.query(`
        SELECT current_work_order_id, lease_token, lease_expires_at
        FROM shop_runtime_state
        WHERE shop_id = $1 AND worker_id = $2
        FOR UPDATE`, [shopId, workerId]);
      const current = runtime.rows[0];
      if (!current?.current_work_order_id || !current.lease_token) {
        await client.query('COMMIT');
        return { released: false, reason: 'no-owned-claim' };
      }
      if (current.lease_expires_at && new Date(current.lease_expires_at) > new Date()) {
        await client.query('COMMIT');
        return { released: false, reason: 'lease-active' };
      }
      const workOrder = await client.query(`
        SELECT id, external_order_number, scenario_code, recovery_state,
          current_ordinary_instance_id
        FROM work_orders
        WHERE id = $1 AND shop_id = $2 AND status IN ('processing','paused')
        FOR UPDATE`, [current.current_work_order_id, shopId]);
      const claimed = workOrder.rows[0];
      if (!claimed) {
        await client.query(`
          UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
            lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
          WHERE shop_id = $1 AND worker_id = $2 AND lease_token = $3`,
        [shopId, workerId, current.lease_token]);
        await client.query('COMMIT');
        return { released: true, reason: 'missing-claim-cleared', workOrderId: current.current_work_order_id };
      }
      if (!['ready', 'retry-authorized'].includes(String(claimed.recovery_state || 'ready'))) {
        await client.query('COMMIT');
        return { released: false, reason: 'recovery-held', workOrderId: claimed.id };
      }
      const uncertain = await client.query(`
        UPDATE external_effects SET status = 'unknown',
          error = coalesce(error, '{}'::jsonb) || jsonb_build_object(
            'reason', 'authentication-blocked-after-lease-expired',
            'markedUnknownAt', now()
          ),
          updated_at = now()
        WHERE shop_id = $1 AND work_order_id = $2 AND status = 'reserved'
          AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
        RETURNING id, effect_type`, [shopId, claimed.id, claimed.current_ordinary_instance_id]);
      const existingUnknown = await client.query(`
        SELECT count(*)::int AS count FROM external_effects
        WHERE shop_id = $1 AND work_order_id = $2 AND status = 'unknown'
          AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid`,
      [shopId, claimed.id, claimed.current_ordinary_instance_id]);
      const unknownExternalEffects = Number(existingUnknown.rows[0]?.count || 0);
      const nextStatus = unknownExternalEffects > 0 ? 'paused' : 'retry-ready';
      const nextStep = unknownExternalEffects > 0
        ? 'external-state-unresolved'
        : 'authentication-blocked-retry-ready';
      await client.query(`
        UPDATE work_orders SET status = $2, runtime_status = $3, current_step = $4,
          payload = payload || jsonb_build_object(
            'authenticationLeaseRecovery', jsonb_build_object(
              'system', $5::text,
              'observedStatus', $6::text,
              'previousLeaseExpiredAt', $7::timestamptz,
              'releasedAt', now()
            )
          ),
          manual_review_reason = CASE WHEN $8::int > 0
            THEN '外部操作结果不确定，必须先只读核对平台状态'
            ELSE NULL END,
          next_attempt_at = CASE WHEN $8::int = 0 THEN now() ELSE NULL END,
          recovery_state = CASE WHEN $8::int > 0 THEN 'held' ELSE 'ready' END,
          recovery_reason = CASE WHEN $8::int > 0 THEN 'unknown-external-effect' ELSE NULL END,
          recovery_version = recovery_version + 1,
          recovery_updated_at = now(), updated_at = now()
        WHERE id = $1`, [claimed.id, nextStatus,
        unknownExternalEffects > 0 ? 'paused' : 'waiting', nextStep, system, observedStatus,
        current.lease_expires_at || null, unknownExternalEffects]);
      await client.query(`
        UPDATE ordinary_work_order_instances SET status = $2, runtime_status = $3,
          current_step = $4, next_attempt_at = CASE WHEN $5::int = 0 THEN now() ELSE NULL END,
          manual_review_reason = CASE WHEN $5::int > 0
            THEN '外部操作结果不确定，必须先只读核对平台状态'
            ELSE NULL END,
          updated_at = now()
        WHERE id = $1`, [claimed.current_ordinary_instance_id, nextStatus,
        unknownExternalEffects > 0 ? 'paused' : 'waiting', nextStep, unknownExternalEffects]);
      await client.query(`
        UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
          lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
        WHERE shop_id = $1 AND worker_id = $2 AND lease_token = $3`,
      [shopId, workerId, current.lease_token]);
      await client.query('COMMIT');
      return {
        released: true,
        reason: unknownExternalEffects > 0 ? 'unknown-external-effect' : 'authentication-blocked',
        workOrderId: claimed.id,
        externalOrderNumber: claimed.external_order_number,
        status: nextStatus,
        unknownExternalEffects,
        markedUnknownEffectIds: uncertain.rows.map((row) => row.id),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverOrphanedReservedExternalEffects({ shopId, minimumAgeMs = 5_000 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query(`
        SELECT effect.id, effect.work_order_id, effect.effect_type,
          work_order.external_order_number, work_order.current_ordinary_instance_id
        FROM external_effects effect
        JOIN work_orders work_order ON work_order.id = effect.work_order_id
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.status IN ('paused', 'retry-ready')
          AND effect.status = 'reserved'
          AND effect.effect_type IN (
            'tms-create', 'pdd-submit', 'evidence-upload', 'pdd-note',
            'oms-manual-allocation'
          )
          AND effect.ordinary_instance_id IS NOT DISTINCT FROM
            work_order.current_ordinary_instance_id
          AND effect.updated_at <= now() - ($2::bigint * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.shop_id = work_order.shop_id
              AND runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
        FOR UPDATE OF effect, work_order`, [shopId, Math.max(0, Number(minimumAgeMs) || 0)]);
      if (!candidates.rowCount) {
        await client.query('COMMIT');
        return [];
      }
      const effectIds = candidates.rows.map((row) => row.id);
      await client.query(`
        UPDATE external_effects SET status = 'unknown',
          error = coalesce(error, '{}'::jsonb) || jsonb_build_object(
            'reason', 'orphaned-reservation-without-active-lease',
            'markedUnknownAt', now()
          ),
          updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'reserved'`, [effectIds]);
      const reconcilableRows = candidates.rows.filter((row) => [
        'tms-create',
        'pdd-submit',
        'pdd-note',
        'oms-manual-allocation',
      ].includes(row.effect_type));
      const reconcilableIds = [...new Set(reconcilableRows.map((row) => row.work_order_id))];
      if (reconcilableIds.length) {
        await client.query(`
          UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
            current_step = 'external-state-reconciliation-ready',
            manual_review_reason = '等待只读核对外部操作结果，禁止重复提交',
            next_attempt_at = now(), recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = recovery_version + 1, recovery_updated_at = now(),
            payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
              'orphanedExternalEffectRecovery', jsonb_build_object(
                'status', 'reconciliation-ready',
                'source', 'reserved-without-active-lease',
                'recoveredAt', now()
              )
            ),
            updated_at = now()
          WHERE id = ANY($1::uuid[])`, [reconcilableIds]);
        await client.query(`
          UPDATE ordinary_work_order_instances instance SET status = 'paused',
            runtime_status = 'paused', current_step = 'external-state-reconciliation-ready',
            manual_review_reason = '等待只读核对外部操作结果，禁止重复提交',
            next_attempt_at = now(), updated_at = now()
          FROM work_orders work_order
          WHERE work_order.id = ANY($1::uuid[])
            AND instance.id = work_order.current_ordinary_instance_id
            AND instance.work_order_id = work_order.id`, [reconcilableIds]);
        for (const workOrderId of reconcilableIds) {
          const rows = candidates.rows.filter((row) => row.work_order_id === workOrderId);
          await client.query(`
            INSERT INTO audit_events
              (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
            VALUES ($1,$2,$3,'system','orphaned-reserved-effects-recovered',$4::jsonb)`, [
            shopId,
            workOrderId,
            rows[0]?.current_ordinary_instance_id || null,
            stringifyJsonb({
              orderNumber: rows[0]?.external_order_number || null,
              effectIds: rows.map((row) => row.id),
              effectTypes: [...new Set(rows.map((row) => row.effect_type))],
              strategy: 'read-only-reconciliation-no-resubmit',
            }),
          ]);
        }
      }
      await client.query('COMMIT');
      return candidates.rows.map((row) => ({
        id: row.id,
        workOrderId: row.work_order_id,
        externalOrderNumber: row.external_order_number,
        effectType: row.effect_type,
        reconciliationReady: reconcilableIds.includes(row.work_order_id),
      }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseOwnedLeaseForIdentityBinding({ shopId, workerId, identityBindingToken }) {
    if (!identityBindingToken) return { released: false, reason: 'binding-token-missing' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const runtime = await client.query(`
        SELECT current_work_order_id, lease_token
        FROM shop_runtime_state
        WHERE shop_id = $1 AND worker_id = $2
        FOR UPDATE`, [shopId, workerId]);
      const workOrderId = runtime.rows[0]?.current_work_order_id || null;
      if (!workOrderId) {
        await client.query('COMMIT');
        return { released: false, reason: 'no-owned-lease' };
      }
      const workOrder = await client.query(`
        SELECT work_order.id, work_order.scenario_code, work_order.status,
          CASE WHEN work_order.scenario_code = 'return-refund' THEN EXISTS (
            SELECT 1 FROM return_refunds refund
            WHERE refund.work_order_id = work_order.id
              AND refund.evidence->>'pddIdentityBindingToken' = $2
          ) ELSE work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' = $2
          END AS identity_matches,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.status IN ('reserved','unknown')
          ) AS uncertain_effect
        FROM work_orders work_order WHERE work_order.id = $1
        FOR UPDATE OF work_order`, [workOrderId, identityBindingToken]);
      const current = workOrder.rows[0];
      if (!current || current.identity_matches || current.uncertain_effect) {
        await client.query('COMMIT');
        return {
          released: false,
          reason: current?.identity_matches ? 'identity-matches'
            : current?.uncertain_effect ? 'uncertain-effect' : 'work-order-missing',
        };
      }
      await client.query(`
        UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
          next_attempt_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('processing','paused')`, [workOrderId]);
      await client.query(`
        UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
          lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
        WHERE shop_id = $1 AND worker_id = $2`, [shopId, workerId]);
      await client.query('COMMIT');
      return { released: true, workOrderId, reason: 'identity-binding-changed' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async bindLegacyPendingOrdersToIdentity({ shopId, identityBindingToken, actualShopName, mallId = null }) {
    const normalizedToken = String(identityBindingToken || '').trim();
    const normalizedShopName = String(actualShopName || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const normalizedMallId = /^\d{5,30}$/u.test(String(mallId || '').trim())
      ? String(mallId).trim() : null;
    if (!shopId || !normalizedToken || !normalizedShopName) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id, instance.identity_status,
          work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' AS previous_binding_token
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.work_order_id = work_order.id
          AND instance.shop_id = work_order.shop_id
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.status IN ('queued','retry-ready')
          AND work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' IS DISTINCT FROM $2
          AND (
            ($4::text IS NOT NULL AND $4 = ANY(ARRAY[
              nullif(work_order.payload->>'pddMallId', ''),
              nullif(work_order.payload->'latestDiscovery'->>'pddMallId', ''),
              nullif(work_order.payload->'pddShopIdentity'->>'mallId', ''),
              nullif(instance.payload->>'pddMallId', ''),
              nullif(instance.payload->'latestDiscovery'->>'pddMallId', ''),
              nullif(instance.payload->'pddShopIdentity'->>'mallId', '')
            ]))
            OR (
              coalesce(
                nullif(work_order.payload->>'pddMallId', ''),
                nullif(work_order.payload->'latestDiscovery'->>'pddMallId', ''),
                nullif(work_order.payload->'pddShopIdentity'->>'mallId', ''),
                nullif(instance.payload->>'pddMallId', ''),
                nullif(instance.payload->'latestDiscovery'->>'pddMallId', ''),
                nullif(instance.payload->'pddShopIdentity'->>'mallId', '')
              ) IS NULL
              AND $3 = ANY(ARRAY[
                nullif(work_order.payload->>'shopNameSnapshot', ''),
                nullif(work_order.payload->>'detectedShopName', ''),
                nullif(work_order.payload->'latestDiscovery'->>'actualShopName', ''),
                nullif(work_order.payload->'pddShopIdentity'->>'actualShopName', ''),
                nullif(instance.payload->>'shopNameSnapshot', ''),
                nullif(instance.payload->>'detectedShopName', ''),
                nullif(instance.payload->'latestDiscovery'->>'actualShopName', ''),
                nullif(instance.payload->'pddShopIdentity'->>'actualShopName', '')
              ])
              AND (
                coalesce(work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken', '') = ''
                OR (
                  instance.identity_status = 'verified'
                  AND instance.platform_case_key IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM shops ambiguous_shop
                    WHERE ambiguous_shop.enabled
                      AND ambiguous_shop.id <> $1
                      AND ambiguous_shop.expected_shop_name = $3
                  )
                )
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.status IN ('reserved','unknown')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM work_orders other
            JOIN shop_runtime_state runtime
              ON runtime.current_work_order_id = other.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
            WHERE other.shop_id <> work_order.shop_id
              AND other.external_order_number = work_order.external_order_number
          )
          AND NOT EXISTS (
            SELECT 1
            FROM work_orders other
            JOIN external_effects effect ON effect.work_order_id = other.id
            WHERE other.shop_id <> work_order.shop_id
              AND other.external_order_number = work_order.external_order_number
              AND effect.status IN ('reserved','unknown')
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, instance`, [
        shopId,
        normalizedToken,
        normalizedShopName,
        normalizedMallId,
      ]);
      for (const workOrder of candidates.rows) {
        const identityPatch = stringifyJsonb({
          pddIdentityBindingToken: normalizedToken,
          pddMallId: normalizedMallId,
          detectedShopName: normalizedShopName,
          shopNameSnapshot: normalizedShopName,
        });
        const discoveryPatch = stringifyJsonb({
          shopId,
          actualShopName: normalizedShopName,
          pddMallId: normalizedMallId,
          pddIdentityBindingToken: normalizedToken,
          identityBackfilledAt: new Date().toISOString(),
        });
        await client.query(`
          UPDATE work_orders SET
            payload = coalesce(payload, '{}'::jsonb)
              || $2::jsonb
              || jsonb_build_object(
                'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb) || $3::jsonb
              ),
            updated_at = now()
          WHERE id = $1`, [workOrder.id, identityPatch, discoveryPatch]);
        await client.query(`
          UPDATE ordinary_work_order_instances SET
            payload = coalesce(payload, '{}'::jsonb)
              || $2::jsonb
              || jsonb_build_object(
                'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb) || $3::jsonb
              ),
            updated_at = now()
          WHERE id = $1`, [workOrder.current_ordinary_instance_id, identityPatch, discoveryPatch]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,'worker-page-detection','legacy-work-order-identity-bound',$3::jsonb,$4)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          stringifyJsonb({
            orderNumber: workOrder.external_order_number,
            actualShopName: normalizedShopName,
            bindingToken: normalizedToken,
            previousBindingToken: workOrder.previous_binding_token || null,
            identityStatus: workOrder.identity_status,
          }),
          `legacy-work-order-identity-bound:${workOrder.id}:${normalizedToken}`,
        ]);
      }
      const ordinaryRelocationCandidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id, instance.identity_status,
          work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' AS previous_binding_token,
          work_order.shop_id AS previous_shop_id, instance.platform_case_key
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.work_order_id = work_order.id
          AND instance.shop_id = work_order.shop_id
        WHERE work_order.shop_id <> $1
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.status IN ('queued','retry-ready')
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND (
            (instance.identity_status = 'verified' AND instance.platform_case_key IS NOT NULL)
            OR (
              instance.identity_status = 'legacy-unverified'
              AND instance.platform_case_key IS NULL
              AND $3 = ANY(ARRAY[
                nullif(work_order.payload->'pddShopIdentity'->>'actualShopName', ''),
                nullif(instance.payload->'pddShopIdentity'->>'actualShopName', '')
              ])
              AND NOT EXISTS (
                SELECT 1 FROM shops ambiguous_shop
                WHERE ambiguous_shop.enabled
                  AND ambiguous_shop.id <> $1
                  AND ambiguous_shop.expected_shop_name = $3
              )
            )
          )
          AND work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' IS DISTINCT FROM $2
          AND (
            ($4::text IS NOT NULL AND $4 = ANY(ARRAY[
              nullif(work_order.payload->>'pddMallId', ''),
              nullif(work_order.payload->'latestDiscovery'->>'pddMallId', ''),
              nullif(work_order.payload->'pddShopIdentity'->>'mallId', ''),
              nullif(instance.payload->>'pddMallId', ''),
              nullif(instance.payload->'latestDiscovery'->>'pddMallId', ''),
              nullif(instance.payload->'pddShopIdentity'->>'mallId', '')
            ]))
            OR (
              coalesce(
                nullif(work_order.payload->>'pddMallId', ''),
                nullif(work_order.payload->'latestDiscovery'->>'pddMallId', ''),
                nullif(work_order.payload->'pddShopIdentity'->>'mallId', ''),
                nullif(instance.payload->>'pddMallId', ''),
                nullif(instance.payload->'latestDiscovery'->>'pddMallId', ''),
                nullif(instance.payload->'pddShopIdentity'->>'mallId', '')
              ) IS NULL
              AND $3 = ANY(ARRAY[
                nullif(work_order.payload->>'shopNameSnapshot', ''),
                nullif(work_order.payload->>'detectedShopName', ''),
                nullif(work_order.payload->'latestDiscovery'->>'actualShopName', ''),
                nullif(work_order.payload->'pddShopIdentity'->>'actualShopName', ''),
                nullif(instance.payload->>'shopNameSnapshot', ''),
                nullif(instance.payload->>'detectedShopName', ''),
                nullif(instance.payload->'latestDiscovery'->>'actualShopName', ''),
                nullif(instance.payload->'pddShopIdentity'->>'actualShopName', '')
              ])
            )
          )
          -- Any prior action retains the source shop in its idempotency key
          -- and saved progress; moving it would make that action replayable.
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM work_orders target
            WHERE target.id <> work_order.id
              AND target.shop_id = $1
              AND target.external_order_number = work_order.external_order_number
              AND target.scenario_code IS DISTINCT FROM 'return-refund'
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, instance`, [
        shopId,
        normalizedToken,
        normalizedShopName,
        normalizedMallId,
      ]);
      const relocatedOrdinaryCandidates = [];
      for (const workOrder of ordinaryRelocationCandidates.rows) {
        const identityPatch = stringifyJsonb({
          pddIdentityBindingToken: normalizedToken,
          pddMallId: normalizedMallId,
          detectedShopName: normalizedShopName,
          shopNameSnapshot: normalizedShopName,
        });
        const discoveryPatch = stringifyJsonb({
          shopId,
          actualShopName: normalizedShopName,
          pddMallId: normalizedMallId,
          pddIdentityBindingToken: normalizedToken,
          identityRelocatedAt: new Date().toISOString(),
        });
        const relocated = await client.query(`
          UPDATE work_orders SET shop_id = $2,
            payload = coalesce(payload, '{}'::jsonb)
              || $3::jsonb
              || jsonb_build_object(
                'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb) || $4::jsonb
              ),
            updated_at = now()
          WHERE id = $1 AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_orders.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM work_orders target
            WHERE target.id <> work_orders.id
              AND target.shop_id = $2
              AND target.external_order_number = work_orders.external_order_number
              AND target.scenario_code IS DISTINCT FROM 'return-refund'
          )
          RETURNING id`, [workOrder.id, shopId, identityPatch, discoveryPatch]);
        if (!relocated.rowCount) continue;
        await client.query(`
          UPDATE ordinary_work_order_instances SET shop_id = $2,
            payload = coalesce(payload, '{}'::jsonb)
              || $3::jsonb
              || jsonb_build_object(
                'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb) || $4::jsonb
              ),
            updated_at = now()
          WHERE work_order_id = $1`, [workOrder.id, shopId, identityPatch, discoveryPatch]);
        for (const table of [
          'external_effects',
          'evidence_assets',
          'verification_locations',
          'audit_events',
          'workflow_events',
          'operator_commands',
          'manual_interventions',
        ]) {
          await client.query(`UPDATE ${table} SET shop_id = $2 WHERE work_order_id = $1`, [workOrder.id, shopId]);
        }
        await relocateWorkflowCheckpoint(client, { workOrderId: workOrder.id, shopId });
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'worker-page-detection','pending-ordinary-work-order-shop-corrected',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          workOrder.current_ordinary_instance_id,
          stringifyJsonb({
            orderNumber: workOrder.external_order_number,
            platformCaseKey: workOrder.platform_case_key,
            actualShopName: normalizedShopName,
            mallId: normalizedMallId,
            bindingToken: normalizedToken,
            previousBindingToken: workOrder.previous_binding_token || null,
            previousShopId: workOrder.previous_shop_id,
          }),
          `pending-ordinary-work-order-shop-corrected:${workOrder.id}:${shopId}:${normalizedToken}`,
        ]);
        relocatedOrdinaryCandidates.push(workOrder);
      }
      const legacyPausedReadOnlyRelocationCandidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id,
          work_order.shop_id AS previous_shop_id,
          detail.detail_url,
          substring(detail.detail_url from '[?&]id=([0-9]{6,30})(&|$)') AS platform_case_id
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.work_order_id = work_order.id
          AND instance.shop_id = work_order.shop_id
        JOIN shops target_shop
          ON target_shop.id = $1
          AND target_shop.expected_shop_name = $3
        JOIN pdd_shop_runtime_bindings binding
          ON binding.shop_id = target_shop.id
          AND binding.binding_token::text = $2
          AND binding.actual_shop_name = target_shop.expected_shop_name
          AND ($4::text IS NULL OR binding.mall_id = $4)
        CROSS JOIN LATERAL (
          SELECT min(tab->>'url') AS detail_url,
            count(DISTINCT tab->>'url')::int AS detail_url_count
          FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(work_order.payload->'derivedTabs') = 'array'
              THEN work_order.payload->'derivedTabs'
            ELSE '[]'::jsonb
          END) tab
          WHERE coalesce(tab->>'purpose', '') LIKE 'pdd-work-order%'
            AND coalesce(tab->>'openedAt', '') <> ''
            AND coalesce(tab->>'url', '')
              ~ '^https://mms[.]pinduoduo[.]com/aftersales/work_order/tododetail/?[?]id=[0-9]{6,30}(&|$)'
        ) detail
        WHERE work_order.shop_id <> $1
          AND work_order.frontend_visibility = 'operational'
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.status = 'paused'
          AND work_order.runtime_status = 'paused'
          AND work_order.completion_state = 'pending'
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND instance.identity_status = 'legacy-unverified'
          AND instance.platform_case_id IS NULL
          AND instance.platform_case_key IS NULL
          AND instance.detail_url IS NULL
          AND detail.detail_url_count = 1
          AND coalesce(work_order.payload->'pddShopIdentity'->>'profileFingerprint', '') <> ''
          AND $3 = ANY(ARRAY[
            nullif(work_order.payload->'pddShopIdentity'->>'actualShopName', ''),
            nullif(instance.payload->'pddShopIdentity'->>'actualShopName', '')
          ])
          AND (
            coalesce(
              nullif(work_order.payload->'pddShopIdentity'->>'mallId', ''),
              nullif(instance.payload->'pddShopIdentity'->>'mallId', '')
            ) IS NULL
            OR $4::text = ANY(ARRAY[
              nullif(work_order.payload->'pddShopIdentity'->>'mallId', ''),
              nullif(instance.payload->'pddShopIdentity'->>'mallId', '')
            ])
          )
          AND coalesce(work_order.manual_review_reason, '')
            ~ '(未找到目标待处理工单|目标待处理工单[^，。；;]*未找到|普通工单详情订单号[^，。；;]*(渲染|加载|读取)[^，。；;]*(超时|失败|未出现|为空)|页面[[:space:]]*body[^，。；;]*(超时|失败|未出现|为空)|read-only page render failed)'
          AND NOT EXISTS (
            SELECT 1 FROM shops ambiguous_shop
            WHERE ambiguous_shop.enabled
              AND ambiguous_shop.id <> $1
              AND ambiguous_shop.expected_shop_name = $3
          )
          AND NOT EXISTS (
            SELECT 1 FROM ordinary_work_order_instances existing_instance
            WHERE existing_instance.platform_case_key =
              'pdd-work-order:' || substring(detail.detail_url from '[?&]id=([0-9]{6,30})(&|$)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND (
                effect.status IN ('reserved','unknown')
                OR (effect.effect_type = 'pdd-submit' AND effect.status = 'succeeded')
                OR (effect.effect_type = 'evidence-upload' AND effect.status = 'failed')
              )
          )
          AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM work_orders target
            WHERE target.id <> work_order.id
              AND target.shop_id = $1
              AND target.external_order_number = work_order.external_order_number
              AND target.scenario_code IS DISTINCT FROM 'return-refund'
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, instance`, [
        shopId,
        normalizedToken,
        normalizedShopName,
        normalizedMallId,
      ]);
      for (const workOrder of legacyPausedReadOnlyRelocationCandidates.rows) {
        const platformCaseKey = `pdd-work-order:${workOrder.platform_case_id}`;
        const scheduledAt = new Date().toISOString();
        const identityPatch = {
          pddIdentityBindingToken: normalizedToken,
          pddMallId: normalizedMallId,
          detectedShopName: normalizedShopName,
          shopNameSnapshot: normalizedShopName,
        };
        const recovery = {
          status: 'ready',
          strategy: 'legacy-page-identity-relocation-then-read-only-pdd-detail',
          previousShopId: workOrder.previous_shop_id,
          targetShopId: shopId,
          platformCaseId: workOrder.platform_case_id,
          platformCaseKey,
          detailUrl: workOrder.detail_url,
          externalActionsReplayed: false,
          scheduledAt,
        };
        const relocated = await client.query(`
          UPDATE work_orders SET shop_id = $2,
            status = 'paused', runtime_status = 'paused',
            current_step = 'pdd-detail-read-only-reconciliation-ready',
            manual_review_reason = '等待只读核对拼多多详情状态，禁止重复提交',
            next_attempt_at = now(), recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = recovery_version + 1, recovery_updated_at = now(),
            payload = (coalesce(payload, '{}'::jsonb) - 'manualReview' - 'error')
              || $3::jsonb
              || jsonb_build_object(
                'detailUrl', $4::text,
                'platformCaseId', $5::text,
                'platformCaseKey', $6::text,
                'step', 'pdd-detail-read-only-reconciliation-ready',
                'latestDiscovery', coalesce(payload->'latestDiscovery', '{}'::jsonb)
                  || jsonb_build_object(
                    'shopId', $2::text,
                    'actualShopName', $7::text,
                    'pddMallId', $8::text,
                    'pddIdentityBindingToken', $9::text,
                    'identityRelocatedAt', now()
                  ),
                'externalStateReconciliationRetry', jsonb_build_object(
                  'attempts', 0, 'maxAttempts', 3, 'scheduledAt', now(),
                  'recoverySource', 'cross-shop-legacy-pdd-read-only'
                ),
                'crossShopLegacyPddReadOnlyRecovery', $10::jsonb
              ),
            updated_at = now()
          WHERE id = $1 AND shop_id = $11
            AND status = 'paused' AND completion_state = 'pending'
          RETURNING id`, [
          workOrder.id,
          shopId,
          stringifyJsonb(identityPatch),
          workOrder.detail_url,
          workOrder.platform_case_id,
          platformCaseKey,
          normalizedShopName,
          normalizedMallId,
          normalizedToken,
          stringifyJsonb(recovery),
          workOrder.previous_shop_id,
        ]);
        if (!relocated.rowCount) throw new Error(
          `Legacy paused work order ${workOrder.external_order_number} changed before read-only relocation`,
        );
        await client.query(`
          UPDATE ordinary_work_order_instances SET shop_id = $2,
            platform_case_id = $3, platform_case_key = $4, detail_url = $5,
            identity_status = 'verified', status = 'paused', runtime_status = 'paused',
            current_step = 'pdd-detail-read-only-reconciliation-ready',
            manual_review_reason = '等待只读核对拼多多详情状态，禁止重复提交',
            next_attempt_at = now(),
            payload = (coalesce(payload, '{}'::jsonb) - 'manualReview' - 'error')
              || $6::jsonb
              || jsonb_build_object(
                'detailUrl', $5::text,
                'platformCaseId', $3::text,
                'platformCaseKey', $4::text,
                'step', 'pdd-detail-read-only-reconciliation-ready',
                'crossShopLegacyPddReadOnlyRecovery', $7::jsonb
              ),
            updated_at = now()
          WHERE id = $1 AND work_order_id = $8`, [
          workOrder.current_ordinary_instance_id,
          shopId,
          workOrder.platform_case_id,
          platformCaseKey,
          workOrder.detail_url,
          stringifyJsonb(identityPatch),
          stringifyJsonb(recovery),
          workOrder.id,
        ]);
        for (const table of [
          'external_effects',
          'evidence_assets',
          'verification_locations',
          'audit_events',
          'workflow_events',
          'operator_commands',
          'manual_interventions',
        ]) {
          await client.query(`UPDATE ${table} SET shop_id = $2 WHERE work_order_id = $1`, [
            workOrder.id,
            shopId,
          ]);
        }
        await relocateWorkflowCheckpoint(client, { workOrderId: workOrder.id, shopId });
        await client.query(`
          UPDATE cross_shop_order_conflicts SET status = 'resolved',
            resolved_shop_id = $2, resolved_by = 'worker-page-detection',
            resolved_at = now(),
            details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
              'resolution', 'legacy-page-identity-read-only-relocation',
              'platformCaseId', $3::text,
              'detailUrl', $4::text,
              'externalActionsReplayed', false
            )
          WHERE external_order_number = $1 AND status = 'open'`, [
          workOrder.external_order_number,
          shopId,
          workOrder.platform_case_id,
          workOrder.detail_url,
        ]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'worker-page-detection',
            'legacy-paused-cross-shop-read-only-recovered',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          workOrder.current_ordinary_instance_id,
          stringifyJsonb({ orderNumber: workOrder.external_order_number, ...recovery }),
          `legacy-paused-cross-shop-read-only-recovered:${workOrder.id}:${shopId}:${normalizedToken}`,
        ]);
      }
      const relocationCandidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          NULL::uuid AS current_ordinary_instance_id,
          NULL::text AS identity_status,
          refund.evidence->>'pddIdentityBindingToken' AS previous_binding_token,
          refund.aftersale_number, work_order.shop_id AS previous_shop_id,
          (work_order.recovery_state = 'held'
            AND work_order.recovery_reason = 'owner-deleted') AS owner_deleted_hold
        FROM work_orders work_order
        JOIN return_refunds refund ON refund.work_order_id = work_order.id
          AND refund.shop_id = work_order.shop_id
        WHERE work_order.shop_id <> $1
          AND work_order.scenario_code = 'return-refund'
          AND (
            work_order.status IN ('queued','retry-ready','paused')
            OR (
              work_order.status = 'archived'
              AND work_order.recovery_state = 'held'
              AND work_order.recovery_reason = 'owner-deleted'
            )
          )
          AND (
            (
              work_order.recovery_state <> 'held'
            )
            OR (
              work_order.recovery_state = 'held'
              AND work_order.recovery_reason = 'owner-deleted'
              AND work_order.completion_state = 'pending'
              AND refund.action_state IN (
                'discovered', 'waiting-logistics', 'ready', 'manual-review',
                'submitting', 'verification-required', 'page-error'
              )
            )
          )
          AND (
            ($3::text IS NOT NULL AND $3 = ANY(ARRAY[
              nullif(refund.evidence->>'pddMallId', ''),
              nullif(work_order.payload->>'pddMallId', ''),
              nullif(work_order.payload->'returnRefund'->'evidence'->>'pddMallId', '')
            ]))
            OR (
              (
                coalesce(refund.evidence->>'pddIdentityBindingToken', '') = ''
                OR (
                  work_order.recovery_state = 'held'
                  AND work_order.recovery_reason = 'owner-deleted'
                )
              )
              AND coalesce(
                nullif(refund.evidence->>'pddMallId', ''),
                nullif(work_order.payload->>'pddMallId', ''),
                nullif(work_order.payload->'returnRefund'->'evidence'->>'pddMallId', '')
              ) IS NULL
              AND $2::text = ANY(ARRAY[
                nullif(refund.evidence->>'detectedShopName', ''),
                nullif(refund.evidence->>'shopNameSnapshot', ''),
                nullif(refund.evidence->>'actualShopName', ''),
                nullif(work_order.payload->>'detectedShopName', ''),
                nullif(work_order.payload->>'shopNameSnapshot', '')
              ])
              AND NOT EXISTS (
                SELECT 1
                FROM pdd_shop_runtime_bindings other_binding
                WHERE other_binding.shop_id <> $1
                  AND other_binding.actual_shop_name = $2
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND (
                effect.status IN ('reserved','unknown')
                OR (
                  effect.effect_type = 'pdd-return-refund'
                  AND effect.status = 'succeeded'
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1
            FROM return_refunds other_refund
            JOIN work_orders other ON other.id = other_refund.work_order_id
            WHERE other_refund.work_order_id <> refund.work_order_id
              AND other_refund.aftersale_number = refund.aftersale_number
              AND other.shop_id = $1
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, refund`, [shopId, normalizedShopName, normalizedMallId]);
      for (const workOrder of relocationCandidates.rows) {
        const restoredFromOwnerDeleted = workOrder.owner_deleted_hold === true;
        const identityPatch = stringifyJsonb({
          pddIdentityBindingToken: normalizedToken,
          pddMallId: normalizedMallId,
          detectedShopName: normalizedShopName,
          shopNameSnapshot: normalizedShopName,
        });
        const recoveryPatch = restoredFromOwnerDeleted ? stringifyJsonb({
          ownerDeletedReturnRefundRecovery: {
            status: 'retry-ready',
            previousShopId: workOrder.previous_shop_id,
            targetShopId: shopId,
            actualShopName: normalizedShopName,
            mallId: normalizedMallId,
            recoveredAt: new Date().toISOString(),
            strategy: 'unique-current-pdd-identity-relocation',
          },
        }) : '{}';
        await client.query(`
          UPDATE work_orders SET shop_id = $2,
            status = CASE WHEN $4::boolean THEN 'retry-ready' ELSE status END,
            runtime_status = CASE WHEN $4::boolean THEN 'retry-ready' ELSE runtime_status END,
            current_step = CASE WHEN $4::boolean
              THEN 'return-refund-identity-relocated-recheck-ready' ELSE current_step END,
            manual_review_reason = CASE WHEN $4::boolean THEN NULL ELSE manual_review_reason END,
            next_attempt_at = CASE WHEN $4::boolean THEN now() ELSE next_attempt_at END,
            recovery_state = CASE WHEN $4::boolean THEN 'ready' ELSE recovery_state END,
            recovery_reason = CASE WHEN $4::boolean THEN NULL ELSE recovery_reason END,
            recovery_version = recovery_version + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
            recovery_updated_at = CASE WHEN $4::boolean THEN now() ELSE recovery_updated_at END,
            completion_state = CASE WHEN $4::boolean THEN 'pending' ELSE completion_state END,
            completion_confirmation_method = CASE WHEN $4::boolean
              THEN NULL ELSE completion_confirmation_method END,
            completion_confirmed_at = CASE WHEN $4::boolean
              THEN NULL ELSE completion_confirmed_at END,
            payload = (CASE WHEN $4::boolean
                THEN coalesce(payload, '{}'::jsonb) - 'manualReview' - 'error'
                ELSE coalesce(payload, '{}'::jsonb)
              END) || $3::jsonb || $5::jsonb,
            updated_at = now()
          WHERE id = $1`, [
          workOrder.id,
          shopId,
          identityPatch,
          restoredFromOwnerDeleted,
          recoveryPatch,
        ]);
        await client.query(`
          UPDATE return_refunds SET shop_id = $2,
            evidence = coalesce(evidence, '{}'::jsonb) || $3::jsonb
              || jsonb_build_object(
                'identityBackfilledAt', now(),
                'ownerDeletedIdentityRecovered', $4::boolean
              ),
            next_check_at = CASE WHEN $4::boolean THEN now() ELSE next_check_at END,
            updated_at = now()
          WHERE work_order_id = $1`, [
          workOrder.id,
          shopId,
          identityPatch,
          restoredFromOwnerDeleted,
        ]);
        await client.query(`
          UPDATE shop_runtime_state
          SET status = 'idle', current_work_order_id = NULL,
            lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE current_work_order_id = $1
            AND shop_id <> $2
            AND (lease_token IS NULL OR lease_expires_at <= now())`, [workOrder.id, shopId]);
        for (const table of [
          'external_effects',
          'evidence_assets',
          'verification_locations',
          'audit_events',
          'workflow_events',
          'operator_commands',
          'manual_interventions',
        ]) {
          await client.query(`UPDATE ${table} SET shop_id = $2 WHERE work_order_id = $1`, [workOrder.id, shopId]);
        }
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,'worker-page-detection',
            CASE WHEN $5::boolean THEN 'owner-deleted-return-refund-shop-restored'
              ELSE 'pending-return-refund-shop-corrected' END,
            $3::jsonb,$4)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          stringifyJsonb({
            orderNumber: workOrder.external_order_number,
            aftersaleNumber: workOrder.aftersale_number,
            actualShopName: normalizedShopName,
            mallId: normalizedMallId,
            bindingToken: normalizedToken,
            previousBindingToken: workOrder.previous_binding_token || null,
            previousShopId: workOrder.previous_shop_id,
          }),
          `${restoredFromOwnerDeleted ? 'owner-deleted-return-refund-shop-restored' : 'pending-return-refund-shop-corrected'}:${workOrder.id}:${shopId}:${normalizedToken}`,
          restoredFromOwnerDeleted,
        ]);
      }
      const refundCandidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          NULL::uuid AS current_ordinary_instance_id,
          NULL::text AS identity_status,
          refund.evidence->>'pddIdentityBindingToken' AS previous_binding_token,
          refund.aftersale_number
        FROM work_orders work_order
        JOIN return_refunds refund ON refund.work_order_id = work_order.id
          AND refund.shop_id = work_order.shop_id
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code = 'return-refund'
          AND work_order.status IN ('queued','retry-ready')
          AND work_order.recovery_state <> 'held'
          AND refund.evidence->>'pddIdentityBindingToken' IS DISTINCT FROM $2
          AND (
            ($4::text IS NOT NULL AND $4 = ANY(ARRAY[
              nullif(refund.evidence->>'pddMallId', ''),
              nullif(work_order.payload->>'pddMallId', ''),
              nullif(work_order.payload->'returnRefund'->'evidence'->>'pddMallId', '')
            ]))
            OR (
              coalesce(
                nullif(refund.evidence->>'pddMallId', ''),
                nullif(work_order.payload->>'pddMallId', ''),
                nullif(work_order.payload->'returnRefund'->'evidence'->>'pddMallId', '')
              ) IS NULL
              AND $3 = ANY(ARRAY[
                nullif(refund.evidence->>'detectedShopName', ''),
                nullif(refund.evidence->>'shopNameSnapshot', ''),
                nullif(refund.evidence->>'actualShopName', ''),
                nullif(work_order.payload->>'detectedShopName', ''),
                nullif(work_order.payload->>'shopNameSnapshot', '')
              ])
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.status IN ('reserved','unknown')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM return_refunds other_refund
            JOIN work_orders other ON other.id = other_refund.work_order_id
            WHERE other.shop_id <> work_order.shop_id
              AND other_refund.aftersale_number = refund.aftersale_number
              AND other.status IN ('processing','queued','retry-ready')
              AND other.recovery_state <> 'held'
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, refund`, [shopId, normalizedToken, normalizedShopName, normalizedMallId]);
      for (const workOrder of refundCandidates.rows) {
        const identityPatch = stringifyJsonb({
          pddIdentityBindingToken: normalizedToken,
          pddMallId: normalizedMallId,
          detectedShopName: normalizedShopName,
          shopNameSnapshot: normalizedShopName,
        });
        await client.query(`
          UPDATE work_orders SET payload = coalesce(payload, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
          WHERE id = $1`, [workOrder.id, identityPatch]);
        await client.query(`
          UPDATE return_refunds SET
            evidence = coalesce(evidence, '{}'::jsonb) || $2::jsonb
              || jsonb_build_object('identityBackfilledAt', now()),
            updated_at = now()
          WHERE work_order_id = $1`, [workOrder.id, identityPatch]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,'worker-page-detection','legacy-return-refund-identity-bound',$3::jsonb,$4)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          stringifyJsonb({
            orderNumber: workOrder.external_order_number,
            aftersaleNumber: workOrder.aftersale_number,
            actualShopName: normalizedShopName,
            mallId: normalizedMallId,
            bindingToken: normalizedToken,
            previousBindingToken: workOrder.previous_binding_token || null,
          }),
          `legacy-return-refund-identity-bound:${workOrder.id}:${normalizedToken}`,
        ]);
      }
      // A refund confirmation can be dispatched immediately before a CAPTCHA
      // appears.  If the operator later logs the same PDD shop in again, the
      // runtime binding token changes while the unresolved effect correctly
      // prevents an ordinary legacy rebind.  That leaves the order permanently
      // unclaimable even though the next operation is read-only reconciliation.
      // Rebind only with exact same-shop name + mall-id proof, and retain the
      // unresolved effect so processReturnRefund cannot replay the click.
      const refundReadOnlyReconciliationCandidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          NULL::uuid AS current_ordinary_instance_id,
          NULL::text AS identity_status,
          refund.evidence->>'pddIdentityBindingToken' AS previous_binding_token,
          refund.aftersale_number,
          effect.status AS effect_status
        FROM work_orders work_order
        JOIN return_refunds refund ON refund.work_order_id = work_order.id
          AND refund.shop_id = work_order.shop_id
        JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = work_order.shop_id
          AND binding.binding_token::text = $2
          AND binding.actual_shop_name = $3
          AND binding.mall_id = $4
        JOIN LATERAL (
          SELECT unresolved.status
          FROM external_effects unresolved
          WHERE unresolved.work_order_id = work_order.id
            AND unresolved.effect_type = 'pdd-return-refund'
            AND unresolved.status IN ('reserved','unknown')
          ORDER BY unresolved.updated_at DESC, unresolved.id DESC
          LIMIT 1
        ) effect ON true
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code = 'return-refund'
          AND work_order.status IN ('queued','retry-ready')
          AND work_order.recovery_state <> 'held'
          AND refund.action_state IN ('page-error','verification-required')
          AND refund.evidence->>'pddIdentityBindingToken' IS DISTINCT FROM $2
          AND $4::text IS NOT NULL
          AND $4 = ANY(ARRAY[
            nullif(refund.evidence->>'pddMallId', ''),
            nullif(work_order.payload->>'pddMallId', ''),
            nullif(work_order.payload->'returnRefund'->'evidence'->>'pddMallId', '')
          ])
          AND $3 = ANY(ARRAY[
            nullif(refund.evidence->>'detectedShopName', ''),
            nullif(refund.evidence->>'shopNameSnapshot', ''),
            nullif(refund.evidence->>'actualShopName', ''),
            nullif(work_order.payload->>'detectedShopName', ''),
            nullif(work_order.payload->>'shopNameSnapshot', '')
          ])
          AND NOT EXISTS (
            SELECT 1 FROM external_effects unsafe_effect
            WHERE unsafe_effect.work_order_id = work_order.id
              AND unsafe_effect.status IN ('reserved','unknown')
              AND unsafe_effect.effect_type <> 'pdd-return-refund'
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects succeeded_effect
            WHERE succeeded_effect.work_order_id = work_order.id
              AND succeeded_effect.effect_type = 'pdd-return-refund'
              AND succeeded_effect.status = 'succeeded'
          )
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1
            FROM return_refunds other_refund
            JOIN work_orders other ON other.id = other_refund.work_order_id
            WHERE other_refund.work_order_id <> refund.work_order_id
              AND other_refund.aftersale_number = refund.aftersale_number
              AND other.shop_id <> work_order.shop_id
              AND other.status IN ('processing','queued','retry-ready')
              AND other.recovery_state <> 'held'
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, refund`, [
        shopId,
        normalizedToken,
        normalizedShopName,
        normalizedMallId,
      ]);
      for (const workOrder of refundReadOnlyReconciliationCandidates.rows) {
        const reboundAt = new Date().toISOString();
        const identityPatch = stringifyJsonb({
          pddIdentityBindingToken: normalizedToken,
          pddMallId: normalizedMallId,
          detectedShopName: normalizedShopName,
          shopNameSnapshot: normalizedShopName,
        });
        const reconciliationPatch = stringifyJsonb({
          returnRefundReadOnlyIdentityRebound: {
            status: 'retry-ready',
            previousBindingToken: workOrder.previous_binding_token || null,
            bindingToken: normalizedToken,
            actualShopName: normalizedShopName,
            mallId: normalizedMallId,
            effectStatus: workOrder.effect_status,
            externalActionReplay: false,
            reboundAt,
          },
        });
        await client.query(`
          UPDATE work_orders SET
            status = 'retry-ready', runtime_status = 'waiting',
            current_step = 'return-refund-read-only-reconciliation-retry-ready',
            next_attempt_at = now(),
            payload = coalesce(payload, '{}'::jsonb) || $2::jsonb || $3::jsonb,
            updated_at = now()
          WHERE id = $1`, [workOrder.id, identityPatch, reconciliationPatch]);
        await client.query(`
          UPDATE return_refunds SET
            evidence = coalesce(evidence, '{}'::jsonb) || $2::jsonb
              || jsonb_build_object(
                'identityBackfilledAt', now(),
                'readOnlyReconciliationIdentityRebound', true
              ),
            next_check_at = now(), updated_at = now()
          WHERE work_order_id = $1`, [workOrder.id, identityPatch]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,'worker-page-detection',
            'return-refund-read-only-reconciliation-identity-rebound',$3::jsonb,$4)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          stringifyJsonb({
            orderNumber: workOrder.external_order_number,
            aftersaleNumber: workOrder.aftersale_number,
            actualShopName: normalizedShopName,
            mallId: normalizedMallId,
            bindingToken: normalizedToken,
            previousBindingToken: workOrder.previous_binding_token || null,
            effectStatus: workOrder.effect_status,
            externalActionReplay: false,
            reboundAt,
          }),
          `return-refund-read-only-reconciliation-identity-rebound:${workOrder.id}:${normalizedToken}`,
        ]);
      }
      const tmsTicketCorrelationCandidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id,
          work_order.payload->'tmsWorkOrder'->>'ticketId' AS saved_ticket_id,
          work_order.payload->'tmsWorkOrder'->>'ticketNo' AS saved_ticket_no,
          work_order.payload->'tmsDuplicateCheck'->>'ticketId' AS observed_ticket_id,
          work_order.payload->'tmsDuplicateCheck'->>'ticketNo' AS observed_ticket_no,
          work_order.payload->'tmsDuplicateCheck'->>'candidateCount' AS candidate_count,
          work_order.payload->'tmsDuplicateCheck'->>'selectionStrategy' AS selection_strategy,
          work_order.payload->'tmsDuplicateCheck'->'decisionComparison'->>'matches'
            AS decision_matches,
          work_order.payload->'tmsDuplicateCheck'->'suborderComparison'->>'provablyDifferent'
            AS suborder_provably_different
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.work_order_id = work_order.id
          AND instance.shop_id = work_order.shop_id
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.status = 'paused'
          AND work_order.current_step = 'manual-review-blocked'
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND instance.identity_status = 'verified'
          AND instance.platform_case_key IS NOT NULL
          AND work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' = $2
          AND work_order.payload->'tmsWorkOrder'->>'status' = 'created'
          AND work_order.payload->'tmsDuplicateCheck'->>'status' = 'matched'
          AND (
            work_order.payload->'tmsDuplicateCheck'->>'selectionStrategy'
              IN ('saved-ticket-identifier','only-row')
            OR (
              work_order.payload->'tmsDuplicateCheck'->>'selectionStrategy'
                = 'saved-ticket-identifier-only-row'
              AND work_order.payload->'tmsDuplicateCheck'->>'candidateCount' = '1'
              AND nullif(work_order.payload->'tmsWorkOrder'->>'ticketNo', '') IS NOT NULL
              AND work_order.payload->'tmsWorkOrder'->>'ticketNo'
                = work_order.payload->'tmsDuplicateCheck'->>'ticketNo'
              AND work_order.payload->'tmsDuplicateCheck'->'decisionComparison'->>'matches'
                = 'true'
              AND work_order.payload->'tmsDuplicateCheck'->'suborderComparison'->>'provablyDifferent'
                = 'false'
            )
          )
          AND work_order.manual_review_reason LIKE '%tms-ticket-recovery%'
          AND work_order.manual_review_reason LIKE '%标识与页面记录不一致%'
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.status IN ('reserved','unknown')
          )
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, instance`, [shopId, normalizedToken]);
      for (const workOrder of tmsTicketCorrelationCandidates.rows) {
        const recovery = {
          status: 'retry-ready',
          reason: 'tms-ticket-record-correlation-fixed',
          recoveredAt: new Date().toISOString(),
          savedTicketId: workOrder.saved_ticket_id || null,
          savedTicketNo: workOrder.saved_ticket_no || null,
          observedTicketId: workOrder.observed_ticket_id || null,
          observedTicketNo: workOrder.observed_ticket_no || null,
          candidateCount: Number(workOrder.candidate_count || 0),
          selectionStrategy: workOrder.selection_strategy || null,
          decisionMatches: workOrder.decision_matches === 'true',
          suborderProvablyDifferent: workOrder.suborder_provably_different === 'true',
        };
        await client.query(`
          UPDATE work_orders SET
            status = 'retry-ready', runtime_status = 'retry-ready',
            current_step = 'tms-ticket-record-correlation-retry-ready',
            manual_review_reason = NULL, next_attempt_at = now(),
            payload = coalesce(payload, '{}'::jsonb)
              || jsonb_build_object(
                'step', 'tms-ticket-record-correlation-retry-ready',
                'manualReview', NULL,
                'error', NULL,
                'tmsTicketRecordCorrelationRecovery', $2::jsonb
              ),
            recovery_version = recovery_version + 1,
            recovery_updated_at = now(), updated_at = now()
          WHERE id = $1`, [workOrder.id, stringifyJsonb(recovery)]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'worker-page-detection',
            'tms-ticket-record-correlation-pause-recovered',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          workOrder.current_ordinary_instance_id,
          stringifyJsonb({ orderNumber: workOrder.external_order_number, ...recovery }),
          `tms-ticket-record-correlation-pause-recovered:${workOrder.id}:${normalizedToken}`,
        ]);
      }
      const tmsEvidenceCompatibilityCandidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id,
          work_order.payload->'tmsWorkOrder'->>'ticketId' AS ticket_id,
          work_order.payload->'tmsWorkOrder'->>'ticketNo' AS ticket_no,
          work_order.payload->'tmsDuplicateCheck'->'identity'->'values'->>'物流问题'
            AS actual_problem_type,
          work_order.payload->'tmsDuplicateCheck'->'identity'->'values'->>'客服备注'
            AS actual_remark
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.work_order_id = work_order.id
          AND instance.shop_id = work_order.shop_id
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.status = 'paused'
          AND work_order.current_step = 'flow-paused'
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND instance.identity_status = 'verified'
          AND instance.platform_case_key IS NOT NULL
          AND work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' = $2
          AND work_order.payload->'tmsWorkOrder'->>'status' = 'created'
          AND work_order.payload->'tmsWorkOrder'->>'problemType' = '拦截退回'
          AND work_order.payload->'tmsDuplicateCheck'->>'status' = 'matched'
          AND work_order.payload->'tmsDuplicateCheck'->>'recovery'
            = 'unique-visible-ticket-rebound'
          AND work_order.payload->'tmsDuplicateCheck'->'identity'->'values'->>'物流问题'
            = '拒收'
          AND coalesce(
            work_order.payload->'tmsDuplicateCheck'->'identity'->'values'->>'客服备注',
            ''
          ) ~ '(拒收|召回|退回|拦截)'
          AND work_order.payload->>'error'
            LIKE 'TMS 截图克隆区域的物流问题或客服备注与本次要求不匹配:%'
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.status IN ('reserved','unknown')
          )
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
        ORDER BY work_order.created_at, work_order.id
        FOR UPDATE OF work_order, instance`, [shopId, normalizedToken]);
      for (const workOrder of tmsEvidenceCompatibilityCandidates.rows) {
        const recovery = {
          status: 'retry-ready',
          reason: 'tms-refusal-recall-evidence-compatible',
          recoveredAt: new Date().toISOString(),
          ticketId: workOrder.ticket_id || null,
          ticketNo: workOrder.ticket_no || null,
          actualProblemType: workOrder.actual_problem_type || null,
          actualRemark: workOrder.actual_remark || null,
        };
        await client.query(`
          UPDATE work_orders SET
            status = 'retry-ready', runtime_status = 'retry-ready',
            current_step = 'tms-evidence-compatible-retry-ready',
            manual_review_reason = NULL, next_attempt_at = now(),
            payload = coalesce(payload, '{}'::jsonb)
              || jsonb_build_object(
                'step', 'tms-evidence-compatible-retry-ready',
                'manualReview', NULL,
                'error', NULL,
                'tmsEvidenceScreenshot', NULL,
                'tmsEvidenceCompatibilityRecovery', $2::jsonb
              ),
            recovery_version = recovery_version + 1,
            recovery_updated_at = now(), updated_at = now()
          WHERE id = $1`, [workOrder.id, stringifyJsonb(recovery)]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'worker-page-detection',
            'tms-evidence-compatibility-pause-recovered',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          workOrder.current_ordinary_instance_id,
          stringifyJsonb({ orderNumber: workOrder.external_order_number, ...recovery }),
          `tms-evidence-compatibility-pause-recovered:${workOrder.id}:${normalizedToken}`,
        ]);
      }
      await client.query('COMMIT');
      return [
        ...candidates.rows,
        ...relocatedOrdinaryCandidates,
        ...legacyPausedReadOnlyRelocationCandidates.rows,
        ...relocationCandidates.rows,
        ...refundCandidates.rows,
        ...refundReadOnlyReconciliationCandidates.rows,
        ...tmsTicketCorrelationCandidates.rows,
        ...tmsEvidenceCompatibilityCandidates.rows,
      ];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // A worker can exit after claiming a work order but before it hands the
  // lease back.  Normally the next claim cycle repairs that state through the
  // runtime lease.  If the runtime row was already cleared, the work order
  // remains `processing` forever and is no longer claimable.  Recover only
  // old refund waits/errors only with current identity and no unresolved effect
  // or verification; preserve the existing refund decision and next check time.
  async recoverOrphanedReturnRefundClaims({ shopId, identityBindingToken, minimumAgeMs = 5 * 60_000 }) {
    if (!identityBindingToken) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query(`
        SELECT w.id, w.external_order_number, w.current_step,
          refund.action_state, refund.next_check_at
        FROM work_orders w
        JOIN return_refunds refund ON refund.work_order_id = w.id AND refund.shop_id = w.shop_id
        JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = w.shop_id
        WHERE w.shop_id = $1 AND w.scenario_code = 'return-refund'
          AND w.status = 'processing' AND w.completion_state = 'pending'
          AND w.recovery_state = 'ready'
          AND coalesce(w.frontend_visibility, 'operational') = 'operational'
          AND w.updated_at <= now() - ($2::bigint * interval '1 millisecond')
          AND refund.action_state IN ('ready', 'waiting-logistics', 'page-error')
          AND refund.completed_at IS NULL
          AND binding.binding_token::text = $3
          AND refund.evidence->>'pddIdentityBindingToken' = $3
          AND refund.evidence->>'pddMallId' = binding.mall_id
          AND NOT EXISTS (SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.shop_id = w.shop_id AND runtime.current_work_order_id = w.id
              AND runtime.lease_token IS NOT NULL AND runtime.lease_expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = w.id AND effect.status IN ('reserved','unknown'))
          AND NOT EXISTS (SELECT 1 FROM verification_locations verification
            WHERE verification.work_order_id = w.id AND verification.resolved_at IS NULL
              AND verification.status IN ('detected','waiting-human','verification-required'))
        ORDER BY w.updated_at FOR UPDATE OF w SKIP LOCKED LIMIT 50`,
      [shopId, Math.max(60_000, Number(minimumAgeMs) || 5 * 60_000), identityBindingToken]);
      const recovered = [];
      for (const row of candidates.rows) {
        const step = row.action_state === 'waiting-logistics' ? 'return-refund-waiting-logistics'
          : row.action_state === 'page-error' ? 'return-refund-page-error' : 'return-refund-ready';
        const recovery = { previousStep: row.current_step, actionState: row.action_state,
          recoveredAt: new Date().toISOString(), externalActionsReplayed: false };
        await client.query(`UPDATE work_orders SET status='retry-ready', runtime_status='waiting',
          current_step=$2, next_attempt_at=coalesce($3::timestamptz,now()),
          payload=coalesce(payload,'{}'::jsonb)||jsonb_build_object('returnRefundOrphanRecovery',$4::jsonb),
          updated_at=now() WHERE id=$1`, [row.id, step, row.next_check_at, stringifyJsonb(recovery)]);
        await client.query(`INSERT INTO audit_events
          (shop_id,work_order_id,actor_id,event_type,payload)
          VALUES($1,$2,'system','return-refund-orphan-recovered',$3::jsonb)`,
        [shopId,row.id,stringifyJsonb(recovery)]);
        recovered.push({ workOrderId: row.id, externalOrderNumber: row.external_order_number, currentStep: step });
      }
      await client.query('COMMIT');
      return recovered;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  // Ordinary orders may also have orphaned claims. Unknown effects continue
  // through their existing read-only reconciliation path.
  async recoverOrphanedProcessingClaims({ shopId, minimumAgeMs = 5 * 60_000 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          work_order.scenario_code, work_order.current_ordinary_instance_id,
          work_order.current_step
        FROM work_orders work_order
        WHERE work_order.shop_id = $1
          AND work_order.status = 'processing'
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.updated_at <= now() - ($2::bigint * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.shop_id = work_order.shop_id
              AND runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
        ORDER BY work_order.updated_at ASC
        FOR UPDATE OF work_order SKIP LOCKED
        LIMIT 50`, [shopId, Math.max(0, Number(minimumAgeMs) || 0)]);
      if (!candidates.rowCount) {
        await client.query('COMMIT');
        return [];
      }

      const recovered = [];
      for (const candidate of candidates.rows) {
        const markedUnknown = await client.query(`
          UPDATE external_effects SET status = 'unknown',
            error = coalesce(error, '{}'::jsonb) || jsonb_build_object(
              'reason', 'orphaned-processing-without-active-lease',
              'markedUnknownAt', now()
            ),
            updated_at = now()
          WHERE work_order_id = $1
            AND status = 'reserved'
            AND ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
          RETURNING id, effect_type`, [
          candidate.id,
          candidate.current_ordinary_instance_id,
        ]);
        const unresolved = await client.query(`
          SELECT count(*)::int AS count
          FROM external_effects
          WHERE work_order_id = $1
            AND status IN ('reserved', 'unknown')
            AND ordinary_instance_id IS NOT DISTINCT FROM $2::uuid`, [
          candidate.id,
          candidate.current_ordinary_instance_id,
        ]);
        const hasUnresolved = Number(unresolved.rows[0]?.count || 0) > 0;
        const nextStatus = hasUnresolved ? 'paused' : 'retry-ready';
        const nextRuntimeStatus = hasUnresolved ? 'paused' : 'waiting';
        const nextStep = hasUnresolved
          ? 'external-state-reconciliation-ready'
          : 'orphaned-processing-retry-ready';
        const nextReason = hasUnresolved
          ? '等待只读核对外部操作结果，禁止重复提交'
          : null;
        const recovery = {
          status: 'recovered',
          source: 'processing-without-active-lease',
          previousStep: candidate.current_step || null,
          recoveredAt: new Date().toISOString(),
          externalActionsReplayed: false,
          markedUnknownEffectIds: markedUnknown.rows.map((row) => row.id),
          unresolvedExternalEffects: hasUnresolved,
        };
        await client.query(`
          UPDATE work_orders SET status = $2, runtime_status = $3,
            current_step = $4,
            manual_review_reason = $5,
            next_attempt_at = now(),
            recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = recovery_version + 1,
            recovery_updated_at = now(),
            payload = coalesce(payload, '{}'::jsonb)
              || jsonb_build_object('orphanedProcessingRecovery', $6::jsonb),
            updated_at = now()
          WHERE id = $1`, [
          candidate.id,
          nextStatus,
          nextRuntimeStatus,
          nextStep,
          nextReason,
          stringifyJsonb(recovery),
        ]);
        if (candidate.current_ordinary_instance_id) {
          await client.query(`
            UPDATE ordinary_work_order_instances SET status = $2,
              runtime_status = $3, current_step = $4,
              manual_review_reason = $5, next_attempt_at = now(), updated_at = now()
            WHERE id = $1`, [
            candidate.current_ordinary_instance_id,
            nextStatus,
            nextRuntimeStatus,
            nextStep,
            nextReason,
          ]);
        }
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id,
             event_type, payload)
          VALUES ($1,$2,$3,'system','orphaned-processing-recovered',$4::jsonb)`, [
          shopId,
          candidate.id,
          candidate.current_ordinary_instance_id || null,
          stringifyJsonb({
            orderNumber: candidate.external_order_number,
            scenarioCode: candidate.scenario_code,
            ...recovery,
            nextStatus,
            nextStep,
          }),
        ]);
        recovered.push({
          workOrderId: candidate.id,
          externalOrderNumber: candidate.external_order_number,
          scenarioCode: candidate.scenario_code,
          previousStep: candidate.current_step || null,
          status: nextStatus,
          currentStep: nextStep,
          unresolvedExternalEffects: hasUnresolved,
        });
      }
      await client.query('COMMIT');
      return recovered;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // A reconciliation claim can survive a worker/browser interruption after
  // its runtime lease has already been cleared. Release only an old,
  // lease-free claim back to the read-only reconciliation queue. Unknown
  // external effects remain unknown; this method never retries or rewrites
  // an external operation.
  async recoverStaleExternalStateReconciliations({ shopId, minimumAgeMs = 10 * 60_000 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query(`
        SELECT work_order.id, work_order.external_order_number,
          work_order.scenario_code, work_order.current_ordinary_instance_id,
          work_order.current_step, work_order.runtime_status,
          work_order.recovery_updated_at
        FROM work_orders work_order
        WHERE work_order.shop_id = $1
          AND work_order.status = 'paused'
          AND work_order.runtime_status IN ('processing', 'verification')
          AND work_order.recovery_state = 'reconciling'
          AND coalesce(work_order.recovery_updated_at, work_order.updated_at,
            work_order.created_at)
            <= now() - ($2::bigint * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.shop_id = work_order.shop_id
              AND runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
        ORDER BY coalesce(work_order.recovery_updated_at, work_order.updated_at,
          work_order.created_at) ASC
        FOR UPDATE OF work_order SKIP LOCKED
        LIMIT 50`, [shopId, Math.max(0, Number(minimumAgeMs) || 0)]);
      if (!candidates.rowCount) {
        await client.query('COMMIT');
        return [];
      }

      const recovered = [];
      for (const candidate of candidates.rows) {
        const recovery = {
          status: 'released',
          source: 'stale-reconciling-without-active-lease',
          previousStep: candidate.current_step || null,
          previousRuntimeStatus: candidate.runtime_status || null,
          previousRecoveryUpdatedAt: candidate.recovery_updated_at || null,
          recoveredAt: new Date().toISOString(),
          externalActionsReplayed: false,
        };
        await client.query(`
          UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
            current_step = 'external-state-reconciliation-ready',
            manual_review_reason = '等待只读核对外部操作结果，禁止重复提交',
            next_attempt_at = now(), recovery_state = 'ready',
            recovery_reason = NULL, recovery_version = recovery_version + 1,
            recovery_updated_at = now(),
            payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
              'staleExternalStateReconciliationRecovery', $2::jsonb
            ),
            updated_at = now()
          WHERE id = $1 AND status = 'paused'
            AND recovery_state = 'reconciling'`, [
          candidate.id,
          stringifyJsonb(recovery),
        ]);
        if (candidate.current_ordinary_instance_id) {
          await client.query(`
            UPDATE ordinary_work_order_instances SET status = 'paused',
              runtime_status = 'paused',
              current_step = 'external-state-reconciliation-ready',
              manual_review_reason = '等待只读核对外部操作结果，禁止重复提交',
              next_attempt_at = now(), updated_at = now()
            WHERE id = $1`, [candidate.current_ordinary_instance_id]);
        }
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id,
             event_type, payload)
          VALUES ($1,$2,$3,'system','stale-external-state-reconciliation-released',$4::jsonb)`, [
          shopId,
          candidate.id,
          candidate.current_ordinary_instance_id || null,
          stringifyJsonb({
            orderNumber: candidate.external_order_number,
            scenarioCode: candidate.scenario_code,
            ...recovery,
          }),
        ]);
        recovered.push({
          workOrderId: candidate.id,
          externalOrderNumber: candidate.external_order_number,
          scenarioCode: candidate.scenario_code,
          previousStep: candidate.current_step || null,
          currentStep: 'external-state-reconciliation-ready',
          externalActionsReplayed: false,
        });
      }
      await client.query('COMMIT');
      return recovered;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverSafeMisboundPddEvidencePauses({
    shopId,
    identityBindingToken,
    actualShopName,
    mallId = null,
  }) {
    const normalizedToken = String(identityBindingToken || '').trim();
    const normalizedShopName = String(actualShopName || '')
      .normalize('NFKC').replace(/\s+/g, ' ').trim();
    const normalizedMallId = /^\d{5,30}$/u.test(String(mallId || '').trim())
      ? String(mallId).trim() : null;
    if (!shopId || !normalizedToken || !normalizedShopName) return [];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const relocated = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT work_order.id, work_order.shop_id AS previous_shop_id,
            work_order.external_order_number, work_order.current_ordinary_instance_id,
            work_order.payload, instance.platform_case_id
          FROM work_orders work_order
          JOIN ordinary_work_order_instances instance
            ON instance.id = work_order.current_ordinary_instance_id
            AND instance.work_order_id = work_order.id
            AND instance.shop_id = work_order.shop_id
          JOIN shops target_shop
            ON target_shop.id = $1
            AND target_shop.enabled
            AND target_shop.onboarding_status = 'ready'
            AND target_shop.expected_shop_name = $3
          JOIN pdd_shop_runtime_bindings binding
            ON binding.shop_id = target_shop.id
            AND binding.actual_shop_name = target_shop.expected_shop_name
            AND binding.binding_token::text = $2
            AND ($4::text IS NULL OR binding.mall_id = $4)
          WHERE work_order.shop_id <> $1
            AND work_order.frontend_visibility = 'operational'
            AND work_order.scenario_code = 'in-transit-refund'
            AND work_order.status = 'paused'
            AND work_order.runtime_status = 'paused'
            AND work_order.current_step = 'manual-review-blocked'
            AND coalesce(work_order.completion_state, 'pending') = 'pending'
            AND work_order.recovery_state IN ('ready','retry-authorized')
            AND instance.identity_status = 'verified'
            AND instance.platform_case_id IS NOT NULL
            AND instance.platform_case_key =
              'pdd-work-order:' || instance.platform_case_id
            AND instance.detail_url =
              'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
                || instance.platform_case_id
            AND $3 = ANY(ARRAY[
              nullif(work_order.payload->>'shopNameSnapshot', ''),
              nullif(work_order.payload->>'detectedShopName', ''),
              nullif(work_order.payload#>>'{latestDiscovery,actualShopName}', ''),
              nullif(work_order.payload#>>'{pddShopIdentity,actualShopName}', ''),
              nullif(instance.payload->>'shopNameSnapshot', ''),
              nullif(instance.payload->>'detectedShopName', ''),
              nullif(instance.payload#>>'{latestDiscovery,actualShopName}', ''),
              nullif(instance.payload#>>'{pddShopIdentity,actualShopName}', '')
            ])
            AND (
              coalesce(
                nullif(work_order.payload->>'pddMallId', ''),
                nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
                nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
                nullif(instance.payload->>'pddMallId', ''),
                nullif(instance.payload#>>'{latestDiscovery,pddMallId}', ''),
                nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
              ) IS NULL
              OR $4::text = ANY(ARRAY[
                nullif(work_order.payload->>'pddMallId', ''),
                nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
                nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
                nullif(instance.payload->>'pddMallId', ''),
                nullif(instance.payload#>>'{latestDiscovery,pddMallId}', ''),
                nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
              ])
            )
            AND work_order.payload#>>'{pddEvidenceUpload,status}' = 'unknown'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(CASE
                WHEN jsonb_typeof(work_order.payload
                  #> '{pddEvidenceUpload,diagnostics,network}') = 'array'
                THEN work_order.payload#>'{pddEvidenceUpload,diagnostics,network}'
                ELSE '[]'::jsonb
              END) network
              WHERE coalesce(network->>'status', '') ~ '^[0-9]+$'
                AND (network->>'status')::int BETWEEN 200 AND 299
                AND network->>'url' LIKE '%file.pinduoduo.com%'
                AND coalesce(network->>'response', '') LIKE '%"url"%'
            )
            AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.status = 'reserved'
            )
            AND EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND effect.effect_type = 'evidence-upload'
                AND effect.status = 'unknown'
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.status = 'unknown'
                AND effect.effect_type <> 'evidence-upload'
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.effect_type = 'pdd-submit'
            )
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
            AND NOT EXISTS (
              SELECT 1 FROM work_orders target
              WHERE target.id <> work_order.id
                AND target.shop_id = $1
                AND target.external_order_number = work_order.external_order_number
                AND target.scenario_code IS DISTINCT FROM 'return-refund'
            )
            AND NOT EXISTS (
              SELECT 1 FROM cross_shop_order_conflicts conflict
              WHERE conflict.external_order_number = work_order.external_order_number
                AND conflict.status = 'open'
            )
          ORDER BY work_order.updated_at, work_order.id
          FOR UPDATE OF work_order, instance
        ), moved_orders AS (
          UPDATE work_orders work_order
          SET shop_id = $1,
            status = 'paused', runtime_status = 'paused',
            current_step = 'pdd-detail-read-only-reconciliation-ready',
            manual_review_reason = '等待只读核对拼多多详情状态，禁止重复提交',
            next_attempt_at = now(), recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = coalesce(work_order.recovery_version, 0) + 1,
            recovery_updated_at = now(),
            payload = (coalesce(work_order.payload, '{}'::jsonb)
              - 'manualReview' - 'error') || jsonb_build_object(
              'shopId', $1,
              'pddIdentityBindingToken', $2,
              'pddMallId', $4,
              'detectedShopName', $3,
              'shopNameSnapshot', $3,
              'latestDiscovery', coalesce(work_order.payload->'latestDiscovery', '{}'::jsonb)
                || jsonb_build_object(
                  'shopId', $1,
                  'actualShopName', $3,
                  'pddMallId', $4,
                  'pddIdentityBindingToken', $2,
                  'identityRelocatedAt', now()
                ),
              'step', 'pdd-detail-read-only-reconciliation-ready',
              'externalStateReconciliationRetry', jsonb_build_object(
                'attempts', 0,
                'maxAttempts', 3,
                'scheduledAt', now(),
                'recoverySource', 'cross-shop-pdd-evidence-read-only'
              ),
              'crossShopPddEvidenceReadOnlyRecovery', jsonb_build_object(
                'status', 'ready',
                'strategy', 'exact-identity-relocation-then-read-only-pdd-detail',
                'previousShopId', candidate.previous_shop_id,
                'targetShopId', $1,
                'platformCaseId', candidate.platform_case_id,
                'externalActionsReplayed', false,
                'scheduledAt', now()
              ),
              'updatedAt', now()
            ),
            updated_at = now()
          FROM candidates candidate
          WHERE work_order.id = candidate.id
          RETURNING work_order.*, candidate.previous_shop_id,
            candidate.platform_case_id
        ), moved_instances AS (
          UPDATE ordinary_work_order_instances instance
          SET shop_id = $1, status = 'paused', runtime_status = 'paused',
            current_step = 'pdd-detail-read-only-reconciliation-ready',
            manual_review_reason = '等待只读核对拼多多详情状态，禁止重复提交',
            next_attempt_at = now(),
            payload = moved.payload,
            updated_at = now()
          FROM moved_orders moved
          WHERE instance.id = moved.current_ordinary_instance_id
            AND instance.work_order_id = moved.id
          RETURNING moved.id, moved.shop_id, moved.external_order_number,
            moved.current_ordinary_instance_id, moved.previous_shop_id,
            moved.platform_case_id, moved.payload
        )
        SELECT * FROM moved_instances`, [
        shopId,
        normalizedToken,
        normalizedShopName,
        normalizedMallId,
      ]);

      for (const workOrder of relocated.rows) {
        await client.query(`
          UPDATE ordinary_work_order_instances instance
          SET shop_id = $2,
            payload = coalesce(instance.payload, '{}'::jsonb)
              || jsonb_strip_nulls(jsonb_build_object(
                'shopId', $2::text,
                'pddIdentityBindingToken', $3::text,
                'pddMallId', $4::text,
                'detectedShopName', $5::text,
                'shopNameSnapshot', $5::text
              ))
              || jsonb_build_object(
                'latestDiscovery', coalesce(instance.payload->'latestDiscovery', '{}'::jsonb)
                  || jsonb_strip_nulls(jsonb_build_object(
                    'shopId', $2::text,
                    'actualShopName', $5::text,
                    'pddMallId', $4::text,
                    'pddIdentityBindingToken', $3::text,
                    'identityRelocatedAt', now()
                  ))
              ),
            updated_at = now()
          WHERE instance.work_order_id = $1`, [
          workOrder.id,
          shopId,
          normalizedToken,
          normalizedMallId,
          normalizedShopName,
        ]);
        for (const table of [
          'external_effects',
          'evidence_assets',
          'verification_locations',
          'audit_events',
          'workflow_events',
          'operator_commands',
          'manual_interventions',
        ]) {
          await client.query(`UPDATE ${table} SET shop_id = $2 WHERE work_order_id = $1`, [
            workOrder.id,
            shopId,
          ]);
        }
        await relocateWorkflowCheckpoint(client, { workOrderId: workOrder.id, shopId });
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
             payload, deduplication_key)
          VALUES ($1,$2,$3,'worker-page-detection',
            'misbound-pdd-evidence-read-only-reconciliation-ready',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          workOrder.id,
          workOrder.current_ordinary_instance_id,
          stringifyJsonb({
            orderNumber: workOrder.external_order_number,
            platformCaseId: workOrder.platform_case_id,
            actualShopName: normalizedShopName,
            mallId: normalizedMallId,
            previousShopId: workOrder.previous_shop_id,
            targetShopId: shopId,
            strategy: 'exact-identity-relocation-then-read-only-pdd-detail',
            externalActionsReplayed: false,
          }),
          `misbound-pdd-evidence-read-only:${workOrder.id}:${shopId}:${normalizedToken}`,
        ]);
      }
      await client.query('COMMIT');
      return relocated.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getOrdinaryQueueEligibility({ shopId, identityBindingToken = null, scenarioCodes = null }) {
    const result = await this.pool.query(`
      SELECT
        count(*) FILTER (WHERE
          work_order.status IN ('queued','retry-ready')
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND (work_order.next_attempt_at IS NULL OR work_order.next_attempt_at <= now())
        )::int AS due,
        count(*) FILTER (WHERE
          work_order.status IN ('queued','retry-ready')
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND (work_order.next_attempt_at IS NULL OR work_order.next_attempt_at <= now())
          AND ($2::text IS NULL
            OR work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' = $2)
        )::int AS claimable,
        count(*) FILTER (WHERE
          work_order.status IN ('queued','retry-ready')
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND (work_order.next_attempt_at IS NULL OR work_order.next_attempt_at <= now())
          AND $2::text IS NOT NULL
          AND work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' IS DISTINCT FROM $2
        )::int AS identity_blocked,
        COALESCE((
          SELECT 1
          FROM shop_runtime_state runtime
          WHERE runtime.shop_id = $1
            AND runtime.current_work_order_id IS NOT NULL
            AND runtime.lease_token IS NOT NULL
            AND runtime.lease_expires_at > now()
          LIMIT 1
        ), 0)::int AS active_claim,
        (
          SELECT runtime.lease_expires_at
          FROM shop_runtime_state runtime
          WHERE runtime.shop_id = $1
            AND runtime.current_work_order_id IS NOT NULL
            AND runtime.lease_token IS NOT NULL
            AND runtime.lease_expires_at > now()
          LIMIT 1
        ) AS active_claim_expires_at
      FROM work_orders work_order
      WHERE work_order.shop_id = $1
        AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
        AND ($3::text[] IS NULL OR work_order.scenario_code = ANY($3::text[]))`, [
      shopId, identityBindingToken, scenarioCodes,
    ]);
    return result.rows[0] || {
      due: 0,
      claimable: 0,
      identity_blocked: 0,
      active_claim: 0,
      active_claim_expires_at: null,
    };
  }

  async listDiscoveryExcludedOrderNumbers(shopId, { excludeOtherShops = true } = {}) {
    const result = await this.pool.query(`
      SELECT DISTINCT external_order_number
      FROM work_orders
      WHERE frontend_visibility = 'recovery-audit'
        OR ($2::boolean AND shop_id <> $1)
        OR status IN ('paused', 'archived', 'completed', 'failed')
      ORDER BY external_order_number`, [shopId, excludeOtherShops]);
    return result.rows.map((row) => row.external_order_number).filter(Boolean);
  }

  async writeHeartbeat({ workerId, mode, shopId = null, metadata = {} }) {
    await this.pool.query(`
      INSERT INTO worker_heartbeats (worker_id, mode, shop_id, metadata, heartbeat_at)
      VALUES ($1,$2,$3,$4::jsonb,now())
      ON CONFLICT (worker_id) DO UPDATE SET mode = EXCLUDED.mode, shop_id = EXCLUDED.shop_id,
        metadata = EXCLUDED.metadata, heartbeat_at = now()`,
      [workerId, mode, shopId, stringifyJsonb(metadata)],
    );
  }

  async claimNext({
    shopId,
    workerId,
    leaseSeconds = 300,
    recoverOwnedLease = false,
    scenarioCodes = null,
    allowOperatorPaused = false,
    identityBindingToken = null,
    unresolvedEffectsOnly = false,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO shop_runtime_state (shop_id, status)
        VALUES ($1, 'idle')
        ON CONFLICT (shop_id) DO NOTHING`, [shopId]);
      const runtime = await client.query(`
        SELECT worker_id, status, lease_token, lease_expires_at,
          current_work_order_id, metadata
        FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`, [shopId]);
      const current = runtime.rows[0];
      // The maintenance drain sets operatorPaused before the runner reaches
      // its next pause check. Guard the claim under this same row lock so a
      // runner that passed an earlier check cannot take a new order meanwhile.
      if (current.metadata?.maintenanceDrain?.active === true
        || ((current.status === 'operator-paused'
          || current.metadata?.operatorPaused === true) && !allowOperatorPaused)) {
        await client.query('COMMIT');
        return null;
      }
      if (current.lease_token && current.lease_expires_at && new Date(current.lease_expires_at) > new Date()) {
        const canRecoverOwnedLease = recoverOwnedLease
          && current.worker_id === workerId
          && current.current_work_order_id;
        if (!canRecoverOwnedLease) {
          await client.query('COMMIT');
          return null;
        }

        const workOrder = await client.query(`
          SELECT work_order.* FROM work_orders work_order
          WHERE work_order.id = $1 AND work_order.recovery_state <> 'held'
            AND (work_order.status = 'processing' OR (
              work_order.status = 'paused'
              AND work_order.current_step IN ('human-verification-required', 'manual-login-required')
            ))
            AND (work_order.scenario_code IS DISTINCT FROM 'return-refund' OR EXISTS (
              SELECT 1 FROM return_refunds refund
              WHERE refund.work_order_id = work_order.id AND (
                refund.action_state = 'ready'
                OR (refund.action_state = 'waiting-logistics'
                  AND refund.next_check_at IS NOT NULL
                  AND refund.next_check_at <= now())
                OR (refund.action_state = 'page-error'
                  AND work_order.status = 'processing')
                OR (refund.action_state = 'verification-required'
                  AND refund.next_check_at IS NOT NULL
                  AND refund.next_check_at <= now())
                OR (refund.action_state = 'verification-required' AND EXISTS (
                  SELECT 1 FROM external_effects refund_effect
                  WHERE refund_effect.work_order_id = work_order.id
                    AND refund_effect.effect_type = 'pdd-return-refund'
                    AND refund_effect.status IN ('reserved','unknown')
                ))
                OR refund.action_state = 'manual-review'
              )
            ))
            AND ($2::text IS NULL OR CASE
              WHEN work_order.scenario_code = 'return-refund' THEN EXISTS (
                SELECT 1 FROM return_refunds identity_refund
                WHERE identity_refund.work_order_id = work_order.id
                  AND identity_refund.evidence->>'pddIdentityBindingToken' = $2
              )
              ELSE work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' = $2
            END)
            AND ($3::text[] IS NULL OR work_order.scenario_code = ANY($3::text[]))
          FOR UPDATE OF work_order`, [current.current_work_order_id, identityBindingToken, scenarioCodes]);
        if (!workOrder.rowCount) {
          await client.query(`
            UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
              next_attempt_at = now(), updated_at = now()
            WHERE id = $1 AND recovery_state <> 'held'
              AND status IN ('processing','paused')`, [current.current_work_order_id]);
          await client.query(`
            UPDATE work_orders work_order SET
              status = CASE WHEN refund.action_state = 'manual-review' THEN 'paused' ELSE 'retry-ready' END,
              runtime_status = CASE WHEN refund.action_state = 'manual-review' THEN 'manual-review' ELSE 'waiting' END,
              current_step = CASE refund.action_state
                WHEN 'waiting-logistics' THEN 'return-refund-waiting-logistics'
                WHEN 'manual-review' THEN 'return-refund-manual-review'
                WHEN 'page-error' THEN 'return-refund-page-error'
                ELSE work_order.current_step
              END,
              next_attempt_at = CASE
                WHEN refund.action_state = 'manual-review' THEN coalesce(
                  refund.next_check_at,
                  refund.last_scanned_at + interval '30 minutes',
                  now() + interval '30 minutes'
                )
                ELSE coalesce(refund.next_check_at, now() + interval '15 minutes')
              END,
              updated_at = now()
            FROM return_refunds refund
            WHERE work_order.id = $1
              AND refund.work_order_id = work_order.id
              AND refund.action_state <> 'ready'`, [current.current_work_order_id]);
          await client.query(`
            UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
              lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
            WHERE shop_id = $1 AND worker_id = $2`, [shopId, workerId]);
          await client.query('COMMIT');
          return null;
        }
        await client.query(`
          UPDATE work_orders SET status = 'processing',
            runtime_status = CASE
              WHEN current_step IN ('human-verification-required', 'manual-login-required')
                THEN 'verification'
              ELSE 'processing'
            END,
            next_attempt_at = NULL, updated_at = now()
          WHERE id = $1
          `, [current.current_work_order_id]);
        const recoveredWorkOrder = await selectClaimedWorkOrder(client, current.current_work_order_id);
        const leaseToken = crypto.randomUUID();
        await client.query(`
          UPDATE shop_runtime_state SET lease_token = $3,
            lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
          WHERE shop_id = $1 AND worker_id = $2`,
        [shopId, workerId, leaseToken, leaseSeconds]);
        await client.query('COMMIT');
        return { ...recoveredWorkOrder, leaseToken, recoveredLease: true };
      }
      if (current.current_work_order_id) {
        await client.query(`
          UPDATE work_orders SET status = 'retry-ready', runtime_status = 'retry-ready', next_attempt_at = now(),
            current_step = COALESCE(current_step, 'lease-expired-retry'), updated_at = now()
          WHERE id = $1 AND recovery_state <> 'held'
            AND (status = 'processing' OR (
              status = 'paused'
              AND current_step IN ('human-verification-required', 'manual-login-required')
            ))`, [current.current_work_order_id]);
        await client.query(`
          UPDATE work_orders work_order SET
            runtime_status = CASE WHEN refund.action_state = 'manual-review' THEN 'manual-review' ELSE 'waiting' END,
            current_step = CASE refund.action_state
              WHEN 'waiting-logistics' THEN 'return-refund-waiting-logistics'
              WHEN 'manual-review' THEN 'return-refund-manual-review'
              WHEN 'page-error' THEN 'return-refund-page-error'
              ELSE work_order.current_step
            END,
            next_attempt_at = CASE
              WHEN refund.action_state = 'manual-review' THEN coalesce(
                refund.next_check_at,
                refund.last_scanned_at + interval '30 minutes',
                now() + interval '30 minutes'
              )
              ELSE coalesce(refund.next_check_at, now() + interval '15 minutes')
            END,
            updated_at = now()
          FROM return_refunds refund
          WHERE work_order.id = $1
            AND refund.work_order_id = work_order.id
            AND refund.action_state <> 'ready'`, [current.current_work_order_id]);
        await client.query(`
          UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
            lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
          WHERE shop_id = $1`, [shopId]);
      }
      await promoteNextDeferredOrdinaryInstance(client, { shopId });
      const result = await client.query(`
        SELECT work_order.id FROM work_orders work_order
        WHERE work_order.shop_id = $1 AND (
            work_order.status IN ('queued', 'retry-ready')
            OR (work_order.status = 'paused' AND work_order.scenario_code = 'return-refund'
              AND EXISTS (
                SELECT 1 FROM return_refunds manual_refund
                WHERE manual_refund.work_order_id = work_order.id
                  AND manual_refund.action_state = 'manual-review'
                  AND coalesce(
                    manual_refund.next_check_at,
                    manual_refund.last_scanned_at + interval '30 minutes',
                    '-infinity'::timestamptz
                  ) <= now()
              ))
          )
          AND work_order.recovery_state IN ('ready', 'retry-authorized')
          AND (
            work_order.next_attempt_at IS NULL
            OR work_order.next_attempt_at <= now()
            OR (work_order.scenario_code = 'return-refund' AND EXISTS (
              SELECT 1 FROM return_refunds scheduled_refund
              WHERE scheduled_refund.work_order_id = work_order.id
                AND scheduled_refund.next_check_at <= now()
            ))
          )
          AND ($2::text[] IS NULL OR work_order.scenario_code = ANY($2::text[]))
          AND (work_order.scenario_code IS DISTINCT FROM 'return-refund' OR EXISTS (
            SELECT 1 FROM return_refunds refund
            WHERE refund.work_order_id = work_order.id AND (
              refund.action_state = 'ready'
              OR (refund.action_state = 'waiting-logistics'
                AND refund.next_check_at IS NOT NULL
                AND refund.next_check_at <= now()
                AND (
                  refund.last_scanned_at IS NULL
                  OR refund.next_check_at > refund.last_scanned_at
                  OR refund.last_scanned_at + make_interval(secs => $5) <= now()
                ))
              OR (refund.action_state = 'page-error'
                AND work_order.status = 'retry-ready')
              OR (refund.action_state = 'verification-required'
                AND refund.next_check_at IS NOT NULL
                AND refund.next_check_at <= now())
              OR (refund.action_state = 'verification-required' AND EXISTS (
                SELECT 1 FROM external_effects refund_effect
                WHERE refund_effect.work_order_id = work_order.id
                  AND refund_effect.effect_type = 'pdd-return-refund'
                  AND refund_effect.status IN ('reserved','unknown')
              ))
              OR (refund.action_state = 'manual-review'
                AND coalesce(
                  refund.next_check_at,
                  refund.last_scanned_at + interval '30 minutes',
                  '-infinity'::timestamptz
                ) <= now())
            )
          ))
          AND ($3::text IS NULL OR CASE
            WHEN work_order.scenario_code = 'return-refund' THEN EXISTS (
              SELECT 1 FROM return_refunds identity_refund
              WHERE identity_refund.work_order_id = work_order.id
                AND identity_refund.evidence->>'pddIdentityBindingToken' = $3
            )
            ELSE work_order.payload->'latestDiscovery'->>'pddIdentityBindingToken' = $3
          END)
          AND (NOT $4::boolean OR EXISTS (
            SELECT 1 FROM external_effects unresolved_effect
            WHERE unresolved_effect.work_order_id = work_order.id
              AND unresolved_effect.effect_type = 'pdd-return-refund'
              AND unresolved_effect.status IN ('reserved','unknown')
          ))
        ORDER BY CASE
          WHEN work_order.current_step IN (
            'operator-retry-requested',
            'operator-resume-requested',
            'verification-recheck-requested',
            'operator-verification-force-cleared',
            'human-verification-required',
            'manual-login-required'
          ) OR EXISTS (
            SELECT 1 FROM external_effects priority_effect
            WHERE priority_effect.work_order_id = work_order.id
              AND priority_effect.effect_type = 'pdd-return-refund'
              AND priority_effect.status IN ('reserved','unknown')
          ) THEN 0
          WHEN work_order.current_step = 'return-refund-terminal-reconciliation-ready' THEN 1
          ELSE 2
        END,
          CASE
            WHEN work_order.scenario_code IS DISTINCT FROM 'return-refund' THEN 0
            WHEN EXISTS (
              SELECT 1 FROM external_effects priority_effect
              WHERE priority_effect.work_order_id = work_order.id
                AND priority_effect.effect_type = 'pdd-return-refund'
                AND priority_effect.status IN ('reserved','unknown')
            ) THEN 0
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'ready'
            ) THEN 1
            -- The verification recovery path sets this step only after a
            -- human challenge clears. Revisit it before old logistics waits;
            -- unresolved challenges retain their lower priority and safety gate.
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'verification-required'
                AND priority_refund.next_check_at <= now()
                AND work_order.current_step = 'verification-cleared-retry-ready'
            ) THEN 2
            -- Give a page that has remained due for hours one retry ahead of
            -- logistics waits. A failed retry schedules its next check in the
            -- future, so it cannot repeatedly take this priority.
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'page-error'
                AND coalesce(priority_refund.next_check_at, work_order.next_attempt_at)
                  <= now() - interval '2 hours'
            ) THEN 2.5
            -- A cleared but repeatedly deferred verification gets one
            -- guarded reassessment after a long quiet period. Keep any
            -- active shop challenge behind logistics work, and let the
            -- normal retry schedule enforce another four-hour gap.
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'verification-required'
                AND priority_refund.next_check_at <= now() - interval '4 hours'
                AND NOT EXISTS (
                  SELECT 1 FROM verification_locations active_verification
                  WHERE active_verification.shop_id = work_order.shop_id
                    AND active_verification.resolved_at IS NULL
                    AND active_verification.status IN (
                      'detected', 'waiting-human', 'verification-required'
                    )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM external_effects uncertain_effect
                  WHERE uncertain_effect.work_order_id = work_order.id
                    AND uncertain_effect.status IN ('reserved', 'unknown')
                )
            ) THEN 2.75
            -- A repeatedly blocked page must not starve overdue logistics
            -- rechecks. Keep ready actions and uncertain-effect reconciliation
            -- ahead, but age eligible waits above routine technical retries.
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'waiting-logistics'
                AND priority_refund.next_check_at <= now() - interval '30 minutes'
            ) THEN 3
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'page-error'
            ) THEN 4
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'verification-required'
            ) THEN 5
            WHEN EXISTS (
              SELECT 1 FROM return_refunds priority_refund
              WHERE priority_refund.work_order_id = work_order.id
                AND priority_refund.action_state = 'manual-review'
            ) THEN 7
            ELSE 6
          END,
          CASE WHEN work_order.scenario_code = 'return-refund' THEN 0 ELSE 1 END,
          (SELECT due_refund.next_check_at FROM return_refunds due_refund
           WHERE due_refund.work_order_id = work_order.id
             AND due_refund.action_state = 'waiting-logistics') ASC NULLS LAST,
          work_order.created_at FOR UPDATE OF work_order SKIP LOCKED LIMIT 1`, [
        shopId,
        scenarioCodes,
        identityBindingToken,
        unresolvedEffectsOnly,
        Math.ceil(RETURN_REFUND_WAIT_RECHECK_MS / 1000),
      ]);
      if (!result.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const leaseToken = crypto.randomUUID();
      const workOrderId = result.rows[0].id;
      await client.query(`
        UPDATE work_orders SET status = 'processing', runtime_status = 'processing', updated_at = now() WHERE id = $1`, [workOrderId]);
      await client.query(`UPDATE ordinary_work_order_instances instance
        SET status = 'processing', runtime_status = 'processing',
          started_at = coalesce(started_at, now()), updated_at = now()
        FROM work_orders work_order
        WHERE work_order.id = $1
          AND instance.id = work_order.current_ordinary_instance_id`, [workOrderId]);
      await client.query(`
        UPDATE shop_runtime_state SET worker_id = $2, status = 'processing', lease_token = $3,
          lease_expires_at = now() + make_interval(secs => $4), current_work_order_id = $5,
          updated_at = now() WHERE shop_id = $1`,
        [shopId, workerId, leaseToken, leaseSeconds, workOrderId]);
      const workOrder = await selectClaimedWorkOrder(client, workOrderId);
      await client.query('COMMIT');
      return { ...workOrder, leaseToken };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueueDiscovered({ shopId, externalOrderNumber, workOrderType, scenarioCode, payload = {} }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ordinary-work-order:${externalOrderNumber}`]);
      const discoveredAt = new Date().toISOString();
      const { platformCaseKey, platformCaseId } = ordinaryPlatformCaseIdentity(payload);
      const detailUrl = String(payload.detailUrl || '').trim() || null;
      if (!platformCaseKey || !platformCaseId || !detailUrl) {
        const identityError = new Error('A verified PDD work-order detail URL and matching platform identity are required');
        identityError.code = 'PDD_PLATFORM_CASE_IDENTITY_INVALID';
        throw identityError;
      }
      const discoveryObservation = {
        shopId,
        workOrderType,
        scenarioCode: scenarioCode || null,
        platformCaseKey,
        platformCaseId,
        detailUrl,
        discoveredAt,
        discoverySource: 'pdd-pending-list',
        actualShopName: payload.detectedShopName || null,
        pddIdentityBindingToken: payload.pddIdentityBindingToken || null,
        reused: true,
      };
      let verifiedRediscoveryIdentity;
      const hasVerifiedRediscoveryIdentity = async () => {
        if (verifiedRediscoveryIdentity !== undefined) return verifiedRediscoveryIdentity;
        const bindingToken = String(payload.pddIdentityBindingToken || '').trim();
        const actualShopName = String(payload.detectedShopName || '')
          .normalize('NFKC').replace(/\s+/gu, ' ').trim();
        const mallId = /^\d{5,30}$/u.test(String(payload.pddMallId || '').trim())
          ? String(payload.pddMallId).trim() : null;
        const validBindingToken = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
          .test(bindingToken);
        const verifiedBinding = validBindingToken && actualShopName
          ? await client.query(`
              SELECT 1 FROM pdd_shop_runtime_bindings
              WHERE shop_id = $1 AND binding_token = $2::uuid
                AND actual_shop_name = $3
                AND ($4::text IS NULL OR mall_id = $4)`, [
            shopId,
            bindingToken,
            actualShopName,
            mallId,
          ])
          : { rowCount: 0 };
        verifiedRediscoveryIdentity = Boolean(verifiedBinding.rowCount);
        return verifiedRediscoveryIdentity;
      };
      let boundWorkOrderId = null;
      if (platformCaseKey) {
        const bound = await client.query(`
          SELECT instance.id, instance.work_order_id, work_order.external_order_number
          FROM ordinary_work_order_instances instance
          JOIN work_orders work_order ON work_order.id = instance.work_order_id
          WHERE instance.platform_case_key = $1
          FOR UPDATE OF instance`, [platformCaseKey]);
        if (bound.rowCount && bound.rows[0].external_order_number !== externalOrderNumber) {
          const conflict = new Error(`PDD work-order instance ${platformCaseKey} belongs to another order`);
          conflict.code = 'PDD_PLATFORM_CASE_ORDER_MISMATCH';
          conflict.platformCaseKey = platformCaseKey;
          throw conflict;
        }
        boundWorkOrderId = bound.rows[0]?.work_order_id || null;
      }
      const migrateCurrentShop = async (existingWorkOrder) => {
        if (existingWorkOrder.shop_id === shopId) return existingWorkOrder;
        const originalShopId = existingWorkOrder.shop_id;
        if (!await hasVerifiedRediscoveryIdentity()) {
          const conflict = new Error(`Cross-shop rediscovery for ${externalOrderNumber} lacks a current verified browser identity`);
          conflict.code = 'PDD_CROSS_SHOP_IDENTITY_UNVERIFIED';
          conflict.conflictingShopId = originalShopId;
          conflict.externalOrderNumber = externalOrderNumber;
          throw conflict;
        }
        const safety = await client.query(`
          SELECT
            EXISTS (
              SELECT 1 FROM external_effects
              WHERE work_order_id = $1
            ) AS has_external_effect,
            EXISTS (
              SELECT 1 FROM shop_runtime_state
              WHERE current_work_order_id = $1 AND lease_token IS NOT NULL
                AND lease_expires_at > now()
            ) AS active_lease`, [existingWorkOrder.id]);
        const unsafe = safety.rows[0] || {};
        if (unsafe.has_external_effect || unsafe.active_lease
          || existingWorkOrder.status === 'processing') {
          const conflict = new Error(`Work order ${externalOrderNumber} is still active in another browser slot`);
          conflict.code = 'PDD_CROSS_SHOP_REDISCOVERY_UNSAFE';
          conflict.conflictingShopId = originalShopId;
          conflict.externalOrderNumber = externalOrderNumber;
          throw conflict;
        }
        const browserTruthPausedRecovery = existingWorkOrder.status === 'paused';
        const uploadFailureReason = /48143|凭证上传[^，。；;]*失败|截图上传[^，。；;]*失败/u
          .test(String(existingWorkOrder.manual_review_reason || ''));
        if (browserTruthPausedRecovery && (
          boundWorkOrderId !== existingWorkOrder.id
          || !isRecoverableBrowserTruthPause(existingWorkOrder)
          || uploadFailureReason
        )) {
          const conflict = new Error(`Paused work order ${externalOrderNumber} is not safe for browser-truth recovery`);
          conflict.code = 'PDD_CROSS_SHOP_REDISCOVERY_UNSAFE';
          conflict.conflictingShopId = originalShopId;
          conflict.externalOrderNumber = externalOrderNumber;
          throw conflict;
        }
        await client.query('UPDATE work_orders SET shop_id = $2, updated_at = now() WHERE id = $1', [
          existingWorkOrder.id,
          shopId,
        ]);
        await client.query(`UPDATE ordinary_work_order_instances
          SET shop_id = $2, updated_at = now() WHERE work_order_id = $1`, [existingWorkOrder.id, shopId]);
        for (const table of [
          'external_effects',
          'evidence_assets',
          'verification_locations',
          'audit_events',
          'workflow_events',
          'operator_commands',
          'manual_interventions',
        ]) {
          await client.query(`UPDATE ${table} SET shop_id = $2 WHERE work_order_id = $1`, [existingWorkOrder.id, shopId]);
        }
        await relocateWorkflowCheckpoint(client, { workOrderId: existingWorkOrder.id, shopId });
        return {
          ...existingWorkOrder,
          shop_id: shopId,
          original_shop_id: originalShopId,
          browser_truth_paused_recovery: browserTruthPausedRecovery,
        };
      };
      const findOrCreateInstance = async (workOrderId, { deferred = false } = {}) => {
        const existing = platformCaseKey
          ? await client.query(`SELECT * FROM ordinary_work_order_instances
              WHERE platform_case_key = $1 FOR UPDATE`, [platformCaseKey])
          : await client.query(`SELECT * FROM ordinary_work_order_instances
              WHERE work_order_id = $1 AND identity_status = 'legacy-unverified'
                AND platform_case_key IS NULL
              ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [workOrderId]);
        if (existing.rowCount) {
          if (existing.rows[0].work_order_id !== workOrderId) {
            throw new Error(`PDD work-order instance ${platformCaseKey || 'unverified'} is bound to another work-order record`);
          }
          const updated = await client.query(`
            UPDATE ordinary_work_order_instances SET
              detail_url = coalesce($2, detail_url),
              work_order_type = $3,
              scenario_code = $4,
              payload = coalesce(payload, '{}'::jsonb) || $5::jsonb,
              last_discovered_at = $6,
              updated_at = now()
            WHERE id = $1 RETURNING *`, [
            existing.rows[0].id,
            detailUrl,
            workOrderType,
            scenarioCode || 'unknown',
            stringifyJsonb({ latestDiscovery: discoveryObservation }),
            discoveredAt,
          ]);
          return { instance: updated.rows[0], inserted: false };
        }
        const instanceId = crypto.randomUUID();
        const inserted = await client.query(`
          INSERT INTO ordinary_work_order_instances (
            id, work_order_id, shop_id, platform_case_id, platform_case_key,
            detail_url, work_order_type, scenario_code, identity_status,
            status, runtime_status, current_step, payload, next_attempt_at,
            first_discovered_at, last_discovered_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pdd-discovered',$12::jsonb,$13,$14,$14
          ) RETURNING *`, [
          instanceId,
          workOrderId,
          shopId,
          platformCaseId,
          platformCaseKey,
          detailUrl,
          workOrderType,
          scenarioCode || 'unknown',
          platformCaseKey ? 'verified' : 'legacy-unverified',
          deferred ? 'deferred' : 'queued',
          deferred ? 'waiting' : 'queued',
          stringifyJsonb({ ...payload, latestDiscovery: { ...discoveryObservation, reused: false } }),
          deferred ? new Date(Date.now() + 2 * 60_000).toISOString() : null,
          discoveredAt,
        ]);
        return { instance: inserted.rows[0], inserted: true };
      };
      const observeExisting = async (existingWorkOrder, instance) => {
        const updated = await client.query(`
          UPDATE work_orders work_order
          SET payload = coalesce(work_order.payload, '{}'::jsonb)
              || jsonb_strip_nulls($2::jsonb)
              || jsonb_build_object(
                'latestDiscovery', $3::jsonb,
                'discoveryCount', CASE
                  WHEN coalesce(work_order.payload->>'discoveryCount', '') ~ '^[0-9]+$'
                    THEN (work_order.payload->>'discoveryCount')::int + 1
                  ELSE 2
                END
              ),
            updated_at = now()
          WHERE id = $1 AND frontend_visibility = 'operational'
          RETURNING id, shop_id, external_order_number, work_order_type, status,
            current_ordinary_instance_id`,
        [existingWorkOrder.id, stringifyJsonb(payload), stringifyJsonb(discoveryObservation)]);
        const workOrder = updated.rows[0] || existingWorkOrder;
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'system','work-order-discovery-reused',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          workOrder.shop_id,
          workOrder.id,
          instance?.id || null,
          stringifyJsonb({
            orderNumber: externalOrderNumber,
            discoveredShopId: shopId,
            originalShopId: workOrder.original_shop_id || workOrder.shop_id,
            workOrderType,
            scenarioCode: scenarioCode || null,
            platformCaseKey,
            discoveredAt,
          }),
          `work-order-discovery-reused:${instance?.id || workOrder.id}:${shopId}`,
        ]);
        return workOrder;
      };
      const recoverBrowserTruthPaused = async (existingWorkOrder, instance) => {
        const recoveryObservation = {
          status: 'retry-ready',
          strategy: 'exact-platform-case-current-browser-identity',
          previousShopId: existingWorkOrder.original_shop_id,
          targetShopId: shopId,
          platformCaseKey,
          bindingToken: payload.pddIdentityBindingToken || null,
          actualShopName: payload.detectedShopName || null,
          recoveredAt: discoveredAt,
        };
        const recovered = await client.query(`
          UPDATE work_orders SET
            work_order_type = $3,
            scenario_code = $4,
            status = 'retry-ready',
            runtime_status = 'retry-ready',
            current_step = 'pdd-browser-truth-identity-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = now(),
            completion_state = 'pending',
            completion_confirmation_method = NULL,
            completion_confirmed_at = NULL,
            handling_classification = 'automated',
            classification_source = 'system',
            classification_reason = NULL,
            classification_updated_at = now(),
            recovery_state = 'ready',
            recovery_reason = NULL,
            recovery_version = recovery_version + 1,
            recovery_updated_at = now(),
            payload = (coalesce(payload, '{}'::jsonb) - 'manualReview' - 'error')
              || jsonb_strip_nulls($5::jsonb)
              || jsonb_build_object(
                'latestDiscovery', $6::jsonb,
                'browserTruthIdentityRecovery', $7::jsonb,
                'discoveryCount', CASE
                  WHEN coalesce(payload->>'discoveryCount', '') ~ '^[0-9]+$'
                    THEN (payload->>'discoveryCount')::int + 1
                  ELSE 2
                END
              ),
            updated_at = now()
          WHERE id = $1 AND shop_id = $2 AND status = 'paused'
            AND completion_state = 'pending'
            AND recovery_state IN ('ready','retry-authorized')
          RETURNING id, shop_id, external_order_number, work_order_type, status,
            current_ordinary_instance_id`, [
          existingWorkOrder.id,
          shopId,
          workOrderType,
          scenarioCode || null,
          stringifyJsonb(payload),
          stringifyJsonb(discoveryObservation),
          stringifyJsonb(recoveryObservation),
        ]);
        if (!recovered.rowCount) {
          const conflict = new Error(`Paused work order ${externalOrderNumber} changed before browser-truth recovery`);
          conflict.code = 'PDD_CROSS_SHOP_REDISCOVERY_UNSAFE';
          throw conflict;
        }
        await client.query(`
          UPDATE ordinary_work_order_instances SET
            status = 'retry-ready', runtime_status = 'retry-ready',
            current_step = 'pdd-browser-truth-identity-retry-ready',
            manual_review_reason = NULL, next_attempt_at = now(),
            payload = (coalesce(payload, '{}'::jsonb) - 'manualReview' - 'error')
              || jsonb_strip_nulls($2::jsonb)
              || jsonb_build_object(
                'latestDiscovery', $3::jsonb,
                'browserTruthIdentityRecovery', $4::jsonb
              ),
            updated_at = now()
          WHERE id = $1`, [
          instance.id,
          stringifyJsonb(payload),
          stringifyJsonb(discoveryObservation),
          stringifyJsonb(recoveryObservation),
        ]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'worker-page-detection','paused-ordinary-browser-truth-recovered',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          existingWorkOrder.id,
          instance.id,
          stringifyJsonb({
            orderNumber: externalOrderNumber,
            platformCaseKey,
            previousShopId: existingWorkOrder.original_shop_id,
            targetShopId: shopId,
            actualShopName: payload.detectedShopName || null,
            bindingToken: payload.pddIdentityBindingToken || null,
            recoveredAt: discoveredAt,
          }),
          `paused-ordinary-browser-truth-recovered:${instance.id}:${shopId}:${payload.pddIdentityBindingToken || 'unbound'}`,
        ]);
        return recovered.rows[0];
      };
      const promoteInstance = async (existingWorkOrder, instance, { restoreDeleted = false } = {}) => {
        await client.query(`UPDATE ordinary_work_order_instances SET
          status = 'queued', runtime_status = 'queued', current_step = 'pdd-discovered',
          next_attempt_at = NULL, started_at = NULL, completed_at = NULL,
          completion_method = NULL, manual_review_reason = NULL, updated_at = now()
          WHERE id = $1`, [instance.id]);
        const promoted = await client.query(`
          UPDATE work_orders SET
            shop_id = $2,
            work_order_type = $3,
            scenario_code = $4,
            status = 'queued',
            runtime_status = 'queued',
            current_step = 'pdd-discovered',
            current_ordinary_instance_id = $5,
            payload = $6::jsonb,
            manual_review_reason = NULL,
            next_attempt_at = NULL,
            completion_state = 'pending',
            completion_confirmation_method = NULL,
            completion_confirmed_at = NULL,
            handling_classification = 'automated',
            classification_source = 'system',
            classification_reason = NULL,
            classification_updated_at = now(),
            recovery_state = 'ready',
            recovery_reason = NULL,
            recovery_version = recovery_version + 1,
            recovery_updated_at = now(),
            frontend_visibility = CASE WHEN $7 THEN 'operational' ELSE frontend_visibility END,
            updated_at = now()
          WHERE id = $1
          RETURNING id, shop_id, external_order_number, work_order_type, status,
            current_ordinary_instance_id`, [
          existingWorkOrder.id,
          shopId,
          workOrderType,
          scenarioCode || null,
          instance.id,
          stringifyJsonb({
            ...payload,
            shopNameSnapshot: payload.detectedShopName || null,
            discoveredAt,
            discoverySource: 'pdd-pending-list',
            discoveryCount: 1,
            platformCaseKey,
            platformCaseId,
            latestDiscovery: { ...discoveryObservation, reused: false },
          }),
          restoreDeleted,
        ]);
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'system','ordinary-work-order-instance-promoted',$4::jsonb,$5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          existingWorkOrder.id,
          instance.id,
          stringifyJsonb({ orderNumber: externalOrderNumber, platformCaseKey, workOrderType, scenarioCode, discoveredAt }),
          `ordinary-instance-promoted:${instance.id}`,
        ]);
        return promoted.rows[0];
      };
      const existingRows = await client.query(`
        SELECT id, shop_id, external_order_number, work_order_type, scenario_code, status,
          frontend_visibility, current_step, current_ordinary_instance_id,
          completion_state, recovery_state, recovery_reason, manual_review_reason
        FROM work_orders
        WHERE external_order_number = $1
          AND scenario_code IS DISTINCT FROM 'return-refund'
        ORDER BY CASE WHEN frontend_visibility = 'operational' THEN 0 ELSE 1 END,
          CASE WHEN idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END,
          created_at
        FOR UPDATE`, [externalOrderNumber]);
      const exactBoundOperational = boundWorkOrderId
        ? existingRows.rows.find((workOrder) => workOrder.id === boundWorkOrderId
          && workOrder.frontend_visibility === 'operational')
        : null;
      const existingOperational = exactBoundOperational || existingRows.rows.find(
        (workOrder) => workOrder.frontend_visibility === 'operational',
      );
      if (existingOperational) {
        const originallySameShop = existingOperational.shop_id === shopId;
        const workOrder = await migrateCurrentShop(existingOperational);
        const currentInstance = workOrder.current_ordinary_instance_id
          ? await client.query('SELECT * FROM ordinary_work_order_instances WHERE id = $1 FOR UPDATE', [workOrder.current_ordinary_instance_id])
          : { rows: [], rowCount: 0 };
        let currentInstanceRow = currentInstance.rows[0] || null;
        let sameShopBrowserTruthRecovery = false;
        if (originallySameShop && currentInstanceRow
          && currentInstanceRow.work_order_id === workOrder.id
          && String(currentInstanceRow.status || '').toLowerCase() === 'paused'
          && isRecoverableBrowserTruthPause(workOrder)
          && await hasVerifiedRediscoveryIdentity()) {
          const safety = await client.query(`
            SELECT
              EXISTS (
                SELECT 1 FROM external_effects
                WHERE work_order_id = $1 AND status IN ('reserved','unknown')
              ) AS unresolved_effect,
              EXISTS (
                SELECT 1 FROM external_effects
                WHERE work_order_id = $1 AND effect_type = 'pdd-submit' AND status = 'succeeded'
              ) AS succeeded_pdd_submit,
              EXISTS (
                SELECT 1 FROM external_effects
                WHERE work_order_id = $1 AND effect_type = 'evidence-upload' AND status IN ('failed','unknown')
              ) AS unsafe_evidence_upload,
              EXISTS (
                SELECT 1 FROM shop_runtime_state
                WHERE current_work_order_id = $1 AND lease_token IS NOT NULL
                  AND lease_expires_at > now()
              ) AS active_lease`, [workOrder.id]);
          const unsafe = safety.rows[0] || {};
          sameShopBrowserTruthRecovery = !unsafe.unresolved_effect
            && !unsafe.succeeded_pdd_submit
            && !unsafe.unsafe_evidence_upload
            && !unsafe.active_lease;
        }
        const legacyIdentityCanBePromoted = sameShopBrowserTruthRecovery
          && platformCaseKey
          && platformCaseId
          && !boundWorkOrderId
          && currentInstanceRow?.identity_status === 'legacy-unverified'
          && !currentInstanceRow.platform_case_id
          && !currentInstanceRow.platform_case_key;
        if (legacyIdentityCanBePromoted) {
          const promotedIdentity = await client.query(`
            UPDATE ordinary_work_order_instances SET
              platform_case_id = $2, platform_case_key = $3, detail_url = $4,
              identity_status = 'verified', work_order_type = $5, scenario_code = $6,
              payload = coalesce(payload, '{}'::jsonb)
                || jsonb_strip_nulls($7::jsonb)
                || jsonb_build_object('latestDiscovery', $8::jsonb),
              last_discovered_at = $9, updated_at = now()
            WHERE id = $1 AND work_order_id = $10
              AND identity_status = 'legacy-unverified'
              AND platform_case_id IS NULL AND platform_case_key IS NULL
            RETURNING *`, [
            currentInstanceRow.id,
            platformCaseId,
            platformCaseKey,
            detailUrl,
            workOrderType,
            scenarioCode || 'unknown',
            stringifyJsonb(payload),
            stringifyJsonb(discoveryObservation),
            discoveredAt,
            workOrder.id,
          ]);
          if (!promotedIdentity.rowCount) {
            const conflict = new Error(`Legacy work-order identity for ${externalOrderNumber} changed before browser-truth recovery`);
            conflict.code = 'PDD_PLATFORM_CASE_IDENTITY_CONFLICT';
            throw conflict;
          }
          currentInstanceRow = promotedIdentity.rows[0];
          boundWorkOrderId = workOrder.id;
        }
        const knownSameInstance = Boolean(platformCaseKey
          && currentInstanceRow?.platform_case_key === platformCaseKey);
        const currentAllowsReplacement = !currentInstanceRow
          || ordinaryInstanceIsTerminal(currentInstanceRow);
        const instanceResult = await findOrCreateInstance(workOrder.id, {
          deferred: !knownSameInstance && !currentAllowsReplacement,
        });
        const instance = instanceResult.instance;
        const previouslyFinished = ordinaryInstanceIsTerminal(instance);
        if (knownSameInstance && (workOrder.browser_truth_paused_recovery || sameShopBrowserTruthRecovery)) {
          const recovered = await recoverBrowserTruthPaused(workOrder, instance);
          await client.query('COMMIT');
          return {
            inserted: false,
            reused: false,
            reopened: true,
            relocated: true,
            browserTruthRecovered: true,
            conflict: false,
            workOrder: recovered,
            instance,
          };
        }
        if (knownSameInstance || previouslyFinished || (!platformCaseKey && !instanceResult.inserted)) {
          const observed = await observeExisting(workOrder, instance);
          await client.query('COMMIT');
          return { inserted: false, reused: true, conflict: false, workOrder: observed, instance };
        }
        const activeEffect = await client.query(`SELECT 1 FROM external_effects
          WHERE work_order_id = $1 AND status IN ('reserved','unknown')
            AND (ordinary_instance_id IS NULL OR ordinary_instance_id = $2)
          LIMIT 1`, [workOrder.id, currentInstanceRow?.id || null]);
        const activeLease = await client.query(`SELECT 1 FROM shop_runtime_state
          WHERE current_work_order_id = $1 AND lease_expires_at > now() LIMIT 1`, [workOrder.id]);
        if (!currentAllowsReplacement || activeEffect.rowCount || activeLease.rowCount) {
          const deferred = await client.query(`UPDATE ordinary_work_order_instances SET status = 'deferred',
            runtime_status = 'waiting', next_attempt_at = coalesce(next_attempt_at, now() + interval '2 minutes'),
            updated_at = now() WHERE id = $1 RETURNING *`, [instance.id]);
          await client.query(`
            INSERT INTO audit_events
              (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
            VALUES ($1,$2,$3,'system','ordinary-work-order-instance-deferred',$4::jsonb,$5)
            ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
            shopId,
            workOrder.id,
            instance.id,
            stringifyJsonb({
              orderNumber: externalOrderNumber,
              platformCaseKey,
              blockedByInstanceId: currentInstanceRow?.id || null,
              blockedByStatus: currentInstanceRow?.status || workOrder.status,
              discoveredAt,
            }),
            `ordinary-instance-deferred:${instance.id}`,
          ]);
          await client.query('COMMIT');
          return {
            inserted: instanceResult.inserted,
            reused: false,
            deferred: true,
            conflict: false,
            workOrder,
            instance: deferred.rows[0] || instance,
          };
        }
        const promoted = await promoteInstance(workOrder, instance);
        await client.query('COMMIT');
        return { inserted: false, reused: false, reopened: true, conflict: false, workOrder: promoted, instance };
      }
      const deletionTombstone = existingRows.rows.find(
        (workOrder) => workOrder.frontend_visibility === 'recovery-audit'
          && workOrder.current_step === 'owner-deleted',
      );
      if (deletionTombstone) {
        if (platformCaseKey) {
          const restoredWorkOrder = await migrateCurrentShop(deletionTombstone);
          const existingInstance = await client.query(`SELECT * FROM ordinary_work_order_instances
            WHERE platform_case_key = $1 FOR UPDATE`, [platformCaseKey]);
          if (!existingInstance.rowCount) {
            const instanceResult = await findOrCreateInstance(restoredWorkOrder.id);
            const promoted = await promoteInstance(restoredWorkOrder, instanceResult.instance, { restoreDeleted: true });
            await client.query('COMMIT');
            return { inserted: false, reused: false, reopened: true, conflict: false, workOrder: promoted, instance: instanceResult.instance };
          }
        }
        await client.query('COMMIT');
        return { inserted: false, reused: false, suppressed: true, conflict: false, workOrder: null };
      }
      const id = crypto.randomUUID();
      const idempotencyKey = `pdd-discovered:${shopId}:${externalOrderNumber}:${workOrderType}`;
      const result = await client.query(`
        INSERT INTO work_orders
          (id, shop_id, external_order_number, work_order_type, scenario_code, status, runtime_status, idempotency_key,
           current_step, manual_review_reason, payload)
        VALUES ($1,$2,$3,$4,$5,'queued','queued',$6,'pdd-discovered',NULL,$7::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id, shop_id, external_order_number, work_order_type, status`,
      [id, shopId, externalOrderNumber, workOrderType, scenarioCode || null, idempotencyKey,
        stringifyJsonb({
          ...payload,
          shopNameSnapshot: payload.detectedShopName || null,
          discoveredAt,
          discoverySource: 'pdd-pending-list',
          discoveryCount: 1,
          latestDiscovery: { ...discoveryObservation, reused: false },
        })]);
      let workOrder = result.rows[0] || null;
      if (!workOrder) {
        const existing = await client.query(`
          SELECT id, shop_id, external_order_number, work_order_type, status
          FROM work_orders
          WHERE external_order_number = $1 AND frontend_visibility = 'operational'
            AND scenario_code IS DISTINCT FROM 'return-refund'
          ORDER BY CASE WHEN idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END,
            created_at
          LIMIT 1 FOR UPDATE`, [externalOrderNumber]);
        workOrder = existing.rows[0] || null;
        if (workOrder) {
          const instanceResult = await findOrCreateInstance(workOrder.id);
          workOrder = await observeExisting(workOrder, instanceResult.instance);
        }
      }
      let instance = null;
      if (result.rowCount && workOrder) {
        const instanceResult = await findOrCreateInstance(workOrder.id);
        instance = instanceResult.instance;
        await client.query(`UPDATE work_orders SET current_ordinary_instance_id = $2,
          payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
            'platformCaseKey', $3::text, 'platformCaseId', $4::text
          ), updated_at = now() WHERE id = $1`, [
          workOrder.id,
          instance.id,
          platformCaseKey,
          platformCaseId,
        ]);
        workOrder.current_ordinary_instance_id = instance.id;
      }
      await client.query('COMMIT');
      return { inserted: Boolean(result.rowCount), reused: !result.rowCount, conflict: false, workOrder, instance };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listFutureReturnRefundRechecks(shopId, minimumLeadSeconds = 600) {
    const leadSeconds = Math.max(60, Math.min(4 * 3600,
      Math.ceil(Number(minimumLeadSeconds) || 600)));
    const result = await this.pool.query(`
      SELECT refund.aftersale_number AS "aftersaleNumber",
        refund.external_order_number AS "orderNumber",
        refund.next_check_at AS "nextCheckAt"
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
        AND work_order.shop_id = refund.shop_id
      WHERE refund.shop_id = $1
        AND refund.action_state = 'waiting-logistics'
        AND refund.next_check_at > now() + ($2::double precision * interval '1 second')
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND NOT EXISTS (
          SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved', 'unknown')
        )
      ORDER BY refund.next_check_at, refund.aftersale_number
      LIMIT 5000`, [shopId, leadSeconds]);
    return result.rows;
  }

  async listConfirmedReturnRefundCompletions(shopId) {
    const result = await this.pool.query(`
      SELECT refund.aftersale_number AS "aftersaleNumber",
        refund.external_order_number AS "orderNumber"
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
        AND work_order.shop_id = refund.shop_id
        AND work_order.external_order_number = refund.external_order_number
      WHERE refund.shop_id = $1
        AND refund.action_state IN ('manual-completed', 'auto-refunded')
        AND refund.completion_method IN (
          'return-refund-read-only-page-completed',
          'return-refund-button-disappeared'
        )
        AND refund.completed_at IS NOT NULL
        AND refund.next_check_at IS NULL
        AND work_order.status = 'completed'
        AND work_order.runtime_status = 'completed'
        AND work_order.completion_state = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved', 'unknown')
        )
      ORDER BY refund.completed_at DESC, refund.aftersale_number
      LIMIT 5000`, [shopId]);
    return result.rows;
  }

  async getReturnRefundScanCursor(shopId) {
    const result = await this.pool.query(`
      SELECT metadata->'returnRefundScanCursor' AS cursor,
        metadata->'returnRefundLastScan'->>'verificationHandledCount' AS verification_handled_count,
        metadata->'returnRefundLastScan'->'resumeProof' AS scope_proof,
        metadata->'returnRefundLastScan'->>'actionScope' AS scan_action_scope,
        metadata->'returnRefundLastScan'->'nextCursor' AS scan_next_cursor,
        metadata->'returnRefundScanRetry'->>'retryNotBefore' AS retry_not_before
      FROM shop_runtime_state WHERE shop_id = $1`, [shopId]);
    const cursor = result.rows[0]?.cursor || {};
    const updatedAt = String(cursor.updatedAt || '').trim();
    const retryNotBefore = String(result.rows[0]?.retry_not_before || '').trim();
    const actionScope = returnRefundCursorActionScope(cursor, {
      actionScope: result.rows[0]?.scan_action_scope,
      nextCursor: result.rows[0]?.scan_next_cursor,
    }) || returnRefundCursorActionScope(cursor, result.rows[0]?.scope_proof);
    return {
      page: Math.max(1, Math.min(10_000, Math.floor(Number(cursor.page) || 1))),
      itemOffset: Math.max(0, Math.min(999, Math.floor(Number(cursor.itemOffset) || 0))),
      ...(Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}),
      ...(Number.isFinite(Date.parse(retryNotBefore)) ? { retryNotBefore } : {}),
      verificationHandledCount: Math.max(0,
        Math.floor(Number(result.rows[0]?.verification_handled_count) || 0)),
      ...(actionScope ? { actionScope } : {}),
    };
  }

  async setReturnRefundScanRetry({ shopId, retryNotBefore, reason }) {
    const retryAt = new Date(retryNotBefore);
    if (!Number.isFinite(retryAt.getTime())) throw new Error('Invalid return-refund scan retry time');
    const retry = {
      retryNotBefore: retryAt.toISOString(),
      reason: String(reason || 'scan-failed').slice(0, 120),
    };
    await this.pool.query(`
      INSERT INTO shop_runtime_state (shop_id, status, metadata)
      VALUES ($1, 'idle', jsonb_build_object('returnRefundScanRetry', $2::jsonb))
      ON CONFLICT (shop_id) DO UPDATE SET
        metadata = coalesce(shop_runtime_state.metadata, '{}'::jsonb)
          || jsonb_build_object('returnRefundScanRetry', $2::jsonb),
        updated_at = now()`, [shopId, stringifyJsonb(retry)]);
    return retry;
  }

  async setReturnRefundScanCursor({ shopId, cursor, scan = null }) {
    const normalized = {
      page: Math.max(1, Math.min(10_000, Math.floor(Number(cursor?.page) || 1))),
      itemOffset: Math.max(0, Math.min(999, Math.floor(Number(cursor?.itemOffset) || 0))),
      updatedAt: new Date().toISOString(),
    };
    const actionScope = returnRefundCursorActionScope(normalized, scan)
      || returnRefundCursorActionScope(normalized, scan?.resumeProof);
    if (actionScope) normalized.actionScope = actionScope;
    await this.pool.query(`
      INSERT INTO shop_runtime_state (shop_id, status, metadata)
      VALUES ($1, 'idle', jsonb_build_object(
        'returnRefundScanCursor', $2::jsonb,
        'returnRefundLastScan', $3::jsonb
      ))
      ON CONFLICT (shop_id) DO UPDATE SET
        metadata = (coalesce(shop_runtime_state.metadata, '{}'::jsonb)
          - 'returnRefundScanRetry')
          || jsonb_build_object(
            'returnRefundScanCursor', $2::jsonb,
            'returnRefundLastScan', $3::jsonb
          ),
        updated_at = now()`, [shopId, stringifyJsonb(normalized), stringifyJsonb(scan || {})]);
    return normalized;
  }

  async enqueueReturnRefunds({ shopId, items = [], autoApproveEnabled = false }) {
    const accepted = [];
    for (const raw of items) {
      const orderNumber = String(raw.orderNumber || '').trim();
      const aftersaleNumber = String(raw.aftersaleNumber || '').trim();
      if (!orderNumber || !aftersaleNumber) continue;
      const capturedAt = raw.evidence?.capturedAt || new Date().toISOString();
      let decision = raw.decision || { outcome: raw.outcome || 'manual-review', reasons: [], rules: {} };
      let outcome = String(decision.outcome || 'manual-review');
      let waitUntil = outcome === 'wait-logistics'
        ? new Date(Date.parse(capturedAt) + 60 * 60_000).toISOString()
        : outcome === 'auto-refund' && !autoApproveEnabled
          ? new Date(Date.parse(capturedAt) + 15 * 60_000).toISOString()
          : null;
      let skippedNotFound = outcome === 'skipped-not-found';
      let actionState = skippedNotFound ? 'skipped-not-found'
        : outcome === 'wait-logistics' ? 'waiting-logistics'
        : outcome === 'auto-refund' ? 'ready'
          : outcome === 'manual-completed' ? 'manual-completed'
            : outcome === 'manual-review' ? 'manual-review' : 'page-error';
      let terminal = outcome === 'manual-completed';
      let automatedCompletion = isAutomatedReturnRefundCompletion(decision);
      let manual = outcome === 'manual-review' || (terminal && !automatedCompletion);
      let queued = outcome === 'auto-refund' && autoApproveEnabled;
      let status = skippedNotFound ? 'archived'
        : terminal ? 'completed' : manual ? 'paused' : queued ? 'queued' : 'retry-ready';
      let runtimeStatus = skippedNotFound ? 'archived'
        : terminal ? 'completed' : manual ? 'manual-review' : queued ? 'queued' : 'waiting';
      let currentStep = skippedNotFound ? 'return-refund-skipped-not-found'
        : terminal ? automatedCompletion
          ? 'return-refund-read-only-complete'
          : 'return-refund-manual-completed'
        : manual ? 'return-refund-manual-review'
          : outcome === 'wait-logistics' ? 'return-refund-waiting-logistics'
            : queued ? 'return-refund-ready' : 'return-refund-read-only-ready';
      const workOrderId = crypto.randomUUID();
      const idempotencyKey = `pdd-return-refund:${shopId}:${aftersaleNumber}`;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`return-refund:${aftersaleNumber}`]);
        let existing = await client.query(`
          SELECT refund.work_order_id, refund.action_state, refund.first_discovered_at,
            work_order.status, work_order.current_step
          FROM return_refunds refund
          JOIN work_orders work_order ON work_order.id = refund.work_order_id
          WHERE refund.shop_id = $1 AND refund.aftersale_number = $2
          FOR UPDATE`, [shopId, aftersaleNumber]);
        if (!existing.rowCount) {
          const crossSlot = await client.query(`
            SELECT refund.work_order_id, refund.action_state, refund.first_discovered_at,
              work_order.status, work_order.shop_id
            FROM return_refunds refund
            JOIN work_orders work_order ON work_order.id = refund.work_order_id
            WHERE refund.aftersale_number = $1
            ORDER BY refund.updated_at DESC
            LIMIT 1 FOR UPDATE OF refund, work_order`, [aftersaleNumber]);
          if (crossSlot.rowCount) {
            const row = crossSlot.rows[0];
            const activeEffect = await client.query(`
              SELECT 1 FROM external_effects
              WHERE work_order_id = $1 AND status IN ('reserved','unknown') LIMIT 1`, [row.work_order_id]);
            const successfulRefundEffect = await client.query(`
              SELECT 1 FROM external_effects
              WHERE work_order_id = $1 AND effect_type = 'pdd-return-refund'
                AND status = 'succeeded' LIMIT 1`, [row.work_order_id]);
            const activeLease = await client.query(`
              SELECT 1 FROM shop_runtime_state
              WHERE current_work_order_id = $1 AND lease_expires_at > now() LIMIT 1`, [row.work_order_id]);
            const terminalRefund = ['completed', 'archived'].includes(row.status)
              && ['auto-refunded', 'manual-completed'].includes(row.action_state);
            if (activeEffect.rowCount || activeLease.rowCount || row.status === 'processing'
              || (successfulRefundEffect.rowCount && !terminalRefund)) {
              const conflict = new Error(`Return refund ${aftersaleNumber} is still active in another browser slot`);
              conflict.code = 'PDD_DUPLICATE_SHOP_ACTIVE_RETURN_REFUND';
              conflict.conflictingShopId = row.shop_id;
              conflict.externalOrderNumber = orderNumber;
              conflict.aftersaleNumber = aftersaleNumber;
              throw conflict;
            }
            await client.query('UPDATE work_orders SET shop_id = $2, updated_at = now() WHERE id = $1', [row.work_order_id, shopId]);
            await client.query('UPDATE return_refunds SET shop_id = $2, updated_at = now() WHERE work_order_id = $1', [row.work_order_id, shopId]);
            for (const table of [
              'external_effects',
              'evidence_assets',
              'verification_locations',
              'audit_events',
              'workflow_events',
              'operator_commands',
              'manual_interventions',
            ]) {
              await client.query(`UPDATE ${table} SET shop_id = $2 WHERE work_order_id = $1`, [row.work_order_id, shopId]);
            }
            existing = crossSlot;
          }
        }
        const firstDiscoveredAt = existing.rows[0]?.first_discovered_at || capturedAt;
        if (outcome !== 'skipped-not-found') {
          decision = evaluateReturnRefundRules(raw, {
            now: Date.parse(capturedAt),
            firstDiscoveredAt,
          });
        }
        raw.decision = decision;
        raw.firstDiscoveredAt = new Date(firstDiscoveredAt).toISOString();
        outcome = String(decision.outcome || 'manual-review');
        waitUntil = outcome === 'wait-logistics'
          ? decision.nextCheckAt || new Date(Date.parse(capturedAt) + RETURN_REFUND_WAIT_RECHECK_MS).toISOString()
          : outcome === 'manual-review'
            ? decision.nextCheckAt || new Date(Date.parse(capturedAt) + RETURN_REFUND_MANUAL_REVIEW_RECHECK_MS).toISOString()
          : outcome === 'auto-refund' && !autoApproveEnabled
            ? new Date(Date.parse(capturedAt) + 15 * 60_000).toISOString()
            : null;
        skippedNotFound = outcome === 'skipped-not-found';
        actionState = skippedNotFound ? 'skipped-not-found'
          : outcome === 'wait-logistics' ? 'waiting-logistics'
          : outcome === 'auto-refund' ? 'ready'
            : outcome === 'manual-completed' ? 'manual-completed'
              : outcome === 'manual-review' ? 'manual-review' : 'page-error';
        terminal = outcome === 'manual-completed';
        automatedCompletion = isAutomatedReturnRefundCompletion(decision);
        manual = outcome === 'manual-review' || (terminal && !automatedCompletion);
        queued = outcome === 'auto-refund' && autoApproveEnabled;
        status = skippedNotFound ? 'archived'
          : terminal ? 'completed' : manual ? 'paused' : queued ? 'queued' : 'retry-ready';
        runtimeStatus = skippedNotFound ? 'archived'
          : terminal ? 'completed' : manual ? 'manual-review' : queued ? 'queued' : 'waiting';
        currentStep = skippedNotFound ? 'return-refund-skipped-not-found'
          : terminal ? automatedCompletion
            ? 'return-refund-read-only-complete'
            : 'return-refund-manual-completed'
          : manual ? 'return-refund-manual-review'
            : outcome === 'wait-logistics' ? 'return-refund-waiting-logistics'
              : queued ? 'return-refund-ready' : 'return-refund-read-only-ready';
        if (!terminal && existing.rows[0]?.status === 'paused'
          && existing.rows[0]?.current_step === 'return-refund-dispatched-unknown-manual-review') {
          const dispatchedEffect = await client.query(`
            SELECT 1 FROM external_effects
            WHERE work_order_id = $1 AND effect_type = 'pdd-return-refund'
              AND status IN ('unknown','failed')
              AND (receipt->'submission'->>'confirmationDispatchStarted' = 'true'
                OR receipt->'submission'->>'confirmationClicked' = 'true')
            LIMIT 1`, [existing.rows[0].work_order_id]);
          if (dispatchedEffect.rowCount) {
            await client.query('COMMIT');
            accepted.push({
              workOrderId: existing.rows[0].work_order_id,
              orderNumber,
              aftersaleNumber,
              outcome: 'manual-review',
              inserted: false,
              protectedDispatchedHold: true,
            });
            continue;
          }
        }
        let selectedWorkOrderId = existing.rows[0]?.work_order_id || null;
        if (!selectedWorkOrderId) {
          const inserted = await client.query(`
            INSERT INTO work_orders
              (id, shop_id, external_order_number, work_order_type, scenario_code,
               status, runtime_status, handling_classification, classification_source,
               classification_reason, classification_updated_at, idempotency_key,
               current_step, payload, manual_review_reason, next_attempt_at,
               completion_state, completion_confirmation_method, completion_confirmed_at)
            VALUES ($1,$2,$3,'退货退款','return-refund',$4,$5,$6,'system',$7,now(),$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
            ON CONFLICT (shop_id, idempotency_key) DO NOTHING
            RETURNING id`, [
            workOrderId,
            shopId,
            orderNumber,
            status,
            runtimeStatus,
            manual ? 'manual' : 'automated',
            raw.decision?.reasons?.join('；') || null,
            idempotencyKey,
            currentStep,
            stringifyJsonb({
              orderNumber,
              workOrderType: '退货退款',
              scenarioCode: 'return-refund',
              aftersaleNumber,
              shopNameSnapshot: raw.evidence?.detectedShopName || null,
              returnRefund: raw,
            }),
            manual && !terminal ? raw.decision?.reasons?.join('；') || '退货退款需要人工处理' : null,
            waitUntil,
            skippedNotFound ? 'not-applicable' : terminal ? 'confirmed' : 'pending',
            skippedNotFound ? 'return-refund-not-found'
              : terminal ? automatedCompletion
                ? 'return-refund-read-only-page-completed'
                : 'return-refund-manual-completed' : null,
            terminal ? capturedAt : null,
          ]);
          selectedWorkOrderId = inserted.rows[0]?.id || null;
          if (!selectedWorkOrderId) {
            const selected = await client.query(`SELECT id FROM work_orders
              WHERE shop_id = $1 AND idempotency_key = $2 FOR UPDATE`, [shopId, idempotencyKey]);
            selectedWorkOrderId = selected.rows[0]?.id || null;
          }
        }
        if (!selectedWorkOrderId) throw new Error(`Unable to persist return refund ${aftersaleNumber}`);

        const uncertainEffect = outcome === 'manual-completed'
          && confirmsReturnRefundCompletion(raw)
          ? await client.query(`
            SELECT id FROM external_effects
            WHERE work_order_id = $1 AND effect_type = 'pdd-return-refund'
              AND status IN ('reserved','unknown')
            ORDER BY reserved_at DESC LIMIT 1 FOR UPDATE`, [selectedWorkOrderId])
          : { rowCount: 0, rows: [] };
        if (uncertainEffect.rowCount) {
          outcome = 'auto-refunded';
          decision = { ...decision, outcome, reasons: [], riskLevel: null };
          raw.decision = decision;
          waitUntil = null;
          actionState = 'auto-refunded';
          terminal = true;
          automatedCompletion = true;
          manual = false;
          queued = false;
          status = 'completed';
          runtimeStatus = 'completed';
          currentStep = 'return-refund-auto-complete';
          await client.query(`
            UPDATE external_effects SET status = 'succeeded', error = NULL,
              receipt = coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb)
                || jsonb_build_object(
                'aftersaleNumber', $2::text,
                'orderNumber', $3::text,
                'reconciledFromPdd', true,
                'completionMethod', 'return-refund-button-disappeared',
                'reconciledAt', now()
              ), updated_at = now()
            WHERE id = $1`, [uncertainEffect.rows[0].id, aftersaleNumber, orderNumber]);
        }

        const immutableTerminal = ['auto-refunded', 'manual-completed', 'skipped-not-found']
          .includes(existing.rows[0]?.action_state);
        await client.query(`
          INSERT INTO return_refunds
            (work_order_id, shop_id, external_order_number, aftersale_number, detail_url,
             aftersale_type, aftersale_status, refund_amount, return_carrier,
             return_tracking_number, logistics_timeline, earliest_logistics_at, latest_logistics_at,
             logistics_transit_span_hours, logistics_contains_changsha,
             logistics_contains_hengshui_jizhou, logistics_direction_matched,
             rule_results, evidence, decision, risk_level,
             action_state, action_button_visible, next_check_at, last_scanned_at,
             completed_at, completion_method)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,
            $18::jsonb,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27)
          ON CONFLICT (work_order_id) DO UPDATE SET
            detail_url = EXCLUDED.detail_url,
            aftersale_type = EXCLUDED.aftersale_type,
            aftersale_status = EXCLUDED.aftersale_status,
            refund_amount = EXCLUDED.refund_amount,
            return_carrier = EXCLUDED.return_carrier,
            return_tracking_number = EXCLUDED.return_tracking_number,
            logistics_timeline = EXCLUDED.logistics_timeline,
            earliest_logistics_at = EXCLUDED.earliest_logistics_at,
            latest_logistics_at = EXCLUDED.latest_logistics_at,
            logistics_transit_span_hours = EXCLUDED.logistics_transit_span_hours,
            logistics_contains_changsha = EXCLUDED.logistics_contains_changsha,
            logistics_contains_hengshui_jizhou = EXCLUDED.logistics_contains_hengshui_jizhou,
            logistics_direction_matched = EXCLUDED.logistics_direction_matched,
            rule_results = EXCLUDED.rule_results,
            -- Keep the page observation that justified a read-only completion.
            -- Later discovery may refresh display fields without rewriting it.
            evidence = CASE
              WHEN return_refunds.action_state = 'manual-completed'
                AND return_refunds.completion_method = 'return-refund-read-only-page-completed'
                THEN return_refunds.evidence
              ELSE return_refunds.evidence || EXCLUDED.evidence
            END,
            decision = CASE WHEN return_refunds.action_state IN ('auto-refunded','manual-completed','skipped-not-found')
              THEN return_refunds.decision ELSE EXCLUDED.decision END,
            risk_level = CASE WHEN return_refunds.action_state IN ('auto-refunded','manual-completed','skipped-not-found')
              THEN return_refunds.risk_level ELSE EXCLUDED.risk_level END,
            action_state = CASE WHEN return_refunds.action_state IN ('auto-refunded','manual-completed','skipped-not-found')
              THEN return_refunds.action_state ELSE EXCLUDED.action_state END,
            action_button_visible = EXCLUDED.action_button_visible,
            next_check_at = CASE WHEN return_refunds.action_state IN ('auto-refunded','manual-completed','skipped-not-found')
              THEN NULL ELSE EXCLUDED.next_check_at END,
            last_scanned_at = EXCLUDED.last_scanned_at,
            completed_at = coalesce(return_refunds.completed_at, EXCLUDED.completed_at),
            completion_method = coalesce(return_refunds.completion_method, EXCLUDED.completion_method),
            updated_at = now()`, [
          selectedWorkOrderId, shopId, orderNumber, aftersaleNumber, raw.detailUrl || null,
          raw.aftersaleType || null, raw.aftersaleStatus || null, raw.refundAmount,
          raw.returnCarrier || null, raw.returnTrackingNumber || null,
          stringifyJsonb(raw.logisticsTimeline || []), raw.earliestLogisticsAt || null,
          raw.latestLogisticsAt || null, raw.logisticsTransitSpanHours,
          raw.logisticsContainsChangsha, raw.logisticsContainsHengshuiJizhou,
          raw.logisticsDirectionMatched, stringifyJsonb(decision.rules || {}),
          stringifyJsonb(raw.evidence || {}), outcome, decision.riskLevel || null,
          actionState, raw.actionButtonVisible, waitUntil, capturedAt,
          terminal || skippedNotFound ? capturedAt : null,
          skippedNotFound ? 'return-refund-not-found'
            : terminal ? (outcome === 'auto-refunded'
              ? 'return-refund-button-disappeared'
              : automatedCompletion
                ? 'return-refund-read-only-page-completed'
                : 'return-refund-manual-completed') : null,
        ]);

        if (!immutableTerminal) {
          await client.query(`
            UPDATE work_orders SET status = $2, runtime_status = $3, current_step = $4,
              handling_classification = $5, classification_reason = $6,
              classification_updated_at = now(), manual_review_reason = $7,
              next_attempt_at = $8,
              payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
                'scenarioCode', 'return-refund',
                'aftersaleNumber', $9::text,
                'returnRefund', $10::jsonb,
                'shopNameSnapshot', $14::text
              ),
              completion_state = $11,
              completion_confirmation_method = $12,
              completion_confirmed_at = $13,
              updated_at = now()
            WHERE id = $1 AND status <> 'processing'`, [
            selectedWorkOrderId, status, runtimeStatus, currentStep,
            manual ? 'manual' : 'automated', decision.reasons?.join('；') || null,
            manual && !terminal ? decision.reasons?.join('；') || '退货退款需要人工处理' : null,
            waitUntil, aftersaleNumber, stringifyJsonb(raw),
            skippedNotFound ? 'not-applicable' : terminal ? 'confirmed' : 'pending',
            skippedNotFound ? 'return-refund-not-found'
              : terminal ? (outcome === 'auto-refunded'
                ? 'return-refund-button-disappeared'
                : automatedCompletion
                  ? 'return-refund-read-only-page-completed'
                  : 'return-refund-manual-completed') : null,
            terminal ? capturedAt : null,
            raw.evidence?.detectedShopName || null,
          ]);
        }

        const scanEventKey = `return-refund:${shopId}:${aftersaleNumber}:decision:${capturedAt}`;
        await client.query(`
          INSERT INTO workflow_events
            (id, event_key, shop_id, work_order_id, external_order_number, system_name,
             stage, event_type, severity, reason_code, message, payload, source_hash, occurred_at)
          VALUES ($1,$2,$3,$4,$5,'pdd','return-refund-decision','return-refund.decision',$6,$7,$8,$9::jsonb,$10,$11)
          ON CONFLICT (event_key) DO NOTHING`, [
          crypto.randomUUID(), scanEventKey, shopId, selectedWorkOrderId, orderNumber,
          manual && !terminal ? 'warning' : 'info',
          decision.reasons?.[0] || null,
          terminal || skippedNotFound
            ? outcome === 'auto-refunded'
              ? '自动退款提交已由按钮消失复核完成'
              : skippedNotFound
                ? '拼多多明确提示订单或售后单不存在，已永久跳过'
                : automatedCompletion
                  ? '自动只读识别到拼多多售后已完成'
                  : '人工已在平台完成该售后'
            : outcome === 'auto-refund' ? '满足自动退款条件' : decision.reasons?.join('；') || outcome,
          stringifyJsonb({ aftersaleNumber, outcome, waitReasonCode: decision.waitReasonCode || null, rules: decision.rules || {}, evidence: raw.evidence || {} }),
          crypto.createHash('sha256').update(scanEventKey).digest('hex'), capturedAt,
        ]);

        if (manual && !terminal) {
          const manualReasonCode = decision.manualReasonCode || 'return-refund-manual-review';
          await client.query(`
            WITH closed AS (
              UPDATE manual_interventions SET status = 'cancelled',
                resolved_at = coalesce(resolved_at, now()),
                resolved_by = coalesce(resolved_by, 'return-refund-reason-reclassified')
              WHERE work_order_id = $1 AND status IN ('open','acknowledged')
                AND reason_code <> $2
              RETURNING id
            )
            UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
            FROM closed WHERE outbox.intervention_id = closed.id
              AND outbox.status IN ('pending','sending','failed')`, [selectedWorkOrderId, manualReasonCode]);
          await client.query(`
            INSERT INTO manual_interventions
              (id, shop_id, work_order_id, channel, reason_code, reason, risk_level,
               status, deduplication_key)
            VALUES ($1,$2,$3,'dashboard',$4,$5,$6,'open',$7)
            ON CONFLICT (deduplication_key) DO UPDATE SET
              reason = EXCLUDED.reason, risk_level = EXCLUDED.risk_level,
              status = 'open', resolved_at = NULL, resolved_by = NULL`, [
            crypto.randomUUID(), shopId, selectedWorkOrderId,
            manualReasonCode,
            decision.reasons?.join('；') || '退货退款需要人工处理',
            decision.riskLevel || 'high',
            `return-refund:${shopId}:${aftersaleNumber}:dashboard:${decision.manualReasonCode || 'general'}`,
          ]);
        }
        if (!manual) {
          await client.query(`
            WITH closed AS (
              UPDATE manual_interventions SET status = 'cancelled',
                resolved_at = coalesce(resolved_at, now()),
                resolved_by = coalesce(resolved_by, 'return-refund-rule-reclassified')
              WHERE work_order_id = $1 AND status IN ('open','acknowledged')
              RETURNING id
            )
            UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
            FROM closed WHERE outbox.intervention_id = closed.id
              AND outbox.status IN ('pending','sending','failed')`, [selectedWorkOrderId]);
        }
        if (terminal) {
          await client.query(`UPDATE manual_interventions
            SET status = 'resolved', resolved_at = coalesce(resolved_at, now()),
              resolved_by = coalesce(resolved_by, 'pdd-return-refund-reconciliation')
            WHERE work_order_id = $1 AND status IN ('open','acknowledged')`, [selectedWorkOrderId]);
        }
        await client.query('COMMIT');
        accepted.push({ workOrderId: selectedWorkOrderId, orderNumber, aftersaleNumber, outcome, inserted: !existing.rowCount });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    return accepted;
  }

  async resolveDetachedClearedReturnRefundVerification({
    shopId,
    assignmentId,
    verificationId,
    commandCompletedAt,
    resolvedAt = new Date().toISOString(),
  } = {}) {
    const normalizedShopId = String(shopId || '').trim();
    const normalizedAssignmentId = String(assignmentId || '').trim();
    const normalizedVerificationId = String(verificationId || '').trim();
    const parsedCommandCompletedAt = Date.parse(String(commandCompletedAt || ''));
    const parsedResolvedAt = Date.parse(String(resolvedAt || ''));
    if (!normalizedShopId
      || !normalizedAssignmentId
      || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(normalizedVerificationId)
      || !Number.isFinite(parsedCommandCompletedAt)
      || !Number.isFinite(parsedResolvedAt)) return null;
    const commandCompletionTimestamp = new Date(parsedCommandCompletedAt).toISOString();
    const resolutionTimestamp = new Date(parsedResolvedAt).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT work_order.id
        FROM work_orders work_order
        JOIN return_refunds refund ON refund.work_order_id = work_order.id
        JOIN verification_locations verification
          ON verification.work_order_id = work_order.id
          AND verification.shop_id = work_order.shop_id
          AND verification.id = $3::uuid
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code = 'return-refund'
          AND work_order.status = 'retry-ready'
          AND work_order.runtime_status IN ('waiting','verification')
          AND work_order.current_step = 'return-refund-verification-required'
          AND coalesce(work_order.completion_state, 'pending') = 'pending'
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
          AND work_order.payload #>> '{residentCommand,assignmentId}' = $2
          AND work_order.payload #>> '{returnRefundResult,outcome}' = 'verification-required'
          AND refund.action_state = 'verification-required'
          AND (
            (
              verification.status IN ('detected','waiting-human','verification-required')
              AND verification.resolved_at IS NULL
            ) OR (
              verification.status IN ('expired','resolved')
              AND verification.resolved_at IS NOT NULL
              AND verification.resolved_at <= $4::timestamptz + interval '5 seconds'
              AND $4::timestamptz >= $5::timestamptz
            )
          )
          AND verification.detected_at <= $4::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.status IN ('reserved','unknown')
          )
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_expires_at > now()
          )
        FOR UPDATE OF work_order, refund, verification`, [
        normalizedShopId,
        normalizedAssignmentId,
        normalizedVerificationId,
        resolutionTimestamp,
        commandCompletionTimestamp,
      ]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const workOrderId = selected.rows[0].id;
      await client.query(`
        UPDATE verification_locations SET status = 'resolved',
          resolved_at = coalesce(resolved_at, $4::timestamptz)
        WHERE id = $3::uuid AND shop_id = $1 AND work_order_id = $2`, [
        normalizedShopId,
        workOrderId,
        normalizedVerificationId,
        resolutionTimestamp,
      ]);
      const remaining = await client.query(`
        SELECT 1 FROM verification_locations
        WHERE shop_id = $1 AND work_order_id = $2
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL
        LIMIT 1`, [normalizedShopId, workOrderId]);
      if (remaining.rowCount) {
        await client.query('COMMIT');
        return { workOrderId, verificationResolved: true, requeued: false };
      }
      await client.query(`
        UPDATE return_refunds SET
          next_check_at = least(coalesce(next_check_at, $3::timestamptz), $3::timestamptz),
          updated_at = now()
        WHERE work_order_id = $1 AND shop_id = $2`, [
        workOrderId,
        normalizedShopId,
        resolutionTimestamp,
      ]);
      await client.query(`
        UPDATE work_orders SET status = 'retry-ready', runtime_status = 'waiting',
          next_attempt_at = least(coalesce(next_attempt_at, $3::timestamptz), $3::timestamptz),
          updated_at = now()
        WHERE id = $1 AND shop_id = $2`, [
        workOrderId,
        normalizedShopId,
        resolutionTimestamp,
      ]);
      await resolveClearedVerificationInterventions(client, {
        shopId: normalizedShopId,
        workOrderId,
        resolvedAt: resolutionTimestamp,
        resolvedBy: 'resident-return-refund-verification-cleared',
      });
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
        VALUES ($1,$2::uuid,'worker-resident-browser',
          'return-refund-verification-cleared-immediate-requeue',
          jsonb_build_object(
            'assignmentId', $3::text,
            'verificationId', $4::text,
            'resolvedAt', $5::timestamptz
          ),
          'return-refund-verification-cleared:' || ($2::uuid)::text || ':' || $4::text)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        normalizedShopId,
        workOrderId,
        normalizedAssignmentId,
        normalizedVerificationId,
        resolutionTimestamp,
      ]);
      await client.query('COMMIT');
      return { workOrderId, verificationResolved: true, requeued: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveRestoredPreClaimPddVerification({
    shopId,
    verificationId,
    workOrderId,
    recoveryStartedAt,
    authenticatedAt,
    resolvedAt = new Date().toISOString(),
    verificationUrl = '',
    observedUrl = '',
  } = {}) {
    const normalizedShopId = String(shopId || '').trim();
    const normalizedVerificationId = String(verificationId || '').trim();
    const normalizedWorkOrderId = String(workOrderId || '').trim();
    const normalizedVerificationUrl = String(verificationUrl || '').trim();
    const normalizedObservedUrl = String(observedUrl || '').trim();
    const parsedRecoveryStartedAt = Date.parse(String(recoveryStartedAt || ''));
    const parsedAuthenticatedAt = Date.parse(String(authenticatedAt || ''));
    const parsedResolvedAt = Date.parse(String(resolvedAt || ''));
    const validUuid = (value) => (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    );
    const authenticatedPddUrl = (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:'
          && parsed.hostname === 'mms.pinduoduo.com'
          && !parsed.pathname.startsWith('/login');
      } catch {
        return false;
      }
    };
    const trustedPddVerificationUrl = (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:'
          && parsed.hostname === 'mms.pinduoduo.com';
      } catch {
        return false;
      }
    };
    if (!normalizedShopId
      || !validUuid(normalizedVerificationId)
      || !validUuid(normalizedWorkOrderId)
      || !Number.isFinite(parsedRecoveryStartedAt)
      || !Number.isFinite(parsedAuthenticatedAt)
      || !Number.isFinite(parsedResolvedAt)
      || parsedRecoveryStartedAt > parsedAuthenticatedAt
      || parsedAuthenticatedAt > parsedResolvedAt
      // A real PDD login/QR challenge starts on /login and redirects to an
      // authenticated business URL after it is cleared. The original URL must
      // remain trusted and exact; only the final observed URL must be logged in.
      || !trustedPddVerificationUrl(normalizedVerificationUrl)
      || !authenticatedPddUrl(normalizedObservedUrl)) return null;
    const recoveryStartedTimestamp = new Date(parsedRecoveryStartedAt).toISOString();
    const authenticationTimestamp = new Date(parsedAuthenticatedAt).toISOString();
    const resolutionTimestamp = new Date(parsedResolvedAt).toISOString();
    const recoveryEvidence = {
      trigger: 'resident-browser-restart-recovery',
      status: 'cleared',
      verificationId: normalizedVerificationId,
      workOrderId: normalizedWorkOrderId,
      verificationUrl: normalizedVerificationUrl,
      observedUrl: normalizedObservedUrl,
      startedAt: recoveryStartedTimestamp,
      authenticatedAt: authenticationTimestamp,
      completedAt: resolutionTimestamp,
      externalActionsReplayed: false,
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT verification.id, verification.stage, verification.detected_at,
          verification.url, work_order.scenario_code, work_order.status,
          work_order.runtime_status, work_order.current_step,
          work_order.current_ordinary_instance_id,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.status IN ('reserved','unknown')
          ) AS has_uncertain_effects
        FROM verification_locations verification
        JOIN work_orders work_order
          ON work_order.id = verification.work_order_id
          AND work_order.shop_id = verification.shop_id
        WHERE verification.id = $2::uuid
          AND verification.shop_id = $1
          AND verification.work_order_id = $3::uuid
          AND lower(verification.system_name) = 'pdd'
          AND verification.status IN ('detected','waiting-human','verification-required')
          AND verification.resolved_at IS NULL
          AND verification.url = $7::text
          AND verification.detected_at <= $4::timestamptz
          AND verification.detected_at <= $5::timestamptz
          AND verification.detected_at <= $6::timestamptz
          AND coalesce(work_order.completion_state, 'pending') = 'pending'
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
          AND work_order.status NOT IN ('completed','archived')
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
        FOR UPDATE OF verification, work_order`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId,
        recoveryStartedTimestamp,
        authenticationTimestamp,
        resolutionTimestamp,
        normalizedVerificationUrl,
      ]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const verification = selected.rows[0];
      const safeToRequeue = verification.status === 'retry-ready'
        || verification.runtime_status === 'verification'
        || /verification|human-verification/iu.test(String(verification.current_step || ''));
      await client.query(`
        UPDATE verification_locations SET status = 'resolved', resolved_at = $4::timestamptz
        WHERE id = $2::uuid AND shop_id = $1 AND work_order_id = $3::uuid
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId,
        resolutionTimestamp,
      ]);
      const remaining = await client.query(`
        SELECT 1 FROM verification_locations
        WHERE shop_id = $1 AND work_order_id = $2::uuid
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL
        LIMIT 1`, [normalizedShopId, normalizedWorkOrderId]);
      // Authentication recovery proves only that verification cleared. An
      // interrupted submit still belongs to read-only reconciliation; moving
      // it to retry-ready while recovery_state is reconciling strands it
      // between both queues and could authorize an unsafe replay later.
      const requeued = safeToRequeue && !remaining.rowCount
        && !verification.has_uncertain_effects;
      if (requeued) {
        const cleanedPayload = `jsonb_set(
          coalesce(payload, '{}'::jsonb)
            - 'verificationLocation' - 'verificationStage' - 'verificationFocus' - 'error',
          '{verificationRecovery}', $4::jsonb, true
        ) || jsonb_build_object('updatedAt', $3::text)`;
        await client.query(`
          UPDATE work_orders SET
            status = 'retry-ready', runtime_status = 'waiting',
            current_step = 'verification-cleared-retry-ready',
            next_attempt_at = least(coalesce(next_attempt_at, $3::timestamptz), $3::timestamptz),
            payload = ${cleanedPayload}, updated_at = now()
          WHERE id = $1::uuid AND shop_id = $2`, [
          normalizedWorkOrderId,
          normalizedShopId,
          resolutionTimestamp,
          stringifyJsonb(recoveryEvidence),
        ]);
        if (verification.current_ordinary_instance_id) {
          await client.query(`
            UPDATE ordinary_work_order_instances SET
              status = 'retry-ready', runtime_status = 'waiting',
              current_step = 'verification-cleared-retry-ready',
              next_attempt_at = least(coalesce(next_attempt_at, $3::timestamptz), $3::timestamptz),
              payload = ${cleanedPayload}, updated_at = now()
            WHERE id = $1::uuid AND shop_id = $2`, [
            verification.current_ordinary_instance_id,
            normalizedShopId,
            resolutionTimestamp,
            stringifyJsonb(recoveryEvidence),
          ]);
        }
        if (verification.scenario_code === 'return-refund') {
          await client.query(`
            UPDATE return_refunds SET
              next_check_at = least(coalesce(next_check_at, $3::timestamptz), $3::timestamptz),
              updated_at = now()
            WHERE work_order_id = $1::uuid AND shop_id = $2`, [
            normalizedWorkOrderId,
            normalizedShopId,
            resolutionTimestamp,
          ]);
        }
      }
      await resolveClearedVerificationInterventions(client, {
        shopId: normalizedShopId,
        workOrderId: normalizedWorkOrderId,
        resolvedAt: resolutionTimestamp,
        resolvedBy: 'worker-resident-browser-restart-recovery',
      });
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
        VALUES ($1,$2::uuid,'worker-resident-browser',
          'pre-claim-pdd-verification-browser-recovered',
          jsonb_build_object(
            'verificationId', $3::text,
            'stage', $4::text,
            'detectedAt', $5::timestamptz,
            'recoveryStartedAt', $6::timestamptz,
            'authenticatedAt', $7::timestamptz,
            'resolvedAt', $8::timestamptz,
            'verificationUrl', $9::text,
            'observedUrl', $10::text,
            'requeued', $11::boolean,
            'uncertainEffectsPreserved', $12::boolean,
            'externalActionsReplayed', false
          ),
          'pre-claim-pdd-verification-browser-recovered:' || $1 || ':' || $3::text)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        normalizedShopId,
        normalizedWorkOrderId,
        normalizedVerificationId,
        verification.stage,
        verification.detected_at,
        recoveryStartedTimestamp,
        authenticationTimestamp,
        resolutionTimestamp,
        recoveryEvidence.verificationUrl,
        recoveryEvidence.observedUrl,
        requeued,
        Boolean(verification.has_uncertain_effects),
      ]);
      await client.query('COMMIT');
      return {
        verificationId: normalizedVerificationId,
        workOrderId: normalizedWorkOrderId,
        verificationResolved: true,
        requeued,
        uncertainEffectsPreserved: Boolean(verification.has_uncertain_effects),
        externalActionsReplayed: false,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveStaleBoundPddVerificationGate({
    shopId,
    verificationId,
    workOrderId,
    detectedAt,
    authenticatedAt,
    runtimeObservedAt,
    resolvedAt = new Date().toISOString(),
    observedUrl = '',
  } = {}) {
    const normalizedShopId = String(shopId || '').trim();
    const normalizedVerificationId = String(verificationId || '').trim();
    const normalizedWorkOrderId = String(workOrderId || '').trim();
    const normalizedObservedUrl = String(observedUrl || '').trim();
    const parsedDetectedAt = Date.parse(String(detectedAt || ''));
    const parsedAuthenticatedAt = Date.parse(String(authenticatedAt || ''));
    const parsedRuntimeObservedAt = Date.parse(String(runtimeObservedAt || ''));
    const parsedResolvedAt = Date.parse(String(resolvedAt || ''));
    const validUuid = (value) => (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    );
    const authenticatedPddUrl = (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:'
          && parsed.hostname === 'mms.pinduoduo.com'
          && !parsed.pathname.startsWith('/login');
      } catch {
        return false;
      }
    };
    if (!normalizedShopId
      || !validUuid(normalizedVerificationId)
      || !validUuid(normalizedWorkOrderId)
      || !Number.isFinite(parsedDetectedAt)
      || !Number.isFinite(parsedAuthenticatedAt)
      || !Number.isFinite(parsedRuntimeObservedAt)
      || !Number.isFinite(parsedResolvedAt)
      || parsedDetectedAt > parsedAuthenticatedAt
      || parsedDetectedAt > parsedRuntimeObservedAt
      || parsedAuthenticatedAt > parsedResolvedAt + 5_000
      || parsedRuntimeObservedAt > parsedResolvedAt + 5_000
      || parsedResolvedAt - parsedDetectedAt < 60_000
      || parsedResolvedAt - parsedAuthenticatedAt > 2 * 60_000
      || parsedResolvedAt - parsedRuntimeObservedAt > 2 * 60_000
      || !authenticatedPddUrl(normalizedObservedUrl)) return null;
    const detectionTimestamp = new Date(parsedDetectedAt).toISOString();
    const authenticationTimestamp = new Date(parsedAuthenticatedAt).toISOString();
    const runtimeObservationTimestamp = new Date(parsedRuntimeObservedAt).toISOString();
    const resolutionTimestamp = new Date(parsedResolvedAt).toISOString();
    const recoveryEvidence = {
      trigger: 'stale-bound-pre-claim-reconciliation',
      status: 'cleared',
      verificationId: normalizedVerificationId,
      workOrderId: normalizedWorkOrderId,
      detectedAt: detectionTimestamp,
      authenticatedAt: authenticationTimestamp,
      runtimeObservedAt: runtimeObservationTimestamp,
      completedAt: resolutionTimestamp,
      observedUrl: normalizedObservedUrl,
      externalActionsReplayed: false,
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT verification.id, verification.stage, verification.detected_at
        FROM verification_locations verification
        JOIN work_orders work_order
          ON work_order.id = verification.work_order_id
          AND work_order.shop_id = verification.shop_id
        JOIN return_refunds refund
          ON refund.work_order_id = work_order.id
          AND refund.shop_id = work_order.shop_id
        LEFT JOIN workflow_checkpoints checkpoint
          ON checkpoint.shop_id = verification.shop_id
        WHERE verification.id = $2::uuid
          AND verification.shop_id = $1
          AND verification.work_order_id = $3::uuid
          AND lower(verification.system_name) = 'pdd'
          AND verification.status IN ('detected','waiting-human','verification-required')
          AND verification.resolved_at IS NULL
          AND verification.detected_at = $4::timestamptz
          AND verification.detected_at <= $5::timestamptz
          AND verification.detected_at <= $6::timestamptz
          AND verification.detected_at <= $7::timestamptz - interval '60 seconds'
          AND $5::timestamptz <= $7::timestamptz + interval '5 seconds'
          AND $5::timestamptz >= $7::timestamptz - interval '2 minutes'
          AND $6::timestamptz BETWEEN $7::timestamptz - interval '2 minutes'
            AND $7::timestamptz + interval '5 seconds'
          AND (
            checkpoint.shop_id IS NULL
            OR coalesce(checkpoint.snapshot #>> '{verificationLocation,id}', '') = ''
            OR (
              checkpoint.snapshot #>> '{verificationLocation,id}' = verification.id::text
              AND checkpoint.source_updated_at < $5::timestamptz
            )
          )
          AND work_order.scenario_code = 'return-refund'
          AND work_order.status = 'retry-ready'
          AND work_order.runtime_status IN ('waiting','verification','retry-ready')
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND work_order.current_step = 'return-refund-verification-required'
          AND coalesce(work_order.completion_state, 'pending') = 'pending'
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
          AND refund.action_state = 'verification-required'
          AND refund.completed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
          )
        FOR UPDATE OF verification, work_order, refund`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId,
        detectionTimestamp,
        authenticationTimestamp,
        runtimeObservationTimestamp,
        resolutionTimestamp,
      ]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const verification = selected.rows[0];
      const resolved = await client.query(`
        UPDATE verification_locations SET status = 'resolved', resolved_at = $4::timestamptz
        WHERE id = $2::uuid AND shop_id = $1 AND work_order_id = $3::uuid
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL
        RETURNING id`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId,
        resolutionTimestamp,
      ]);
      if (!resolved.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const remaining = await client.query(`
        SELECT 1 FROM verification_locations
        WHERE shop_id = $1 AND work_order_id = $2::uuid
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL
        LIMIT 1`, [normalizedShopId, normalizedWorkOrderId]);
      const requeued = !remaining.rowCount;
      if (requeued) {
        const cleanedPayload = `jsonb_set(
          coalesce(payload, '{}'::jsonb)
            - 'verificationLocation' - 'verificationStage' - 'verificationFocus' - 'error',
          '{verificationRecovery}', $4::jsonb, true
        ) || jsonb_build_object('updatedAt', $3::text)`;
        await client.query(`
          UPDATE work_orders SET
            status = 'retry-ready', runtime_status = 'waiting',
            current_step = 'verification-cleared-retry-ready',
            next_attempt_at = least(coalesce(next_attempt_at, $3::timestamptz), $3::timestamptz),
            payload = ${cleanedPayload}, updated_at = now()
          WHERE id = $1::uuid AND shop_id = $2`, [
          normalizedWorkOrderId,
          normalizedShopId,
          resolutionTimestamp,
          stringifyJsonb(recoveryEvidence),
        ]);
        await client.query(`
          UPDATE return_refunds SET
            next_check_at = least(coalesce(next_check_at, $3::timestamptz), $3::timestamptz),
            updated_at = now()
          WHERE work_order_id = $1::uuid AND shop_id = $2
            AND action_state = 'verification-required'
            AND completed_at IS NULL`, [
          normalizedWorkOrderId,
          normalizedShopId,
          resolutionTimestamp,
        ]);
        await resolveClearedVerificationInterventions(client, {
          shopId: normalizedShopId,
          workOrderId: normalizedWorkOrderId,
          resolvedAt: resolutionTimestamp,
          resolvedBy: 'worker-stale-bound-pdd-verification-recovery',
        });
      }
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
        VALUES ($1,$2::uuid,'worker-resident-browser',
          'stale-bound-pdd-verification-reconciled',
          jsonb_build_object(
            'verificationId', $3::text,
            'stage', $4::text,
            'detectedAt', $5::timestamptz,
            'authenticatedAt', $6::timestamptz,
            'runtimeObservedAt', $7::timestamptz,
            'resolvedAt', $8::timestamptz,
            'observedUrl', $9::text,
            'requeued', $10::boolean,
            'strategy', 'detached-bound-return-refund-read-only-reevaluation',
            'externalActionsReplayed', false
          ),
          'stale-bound-pdd-verification-reconciled:' || $1 || ':' || $3::text)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        normalizedShopId,
        normalizedWorkOrderId,
        normalizedVerificationId,
        verification.stage,
        verification.detected_at,
        authenticationTimestamp,
        runtimeObservationTimestamp,
        resolutionTimestamp,
        normalizedObservedUrl,
        requeued,
      ]);
      await client.query('COMMIT');
      return {
        verificationId: normalizedVerificationId,
        workOrderId: normalizedWorkOrderId,
        verificationResolved: true,
        requeued,
        externalActionsReplayed: false,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveStaleBoundOrdinaryPddVerificationGate({
    shopId,
    verificationId,
    workOrderId,
    identityBindingToken,
    detectedAt,
    authenticatedAt,
    runtimeObservedAt,
    resolvedAt = new Date().toISOString(),
    observedUrl = '',
  } = {}) {
    const normalizedShopId = String(shopId || '').trim();
    const normalizedVerificationId = String(verificationId || '').trim();
    const normalizedWorkOrderId = String(workOrderId || '').trim();
    const normalizedBindingToken = String(identityBindingToken || '').trim();
    const normalizedObservedUrl = String(observedUrl || '').trim();
    const parsedDetectedAt = Date.parse(String(detectedAt || ''));
    const parsedAuthenticatedAt = Date.parse(String(authenticatedAt || ''));
    const parsedRuntimeObservedAt = Date.parse(String(runtimeObservedAt || ''));
    const parsedResolvedAt = Date.parse(String(resolvedAt || ''));
    const validUuid = (value) => (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    );
    const authenticatedPddUrl = (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:'
          && parsed.hostname === 'mms.pinduoduo.com'
          && !parsed.pathname.startsWith('/login');
      } catch {
        return false;
      }
    };
    if (!normalizedShopId
      || !validUuid(normalizedVerificationId)
      || !validUuid(normalizedWorkOrderId)
      || !validUuid(normalizedBindingToken)
      || !Number.isFinite(parsedDetectedAt)
      || !Number.isFinite(parsedAuthenticatedAt)
      || !Number.isFinite(parsedRuntimeObservedAt)
      || !Number.isFinite(parsedResolvedAt)
      || parsedDetectedAt > parsedAuthenticatedAt
      || parsedDetectedAt > parsedRuntimeObservedAt
      || parsedAuthenticatedAt > parsedResolvedAt + 5_000
      || parsedRuntimeObservedAt > parsedResolvedAt + 5_000
      || parsedResolvedAt - parsedDetectedAt < 60_000
      || parsedResolvedAt - parsedRuntimeObservedAt > 2 * 60_000
      || !authenticatedPddUrl(normalizedObservedUrl)) return null;
    const detectionTimestamp = new Date(parsedDetectedAt).toISOString();
    const authenticationTimestamp = new Date(parsedAuthenticatedAt).toISOString();
    const runtimeObservationTimestamp = new Date(parsedRuntimeObservedAt).toISOString();
    const resolutionTimestamp = new Date(parsedResolvedAt).toISOString();
    const recoveryEvidence = {
      trigger: 'stale-bound-ordinary-pre-claim-reconciliation',
      status: 'cleared',
      verificationId: normalizedVerificationId,
      workOrderId: normalizedWorkOrderId,
      detectedAt: detectionTimestamp,
      authenticatedAt: authenticationTimestamp,
      runtimeObservedAt: runtimeObservationTimestamp,
      completedAt: resolutionTimestamp,
      observedUrl: normalizedObservedUrl,
      identityBindingToken: normalizedBindingToken,
      externalActionsReplayed: false,
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT verification.id, verification.stage, verification.detected_at,
          work_order.current_ordinary_instance_id,
          work_order.external_order_number,
          work_order.scenario_code,
          (
            SELECT count(*)::int
            FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND (effect.ordinary_instance_id IS NULL
                OR effect.ordinary_instance_id = instance.id)
              AND effect.status = 'succeeded'
          ) AS succeeded_effect_count
        FROM verification_locations verification
        JOIN work_orders work_order
          ON work_order.id = verification.work_order_id
          AND work_order.shop_id = verification.shop_id
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.work_order_id = work_order.id
          AND instance.shop_id = work_order.shop_id
        JOIN pdd_shop_runtime_bindings binding
          ON binding.shop_id = work_order.shop_id
          AND binding.binding_token::text = $8::text
        JOIN shop_identity_bindings identity
          ON identity.shop_id = work_order.shop_id
          AND identity.status = 'confirmed'
          AND identity.profile_fingerprint = binding.profile_fingerprint
        LEFT JOIN workflow_checkpoints checkpoint
          ON checkpoint.shop_id = verification.shop_id
        WHERE verification.id = $2::uuid
          AND verification.shop_id = $1
          AND verification.work_order_id = $3::uuid
          AND verification.ordinary_instance_id = instance.id
          AND lower(verification.system_name) = 'pdd'
          AND verification.status IN ('detected','waiting-human','verification-required')
          AND verification.resolved_at IS NULL
          AND verification.detected_at = $4::timestamptz
          AND verification.detected_at <= $5::timestamptz
          AND verification.detected_at <= $6::timestamptz
          AND verification.detected_at <= $7::timestamptz - interval '60 seconds'
          AND $5::timestamptz <= $7::timestamptz + interval '5 seconds'
          AND $6::timestamptz BETWEEN $7::timestamptz - interval '2 minutes'
            AND $7::timestamptz + interval '5 seconds'
          AND (
            checkpoint.shop_id IS NULL
            OR coalesce(checkpoint.snapshot #>> '{verificationLocation,id}', '') = ''
            OR (
              checkpoint.snapshot #>> '{verificationLocation,id}' = verification.id::text
              AND checkpoint.source_updated_at < $5::timestamptz
            )
          )
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.scenario_code IS DISTINCT FROM 'product-shortage'
          AND work_order.status = 'retry-ready'
          AND work_order.runtime_status IN ('waiting','verification','retry-ready')
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND work_order.current_step = 'human-verification-required'
          AND coalesce(work_order.completion_state, 'pending') = 'pending'
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
          AND instance.identity_status = 'verified'
          AND instance.status = 'retry-ready'
          AND instance.runtime_status IN ('waiting','verification','retry-ready')
          AND instance.current_step = 'human-verification-required'
          AND work_order.payload #>> '{latestDiscovery,pddIdentityBindingToken}' = $8::text
          AND instance.payload #>> '{latestDiscovery,pddIdentityBindingToken}' = $8::text
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = work_order.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND (effect.ordinary_instance_id IS NULL
                OR effect.ordinary_instance_id = instance.id)
              AND (
                effect.status <> 'succeeded'
                OR effect.effect_type IN ('pdd-submit','pdd-return-refund')
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND (effect.ordinary_instance_id IS NULL
                OR effect.ordinary_instance_id = instance.id)
              AND effect.effect_type = 'tms-create'
              AND effect.status = 'succeeded'
              AND NOT EXISTS (
                SELECT 1 FROM tms_work_orders tms
                WHERE tms.work_order_id = work_order.id
                  AND (tms.ordinary_instance_id IS NULL
                    OR tms.ordinary_instance_id = instance.id)
                  AND tms.status IN ('created','succeeded','completed')
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM tms_work_orders tms
            WHERE tms.work_order_id = work_order.id
              AND (tms.ordinary_instance_id IS NULL
                OR tms.ordinary_instance_id = instance.id)
              AND NOT EXISTS (
                SELECT 1 FROM external_effects effect
                WHERE effect.work_order_id = work_order.id
                  AND (effect.ordinary_instance_id IS NULL
                    OR effect.ordinary_instance_id = instance.id)
                  AND effect.effect_type = 'tms-create'
                  AND effect.status = 'succeeded'
              )
          )
        FOR UPDATE OF verification, work_order, instance`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId,
        detectionTimestamp,
        authenticationTimestamp,
        runtimeObservationTimestamp,
        resolutionTimestamp,
        normalizedBindingToken,
      ]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const verification = selected.rows[0];
      const resolved = await client.query(`
        UPDATE verification_locations SET status = 'resolved', resolved_at = $4::timestamptz
        WHERE id = $2::uuid AND shop_id = $1 AND work_order_id = $3::uuid
          AND ordinary_instance_id = $5::uuid
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL
        RETURNING id`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId,
        resolutionTimestamp,
        verification.current_ordinary_instance_id,
      ]);
      if (!resolved.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const remaining = await client.query(`
        SELECT 1 FROM verification_locations
        WHERE shop_id = $1 AND work_order_id = $2::uuid
          AND ordinary_instance_id = $3::uuid
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL
        LIMIT 1`, [
        normalizedShopId,
        normalizedWorkOrderId,
        verification.current_ordinary_instance_id,
      ]);
      const requeued = !remaining.rowCount;
      if (requeued) {
        const cleanedPayload = `jsonb_set(
          coalesce(payload, '{}'::jsonb)
            - 'verificationLocation' - 'verificationStage' - 'verificationFocus'
            - 'manualReview' - 'error',
          '{verificationRecovery}', $4::jsonb, true
        ) || jsonb_build_object('updatedAt', $3::text)`;
        const updatedWorkOrder = await client.query(`
          UPDATE work_orders SET
            status = 'retry-ready', runtime_status = 'waiting',
            current_step = 'verification-cleared-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = least(coalesce(next_attempt_at, $3::timestamptz), $3::timestamptz),
            recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = coalesce(recovery_version, 0) + 1,
            recovery_updated_at = now(),
            payload = ${cleanedPayload}, updated_at = now()
          WHERE id = $1::uuid AND shop_id = $2
            AND current_ordinary_instance_id = $5::uuid
            AND status = 'retry-ready'
            AND current_step = 'human-verification-required'
          RETURNING id`, [
          normalizedWorkOrderId,
          normalizedShopId,
          resolutionTimestamp,
          stringifyJsonb(recoveryEvidence),
          verification.current_ordinary_instance_id,
        ]);
        if (!updatedWorkOrder.rowCount) {
          await client.query('ROLLBACK');
          return null;
        }
        const updatedInstance = await client.query(`
          UPDATE ordinary_work_order_instances SET
            status = 'retry-ready', runtime_status = 'waiting',
            current_step = 'verification-cleared-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = least(coalesce(next_attempt_at, $3::timestamptz), $3::timestamptz),
            payload = ${cleanedPayload}, updated_at = now()
          WHERE id = $1::uuid AND work_order_id = $2::uuid
            AND shop_id = $5
            AND status = 'retry-ready'
            AND current_step = 'human-verification-required'
          RETURNING id`, [
          verification.current_ordinary_instance_id,
          normalizedWorkOrderId,
          resolutionTimestamp,
          stringifyJsonb(recoveryEvidence),
          normalizedShopId,
        ]);
        if (!updatedInstance.rowCount) {
          await client.query('ROLLBACK');
          return null;
        }
        await resolveClearedVerificationInterventions(client, {
          shopId: normalizedShopId,
          workOrderId: normalizedWorkOrderId,
          resolvedAt: resolutionTimestamp,
          resolvedBy: 'worker-stale-bound-ordinary-pdd-verification-recovery',
        });
      }
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
           payload, deduplication_key)
        VALUES ($1,$2::uuid,$3::uuid,'worker-resident-browser',
          'stale-bound-ordinary-pdd-verification-reconciled',
          jsonb_build_object(
            'verificationId', $4::text,
            'stage', $5::text,
            'detectedAt', $6::timestamptz,
            'authenticatedAt', $7::timestamptz,
            'runtimeObservedAt', $8::timestamptz,
            'resolvedAt', $9::timestamptz,
            'observedUrl', $10::text,
            'identityBindingToken', $11::text,
            'requeued', $12::boolean,
            'existingSucceededEffectsPreserved', $13::int,
            'strategy', 'detached-bound-ordinary-safe-resume',
            'externalActionsReplayed', false
          ),
          'stale-bound-ordinary-pdd-verification-reconciled:' || $1 || ':' || $4::text)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        normalizedShopId,
        normalizedWorkOrderId,
        verification.current_ordinary_instance_id,
        normalizedVerificationId,
        verification.stage,
        verification.detected_at,
        authenticationTimestamp,
        runtimeObservationTimestamp,
        resolutionTimestamp,
        normalizedObservedUrl,
        normalizedBindingToken,
        requeued,
        verification.succeeded_effect_count,
      ]);
      await client.query('COMMIT');
      return {
        verificationId: normalizedVerificationId,
        workOrderId: normalizedWorkOrderId,
        ordinaryInstanceId: verification.current_ordinary_instance_id,
        verificationResolved: true,
        requeued,
        existingSucceededEffectsPreserved: verification.succeeded_effect_count,
        recoveryKind: 'ordinary',
        externalActionsReplayed: false,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveStaleDetachedPddVerificationGate({
    shopId,
    verificationId,
    authenticatedAt,
    runtimeObservedAt,
    resolvedAt = new Date().toISOString(),
  } = {}) {
    const normalizedShopId = String(shopId || '').trim();
    const normalizedVerificationId = String(verificationId || '').trim();
    const parsedAuthenticatedAt = Date.parse(String(authenticatedAt || ''));
    const parsedRuntimeObservedAt = Date.parse(String(runtimeObservedAt || ''));
    const parsedResolvedAt = Date.parse(String(resolvedAt || ''));
    if (!normalizedShopId
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
        .test(normalizedVerificationId)
      || !Number.isFinite(parsedAuthenticatedAt)
      || !Number.isFinite(parsedRuntimeObservedAt)
      || !Number.isFinite(parsedResolvedAt)) return null;
    const authenticationTimestamp = new Date(parsedAuthenticatedAt).toISOString();
    const runtimeObservationTimestamp = new Date(parsedRuntimeObservedAt).toISOString();
    const resolutionTimestamp = new Date(parsedResolvedAt).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT verification.id, verification.stage, verification.detected_at
        FROM verification_locations verification
        LEFT JOIN workflow_checkpoints checkpoint
          ON checkpoint.shop_id = verification.shop_id
        WHERE verification.id = $2::uuid
          AND verification.shop_id = $1
          AND lower(verification.system_name) = 'pdd'
          AND verification.work_order_id IS NULL
          AND verification.status IN ('detected','waiting-human','verification-required')
          AND verification.resolved_at IS NULL
          AND verification.detected_at <= $3::timestamptz
          AND verification.detected_at <= $4::timestamptz
          AND verification.detected_at <= $5::timestamptz - interval '60 seconds'
          AND $3::timestamptz <= $5::timestamptz + interval '5 seconds'
          AND $4::timestamptz BETWEEN $5::timestamptz - interval '2 minutes'
            AND $5::timestamptz + interval '5 seconds'
          AND coalesce(checkpoint.snapshot #>> '{verificationLocation,id}', '')
            <> verification.id::text
        FOR UPDATE OF verification`, [
        normalizedShopId,
        normalizedVerificationId,
        authenticationTimestamp,
        runtimeObservationTimestamp,
        resolutionTimestamp,
      ]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const verification = selected.rows[0];
      const resolved = await client.query(`
        UPDATE verification_locations SET
          status = 'resolved',
          resolved_at = $3::timestamptz
        WHERE id = $2::uuid
          AND shop_id = $1
          AND work_order_id IS NULL
          AND status IN ('detected','waiting-human','verification-required')
          AND resolved_at IS NULL
        RETURNING id`, [
        normalizedShopId,
        normalizedVerificationId,
        resolutionTimestamp,
      ]);
      if (!resolved.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const assistance = await client.query(`
        WITH resolved AS (
          UPDATE manual_interventions intervention SET
            status = 'resolved',
            resolved_at = coalesce(intervention.resolved_at, $4::timestamptz),
            resolved_by = coalesce(
              intervention.resolved_by,
              'worker-stale-detached-pdd-verification-recovery'
            )
          WHERE intervention.shop_id = $1
            AND intervention.work_order_id IS NULL
            AND intervention.status IN ('open', 'acknowledged')
            AND intervention.reason_code = ANY($3::text[])
            AND intervention.created_at BETWEEN $5::timestamptz - interval '5 seconds'
              AND $4::timestamptz
            AND NOT EXISTS (
              SELECT 1
              FROM verification_locations active
              WHERE active.shop_id = $1
                AND active.id <> $2::uuid
                AND active.work_order_id IS NULL
                AND active.status IN ('detected','waiting-human','verification-required')
                AND active.resolved_at IS NULL
            )
          RETURNING intervention.id
        ), cancelled AS (
          UPDATE notification_outbox outbox SET
            status = 'cancelled',
            updated_at = now(),
            last_error = jsonb_build_object(
              'reason', 'stale-detached-pdd-verification-reconciled'
            )
          FROM resolved
          WHERE outbox.intervention_id = resolved.id
            AND outbox.status IN ('pending', 'sending', 'failed')
          RETURNING outbox.id
        )
        SELECT
          coalesce((SELECT jsonb_agg(id) FROM resolved), '[]'::jsonb)
            AS intervention_ids,
          coalesce((SELECT jsonb_agg(id) FROM cancelled), '[]'::jsonb)
            AS outbox_ids`, [
        normalizedShopId,
        normalizedVerificationId,
        verificationInterventionReasonCodes,
        resolutionTimestamp,
        verification.detected_at,
      ]);
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
        VALUES ($1,NULL,'worker-resident-browser',
          'stale-detached-pdd-verification-reconciled',
          jsonb_build_object(
            'verificationId', $2::text,
            'stage', $3::text,
            'detectedAt', $4::timestamptz,
            'authenticatedAt', $5::timestamptz,
            'runtimeObservedAt', $6::timestamptz,
            'resolvedAt', $7::timestamptz,
            'strategy', 'fresh-authenticated-resident-browser-without-challenge',
            'externalActionsReplayed', false
          ),
          'stale-detached-pdd-verification-reconciled:' || $1 || ':' || $2::text)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        normalizedShopId,
        normalizedVerificationId,
        verification.stage,
        verification.detected_at,
        authenticationTimestamp,
        runtimeObservationTimestamp,
        resolutionTimestamp,
      ]);
      await client.query('COMMIT');
      return {
        verificationId: normalizedVerificationId,
        verificationResolved: true,
        stage: verification.stage,
        detectedAt: verification.detected_at,
        resolvedAt: resolutionTimestamp,
        interventionIds: assistance.rows[0]?.intervention_ids || [],
        cancelledOutboxIds: assistance.rows[0]?.outbox_ids || [],
        externalActionsReplayed: false,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // A live CAPTCHA can remain visible after its two-minute operator/plugin
  // budget expires. Expire only the database gate and requeue the associated
  // business record; the browser page itself is intentionally left open for
  // the plugin. An unknown PDD submission goes only to read-only reconciliation,
  // never back to the normal submission queue.
  async expireTimedOutVerificationGate({
    shopId,
    verificationId,
    workOrderId = null,
    detectedAt = null,
    timeoutAt = new Date().toISOString(),
    timeoutMs = 120_000,
    nextAttemptAt = null,
  } = {}) {
    const normalizedShopId = String(shopId || '').trim();
    const normalizedVerificationId = String(verificationId || '').trim();
    const normalizedWorkOrderId = String(workOrderId || '').trim();
    const validUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
    const parsedDetectedAt = Date.parse(String(detectedAt || ''));
    const parsedTimeoutAt = Date.parse(String(timeoutAt || ''));
    const configuredTimeoutMs = Number(timeoutMs);
    const minimumTimeoutMs = Number.isFinite(configuredTimeoutMs)
      ? Math.max(60_000, configuredTimeoutMs)
      : 120_000;
    if (!normalizedShopId
      || !validUuid(normalizedVerificationId)
      || (normalizedWorkOrderId && !validUuid(normalizedWorkOrderId))
      || !Number.isFinite(parsedDetectedAt)
      || !Number.isFinite(parsedTimeoutAt)
      || parsedTimeoutAt - parsedDetectedAt < minimumTimeoutMs - 5_000) return null;
    const detectionTimestamp = new Date(parsedDetectedAt).toISOString();
    const timeoutTimestamp = new Date(parsedTimeoutAt).toISOString();
    const fallbackRetryTimestamp = new Date(parsedTimeoutAt + 15_000).toISOString();
    const parsedNextAttemptAt = Date.parse(String(nextAttemptAt || ''));
    const requestedRetryTimestamp = Number.isFinite(parsedNextAttemptAt)
      ? new Date(parsedNextAttemptAt).toISOString()
      : fallbackRetryTimestamp;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT verification.id, verification.shop_id, verification.work_order_id,
          verification.ordinary_instance_id, verification.system_name,
          verification.stage, verification.detected_at,
          work_order.scenario_code, work_order.status AS work_order_status,
          work_order.runtime_status AS work_order_runtime_status,
          work_order.current_step AS work_order_step,
          work_order.current_ordinary_instance_id,
          work_order.completion_state, work_order.next_attempt_at,
          work_order.recovery_state,
          work_order.payload AS work_order_payload,
          instance.status AS instance_status,
          instance.runtime_status AS instance_runtime_status,
          instance.current_step AS instance_step,
          instance.payload AS instance_payload,
          refund.action_state AS refund_action_state,
          refund.next_check_at AS refund_next_check_at,
          EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.shop_id = verification.shop_id
              AND runtime.current_work_order_id = verification.work_order_id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          ) AS active_lease,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = verification.work_order_id
              AND effect.status IN ('reserved', 'unknown')
          ) AS uncertain_effect,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = verification.work_order_id
              AND effect.ordinary_instance_id IS NOT DISTINCT FROM
                work_order.current_ordinary_instance_id
              AND effect.effect_type = 'pdd-submit'
              AND effect.status = 'unknown'
          ) AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = verification.work_order_id
              AND effect.status IN ('reserved', 'unknown')
              AND NOT (
                effect.ordinary_instance_id IS NOT DISTINCT FROM
                  work_order.current_ordinary_instance_id
                AND effect.effect_type = 'pdd-submit'
                AND effect.status = 'unknown'
              )
          ) AS unknown_pdd_submit_only
        FROM verification_locations verification
        LEFT JOIN work_orders work_order
          ON work_order.id = verification.work_order_id
          AND work_order.shop_id = verification.shop_id
        LEFT JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.shop_id = work_order.shop_id
        LEFT JOIN return_refunds refund
          ON refund.work_order_id = work_order.id
          AND refund.shop_id = work_order.shop_id
        WHERE verification.id = $2::uuid
          AND verification.shop_id = $1
          AND ($3::uuid IS NULL OR verification.work_order_id = $3::uuid)
          AND verification.status IN ('detected', 'waiting-human', 'verification-required')
          AND verification.resolved_at IS NULL
          AND verification.detected_at <= $4::timestamptz - ($5::bigint * interval '1 millisecond')
        FOR UPDATE OF verification`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId || null,
        timeoutTimestamp,
        Math.round(minimumTimeoutMs),
      ]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const verification = selected.rows[0];
      const readOnlyReconciliation = verification.uncertain_effect
        && verification.unknown_pdd_submit_only
        && verification.scenario_code !== 'return-refund'
        && verification.work_order_status === 'paused'
        && verification.completion_state === 'pending'
        && ['held', 'reconciling'].includes(verification.recovery_state);
      if (verification.active_lease || (verification.uncertain_effect && !readOnlyReconciliation)) {
        await client.query('ROLLBACK');
        return {
          verificationId: normalizedVerificationId,
          workOrderId: verification.work_order_id || null,
          verificationResolved: false,
          requeued: false,
          reason: verification.active_lease ? 'active-lease' : 'uncertain-external-effect',
        };
      }

      const resolved = await client.query(`
        UPDATE verification_locations SET status = 'expired', resolved_at = $4::timestamptz
        WHERE id = $2::uuid AND shop_id = $1
          AND ($3::uuid IS NULL OR work_order_id = $3::uuid)
          AND status IN ('detected', 'waiting-human', 'verification-required')
          AND resolved_at IS NULL
        RETURNING id`, [
        normalizedShopId,
        normalizedVerificationId,
        normalizedWorkOrderId || null,
        timeoutTimestamp,
      ]);
      if (!resolved.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }

      const workOrderIdValue = verification.work_order_id || null;
      const scenarioCode = String(verification.scenario_code || '').trim().toLowerCase();
      const isReturnRefund = scenarioCode === 'return-refund';
      const waitingLogistics = isReturnRefund
        && String(verification.refund_action_state || '').trim().toLowerCase() === 'waiting-logistics';
      const nextAttemptMs = waitingLogistics
        ? (Date.parse(String(verification.next_attempt_at || ''))
          || Date.parse(String(verification.refund_next_check_at || ''))
          || parsedNextAttemptAt
          || parsedTimeoutAt + 15_000)
        : Math.min(
          Date.parse(String(verification.next_attempt_at || '')) || Number.POSITIVE_INFINITY,
          parsedNextAttemptAt || parsedTimeoutAt + 15_000,
        );
      const nextAttemptTimestamp = new Date(Number.isFinite(nextAttemptMs)
        ? nextAttemptMs
        : parsedTimeoutAt + 15_000).toISOString();
      const retryStep = waitingLogistics
        ? 'return-refund-waiting-logistics'
        : 'verification-timeout-retry-ready';
      const timeoutPayload = {
        ...(verification.work_order_payload && typeof verification.work_order_payload === 'object'
          ? verification.work_order_payload : {}),
      };
      delete timeoutPayload.verificationLocation;
      delete timeoutPayload.verificationStage;
      delete timeoutPayload.verificationFocus;
      delete timeoutPayload.verificationRecovery;
      delete timeoutPayload.manualReview;
      delete timeoutPayload.error;
      timeoutPayload.step = retryStep;
      timeoutPayload.updatedAt = timeoutTimestamp;
      timeoutPayload.verificationTimeout = {
        ...(timeoutPayload.verificationTimeout && typeof timeoutPayload.verificationTimeout === 'object'
          ? timeoutPayload.verificationTimeout : {}),
        status: 'closed',
        system: verification.system_name || 'pdd',
        stage: verification.stage || null,
        timeoutMs: Math.round(minimumTimeoutMs),
        verificationId: normalizedVerificationId,
        detectedAt: detectionTimestamp,
        timedOutAt: timeoutTimestamp,
        releaseReason: 'verification-timeout-release',
        pluginOwned: true,
        externalActionsReplayed: false,
      };
      timeoutPayload.verificationRecheck = {
        ...(timeoutPayload.verificationRecheck && typeof timeoutPayload.verificationRecheck === 'object'
          ? timeoutPayload.verificationRecheck : {}),
        trigger: 'verification-timeout-release',
        status: 'closed',
        verificationId: normalizedVerificationId,
        requestedAt: timeoutTimestamp,
        completedAt: timeoutTimestamp,
        externalActionsReplayed: false,
      };

      if (readOnlyReconciliation) {
        timeoutPayload.step = 'external-state-reconciliation-ready';
        timeoutPayload.externalStateReconciliationRecovery = {
          source: 'verification-timeout-with-unknown-pdd-submit',
          effectType: 'pdd-submit',
          readOnly: true,
          externalActionsReplayed: false,
          recoveredAt: timeoutTimestamp,
        };
        if (verification.recovery_state === 'reconciling') {
          const retry = timeoutPayload.externalStateReconciliationRetry || {};
          const attempts = Number(retry.attempts);
          timeoutPayload.externalStateReconciliationRetry = {
            ...retry,
            attempts: Number.isFinite(attempts) ? Math.max(0, attempts - 1) : 0,
            verificationAttemptRefundedAt: timeoutTimestamp,
          };
        }
        const readOnlyReady = await client.query(`
          UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
            current_step = 'external-state-reconciliation-ready',
            manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
            next_attempt_at = now(), recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = coalesce(recovery_version, 0) + 1,
            recovery_updated_at = now(), payload = $3::jsonb, updated_at = now()
          WHERE id = $1::uuid AND shop_id = $2
            AND status = 'paused' AND completion_state = 'pending'
            AND recovery_state IN ('held', 'reconciling')
          RETURNING id`, [workOrderIdValue, normalizedShopId, stringifyJsonb(timeoutPayload)]);
        if (!readOnlyReady.rowCount) {
          await client.query('ROLLBACK');
          return { verificationId: normalizedVerificationId, verificationResolved: false,
            requeued: false, reason: 'read-only-reconciliation-state-changed' };
        }
        if (verification.current_ordinary_instance_id) {
          await client.query(`
            UPDATE ordinary_work_order_instances SET status = 'paused',
              runtime_status = 'paused', current_step = 'external-state-reconciliation-ready',
              manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
              next_attempt_at = now(), payload = $4::jsonb, updated_at = now()
            WHERE id = $1::uuid AND work_order_id = $2::uuid AND shop_id = $3`, [
            verification.current_ordinary_instance_id,
            workOrderIdValue,
            normalizedShopId,
            stringifyJsonb(timeoutPayload),
          ]);
        }
      }

      let requeued = false;
      if (!readOnlyReconciliation && workOrderIdValue
        && verification.completion_state === 'pending'
        && !['completed', 'archived'].includes(String(verification.work_order_status || '').toLowerCase())) {
        const updated = await client.query(`
          UPDATE work_orders SET
            status = 'retry-ready', runtime_status = 'waiting',
            current_step = $3, manual_review_reason = NULL,
            next_attempt_at = $4::timestamptz,
            recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = coalesce(recovery_version, 0) + 1,
            recovery_updated_at = now(), payload = $5::jsonb, updated_at = now()
          WHERE id = $1::uuid AND shop_id = $2
            AND completion_state = 'pending'
            AND status NOT IN ('completed', 'archived')
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.shop_id = work_orders.shop_id
                AND runtime.current_work_order_id = work_orders.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
          RETURNING id`, [
          workOrderIdValue,
          normalizedShopId,
          retryStep,
          nextAttemptTimestamp,
          stringifyJsonb(timeoutPayload),
        ]);
        requeued = Boolean(updated.rowCount);
        if (requeued && verification.current_ordinary_instance_id) {
          await client.query(`
            UPDATE ordinary_work_order_instances SET
              status = 'retry-ready', runtime_status = 'waiting',
              current_step = $4, manual_review_reason = NULL,
              next_attempt_at = $5::timestamptz,
              payload = $6::jsonb, updated_at = now()
            WHERE id = $1::uuid AND work_order_id = $2::uuid AND shop_id = $3
              AND status NOT IN ('completed', 'archived')`, [
            verification.current_ordinary_instance_id,
            workOrderIdValue,
            normalizedShopId,
            retryStep,
            nextAttemptTimestamp,
            stringifyJsonb(timeoutPayload),
          ]);
        }
        if (requeued && isReturnRefund) {
          await client.query(`
            UPDATE return_refunds SET
              next_check_at = CASE
                WHEN action_state = 'waiting-logistics'
                  THEN coalesce(next_check_at, $3::timestamptz)
                ELSE least(coalesce(next_check_at, $3::timestamptz), $3::timestamptz)
              END,
              updated_at = now()
            WHERE work_order_id = $1::uuid AND shop_id = $2`, [
            workOrderIdValue,
            normalizedShopId,
            nextAttemptTimestamp,
          ]);
        }
      }
      if (workOrderIdValue) {
        await resolveClearedVerificationInterventions(client, {
          shopId: normalizedShopId,
          workOrderId: workOrderIdValue,
          resolvedAt: timeoutTimestamp,
          resolvedBy: 'worker-verification-timeout-release',
        });
      }
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type,
           payload, deduplication_key)
        VALUES ($1,$2::uuid,$3::uuid,'worker-resident-browser',
          'verification-timeout-released',
          jsonb_build_object(
            'verificationId', $4::text,
            'system', $5::text,
            'stage', $6::text,
            'detectedAt', $7::timestamptz,
            'timedOutAt', $8::timestamptz,
            'closeResult', $9::jsonb,
            'requeued', $10::boolean,
            'readOnlyReconciliationReady', $11::boolean,
            'pluginSurfaceRetained', true,
            'externalActionsReplayed', false
          ),
          'verification-timeout-released:' || $1 || ':' || $4::text)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
        normalizedShopId,
        workOrderIdValue,
        verification.current_ordinary_instance_id || null,
        normalizedVerificationId,
        verification.system_name || 'pdd',
        verification.stage,
        detectionTimestamp,
        timeoutTimestamp,
        stringifyJsonb({ reason: 'worker-timeout-release', pluginSurfaceRetained: true }),
        requeued,
        Boolean(readOnlyReconciliation),
      ]);
      await client.query('COMMIT');
      return {
        verificationId: normalizedVerificationId,
        workOrderId: workOrderIdValue,
        ordinaryInstanceId: verification.current_ordinary_instance_id || null,
        verificationResolved: true,
        requeued,
        readOnlyReconciliationReady: Boolean(readOnlyReconciliation),
        pluginSurfaceRetained: true,
        timedOutAt: timeoutTimestamp,
        externalActionsReplayed: false,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // A work order already released to read-only external-state reconciliation
  // must not be held forever by the CAPTCHA row that caused the interruption.
  // Resolve only the database gate after the normal two-minute budget, keep
  // the browser surface open for the plugin, and leave every unknown effect
  // untouched. The reconciliation queue remains the only path that can act.
  async resolveReadOnlyReconciliationVerificationGates({
    shopId,
    minimumAgeMs = 120_000,
  } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query(`
        SELECT verification.id, verification.work_order_id,
          verification.ordinary_instance_id, verification.stage,
          verification.detected_at, work_order.external_order_number,
          work_order.current_ordinary_instance_id
        FROM verification_locations verification
        JOIN work_orders work_order
          ON work_order.id = verification.work_order_id
          AND work_order.shop_id = verification.shop_id
        WHERE verification.shop_id = $1
          AND verification.status IN ('detected', 'waiting-human', 'verification-required')
          AND verification.resolved_at IS NULL
          AND verification.detected_at <= now()
            - ($2::bigint * interval '1 millisecond')
          AND work_order.status = 'paused'
          AND work_order.runtime_status = 'paused'
          AND work_order.current_step = 'external-state-reconciliation-ready'
          AND work_order.recovery_state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.shop_id = verification.shop_id
              AND runtime.current_work_order_id = verification.work_order_id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )
        ORDER BY verification.detected_at ASC
        FOR UPDATE OF verification SKIP LOCKED
        LIMIT 50`, [shopId, Math.max(60_000, Number(minimumAgeMs) || 0)]);
      if (!candidates.rowCount) {
        await client.query('COMMIT');
        return [];
      }

      const resolvedAt = new Date().toISOString();
      const resolved = [];
      for (const candidate of candidates.rows) {
        const update = await client.query(`
          UPDATE verification_locations SET status = 'expired', resolved_at = $3::timestamptz
          WHERE id = $1::uuid AND shop_id = $2
            AND status IN ('detected', 'waiting-human', 'verification-required')
            AND resolved_at IS NULL
          RETURNING id`, [candidate.id, shopId, resolvedAt]);
        if (!update.rowCount) continue;
        const interventionIds = await resolveClearedVerificationInterventions(client, {
          shopId,
          workOrderId: candidate.work_order_id,
          resolvedAt,
          resolvedBy: 'worker-read-only-reconciliation-timeout',
        });
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id,
             event_type, payload, deduplication_key)
          VALUES ($1,$2,$3,'worker-resident-browser',
            'verification-timeout-released-read-only-reconciliation',
            $4::jsonb, $5)
          ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`, [
          shopId,
          candidate.work_order_id,
          candidate.ordinary_instance_id || candidate.current_ordinary_instance_id || null,
          stringifyJsonb({
            verificationId: candidate.id,
            externalOrderNumber: candidate.external_order_number,
            stage: candidate.stage,
            detectedAt: candidate.detected_at,
            timedOutAt: resolvedAt,
            requeued: false,
            pluginSurfaceRetained: true,
            externalActionsReplayed: false,
            interventionIds,
          }),
          `verification-timeout-released-read-only:${shopId}:${candidate.id}`,
        ]);
        resolved.push({
          verificationId: candidate.id,
          workOrderId: candidate.work_order_id,
          externalOrderNumber: candidate.external_order_number,
          requeued: false,
          pluginSurfaceRetained: true,
          externalActionsReplayed: false,
        });
      }
      await client.query('COMMIT');
      return resolved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // A held, unknown refund effect must never enter the normal refund queue.
  // This lease permits only a read of the exact PDD aftersale detail; the
  // result writer below keeps the effect and the hold unless terminal proof
  // is observed for the same order and aftersale.
  async claimHeldReturnRefundReadOnly({
    shopId, workerId, identityBindingToken, leaseSeconds = 300,
  }) {
    if (!identityBindingToken) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const runtimeResult = await client.query(`
        SELECT status, lease_token, lease_expires_at, current_work_order_id,
          metadata
        FROM shop_runtime_state WHERE shop_id = $1 FOR UPDATE`, [shopId]);
      const runtime = runtimeResult.rows[0];
      if (!runtime || runtime.status === 'operator-paused'
        || runtime.metadata?.operatorPaused === true
        || (runtime.status !== 'idle' && !runtime.lease_token)
        || (runtime.current_work_order_id && !runtime.lease_token)
        || (runtime.lease_token && !runtime.lease_expires_at)
        || (runtime.lease_token && runtime.lease_expires_at
          && new Date(runtime.lease_expires_at) > new Date())) {
        await client.query('COMMIT');
        return null;
      }
      const candidate = await client.query(`
        SELECT work_order.id
        FROM work_orders work_order
        JOIN return_refunds refund ON refund.work_order_id = work_order.id
          AND refund.shop_id = work_order.shop_id
        JOIN shops shop ON shop.id = work_order.shop_id
          AND shop.enabled = true AND shop.onboarding_status = 'ready'
        JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = shop.id
          AND binding.binding_token::text = $2
          AND binding.actual_shop_name = shop.expected_shop_name
          AND binding.mall_id IS NOT NULL
        JOIN shop_identity_bindings identity ON identity.shop_id = shop.id
          AND identity.status = 'confirmed'
          AND identity.expected_shop_name = shop.expected_shop_name
          AND identity.mall_id = binding.mall_id
          AND identity.profile_fingerprint = binding.profile_fingerprint
        WHERE work_order.shop_id = $1
          AND work_order.scenario_code = 'return-refund'
          AND work_order.recovery_state = 'held'
          AND work_order.recovery_reason = 'unknown-external-effect'
          AND work_order.completion_state = 'pending'
          AND work_order.status IN ('paused','retry-ready','processing')
          AND (work_order.next_attempt_at IS NULL OR work_order.next_attempt_at <= now())
          AND ($3::uuid IS NULL OR work_order.id = $3)
          AND refund.external_order_number = work_order.external_order_number
          AND refund.evidence->>'pddIdentityBindingToken' = $2
          AND refund.evidence->>'pddMallId' = binding.mall_id
          AND binding.actual_shop_name = refund.evidence->>'detectedShopName'
          AND refund.detail_url LIKE 'https://mms.pinduoduo.com/aftersales-ssr/detail%'
          AND refund.detail_url LIKE '%' || refund.aftersale_number || '%'
          AND refund.detail_url LIKE '%' || work_order.external_order_number || '%'
          AND (SELECT count(*) FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.effect_type = 'pdd-return-refund') = 1
          AND EXISTS (
            SELECT 1 FROM external_effects held_effect
            WHERE held_effect.work_order_id = work_order.id
              AND held_effect.effect_type = 'pdd-return-refund'
              AND held_effect.status = 'unknown'
              AND held_effect.reserved_at <= now() - interval '30 minutes'
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects unsafe_effect
            WHERE unsafe_effect.work_order_id = work_order.id
              AND unsafe_effect.status IN ('reserved','unknown')
              AND unsafe_effect.effect_type <> 'pdd-return-refund'
          )
          AND NOT EXISTS (
            SELECT 1 FROM external_effects succeeded_effect
            WHERE succeeded_effect.work_order_id = work_order.id
              AND succeeded_effect.effect_type = 'pdd-return-refund'
              AND succeeded_effect.status = 'succeeded'
          )
          AND NOT EXISTS (
            SELECT 1 FROM verification_locations verification
            WHERE verification.shop_id = shop.id
              AND verification.resolved_at IS NULL
              AND verification.status IN ('detected','waiting-human','verification-required')
          )
        ORDER BY work_order.updated_at, work_order.id
        FOR UPDATE OF work_order, refund SKIP LOCKED LIMIT 1`, [
        shopId, identityBindingToken, runtime.lease_token
          ? runtime.current_work_order_id : null,
      ]);
      if (!candidate.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const workOrderId = candidate.rows[0].id;
      const leaseToken = crypto.randomUUID();
      await client.query(`
        UPDATE work_orders SET status = 'processing', runtime_status = 'processing',
          current_step = 'return-refund-held-read-only-reconciliation',
          updated_at = now()
        WHERE id = $1`, [workOrderId]);
      await client.query(`
        UPDATE shop_runtime_state SET worker_id = $2, status = 'processing',
          lease_token = $3,
          lease_expires_at = now() + make_interval(secs => $4),
          current_work_order_id = $5, updated_at = now()
        WHERE shop_id = $1`, [shopId, workerId, leaseToken, leaseSeconds, workOrderId]);
      const workOrder = await selectClaimedWorkOrder(client, workOrderId);
      await client.query('COMMIT');
      return { ...workOrder, leaseToken, heldRefundReadOnly: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async finishHeldReturnRefundReadOnly({ shopId, workOrderId, leaseToken, result }) {
    const facts = result?.facts || {};
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT work_order.external_order_number, work_order.status,
          work_order.recovery_state, work_order.recovery_reason,
          refund.aftersale_number, refund.detail_url, refund.action_state,
          refund.aftersale_status, refund.completed_at,
          effect.id AS effect_id, effect.status AS effect_status,
          effect.receipt AS effect_receipt
        FROM shop_runtime_state runtime
        JOIN work_orders work_order ON work_order.id = runtime.current_work_order_id
          AND work_order.shop_id = runtime.shop_id
        JOIN return_refunds refund ON refund.work_order_id = work_order.id
        LEFT JOIN LATERAL (
          SELECT id, status, receipt FROM external_effects
          WHERE work_order_id = work_order.id
            AND effect_type = 'pdd-return-refund'
          ORDER BY reserved_at DESC LIMIT 1
        ) effect ON true
        WHERE runtime.shop_id = $1 AND work_order.id = $2
          AND runtime.lease_token = $3 AND runtime.lease_expires_at > now()
          AND work_order.scenario_code = 'return-refund'
          AND work_order.status IN ('processing','paused')
          AND work_order.recovery_state = 'held'
          AND work_order.recovery_reason = 'unknown-external-effect'
        FOR UPDATE OF runtime, work_order, refund`, [
        shopId, workOrderId, leaseToken,
      ]);
      if (selected.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      const row = selected.rows[0];
      const sameCase = facts.orderNumber === row.external_order_number
        && facts.aftersaleNumber === row.aftersale_number;
      const terminalFromPage = row.effect_status === 'unknown' && sameCase
        && ['auto-refunded', 'manual-completed'].includes(result?.outcome)
        && confirmsReturnRefundCompletion(facts);
      const terminalFromScan = row.effect_status === 'succeeded'
        && row.effect_receipt?.reconciledFromPdd === true
        && row.action_state === 'auto-refunded'
        && Boolean(row.completed_at);
      if (terminalFromPage || terminalFromScan) {
        await client.query('COMMIT');
        const completed = await this.finishReturnRefundClaim({
          shopId, workOrderId, leaseToken,
          result: {
            ...result,
            outcome: 'auto-refunded',
            completionMethod: 'return-refund-button-disappeared',
            readOnlyReview: true,
            ...(terminalFromScan ? {
              facts: {
                orderNumber: row.external_order_number,
                aftersaleNumber: row.aftersale_number,
                aftersaleStatus: row.aftersale_status,
                detailUrl: row.detail_url,
              },
            } : {}),
          },
        });
        if (completed) {
          await this.pool.query(`
            UPDATE work_orders work_order SET recovery_state = 'ready',
              recovery_reason = NULL, recovery_updated_at = now(),
              updated_at = now()
            WHERE work_order.id = $1 AND work_order.shop_id = $2
              AND work_order.status = 'completed'
              AND work_order.completion_state = 'confirmed'
              AND work_order.recovery_state = 'held'
              AND EXISTS (
                SELECT 1 FROM external_effects effect
                WHERE effect.work_order_id = work_order.id
                  AND effect.effect_type = 'pdd-return-refund'
                  AND effect.status = 'succeeded'
              )`, [workOrderId, shopId]);
        }
        return completed;
      }
      const checkedAt = new Date().toISOString();
      const nextCheckAt = new Date(Date.now() + RETURN_REFUND_WAIT_RECHECK_MS).toISOString();
      const observation = {
        checkedAt,
        nextCheckAt,
        outcome: String(result?.outcome || 'page-error'),
        sameCase,
        observedStatus: sameCase ? String(facts.aftersaleStatus || '') : null,
        reason: String(result?.reasons?.[0] || result?.error || 'read-only-check-incomplete').slice(0, 300),
        externalActionReplay: false,
      };
      await client.query(`
        UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
          current_step = 'external-state-unresolved',
          next_attempt_at = $2,
          payload = coalesce(payload, '{}'::jsonb)
            || jsonb_build_object('heldRefundReadOnlyCheck', $3::jsonb),
          updated_at = now()
        WHERE id = $1`, [workOrderId, nextCheckAt, stringifyJsonb(observation)]);
      if (sameCase) {
        await client.query(`
          UPDATE return_refunds SET aftersale_status = coalesce($2, aftersale_status),
            last_scanned_at = now(), updated_at = now()
          WHERE work_order_id = $1`, [workOrderId, facts.aftersaleStatus || null]);
      }
      await client.query(`
        UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
          lease_expires_at = NULL, current_work_order_id = NULL,
          updated_at = now()
        WHERE shop_id = $1 AND lease_token = $2`, [shopId, leaseToken]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getReturnRefundForClaim({ workOrderId, shopId }) {
    const result = await this.pool.query(`
      SELECT refund.*, effect.id AS effect_id, effect.status AS effect_status,
        effect.receipt AS effect_receipt, effect.error AS effect_error,
        effect.reserved_at AS effect_reserved_at,
        work_order.manual_review_reason,
        intervention.reason_code AS active_manual_reason_code
      FROM return_refunds refund
      JOIN work_orders work_order ON work_order.id = refund.work_order_id
      LEFT JOIN LATERAL (
        SELECT id, status, receipt, error, reserved_at FROM external_effects
        WHERE work_order_id = refund.work_order_id AND effect_type = 'pdd-return-refund'
        ORDER BY reserved_at DESC LIMIT 1
      ) effect ON true
      LEFT JOIN LATERAL (
        SELECT reason_code FROM manual_interventions
        WHERE work_order_id = refund.work_order_id
          AND status IN ('open', 'acknowledged')
        ORDER BY created_at DESC LIMIT 1
      ) intervention ON true
      WHERE refund.work_order_id = $1 AND refund.shop_id = $2`, [workOrderId, shopId]);
    return result.rows[0] || null;
  }

  async finishReturnRefundClaim({ shopId, workOrderId, leaseToken, result }) {
    const outcome = String(result?.outcome || 'verification-required');
    const completed = ['auto-refunded', 'manual-completed'].includes(outcome);
    const skippedNotFound = outcome === 'skipped-not-found';
    const automatedCompletion = isAutomatedReturnRefundCompletion(result);
    const manual = outcome === 'manual-review'
      || (outcome === 'manual-completed' && !automatedCompletion);
    const waitingLogistics = outcome === 'wait-logistics';
    const manualReview = outcome === 'manual-review';
    const pageError = outcome === 'page-error';
    const verificationRequired = outcome === 'verification-required';
    const readyDisabled = outcome === 'ready';
    const existingEffectResolution = result?.existingEffectResolution;
    const dispatchedUnknownManualReview = manualReview
      && existingEffectResolution?.disposition === 'manual-review';
    const dispatchedUnknownManualHoldAt = '2099-01-01T00:00:00.000Z';
    const releaseExistingRetryableEffect = readyDisabled
      && existingEffectResolution?.effectStatus === 'failed'
      && existingEffectResolution?.retryable === true;
    const releaseExistingWaitingEffect = waitingLogistics
      && existingEffectResolution?.effectStatus === 'failed'
      && existingEffectResolution?.retryable === false
      && existingEffectResolution?.disposition === 'wait-logistics';
    const releaseExistingUnknownEffect = releaseExistingRetryableEffect
      || releaseExistingWaitingEffect;
    const recordExistingUnknownProof = (verificationRequired || pageError)
      && existingEffectResolution?.effectStatus === 'unknown'
      && [
        'pdd-exact-pending-proof-waiting',
        'pdd-exact-counterparty-pending-no-action-proof-waiting',
      ].includes(existingEffectResolution?.reason)
      && existingEffectResolution?.pendingProof;
    const nextAttemptAt = dispatchedUnknownManualReview
      ? dispatchedUnknownManualHoldAt
      : waitingLogistics
      ? result?.nextCheckAt || new Date(Date.now() + RETURN_REFUND_WAIT_RECHECK_MS).toISOString()
      : manualReview
        ? result?.nextCheckAt || new Date(Date.now() + RETURN_REFUND_MANUAL_REVIEW_RECHECK_MS).toISOString()
      : pageError
        ? result?.nextCheckAt || new Date(Date.now() + RETURN_REFUND_PAGE_ERROR_RECHECK_MS).toISOString()
      : verificationRequired
        ? result?.nextCheckAt || new Date(Date.now() + (
          existingEffectResolution ? RETURN_REFUND_UNKNOWN_RECHECK_MS : RETURN_REFUND_VERIFICATION_RECHECK_MS
        )).toISOString()
        : readyDisabled
          ? result?.nextCheckAt || new Date(Date.now() + 15 * 60_000).toISOString() : null;
    const workOrderStatus = skippedNotFound ? 'archived'
      : completed ? 'completed'
      : manual ? 'paused' : 'retry-ready';
    const runtimeStatus = skippedNotFound ? 'archived'
      : completed ? 'completed'
      : manual ? 'manual-review' : 'waiting';
    const currentStep = skippedNotFound ? 'return-refund-skipped-not-found'
      : outcome === 'auto-refunded' ? 'return-refund-auto-complete'
      : outcome === 'manual-completed'
        ? automatedCompletion
          ? 'return-refund-read-only-complete'
          : 'return-refund-manual-completed'
        : outcome === 'wait-logistics' ? 'return-refund-waiting-logistics'
      : outcome === 'manual-review' ? dispatchedUnknownManualReview
        ? 'return-refund-dispatched-unknown-manual-review'
        : 'return-refund-manual-review'
            : outcome === 'page-error' ? 'return-refund-page-error'
              : outcome === 'ready'
                ? releaseExistingRetryableEffect
                  ? 'return-refund-safe-retry-ready'
                  : 'return-refund-read-only-ready'
                : 'return-refund-verification-required';
    const reason = result?.reasons?.join('；') || result?.error || null;
    const completionMethod = outcome === 'auto-refunded'
      ? 'return-refund-button-disappeared'
      : skippedNotFound
        ? 'return-refund-not-found'
        : result?.completionMethod || 'return-refund-manual-completed';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lease = await client.query(`SELECT 1 FROM shop_runtime_state
        WHERE shop_id = $1 AND current_work_order_id = $2 AND lease_token = $3
          AND lease_expires_at > now() FOR UPDATE`, [shopId, workOrderId, leaseToken]);
      if (!lease.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      if (releaseExistingUnknownEffect) {
        const releasedEffect = await client.query(`
          UPDATE external_effects SET status = 'failed',
            receipt = coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb)
              || jsonb_build_object(
              'reconciliation', jsonb_build_object(
                'status', $7::text,
                'reason', $3::text,
                'orderNumber', $4::text,
                'aftersaleNumber', $5::text,
                'observedStatus', $6::text,
                'releasedAt', now()
              )
            ),
            error = coalesce(error, '{}'::jsonb) || jsonb_build_object(
              'reconciliationReason', $3::text
            ),
            updated_at = now()
          WHERE work_order_id = $1 AND shop_id = $2
            AND effect_type = 'pdd-return-refund' AND status IN ('unknown','reserved')
          RETURNING id`, [
          workOrderId,
          shopId,
          existingEffectResolution.reason,
          result?.facts?.orderNumber || null,
          result?.facts?.aftersaleNumber || null,
          result?.facts?.aftersaleStatus || null,
          releaseExistingWaitingEffect ? 'wait-logistics-released' : 'safe-retry-released',
        ]);
        if (!releasedEffect.rowCount) {
          throw new Error('return-refund-safe-retry-effect-not-found');
        }
      }
      if (recordExistingUnknownProof) {
        const recordedProof = await client.query(`
          UPDATE external_effects SET
            receipt = jsonb_set(
              coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb),
              '{reconciliationProof}',
              $3::jsonb,
              true
            ),
            updated_at = now()
          WHERE work_order_id = $1 AND shop_id = $2
            AND effect_type = 'pdd-return-refund' AND status IN ('unknown','reserved')
          RETURNING id`, [
          workOrderId,
          shopId,
          stringifyJsonb(existingEffectResolution.pendingProof),
        ]);
        if (!recordedProof.rowCount) {
          throw new Error('return-refund-reconciliation-proof-effect-not-found');
        }
      }
      await client.query(`
        UPDATE return_refunds SET
          detail_url = coalesce($2, detail_url),
          aftersale_type = coalesce($3, aftersale_type),
          aftersale_status = coalesce($4, aftersale_status),
          refund_amount = coalesce($5, refund_amount),
          return_carrier = coalesce($6, return_carrier),
          return_tracking_number = coalesce($7, return_tracking_number),
          logistics_timeline = coalesce($8::jsonb, logistics_timeline),
          earliest_logistics_at = coalesce($9, earliest_logistics_at),
          latest_logistics_at = coalesce($10, latest_logistics_at),
          logistics_transit_span_hours = coalesce($11, logistics_transit_span_hours),
          logistics_contains_changsha = coalesce($12, logistics_contains_changsha),
          logistics_contains_hengshui_jizhou = coalesce($13, logistics_contains_hengshui_jizhou),
          logistics_direction_matched = coalesce($14, logistics_direction_matched),
          rule_results = coalesce($15::jsonb, rule_results),
          evidence = evidence || coalesce($16::jsonb, '{}'::jsonb),
          decision = $17,
          risk_level = $18,
          action_state = $19,
          action_button_visible = $20,
          next_check_at = $21,
          last_scanned_at = now(),
          completed_at = CASE WHEN $22 THEN now() ELSE completed_at END,
          completion_method = CASE WHEN $22 THEN $23 ELSE completion_method END,
          updated_at = now()
        WHERE work_order_id = $1`, [
        workOrderId, result?.facts?.detailUrl || null, result?.facts?.aftersaleType || null,
        result?.facts?.aftersaleStatus || null, result?.facts?.refundAmount,
        result?.facts?.returnCarrier || null, result?.facts?.returnTrackingNumber || null,
        result?.facts?.logisticsTimeline ? stringifyJsonb(result.facts.logisticsTimeline) : null,
        result?.facts?.earliestLogisticsAt || null, result?.facts?.latestLogisticsAt || null,
        result?.facts?.logisticsTransitSpanHours, result?.facts?.logisticsContainsChangsha,
        result?.facts?.logisticsContainsHengshuiJizhou, result?.facts?.logisticsDirectionMatched,
        result?.rules ? stringifyJsonb(result.rules) : null,
        result?.facts?.evidence ? stringifyJsonb(result.facts.evidence) : null,
        outcome, result?.riskLevel || null,
        outcome === 'auto-refunded' ? 'auto-refunded'
          : outcome === 'manual-completed' ? 'manual-completed'
            : outcome === 'skipped-not-found' ? 'skipped-not-found'
            : outcome === 'wait-logistics' ? 'waiting-logistics'
              : outcome === 'manual-review' ? 'manual-review'
                : outcome === 'page-error' ? 'page-error'
                  : outcome === 'ready' ? 'ready' : 'verification-required',
        result?.facts?.actionButtonVisible, nextAttemptAt, completed || skippedNotFound,
        completionMethod,
      ]);
      await client.query(`
        UPDATE work_orders SET status = $2, runtime_status = $3, current_step = $4,
          handling_classification = $5, classification_reason = $6,
          classification_updated_at = now(), manual_review_reason = $7,
          next_attempt_at = $8,
          payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('returnRefundResult', $9::jsonb),
          completion_state = $10, completion_confirmation_method = $11,
          completion_confirmed_at = CASE WHEN $12 THEN now() ELSE NULL END,
          updated_at = now()
        WHERE id = $1`, [
        workOrderId, workOrderStatus, runtimeStatus, currentStep,
        manual ? 'manual' : 'automated', reason, manual && !completed ? reason : null,
        nextAttemptAt, stringifyJsonb(result || {}),
          skippedNotFound ? 'not-applicable' : completed ? 'confirmed' : 'pending',
          completed || skippedNotFound ? completionMethod : null,
        completed,
      ]);
      if (skippedNotFound) {
        await client.query(`UPDATE external_effects SET status = 'failed',
          receipt = coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb)
            || jsonb_build_object(
            'reconciliationStatus', 'skipped-not-found',
            'completionMethod', $2::text,
            'reconciledAt', now()
          ),
          error = coalesce(error, '{}'::jsonb) || jsonb_build_object(
            'reconciliationReason', 'pdd-return-refund-not-found'
          ),
          updated_at = now()
          WHERE work_order_id = $1 AND effect_type = 'pdd-return-refund'
            AND status IN ('reserved','unknown')`, [workOrderId, completionMethod]);
        await client.query(`
          WITH closed AS (
            UPDATE manual_interventions SET status = 'cancelled',
              resolved_at = coalesce(resolved_at, now()),
              resolved_by = coalesce(resolved_by, 'return-refund-not-found')
            WHERE work_order_id = $1 AND status IN ('open','acknowledged')
            RETURNING id
          )
          UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
          FROM closed WHERE outbox.intervention_id = closed.id
            AND outbox.status IN ('pending','sending','failed')`, [workOrderId]);
      } else if (completed) {
        await client.query(`UPDATE external_effects SET status = 'succeeded',
          receipt = coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb)
            || jsonb_build_object(
            'reconciledFromPdd', true, 'completionMethod', $2::text, 'reconciledAt', now()
          ), updated_at = now()
          WHERE work_order_id = $1 AND effect_type = 'pdd-return-refund'
            AND status IN ('reserved','unknown')`, [workOrderId,
          completionMethod]);
        await client.query(`
          WITH closed AS (
            UPDATE manual_interventions SET status = 'resolved',
              resolved_at = coalesce(resolved_at, now()),
              resolved_by = coalesce(resolved_by, 'return-refund-completion')
            WHERE work_order_id = $1 AND status IN ('open','acknowledged')
            RETURNING id
          )
          UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
          FROM closed WHERE outbox.intervention_id = closed.id
            AND outbox.status IN ('pending','sending','failed')`, [workOrderId]);
      } else if (manual || verificationRequired) {
        const manualReasonCode = verificationRequired
          ? 'return-refund-verification-required'
          : result?.manualReasonCode || 'return-refund-manual-review';
        await client.query(`
          WITH closed AS (
            UPDATE manual_interventions SET status = 'cancelled',
              resolved_at = coalesce(resolved_at, now()),
              resolved_by = coalesce(resolved_by, 'return-refund-reason-reclassified')
            WHERE work_order_id = $1 AND status IN ('open','acknowledged')
              AND reason_code <> $2
            RETURNING id
          )
          UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
          FROM closed WHERE outbox.intervention_id = closed.id
            AND outbox.status IN ('pending','sending','failed')`, [workOrderId, manualReasonCode]);
        await client.query(`
          INSERT INTO manual_interventions
            (id, shop_id, work_order_id, channel, reason_code, reason, risk_level, status, deduplication_key)
          SELECT $1,$2,$3,'dashboard',$4,$5,'high','open',
            'return-refund:' || $2 || ':' || refund.aftersale_number || ':dashboard:' || $4
          FROM return_refunds refund WHERE refund.work_order_id = $3
          ON CONFLICT (deduplication_key) DO UPDATE SET reason = EXCLUDED.reason,
            risk_level = EXCLUDED.risk_level,
            status = 'open', resolved_at = NULL, resolved_by = NULL`, [
          crypto.randomUUID(), shopId, workOrderId,
          manualReasonCode,
          reason || (verificationRequired ? '退款提交结果不明确，禁止重复点击，等待平台状态复核' : '退货退款需要人工处理'),
        ]);
      } else {
        await client.query(`
          WITH closed AS (
            UPDATE manual_interventions SET status = 'cancelled',
              resolved_at = coalesce(resolved_at, now()),
              resolved_by = coalesce(resolved_by, 'return-refund-waiting-reclassified')
            WHERE work_order_id = $1 AND status IN ('open','acknowledged')
            RETURNING id
          )
          UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
          FROM closed WHERE outbox.intervention_id = closed.id
            AND outbox.status IN ('pending','sending','failed')`, [workOrderId]);
      }
      if (completed || skippedNotFound) {
        await resolveTerminalReturnRefundVerifications(client, {
          shopId,
          workOrderId,
          allowActiveLease: true,
          resolvedBy: 'worker-return-refund-terminal-completion',
        });
      }
      const refund = await client.query('SELECT aftersale_number FROM return_refunds WHERE work_order_id = $1', [workOrderId]);
      const occurredAt = new Date().toISOString();
      const eventKey = `return-refund:${shopId}:${refund.rows[0]?.aftersale_number || workOrderId}:${currentStep}:${occurredAt}`;
      await client.query(`
        INSERT INTO workflow_events
          (id, event_key, shop_id, work_order_id, external_order_number, system_name,
           stage, event_type, severity, reason_code, message, payload, source_hash, occurred_at)
        SELECT $1,$2,w.shop_id,w.id,w.external_order_number,'pdd',$3,'return-refund.result',$4,$5,$6,$7::jsonb,$8,$9
        FROM work_orders w WHERE w.id = $10`, [
        crypto.randomUUID(), eventKey, currentStep,
        manual || verificationRequired || pageError ? 'warning' : 'info', reason,
        completed ? '退货退款处理已闭环' : reason || outcome,
        stringifyJsonb(result || {}), crypto.createHash('sha256').update(eventKey).digest('hex'), occurredAt, workOrderId,
      ]);
      await client.query(`UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL,
        lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
        WHERE shop_id = $1 AND lease_token = $2`, [shopId, leaseToken]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverSafePddRemarkFailures({ shopId, maxAttempts = 2 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE work_orders work_order SET
          status = 'retry-ready',
          runtime_status = 'retry-ready',
          current_step = 'pdd-order-remark-retry-ready',
          payload = jsonb_set(
            work_order.payload - 'manualReview',
            '{pddOrderRemark}',
            coalesce(work_order.payload->'pddOrderRemark', '{}'::jsonb) || jsonb_build_object(
              'status', 'retry-ready',
              'reason', NULL,
              'autoRecoveryCount', CASE
                WHEN coalesce(work_order.payload->'pddOrderRemark'->>'autoRecoveryCount', '') ~ '^[0-9]+$'
                  THEN (work_order.payload->'pddOrderRemark'->>'autoRecoveryCount')::int + 1
                ELSE 1 END,
              'autoRecoveryAt', now()
            ),
            true
          ),
          manual_review_reason = NULL,
          next_attempt_at = now(),
          recovery_state = 'ready',
          recovery_reason = NULL,
          recovery_version = recovery_version + 1,
          recovery_updated_at = now(),
          updated_at = now()
        WHERE work_order.shop_id = $1
          AND work_order.status = 'paused'
          AND work_order.current_step = 'manual-review-blocked'
          AND work_order.payload->'pddOrderRemark'->>'status' = 'failed'
          AND (
            coalesce(work_order.manual_review_reason, '') ~
              'pdd-order-remark.*(未在限定时间内完成渲染|进入验证页面|未找到查看详情|未找到添加备注或修改备注入口)'
            OR coalesce(work_order.manual_review_reason, '') ~
              'pdd-order-remark.*locator\.click: Timeout'
            OR coalesce(work_order.manual_review_reason, '') ~
              'pdd-order-remark.*page\\.reload: Timeout'
          )
          AND CASE
            WHEN coalesce(work_order.payload->'pddOrderRemark'->>'autoRecoveryCount', '') ~ '^[0-9]+$'
              THEN (work_order.payload->'pddOrderRemark'->>'autoRecoveryCount')::int
            ELSE 0 END < $2
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND effect.effect_type = 'pdd-note'
              AND effect.status IN ('reserved', 'unknown')
          )
        RETURNING work_order.id, work_order.external_order_number,
          work_order.payload->'pddOrderRemark'->>'autoRecoveryCount' AS auto_recovery_count`,
      [shopId, maxAttempts]);
      for (const row of result.rows) {
        await client.query(`
          INSERT INTO audit_events (shop_id, work_order_id, actor_id, event_type, payload)
          VALUES ($1,$2,'system','pdd-order-remark-auto-recovery',$3::jsonb)`, [
          shopId,
          row.id,
          stringifyJsonb({
            orderNumber: row.external_order_number,
            autoRecoveryCount: Number(row.auto_recovery_count || 1),
            reason: 'safe-pre-save-detail-recovery',
          }),
        ]);
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverSafeTransientOrdinaryPauses({
    shopId,
    authenticatedSystems = [],
    maxAttempts = 2,
    maxTransientAttempts = 5,
  }) {
    const systems = [...new Set(authenticatedSystems
      .map((system) => String(system || '').trim().toLowerCase())
      .filter((system) => ['pdd', 'oms', 'tms'].includes(system)))];
    if (!systems.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT work_order.id, work_order.external_order_number,
            work_order.current_ordinary_instance_id,
            coalesce(
              work_order.manual_review_reason,
              instance.manual_review_reason,
              work_order.payload->>'error',
              ''
            ) AS previous_reason,
            CASE
              WHEN coalesce(work_order.payload
                #>> '{safeTransientPauseRecovery,attempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{safeTransientPauseRecovery,attempts}')::int
              ELSE 0
            END AS previous_attempts,
            CASE
              WHEN 'tms' = ANY($2::text[]) AND (
                coalesce(work_order.manual_review_reason, instance.manual_review_reason,
                  work_order.payload->>'error', '') LIKE 'TMS 客服登记页两轮等待后仍未找到新建按钮或窗口:%'
                OR coalesce(work_order.manual_review_reason, instance.manual_review_reason,
                  work_order.payload->>'error', '') LIKE 'locator.waitFor: Timeout%filter-panel%'
              ) THEN 'tms-registration-navigation-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) LIKE 'OMS automatic login recovery deferred for this shop profile:%'
              THEN 'authenticated-oms-login-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) = 'pdd 标签页不可用'
              THEN 'authenticated-pdd-anchor-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ '^PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE:'
              THEN 'pdd-result-stage-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ '^(?:PDD_PENDING_LIST_FILTER_UNCONFIRMED:|拼多多工单状态筛选未找到(?:全部|待处理)选项，停止本轮查询$)'
              THEN 'pdd-pending-list-filter-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ '^page\\.reload:.*net::ERR_HTTP_RESPONSE_CODE_FAILURE'
              THEN 'pdd-page-reload-http-error-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ 'BROWSER_NAVIGATION_TEMPORARILY_UNAVAILABLE.*open-derived-pdd-detail-resume.*chrome-error://chromewebdata'
              THEN 'pdd-derived-detail-navigation-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ 'EBUSY:.*tms-logistics-work-orders.*\\.png'
              THEN 'tms-screenshot-lock-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ '^page\\.(?:goto|reload): Timeout [0-9.]+ms exceeded'
              THEN 'pdd-page-navigation-timeout-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ '^拼多多resolution-refresh-ordinary-list-query-controls刷新后等待 [0-9]+ 毫秒仍未出现有效结果$'
              THEN 'pdd-resolution-list-query-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) IN (
                '拼多多“发货物流”在刷新后仍未完成渲染',
                '拼多多“退货物流”在刷新后仍未完成渲染'
              )
              THEN 'pdd-logistics-render-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) = '好人好事工单未找到“反馈”入口'
              THEN 'product-shortage-feedback-entry-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) = '点击反馈后“问题反馈”弹窗未出现'
              THEN 'product-shortage-feedback-dialog-recovery'
              WHEN coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) = '问题反馈弹窗未找到“确认提交”按钮'
              THEN 'product-shortage-feedback-confirm-recovery'
              WHEN work_order.current_step = 'transient-workflow-retry-ready'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^Playwright workflow exited with code (-1|[1-9][0-9]*)$'
              THEN 'workflow-process-exit-recovery'
              ELSE 'transient-element-screenshot-recovery'
            END AS strategy
          FROM work_orders work_order
          JOIN ordinary_work_order_instances instance
            ON instance.id = work_order.current_ordinary_instance_id
           AND instance.work_order_id = work_order.id
           AND instance.shop_id = work_order.shop_id
          WHERE work_order.shop_id = $1
            AND work_order.frontend_visibility = 'operational'
            AND work_order.status IN ('paused', 'failed')
            AND instance.status IN ('paused', 'failed')
            AND work_order.completion_state = 'pending'
            AND work_order.recovery_state IN ('ready', 'retry-authorized')
            AND work_order.payload->'ordinaryReissueCreation' IS NULL
            AND work_order.payload->'reissueOrder' IS NULL
            AND work_order.current_step IN (
              'flow-paused', 'manual-review-blocked', 'transient-workflow-retry-ready'
            )
            AND (
              (
                'pdd' = ANY($2::text[]) AND 'tms' = ANY($2::text[])
                AND work_order.current_step = 'flow-paused'
                AND instance.scenario_code IS DISTINCT FROM 'return-refund'
                AND instance.identity_status = 'verified'
                AND (
                  coalesce(work_order.manual_review_reason, instance.manual_review_reason,
                    work_order.payload->>'error', '') LIKE 'TMS 客服登记页两轮等待后仍未找到新建按钮或窗口:%'
                  OR coalesce(work_order.manual_review_reason, instance.manual_review_reason,
                    work_order.payload->>'error', '') LIKE 'locator.waitFor: Timeout%filter-panel%'
                )
                -- Only the inspected navigation failures before any business
                -- effect can retry. Submitted/uncertain tickets stay protected.
                AND NOT EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                    AND (effect.ordinary_instance_id = instance.id
                      OR effect.ordinary_instance_id IS NULL)
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tms_work_orders ticket
                  WHERE ticket.work_order_id = work_order.id
                    AND (ticket.ordinary_instance_id = instance.id
                      OR ticket.ordinary_instance_id IS NULL)
                )
              )
              OR
              (
                'oms' = ANY($2::text[])
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) LIKE 'OMS automatic login recovery deferred for this shop profile:%'
                AND work_order.payload #>> '{systemLogin,system}' = 'oms'
                AND work_order.payload #>> '{systemLogin,status}' = 'retry-ready'
              )
              OR (
                'pdd' = ANY($2::text[])
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) = 'pdd 标签页不可用'
              )
              OR (
                'pdd' = ANY($2::text[])
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^locator[.]screenshot: Timeout [0-9.]+ms exceeded[.]'
              )
              OR (
                'pdd' = ANY($2::text[])
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE:'
              )
              OR (
                'pdd' = ANY($2::text[])
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^(?:PDD_PENDING_LIST_FILTER_UNCONFIRMED:|拼多多工单状态筛选未找到(?:全部|待处理)选项，停止本轮查询$)'
              )
              OR (
                instance.scenario_code IS DISTINCT FROM 'return-refund'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^page\\.reload:.*net::ERR_HTTP_RESPONSE_CODE_FAILURE'
              )
              OR (
                instance.scenario_code IS DISTINCT FROM 'return-refund'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ 'BROWSER_NAVIGATION_TEMPORARILY_UNAVAILABLE.*open-derived-pdd-detail-resume.*chrome-error://chromewebdata'
              )
              OR (
                'tms' = ANY($2::text[])
                AND instance.scenario_code IS DISTINCT FROM 'return-refund'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ 'EBUSY:.*tms-logistics-work-orders.*\\.png'
              )
              OR (
                instance.scenario_code IS DISTINCT FROM 'return-refund'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^page\\.(?:goto|reload): Timeout [0-9.]+ms exceeded'
              )
              OR (
                instance.scenario_code IS DISTINCT FROM 'return-refund'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^拼多多resolution-refresh-ordinary-list-query-controls刷新后等待 [0-9]+ 毫秒仍未出现有效结果$'
              )
              OR (
                'pdd' = ANY($2::text[])
                AND instance.scenario_code = 'product-shortage'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) IN (
                  '拼多多“发货物流”在刷新后仍未完成渲染',
                  '拼多多“退货物流”在刷新后仍未完成渲染'
                )
              )
              OR (
                'pdd' = ANY($2::text[])
                AND instance.scenario_code IS DISTINCT FROM 'return-refund'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^拼多多.*(?:物流|物流标签).*刷新后.*(?:仍未完成渲染|仍未找到)'
              )
              OR (
                'pdd' = ANY($2::text[])
                AND instance.scenario_code = 'product-shortage'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) = '好人好事工单未找到“反馈”入口'
              )
              OR (
                'pdd' = ANY($2::text[])
                AND instance.scenario_code = 'product-shortage'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) IN (
                  '点击反馈后“问题反馈”弹窗未出现',
                  '问题反馈弹窗未找到“确认提交”按钮'
                )
              )
              OR (
                'pdd' = ANY($2::text[])
                AND work_order.current_step = 'transient-workflow-retry-ready'
                AND coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^Playwright workflow exited with code (-1|[1-9][0-9]*)$'
                AND CASE
                  WHEN coalesce(work_order.payload
                    #>> '{transientWorkflowRecovery,count}', '') ~ '^[0-9]+$'
                  THEN (work_order.payload
                    #>> '{transientWorkflowRecovery,count}')::int
                  ELSE 0
                END < $4::int
              )
            )
            AND CASE
              WHEN coalesce(work_order.payload
                #>> '{safeTransientPauseRecovery,attempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{safeTransientPauseRecovery,attempts}')::int
              ELSE 0
            END < $3::int
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND effect.status IN ('reserved', 'unknown')
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND effect.effect_type = 'oms-reissue-create'
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND effect.effect_type = 'pdd-submit'
                AND effect.status = 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
          FOR UPDATE OF work_order, instance
        ), recovered AS (
          UPDATE work_orders work_order SET
            status = 'retry-ready',
            runtime_status = 'retry-ready',
            current_step = 'safe-transient-pause-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = now(),
            recovery_state = 'ready',
            recovery_reason = NULL,
            recovery_version = recovery_version + 1,
            recovery_updated_at = now(),
            payload = (coalesce(work_order.payload, '{}'::jsonb)
              - 'manualReview' - 'error')
              || jsonb_build_object(
                'step', 'safe-transient-pause-retry-ready',
                'systemLogin', CASE
                  WHEN candidate.strategy = 'authenticated-oms-login-recovery'
                  THEN coalesce(work_order.payload->'systemLogin', '{}'::jsonb)
                    || jsonb_build_object(
                      'status', 'authenticated-recovery',
                      'attempts', 0,
                      'recoveredAt', now()
                    )
                  ELSE work_order.payload->'systemLogin'
                END,
                'browserRecovery', coalesce(
                  work_order.payload->'browserRecovery', '{}'::jsonb
                ) || jsonb_build_object('count', 0),
                'transientWorkflowRecovery', CASE
                  WHEN candidate.strategy = 'workflow-process-exit-recovery'
                  THEN coalesce(
                    work_order.payload->'transientWorkflowRecovery', '{}'::jsonb
                  ) || jsonb_build_object('retryAt', now())
                  ELSE coalesce(
                    work_order.payload->'transientWorkflowRecovery', '{}'::jsonb
                  ) || jsonb_build_object('count', 0, 'retryAt', now())
                END,
                'safeTransientPauseRecovery', jsonb_build_object(
                  'attempts', candidate.previous_attempts + 1,
                  'maxAttempts', $3::int,
                  'previousReason', candidate.previous_reason,
                  'strategy', candidate.strategy,
                  'authenticatedSystems', to_jsonb($2::text[]),
                  'recoveredAt', now()
                ),
                'updatedAt', now()
              ),
            updated_at = now()
          FROM candidates candidate
          WHERE work_order.id = candidate.id
          RETURNING work_order.id, work_order.shop_id,
            work_order.external_order_number,
            work_order.current_ordinary_instance_id,
            candidate.previous_reason, candidate.strategy,
            work_order.payload
              #>> '{safeTransientPauseRecovery,attempts}' AS recovery_attempts
        ), recovered_instances AS (
          UPDATE ordinary_work_order_instances instance SET
            status = 'retry-ready',
            runtime_status = 'retry-ready',
            current_step = 'safe-transient-pause-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = now(),
            payload = recovered_work_order.payload,
            updated_at = now()
          FROM work_orders recovered_work_order
          JOIN recovered ON recovered.id = recovered_work_order.id
          WHERE instance.id = recovered.current_ordinary_instance_id
            AND instance.work_order_id = recovered.id
            AND instance.shop_id = recovered.shop_id
          RETURNING recovered.*
        ), audited AS (
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id,
             event_type, payload)
          SELECT recovered.shop_id, recovered.id,
            recovered.current_ordinary_instance_id, 'system',
            'safe-transient-ordinary-pause-recovered',
            jsonb_build_object(
              'orderNumber', recovered.external_order_number,
              'previousReason', recovered.previous_reason,
              'strategy', recovered.strategy,
              'recoveryAttempts', recovered.recovery_attempts,
              'maxAttempts', $3::int,
              'externalActionsReplayed', false
            )
          FROM recovered_instances recovered
          RETURNING work_order_id
        ), resolved AS (
          UPDATE manual_interventions intervention SET
            status = 'resolved',
            resolved_at = coalesce(intervention.resolved_at, now()),
            resolved_by = coalesce(
              intervention.resolved_by,
              'safe-transient-ordinary-pause-recovery'
            )
          FROM recovered_instances recovered
          WHERE intervention.work_order_id = recovered.id
            AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
              recovered.current_ordinary_instance_id
            AND intervention.status IN ('open', 'acknowledged')
            AND intervention.reason = recovered.previous_reason
          RETURNING intervention.id
        ), cancelled AS (
        UPDATE notification_outbox outbox SET
          status = 'cancelled',
          updated_at = now(),
          last_error = jsonb_build_object(
            'reason', 'safe-transient-ordinary-pause-recovered'
          )
        FROM resolved
        WHERE outbox.intervention_id = resolved.id
          AND outbox.status IN ('pending', 'sending', 'failed')
        RETURNING outbox.id
        )
        SELECT recovered.id, recovered.external_order_number,
          recovered.current_ordinary_instance_id, recovered.strategy,
          recovered.recovery_attempts
        FROM recovered_instances recovered
        ORDER BY recovered.external_order_number`, [
        shopId,
        systems,
        maxAttempts,
        Math.max(1, Number(maxTransientAttempts) || 5),
      ]);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverSafePddDetailPauses({ shopId, maxAttempts = 3, pddAuthenticated = false }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT work_order.id, work_order.shop_id, work_order.external_order_number,
            work_order.current_ordinary_instance_id,
            binding.binding_token,
            binding.actual_shop_name,
            binding.mall_id,
            coalesce(
              nullif(work_order.payload->>'detailUrl', ''),
              nullif(instance.detail_url, ''),
              nullif(instance.payload->>'detailUrl', '')
            ) AS previous_detail_url,
            binding.binding_token::text IS DISTINCT FROM
              work_order.payload #>> '{latestDiscovery,pddIdentityBindingToken}'
              AS binding_changed,
            coalesce(
              work_order.manual_review_reason,
              instance.manual_review_reason,
              work_order.payload->>'error',
              ''
            ) AS previous_reason,
            CASE
              WHEN coalesce(work_order.payload
                #>> '{transientWorkflowRecovery,count}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{transientWorkflowRecovery,count}')::int
              ELSE 0
            END AS previous_transient_count,
            CASE
              WHEN coalesce(work_order.payload
                #>> '{safePddDetailRecovery,attempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{safePddDetailRecovery,attempts}')::int
              ELSE 0
            END AS previous_attempts
          FROM work_orders work_order
          JOIN shops shop ON shop.id = work_order.shop_id
          JOIN ordinary_work_order_instances instance
            ON instance.id = work_order.current_ordinary_instance_id
            AND instance.work_order_id = work_order.id
            AND instance.shop_id = work_order.shop_id
          JOIN pdd_shop_runtime_bindings binding
            ON binding.shop_id = work_order.shop_id
            AND binding.actual_shop_name = shop.expected_shop_name
          WHERE work_order.shop_id = $1
            AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
            AND shop.enabled = true
            AND shop.onboarding_status = 'ready'
            AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
            AND work_order.status = 'paused'
            AND instance.status = 'paused'
            AND coalesce(work_order.completion_state, 'pending') = 'pending'
            AND coalesce(work_order.recovery_state, 'ready') <> 'held'
            AND work_order.current_step IN ('flow-paused', 'manual-review-blocked')
            AND (
              binding.binding_token::text =
                work_order.payload #>> '{latestDiscovery,pddIdentityBindingToken}'
              OR (
                instance.identity_status = 'verified'
                AND instance.platform_case_key IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM shops ambiguous_shop
                  WHERE ambiguous_shop.enabled
                    AND ambiguous_shop.id <> work_order.shop_id
                    AND ambiguous_shop.expected_shop_name = binding.actual_shop_name
                )
                AND (
                  binding.mall_id = coalesce(
                    nullif(work_order.payload->>'pddMallId', ''),
                    nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
                    nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
                    nullif(instance.payload->>'pddMallId', ''),
                    nullif(instance.payload#>>'{latestDiscovery,pddMallId}', ''),
                    nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
                  )
                  OR (
                    coalesce(
                      nullif(work_order.payload->>'pddMallId', ''),
                      nullif(work_order.payload#>>'{latestDiscovery,pddMallId}', ''),
                      nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
                      nullif(instance.payload->>'pddMallId', ''),
                      nullif(instance.payload#>>'{latestDiscovery,pddMallId}', ''),
                      nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
                    ) IS NULL
                    AND binding.actual_shop_name = ANY(ARRAY[
                      nullif(work_order.payload->>'shopNameSnapshot', ''),
                      nullif(work_order.payload->>'detectedShopName', ''),
                      nullif(work_order.payload#>>'{latestDiscovery,actualShopName}', ''),
                      nullif(work_order.payload#>>'{pddShopIdentity,actualShopName}', ''),
                      nullif(instance.payload->>'shopNameSnapshot', ''),
                      nullif(instance.payload->>'detectedShopName', ''),
                      nullif(instance.payload#>>'{latestDiscovery,actualShopName}', ''),
                      nullif(instance.payload#>>'{pddShopIdentity,actualShopName}', '')
                    ])
                  )
                )
              )
              OR (
                instance.identity_status = 'legacy-unverified'
                AND instance.platform_case_id IS NULL
                AND instance.platform_case_key IS NULL
                AND binding.actual_shop_name = ANY(ARRAY[
                  nullif(work_order.payload#>>'{pddShopIdentity,actualShopName}', ''),
                  nullif(work_order.payload#>>'{pddShopIdentity,mallName}', ''),
                  nullif(instance.payload#>>'{pddShopIdentity,actualShopName}', ''),
                  nullif(instance.payload#>>'{pddShopIdentity,mallName}', '')
                ])
                AND (
                  coalesce(
                    nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
                    nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
                  ) IS NULL
                  OR binding.mall_id = coalesce(
                    nullif(work_order.payload#>>'{pddShopIdentity,mallId}', ''),
                    nullif(instance.payload#>>'{pddShopIdentity,mallId}', '')
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM shops ambiguous_shop
                  WHERE ambiguous_shop.enabled
                    AND ambiguous_shop.id <> work_order.shop_id
                    AND ambiguous_shop.expected_shop_name = binding.actual_shop_name
                )
              )
            )
            AND (
              coalesce(
                work_order.manual_review_reason,
                instance.manual_review_reason,
                work_order.payload->>'error',
                ''
              ) ~ (
                '^(PDD_DETAIL_TEMPORARILY_UNAVAILABLE:|未找到目标待处理工单（已等待 [0-9]+ 秒）:|'
                || '拼多多[^\r\n]*刷新后等待 [0-9]+ 毫秒仍未出现有效结果$|'
                || '目标工单不在待处理列表，且已验证详情无法确认订单号:)'
              )
              OR (
                coalesce(
                  work_order.manual_review_reason,
                  instance.manual_review_reason,
                  work_order.payload->>'error',
                  ''
                ) ~ '^page[.](waitForURL|goto|reload): Timeout [0-9]+ms exceeded'
                AND coalesce(
                  nullif(work_order.payload->>'detailUrl', ''),
                  nullif(instance.detail_url, ''),
                  nullif(instance.payload->>'detailUrl', ''),
                  ''
                ) ~
                  '^https://mms[.]pinduoduo[.]com/aftersales/work_order/tododetail/?[?]id=[0-9]+'
              )
              OR (
                -- Logistics analysis failed before any recorded external action.
                -- Rebind only an exact verified case in the currently logged-in shop.
                $3::boolean
                AND work_order.scenario_code = 'in-transit-refund'
                AND instance.scenario_code = 'in-transit-refund'
                AND work_order.current_step = 'flow-paused'
                AND work_order.runtime_status = 'paused'
                AND instance.runtime_status = 'paused'
                AND instance.identity_status = 'verified'
                AND instance.platform_case_id ~ '^[0-9]{6,30}$'
                AND instance.platform_case_key =
                  'pdd-work-order:' || instance.platform_case_id
                AND instance.detail_url =
                  'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
                    || instance.platform_case_id
                AND binding.mall_id IS NOT NULL
                AND binding.mall_id = work_order.payload->>'pddMallId'
                AND binding.mall_id = instance.payload->>'pddMallId'
                AND binding.actual_shop_name = work_order.payload->>'shopNameSnapshot'
                AND binding.last_seen_at >= now() - interval '10 minutes'
                AND EXISTS (
                  SELECT 1 FROM shop_identity_bindings confirmed
                  WHERE confirmed.shop_id = work_order.shop_id
                    AND confirmed.status = 'confirmed'
                    AND confirmed.expected_shop_name = binding.actual_shop_name
                    AND confirmed.mall_id = binding.mall_id
                    AND confirmed.profile_fingerprint = binding.profile_fingerprint
                )
                AND NOT EXISTS (
                  SELECT 1 FROM shops ambiguous_shop
                  WHERE ambiguous_shop.enabled
                    AND ambiguous_shop.id <> work_order.shop_id
                    AND ambiguous_shop.expected_shop_name = binding.actual_shop_name
                )
                AND NOT EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tms_work_orders ticket
                  WHERE ticket.work_order_id = work_order.id
                )
                AND work_order.payload#>>'{pddResolutionSubmission,lastClickAttemptedAt}' IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM verification_locations verification
                  WHERE verification.shop_id = work_order.shop_id
                    AND verification.resolved_at IS NULL
                    AND verification.status IN (
                      'detected', 'waiting-human', 'verification-required'
                    )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM work_orders other
                  JOIN external_effects effect ON effect.work_order_id = other.id
                  WHERE other.id <> work_order.id
                    AND other.external_order_number = work_order.external_order_number
                )
                AND coalesce(work_order.manual_review_reason,
                  instance.manual_review_reason, work_order.payload->>'error', '') =
                    'PDD_LOGISTICS_ANALYSIS_TEMPORARILY_UNAVAILABLE: 拼多多物流时间线或阶段分析不完整'
              )
            )
            AND CASE
              WHEN coalesce(work_order.payload
                #>> '{safePddDetailRecovery,attempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{safePddDetailRecovery,attempts}')::int
              ELSE 0
            END < $2::int
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND (
                  effect.ordinary_instance_id IS NULL
                  OR effect.ordinary_instance_id = instance.id
                )
                AND effect.status IN ('reserved', 'unknown')
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND (
                  effect.ordinary_instance_id IS NULL
                  OR effect.ordinary_instance_id = instance.id
                )
                AND effect.effect_type = 'pdd-submit'
                AND effect.status = 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.shop_id = work_order.shop_id
                AND runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
          FOR UPDATE OF work_order, instance
        ), recovered AS (
          UPDATE work_orders work_order SET
            status = 'retry-ready', runtime_status = 'retry-ready',
            current_step = 'ordinary-detail-fresh-query-retry-ready',
            manual_review_reason = NULL, next_attempt_at = now(),
            recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = recovery_version + 1,
            recovery_updated_at = now(),
            payload = (coalesce(work_order.payload, '{}'::jsonb)
              - 'manualReview' - 'error')
              || jsonb_strip_nulls(jsonb_build_object(
                'pddIdentityBindingToken', candidate.binding_token,
                'pddMallId', candidate.mall_id,
                'detectedShopName', candidate.actual_shop_name,
                'shopNameSnapshot', candidate.actual_shop_name
              ))
              || jsonb_build_object(
                'step', 'ordinary-detail-fresh-query-retry-ready',
                'latestDiscovery', coalesce(work_order.payload->'latestDiscovery', '{}'::jsonb)
                  || jsonb_strip_nulls(jsonb_build_object(
                    'shopId', candidate.shop_id,
                    'actualShopName', candidate.actual_shop_name,
                    'pddMallId', candidate.mall_id,
                    'pddIdentityBindingToken', candidate.binding_token,
                    'identityBackfilledAt', now()
                  )),
                'transientWorkflowRecovery', jsonb_build_object(
                  'count', 0,
                  'maxAttempts', 5,
                  'lastReason', candidate.previous_reason,
                  'retryAt', now(),
                  'recoveredAt', now(),
                  'recoverySource', 'safe-pdd-detail-auto-recovery',
                  'previousCount', candidate.previous_transient_count
                ),
                'pddStaleDetailRecovery', jsonb_build_object(
                  'status', 'retry-ready',
                  'strategy', 'fresh-exact-order-query',
                  'previousDetailUrl', candidate.previous_detail_url,
                  'previousReason', candidate.previous_reason,
                  'bindingRebound', candidate.binding_changed,
                  'recoveredAt', now()
                ),
                'safePddDetailRecovery', jsonb_build_object(
                  'attempts', candidate.previous_attempts + 1,
                  'maxAttempts', $2::int,
                  'previousReason', candidate.previous_reason,
                  'strategy', 'fresh-exact-order-query',
                  'recoveredAt', now()
                ),
                'updatedAt', now()
              ),
            updated_at = now()
          FROM candidates candidate
          WHERE work_order.id = candidate.id
          RETURNING work_order.id, work_order.external_order_number,
            work_order.current_ordinary_instance_id, work_order.payload,
            candidate.previous_reason, candidate.previous_attempts + 1 AS attempts,
            candidate.binding_changed, candidate.previous_transient_count
        ), recovered_instances AS (
          UPDATE ordinary_work_order_instances instance SET
            status = 'retry-ready', runtime_status = 'retry-ready',
            current_step = 'ordinary-detail-fresh-query-retry-ready',
            manual_review_reason = NULL, next_attempt_at = now(),
            payload = recovered.payload, updated_at = now()
          FROM recovered
          WHERE instance.id = recovered.current_ordinary_instance_id
            AND instance.work_order_id = recovered.id
          RETURNING recovered.*
        ), resolved AS (
          UPDATE manual_interventions intervention SET
            status = 'resolved', resolved_at = coalesce(intervention.resolved_at, now()),
            resolved_by = coalesce(intervention.resolved_by, 'safe-pdd-detail-auto-recovery')
          FROM recovered_instances recovered
          WHERE intervention.work_order_id = recovered.id
            AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
              recovered.current_ordinary_instance_id
            AND intervention.status IN ('open', 'acknowledged')
            AND intervention.reason_code = 'external-system-error'
            AND intervention.reason ~ (
              '^(PDD_DETAIL_TEMPORARILY_UNAVAILABLE:|未找到目标待处理工单（已等待 [0-9]+ 秒）:|'
              || '拼多多[^\r\n]*刷新后等待 [0-9]+ 毫秒仍未出现有效结果$|'
              || '目标工单不在待处理列表，且已验证详情无法确认订单号:|'
              || 'page[.](waitForURL|goto|reload): Timeout [0-9]+ms exceeded)'
            )
          RETURNING intervention.id
        ), cancelled AS (
          UPDATE notification_outbox outbox SET status = 'cancelled',
            updated_at = now(),
            last_error = jsonb_build_object('reason', 'automatic-safe-pdd-detail-recovery')
          FROM resolved
          WHERE outbox.intervention_id = resolved.id
            AND outbox.status IN ('pending', 'sending', 'failed')
          RETURNING outbox.id
        )
        SELECT * FROM recovered_instances`, [shopId, maxAttempts, pddAuthenticated]);
      for (const row of result.rows) {
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
          VALUES ($1,$2,$3,'system','ordinary-safe-pdd-detail-auto-recovered',$4::jsonb)`, [
          shopId,
          row.id,
          row.current_ordinary_instance_id,
          stringifyJsonb({
            orderNumber: row.external_order_number,
            previousReason: row.previous_reason,
            attempts: Number(row.attempts || 1),
            maxAttempts,
            strategy: 'fresh-exact-order-query',
            bindingRebound: Boolean(row.binding_changed),
            previousTransientRecoveryCount: Number(row.previous_transient_count || 0),
          }),
        ]);
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverSafeUnconfirmedPddSubmissions({ shopId, maxAttempts = 2,
    pddAuthenticated = false }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT work_order.id, work_order.external_order_number,
            work_order.current_ordinary_instance_id,
            work_order.manual_review_reason AS previous_reason,
            CASE
              WHEN coalesce(work_order.payload
                #>> '{unconfirmedPddSubmissionRecovery,recoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{unconfirmedPddSubmissionRecovery,recoveryAttempts}')::int
              ELSE 0
            END AS previous_recovery_attempts,
            effect.id AS effect_id, effect.idempotency_key,
            effect.updated_at AS submitted_at,
            effect.receipt #>> '{result,selectionProof,submitContext,selectedPddOption}'
              AS submitted_option,
            coalesce(work_order.manual_review_reason, '') ~
              '^拼多多resolution-refresh-ordinary-list-query-controls刷新后等待 [0-9]+ 毫秒仍未出现有效结果$'
              AS protected_read_only
          FROM work_orders work_order
          JOIN LATERAL (
            SELECT candidate.id, candidate.idempotency_key, candidate.updated_at,
              candidate.receipt
            FROM external_effects candidate
            WHERE candidate.work_order_id = work_order.id
              AND candidate.ordinary_instance_id IS NOT DISTINCT FROM
                work_order.current_ordinary_instance_id
              AND candidate.effect_type = 'pdd-submit'
              AND candidate.status = 'succeeded'
              AND candidate.idempotency_key NOT LIKE '%-send-script-v1'
            ORDER BY candidate.updated_at DESC
            LIMIT 1
          ) effect ON true
          LEFT JOIN ordinary_work_order_instances instance
            ON instance.id = work_order.current_ordinary_instance_id
           AND instance.work_order_id = work_order.id
           AND instance.shop_id = work_order.shop_id
          LEFT JOIN shops shop ON shop.id = work_order.shop_id
          LEFT JOIN pdd_shop_runtime_bindings binding
            ON binding.shop_id = work_order.shop_id
          LEFT JOIN shop_identity_bindings identity
            ON identity.shop_id = work_order.shop_id
          WHERE work_order.shop_id = $1
            AND work_order.status = 'paused'
            AND work_order.completion_state <> 'confirmed'
            AND (
              (
                work_order.current_step IN ('flow-paused', 'manual-review-blocked')
                AND (
                  work_order.manual_review_reason =
                    '拼多多提交后未确认当前普通工单已完结，禁止重复提交'
                  OR (
                    work_order.payload #>> '{externalStateReconciliation,effectType}' = 'pdd-submit'
                    AND work_order.payload #>> '{externalStateReconciliation,state}'
                      IN ('not-applied', 'unresolved')
                  )
                )
              )
              OR (
                work_order.current_step = 'external-state-reconciliation-failed'
                AND work_order.payload
                  #>> '{externalStateReconciliationTarget,effectType}' = 'pdd-submit'
                AND coalesce(work_order.manual_review_reason, '') ~
                  'locator\\.(fill|waitFor): Timeout'
              )
              OR (
                work_order.current_step = 'external-state-unresolved'
                AND coalesce(work_order.manual_review_reason, '') ~
                  '^browserContext[.]storageState: Protocol error [(]Target[.]createTarget[)]: Failed to open a new tab'
                AND effect.receipt #>> '{result,submitReceipt,success}' = 'true'
                AND effect.receipt #>> '{result,submitReceipt,requestCaptured}' = 'true'
                AND effect.receipt #>> '{result,submitReceipt,responseCaptured}' = 'true'
                AND EXISTS (
                  SELECT 1
                  FROM ordinary_work_order_instances instance
                  WHERE instance.id = work_order.current_ordinary_instance_id
                    AND instance.work_order_id = work_order.id
                    AND instance.shop_id = work_order.shop_id
                    AND instance.status = 'paused'
                    AND instance.identity_status = 'verified'
                  AND instance.scenario_code IS DISTINCT FROM 'product-shortage'
                )
              )
              OR (
                $3::boolean
                AND work_order.current_step = 'flow-paused'
                AND coalesce(work_order.manual_review_reason, '') ~
                  '^拼多多resolution-refresh-ordinary-list-query-controls刷新后等待 [0-9]+ 毫秒仍未出现有效结果$'
                AND instance.status = 'paused'
                AND instance.runtime_status = 'paused'
                AND instance.identity_status = 'verified'
                AND instance.platform_case_id ~ '^[0-9]{6,30}$'
                AND instance.platform_case_key =
                  'pdd-work-order:' || instance.platform_case_id
                AND instance.detail_url =
                  'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
                    || instance.platform_case_id
                AND binding.actual_shop_name = shop.expected_shop_name
                AND identity.status = 'confirmed'
                AND identity.expected_shop_name = shop.expected_shop_name
                AND identity.mall_id = binding.mall_id
                AND identity.profile_fingerprint = binding.profile_fingerprint
                AND binding.binding_token::text = work_order.payload
                  #>> '{latestDiscovery,pddIdentityBindingToken}'
                AND binding.last_seen_at > now() - interval '10 minutes'
                AND effect.idempotency_key LIKE
                  'pdd-submit:' || work_order.shop_id || ':pdd-work-order:'
                    || instance.platform_case_id || ':%'
                AND effect.receipt #>> '{result,submitReceipt,success}' = 'true'
                AND effect.receipt #>> '{result,submitReceipt,clickAttempted}' = 'true'
                AND effect.receipt #>> '{result,submitReceipt,requestCaptured}' = 'true'
                AND effect.receipt #>> '{result,submitReceipt,responseCaptured}' = 'true'
                AND effect.receipt #>> '{result,submitReceipt,httpStatus}' = '200'
                AND effect.receipt #>> '{result,submitReceipt,requestUrl}' =
                  'https://mms.pinduoduo.com/latitude/mallTicket/submitForm'
                AND effect.receipt #>> '{result,selectionProof,orderNumber}' =
                  work_order.external_order_number
                AND coalesce(effect.receipt
                  #>> '{result,selectionProof,submitContext,selectedPddOption}', '') <> ''
              )
            )
            AND CASE
              WHEN coalesce(work_order.payload
                #>> '{unconfirmedPddSubmissionRecovery,recoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{unconfirmedPddSubmissionRecovery,recoveryAttempts}')::int
              ELSE 0
            END < $2::int
            AND (
              coalesce(work_order.payload
                #>> '{pddResolutionSubmission,effectStage}', '') = ''
              OR right(
                effect.idempotency_key,
                length(work_order.payload
                  #>> '{pddResolutionSubmission,effectStage}') + 1
              ) = ':' || (work_order.payload
                #>> '{pddResolutionSubmission,effectStage}')
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects unresolved
              WHERE unresolved.work_order_id = work_order.id
                AND unresolved.ordinary_instance_id IS NOT DISTINCT FROM
                  work_order.current_ordinary_instance_id
                AND unresolved.status IN ('reserved', 'unknown')
            )
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
        )
        UPDATE work_orders work_order SET
          runtime_status = 'paused',
          current_step = 'external-state-reconciliation-ready',
          manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
          next_attempt_at = now(),
          recovery_state = 'ready',
          recovery_reason = NULL,
          recovery_version = recovery_version + 1,
          recovery_updated_at = now(),
          payload = (coalesce(work_order.payload, '{}'::jsonb)
            - 'manualReview' - 'error')
            || jsonb_build_object(
              'step', 'external-state-reconciliation-ready',
              'externalStateReconciliationTarget', jsonb_build_object(
                'effectId', candidate.effect_id,
                'effectType', 'pdd-submit',
                'idempotencyKey', candidate.idempotency_key,
                'status', 'succeeded',
                'submitAttemptCount', CASE
                  WHEN coalesce(work_order.payload
                    #>> '{pddResolutionSubmission,submitAttemptCount}', '') ~ '^[0-9]+$'
                  THEN (work_order.payload
                    #>> '{pddResolutionSubmission,submitAttemptCount}')::int
                  ELSE 1
                END,
                'maximumAutomaticSubmitAttempts', CASE
                  WHEN candidate.protected_read_only THEN 1
                  WHEN coalesce(work_order.payload
                    #>> '{pddResolutionSubmission,maximumAutomaticSubmitAttempts}', '') ~ '^[0-9]+$'
                  THEN (work_order.payload
                    #>> '{pddResolutionSubmission,maximumAutomaticSubmitAttempts}')::int
                  ELSE 2
                END,
                'updatedAt', candidate.submitted_at,
                'protectedReadOnly', candidate.protected_read_only,
                'submittedOption', candidate.submitted_option
              ),
              'pddResolutionSubmission', CASE
                WHEN candidate.protected_read_only THEN
                  coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
                    || jsonb_build_object(
                      'shopId', work_order.shop_id,
                      'orderNumber', work_order.external_order_number,
                      'status', 'submitted-unconfirmed',
                      'submitClicked', true,
                      'submitAttemptCount', 1,
                      'maximumAutomaticSubmitAttempts', 1,
                      'lastClickAttemptedAt', candidate.submitted_at,
                      'effectId', candidate.effect_id,
                      'idempotencyKey', candidate.idempotency_key
                    )
                ELSE work_order.payload->'pddResolutionSubmission'
              END,
              'unconfirmedPddSubmissionRecovery', jsonb_build_object(
                'previousReason', candidate.previous_reason,
                'strategy', 'read-only-pdd-state-reconciliation-no-resubmit',
                'recoveryAttempts', candidate.previous_recovery_attempts + 1,
                'maxRecoveryAttempts', $2::int,
                'recoveredAt', now()
              )
            ),
          updated_at = now()
        FROM candidates candidate
        WHERE work_order.id = candidate.id
        RETURNING work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id,
          work_order.payload
            #>> '{unconfirmedPddSubmissionRecovery,recoveryAttempts}' AS recovery_attempts`,
      [shopId, maxAttempts, pddAuthenticated]);
      if (result.rows.length) {
        await client.query(`
          UPDATE ordinary_work_order_instances instance SET
            status = 'paused',
            runtime_status = 'paused',
            current_step = 'external-state-reconciliation-ready',
            manual_review_reason = '等待只读核对拼多多提交结果，禁止重复提交',
            next_attempt_at = now(),
            payload = (coalesce(instance.payload, '{}'::jsonb)
              - 'manualReview' - 'error')
              || jsonb_build_object(
                'step', 'external-state-reconciliation-ready',
                'externalStateReconciliationTarget',
                  work_order.payload->'externalStateReconciliationTarget',
                'unconfirmedPddSubmissionRecovery',
                  work_order.payload->'unconfirmedPddSubmissionRecovery'
              ),
            updated_at = now()
          FROM work_orders work_order
          WHERE instance.id = work_order.current_ordinary_instance_id
            AND instance.work_order_id = work_order.id
            AND work_order.id = ANY($1::uuid[])`,
        [result.rows.map((row) => row.id)]);
      }
      for (const row of result.rows) {
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
          VALUES ($1,$2,$3,'system','unconfirmed-pdd-submit-reconciliation-recovered',$4::jsonb)`, [
          shopId,
          row.id,
          row.current_ordinary_instance_id,
          stringifyJsonb({
            orderNumber: row.external_order_number,
            strategy: 'read-only-pdd-state-reconciliation-no-resubmit',
            recoveryAttempts: Number(row.recovery_attempts || 1),
            maxRecoveryAttempts: maxAttempts,
          }),
        ]);
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverProactiveLogisticsPostResultFollowups({ shopId, maxAttempts = 2 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT work_order.id, work_order.external_order_number,
            work_order.current_ordinary_instance_id,
            CASE
              WHEN coalesce(work_order.payload
                #>> '{ordinaryPddPostResultFollowupRecovery,recoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{ordinaryPddPostResultFollowupRecovery,recoveryAttempts}')::int
              ELSE 0
            END AS previous_recovery_attempts
          FROM work_orders work_order
          JOIN ordinary_work_order_instances instance
            ON instance.id = work_order.current_ordinary_instance_id
           AND instance.work_order_id = work_order.id
          WHERE work_order.shop_id = $1
            AND work_order.frontend_visibility = 'operational'
            AND work_order.status IN ('paused', 'failed')
            AND work_order.completion_state <> 'confirmed'
            AND instance.scenario_code = 'proactive-logistics-service'
            AND instance.runtime_status IN ('paused', 'failed')
            AND work_order.current_step IN (
              'flow-paused', 'manual-review-blocked', 'ordinary-scenario-starting'
            )
            AND (
              work_order.manual_review_reason =
                '拼多多提交后未确认当前普通工单已完结，禁止重复提交'
              OR work_order.payload
                #>> '{ordinaryScenarioDecision,reasonCode}' =
                  'consumer-return-waybill-confirmation-required'
              OR (
                work_order.current_step = 'ordinary-scenario-starting'
                AND work_order.manual_review_reason = 'Playwright workflow exited with code 1'
              )
            )
            AND CASE
              WHEN coalesce(work_order.payload
                #>> '{ordinaryPddPostResultFollowupRecovery,recoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{ordinaryPddPostResultFollowupRecovery,recoveryAttempts}')::int
              ELSE 0
            END < $2::int
            AND EXISTS (
              SELECT 1 FROM external_effects result_effect
              WHERE result_effect.work_order_id = work_order.id
                AND result_effect.ordinary_instance_id IS NOT DISTINCT FROM
                  work_order.current_ordinary_instance_id
                AND result_effect.effect_type = 'pdd-submit'
                AND result_effect.status = 'succeeded'
                AND result_effect.idempotency_key LIKE '%:result'
            )
            AND (
              coalesce(work_order.payload
                #>> '{pddResolutionSubmission,effectStage}', '') = ''
              OR right(work_order.payload
                #>> '{pddResolutionSubmission,effectStage}', 7) = ':result'
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects completed_followup_effect
              WHERE completed_followup_effect.work_order_id = work_order.id
                AND completed_followup_effect.ordinary_instance_id IS NOT DISTINCT FROM
                  work_order.current_ordinary_instance_id
                AND completed_followup_effect.effect_type = 'pdd-submit'
                AND completed_followup_effect.status = 'succeeded'
                AND completed_followup_effect.idempotency_key NOT LIKE '%:primary'
                AND completed_followup_effect.idempotency_key NOT LIKE '%:result'
                AND completed_followup_effect.idempotency_key NOT LIKE '%-send-script-v1'
                AND completed_followup_effect.idempotency_key
                  NOT LIKE '%-submit-prefilled-reply-v1'
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects followup_effect
              WHERE followup_effect.work_order_id = work_order.id
                AND followup_effect.ordinary_instance_id IS NOT DISTINCT FROM
                  work_order.current_ordinary_instance_id
                AND followup_effect.effect_type = 'pdd-submit'
                AND (
                  followup_effect.idempotency_key LIKE '%-send-script-v1'
                  OR followup_effect.idempotency_key LIKE '%-submit-prefilled-reply-v1'
                )
                AND followup_effect.status IN ('succeeded', 'reserved', 'unknown')
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects unresolved
              WHERE unresolved.work_order_id = work_order.id
                AND unresolved.ordinary_instance_id IS NOT DISTINCT FROM
                  work_order.current_ordinary_instance_id
                AND unresolved.status IN ('reserved', 'unknown')
            )
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
        )
        UPDATE work_orders work_order SET
          status = 'retry-ready',
          runtime_status = 'retry-ready',
          current_step = 'ordinary-post-result-followup-retry-ready',
          manual_review_reason = NULL,
          next_attempt_at = now(),
          recovery_state = 'ready',
          recovery_reason = NULL,
          recovery_version = recovery_version + 1,
          recovery_updated_at = now(),
          payload = (coalesce(work_order.payload, '{}'::jsonb)
            - 'manualReview' - 'error')
            || jsonb_build_object(
              'step', 'ordinary-post-result-followup-retry-ready',
              'ordinaryPddPostResultFollowupRecovery', jsonb_build_object(
                'strategy', 'resume-separately-guarded-followup-no-result-resubmit',
                'recoveryAttempts', candidate.previous_recovery_attempts + 1,
                'maxRecoveryAttempts', $2::int,
                'recoveredAt', now()
              )
            ),
          updated_at = now()
        FROM candidates candidate
        WHERE work_order.id = candidate.id
        RETURNING work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id,
          work_order.payload
            #>> '{ordinaryPddPostResultFollowupRecovery,recoveryAttempts}' AS recovery_attempts`,
      [shopId, maxAttempts]);
      if (result.rows.length) {
        await client.query(`
          UPDATE ordinary_work_order_instances instance SET
            status = 'retry-ready',
            runtime_status = 'retry-ready',
            current_step = 'ordinary-post-result-followup-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = now(),
            payload = (coalesce(instance.payload, '{}'::jsonb)
              - 'manualReview' - 'error')
              || jsonb_build_object(
                'step', 'ordinary-post-result-followup-retry-ready',
                'ordinaryPddPostResultFollowupRecovery',
                  work_order.payload->'ordinaryPddPostResultFollowupRecovery'
              ),
            updated_at = now()
          FROM work_orders work_order
          WHERE instance.id = work_order.current_ordinary_instance_id
            AND instance.work_order_id = work_order.id
            AND work_order.id = ANY($1::uuid[])`,
        [result.rows.map((row) => row.id)]);
      }
      for (const row of result.rows) {
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
          VALUES ($1,$2,$3,'system','ordinary-post-result-followup-recovered',$4::jsonb)`, [
          shopId,
          row.id,
          row.current_ordinary_instance_id,
          stringifyJsonb({
            orderNumber: row.external_order_number,
            strategy: 'resume-separately-guarded-followup-no-result-resubmit',
            recoveryAttempts: Number(row.recovery_attempts || 1),
            maxRecoveryAttempts: maxAttempts,
          }),
        ]);
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverTerminalOmsManualAllocationPauses({
    shopId,
    identityBindingToken,
    maxAttempts = 2,
  }) {
    if (!identityBindingToken) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT work_order.id, work_order.external_order_number,
            work_order.current_ordinary_instance_id,
            coalesce(
              work_order.manual_review_reason,
              instance.manual_review_reason,
              work_order.payload->>'error',
              ''
            ) AS previous_reason,
            coalesce(
              nullif(work_order.payload#>>'{omsAnalysis,orderStatus}', ''),
              nullif(work_order.payload->>'omsOrderStatus', ''),
              nullif(instance.payload#>>'{omsAnalysis,orderStatus}', ''),
              nullif(instance.payload->>'omsOrderStatus', ''),
              CASE upper(coalesce(
                work_order.payload#>>'{omsLiveOrderState,status}',
                instance.payload#>>'{omsLiveOrderState,status}',
                ''
              ))
                WHEN 'INVALID' THEN '作废'
                WHEN 'VOID' THEN '作废'
                WHEN 'CANCELLED' THEN '已取消'
                WHEN 'CANCELED' THEN '已取消'
                WHEN 'CLOSED' THEN '已关闭'
                ELSE NULL
              END
            ) AS terminal_order_status,
            CASE
              WHEN coalesce(work_order.payload
                #>> '{omsTerminalOrderRecovery,runtimeRecoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{omsTerminalOrderRecovery,runtimeRecoveryAttempts}')::int
              ELSE 0
            END AS previous_recovery_attempts
          FROM work_orders work_order
          JOIN shops shop ON shop.id = work_order.shop_id
          JOIN ordinary_work_order_instances instance
            ON instance.id = work_order.current_ordinary_instance_id
           AND instance.work_order_id = work_order.id
           AND instance.shop_id = work_order.shop_id
          JOIN pdd_shop_runtime_bindings binding
            ON binding.shop_id = work_order.shop_id
           AND binding.actual_shop_name = shop.expected_shop_name
           AND binding.binding_token = $2::uuid
           AND binding.binding_token::text =
             work_order.payload#>>'{latestDiscovery,pddIdentityBindingToken}'
          WHERE work_order.shop_id = $1
            AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
            AND work_order.scenario_code = 'abnormal-network-warning'
            AND work_order.status = 'paused'
            AND instance.status = 'paused'
            AND coalesce(work_order.completion_state, 'pending') = 'pending'
            AND coalesce(work_order.recovery_state, 'ready') <> 'held'
            AND work_order.current_step = 'flow-paused'
            AND coalesce(
              work_order.manual_review_reason,
              instance.manual_review_reason,
              work_order.payload->>'error',
              ''
            ) LIKE 'OMS 订单行右键菜单未找到“手工配货”%'
            AND (
              coalesce(
                work_order.payload#>>'{omsAnalysis,orderStatus}',
                work_order.payload->>'omsOrderStatus',
                instance.payload#>>'{omsAnalysis,orderStatus}',
                instance.payload->>'omsOrderStatus',
                ''
              ) IN ('作废', '已取消', '已关闭')
              OR upper(coalesce(
                work_order.payload#>>'{omsLiveOrderState,status}',
                instance.payload#>>'{omsLiveOrderState,status}',
                ''
              )) IN ('INVALID', 'VOID', 'CANCELLED', 'CANCELED', 'CLOSED')
            )
            AND CASE
              WHEN coalesce(work_order.payload
                #>> '{omsTerminalOrderRecovery,runtimeRecoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{omsTerminalOrderRecovery,runtimeRecoveryAttempts}')::int
              ELSE 0
            END < $3::int
            AND NOT EXISTS (
              SELECT 1 FROM external_effects effect
              WHERE effect.work_order_id = work_order.id
                AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND effect.effect_type = 'oms-manual-allocation'
            )
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.shop_id = work_order.shop_id
                AND runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
          FOR UPDATE OF work_order, instance
        )
        UPDATE work_orders work_order SET
          status = 'retry-ready',
          runtime_status = 'retry-ready',
          current_step = 'oms-terminal-order-retry-ready',
          manual_review_reason = NULL,
          next_attempt_at = now(),
          recovery_state = 'ready',
          recovery_reason = NULL,
          recovery_version = recovery_version + 1,
          recovery_updated_at = now(),
          payload = (coalesce(work_order.payload, '{}'::jsonb)
            - 'manualReview' - 'error' - 'omsManualAllocation' - 'pddResolutionDecision')
            || jsonb_build_object(
              'step', 'oms-terminal-order-retry-ready',
              'omsTerminalOrderRecovery',
                coalesce(work_order.payload->'omsTerminalOrderRecovery', '{}'::jsonb)
                  || jsonb_build_object(
                    'status', 'retry-ready',
                    'strategy', 'skip-impossible-manual-allocation-and-report-terminal-order',
                    'terminalOrderStatus', candidate.terminal_order_status,
                    'previousReason', candidate.previous_reason,
                    'runtimeRecoveryAttempts', candidate.previous_recovery_attempts + 1,
                    'maxRuntimeRecoveryAttempts', $3::int,
                    'recoveredAt', now()
                  ),
              'updatedAt', now()
            ),
          updated_at = now()
        FROM candidates candidate
        WHERE work_order.id = candidate.id
        RETURNING work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id,
          candidate.terminal_order_status,
          work_order.payload
            #>> '{omsTerminalOrderRecovery,runtimeRecoveryAttempts}' AS recovery_attempts`,
      [shopId, identityBindingToken, maxAttempts]);
      if (result.rows.length) {
        const workOrderIds = result.rows.map((row) => row.id);
        await client.query(`
          UPDATE ordinary_work_order_instances instance SET
            status = 'retry-ready',
            runtime_status = 'retry-ready',
            current_step = 'oms-terminal-order-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = now(),
            payload = work_order.payload,
            updated_at = now()
          FROM work_orders work_order
          WHERE instance.id = work_order.current_ordinary_instance_id
            AND instance.work_order_id = work_order.id
            AND work_order.id = ANY($1::uuid[])`,
        [workOrderIds]);
        const resolved = await client.query(`
          UPDATE manual_interventions intervention SET
            status = 'resolved',
            resolved_at = coalesce(intervention.resolved_at, now()),
            resolved_by = coalesce(intervention.resolved_by,
              'terminal-oms-manual-allocation-auto-recovery')
          FROM work_orders work_order
          WHERE work_order.id = ANY($1::uuid[])
            AND intervention.work_order_id = work_order.id
            AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
              work_order.current_ordinary_instance_id
            AND intervention.status IN ('open', 'acknowledged')
            AND intervention.reason_code NOT IN (
              'image-upload-failed', 'pdd-upload-authorization-failed'
            )
          RETURNING intervention.id`,
        [workOrderIds]);
        if (resolved.rows.length) {
          await client.query(`
            UPDATE notification_outbox SET
              status = 'cancelled',
              updated_at = now(),
              last_error = jsonb_build_object(
                'reason', 'automatic-terminal-oms-manual-allocation-recovery'
              )
            WHERE intervention_id = ANY($1::uuid[])
              AND status IN ('pending', 'sending', 'failed')`,
          [resolved.rows.map((row) => row.id)]);
        }
      }
      for (const row of result.rows) {
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
          VALUES ($1,$2,$3,'system','terminal-oms-manual-allocation-auto-recovered',$4::jsonb)`, [
          shopId,
          row.id,
          row.current_ordinary_instance_id,
          stringifyJsonb({
            orderNumber: row.external_order_number,
            terminalOrderStatus: row.terminal_order_status,
            strategy: 'skip-impossible-manual-allocation-and-report-terminal-order',
            recoveryAttempts: Number(row.recovery_attempts || 1),
            maxRecoveryAttempts: maxAttempts,
          }),
        ]);
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverConsumerNegotiationFollowups({ shopId, maxAttempts = 2 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT work_order.id, work_order.external_order_number,
            work_order.current_ordinary_instance_id,
            coalesce(
              work_order.manual_review_reason,
              instance.manual_review_reason,
              work_order.payload->>'error',
              ''
            ) AS previous_reason,
            CASE
              WHEN coalesce(work_order.payload
                #>> '{consumerNegotiationFollowupRecovery,recoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{consumerNegotiationFollowupRecovery,recoveryAttempts}')::int
              ELSE 0
            END AS previous_recovery_attempts
          FROM work_orders work_order
          JOIN shops shop ON shop.id = work_order.shop_id
          JOIN ordinary_work_order_instances instance
            ON instance.id = work_order.current_ordinary_instance_id
           AND instance.work_order_id = work_order.id
           AND instance.shop_id = work_order.shop_id
          JOIN pdd_shop_runtime_bindings binding
            ON binding.shop_id = work_order.shop_id
           AND binding.actual_shop_name = shop.expected_shop_name
           AND binding.binding_token::text =
             work_order.payload #>> '{latestDiscovery,pddIdentityBindingToken}'
          WHERE work_order.shop_id = $1
            AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
            AND work_order.scenario_code = 'in-transit-refund'
            AND work_order.status = 'paused'
            AND instance.status = 'paused'
            AND coalesce(work_order.completion_state, 'pending') = 'pending'
            AND coalesce(work_order.recovery_state, 'ready') <> 'held'
            AND work_order.current_step = 'flow-paused'
            AND coalesce(
              work_order.manual_review_reason,
              instance.manual_review_reason,
              work_order.payload->>'error',
              ''
            ) = '外部操作已存在 succeeded 记录，禁止重复执行'
            AND work_order.payload->'pddResolutionSubmission'->>'orderNumber'
              = work_order.external_order_number
            AND work_order.payload->'pddResolutionSubmission'->>'status'
              IN ('followup-waiting', 'followup-ready')
            AND work_order.payload->'pddResolutionSubmission'->>'interceptProgressOutcome'
              = '快递还在拦截中'
            AND nullif(
              work_order.payload->'pddResolutionSubmission'->>'consumerResponseWaitStartedAt',
              ''
            ) IS NOT NULL
            AND work_order.payload->'pddResolutionFlow'->>'flowCode'
              = 'consumer-negotiation-followup'
            AND CASE
              WHEN coalesce(work_order.payload
                #>> '{consumerNegotiationFollowupRecovery,recoveryAttempts}', '') ~ '^[0-9]+$'
              THEN (work_order.payload
                #>> '{consumerNegotiationFollowupRecovery,recoveryAttempts}')::int
              ELSE 0
            END < $2::int
            AND EXISTS (
              SELECT 1 FROM external_effects tms_effect
              WHERE tms_effect.work_order_id = work_order.id
                AND tms_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND tms_effect.effect_type = 'tms-create'
                AND tms_effect.status = 'succeeded'
            )
            AND EXISTS (
              SELECT 1 FROM external_effects note_effect
              WHERE note_effect.work_order_id = work_order.id
                AND note_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND note_effect.effect_type = 'pdd-note'
                AND note_effect.status = 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects unresolved_effect
              WHERE unresolved_effect.work_order_id = work_order.id
                AND unresolved_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND unresolved_effect.status IN ('reserved', 'unknown')
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_effects completed_followup_effect
              WHERE completed_followup_effect.work_order_id = work_order.id
                AND completed_followup_effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
                AND completed_followup_effect.effect_type = 'pdd-submit'
                AND completed_followup_effect.status = 'succeeded'
                AND completed_followup_effect.idempotency_key
                  LIKE '%:consumer-negotiation-followup-v1'
            )
            AND NOT EXISTS (
              SELECT 1 FROM shop_runtime_state runtime
              WHERE runtime.current_work_order_id = work_order.id
                AND runtime.lease_token IS NOT NULL
                AND runtime.lease_expires_at > now()
            )
          FOR UPDATE OF work_order, instance
        )
        UPDATE work_orders work_order SET
          status = 'retry-ready',
          runtime_status = 'retry-ready',
          current_step = 'pdd-consumer-negotiation-followup-retry-ready',
          manual_review_reason = NULL,
          next_attempt_at = now(),
          recovery_state = 'ready',
          recovery_reason = NULL,
          recovery_version = recovery_version + 1,
          recovery_updated_at = now(),
          payload = (coalesce(work_order.payload, '{}'::jsonb)
            - 'manualReview' - 'error' - 'pddResolutionDecision')
            || jsonb_build_object(
              'step', 'pdd-consumer-negotiation-followup-retry-ready',
              'pddResolutionFlow',
                coalesce(work_order.payload->'pddResolutionFlow', '{}'::jsonb)
                  || jsonb_build_object('flowCode', 'consumer-negotiation-followup'),
              'pddResolutionSubmission',
                coalesce(work_order.payload->'pddResolutionSubmission', '{}'::jsonb)
                  || jsonb_build_object(
                    'status', 'followup-ready',
                    'orderNumber', work_order.external_order_number
                  ),
              'consumerNegotiationFollowupRecovery',
                coalesce(work_order.payload->'consumerNegotiationFollowupRecovery', '{}'::jsonb)
                  || jsonb_build_object(
                    'status', 'retry-ready',
                    'strategy', 'resume-pdd-followup-without-oms-or-tms-replay',
                    'previousReason', candidate.previous_reason,
                    'recoveryAttempts', candidate.previous_recovery_attempts + 1,
                    'maxRecoveryAttempts', $2::int,
                    'recoveredAt', now()
                  ),
              'updatedAt', now()
            ),
          updated_at = now()
        FROM candidates candidate
        WHERE work_order.id = candidate.id
        RETURNING work_order.id, work_order.external_order_number,
          work_order.current_ordinary_instance_id,
          work_order.payload
            #>> '{consumerNegotiationFollowupRecovery,recoveryAttempts}' AS recovery_attempts`,
      [shopId, maxAttempts]);
      if (result.rows.length) {
        const workOrderIds = result.rows.map((row) => row.id);
        await client.query(`
          UPDATE ordinary_work_order_instances instance SET
            status = 'retry-ready',
            runtime_status = 'retry-ready',
            current_step = 'pdd-consumer-negotiation-followup-retry-ready',
            manual_review_reason = NULL,
            next_attempt_at = now(),
            payload = work_order.payload,
            updated_at = now()
          FROM work_orders work_order
          WHERE instance.id = work_order.current_ordinary_instance_id
            AND instance.work_order_id = work_order.id
            AND work_order.id = ANY($1::uuid[])`,
        [workOrderIds]);
        const resolved = await client.query(`
          UPDATE manual_interventions intervention SET
            status = 'resolved',
            resolved_at = coalesce(intervention.resolved_at, now()),
            resolved_by = coalesce(intervention.resolved_by,
              'consumer-negotiation-followup-auto-recovery')
          FROM work_orders work_order
          WHERE work_order.id = ANY($1::uuid[])
            AND intervention.work_order_id = work_order.id
            AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
              work_order.current_ordinary_instance_id
            AND intervention.status IN ('open', 'acknowledged')
            AND intervention.reason_code NOT IN (
              'image-upload-failed', 'pdd-upload-authorization-failed'
            )
          RETURNING intervention.id`,
        [workOrderIds]);
        if (resolved.rows.length) {
          await client.query(`
            UPDATE notification_outbox SET
              status = 'cancelled',
              updated_at = now(),
              last_error = jsonb_build_object(
                'reason', 'automatic-consumer-negotiation-followup-recovery'
              )
            WHERE intervention_id = ANY($1::uuid[])
              AND status IN ('pending', 'sending', 'failed')`,
          [resolved.rows.map((row) => row.id)]);
        }
      }
      for (const row of result.rows) {
        await client.query(`
          INSERT INTO audit_events
            (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
          VALUES ($1,$2,$3,'system','consumer-negotiation-followup-auto-recovered',$4::jsonb)`, [
          shopId,
          row.id,
          row.current_ordinary_instance_id,
          stringifyJsonb({
            orderNumber: row.external_order_number,
            strategy: 'resume-pdd-followup-without-oms-or-tms-replay',
            proof: 'succeeded-tms-create-and-pdd-note-with-no-uncertain-effect',
            recoveryAttempts: Number(row.recovery_attempts || 1),
            maxRecoveryAttempts: maxAttempts,
          }),
        ]);
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease({ shopId, workerId, leaseToken, leaseSeconds = 300 }) {
    const result = await this.pool.query(`
      UPDATE shop_runtime_state SET lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
      WHERE shop_id = $1 AND worker_id = $2 AND lease_token = $3 AND lease_expires_at > now()
      RETURNING shop_id`, [shopId, workerId, leaseToken, leaseSeconds]);
    return result.rowCount === 1;
  }

  async hasValidLease({ shopId, workerId, workOrderId, leaseToken }) {
    const result = await this.pool.query(`
      SELECT 1
      FROM shop_runtime_state runtime
      JOIN work_orders work_order
        ON work_order.id = runtime.current_work_order_id
       AND work_order.shop_id = runtime.shop_id
      WHERE runtime.shop_id = $1
        AND runtime.worker_id = $2
        AND runtime.current_work_order_id = $3
        AND runtime.lease_token = $4
        AND runtime.lease_expires_at > now()
        AND work_order.status = 'processing'`,
    [shopId, workerId, workOrderId, leaseToken]);
    return result.rowCount === 1;
  }

  async finishClaimed({ shopId, workOrderId, leaseToken, status, currentStep, payload = {}, error = null, nextAttemptAt = null }) {
    const nextStatus = ['archived', 'completed', 'paused', 'retry-ready', 'failed'].includes(status) ? status : 'paused';
    const completion = completionTruth(payload, nextStatus);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE work_orders w SET status = $4, runtime_status = $4, current_step = $5,
          payload = $6::jsonb
            || CASE WHEN w.payload ? 'latestDiscovery'
              THEN jsonb_build_object('latestDiscovery', w.payload->'latestDiscovery') ELSE '{}'::jsonb END
            || CASE WHEN NOT ($6::jsonb ? 'tmsWorkOrder') AND w.payload ? 'tmsWorkOrder'
              THEN jsonb_build_object('tmsWorkOrder', w.payload->'tmsWorkOrder') ELSE '{}'::jsonb END,
          manual_review_reason = $7, next_attempt_at = $8, completion_state = $9,
          completion_confirmation_method = $10, completion_confirmed_at = $11, updated_at = now()
        FROM shop_runtime_state s
        WHERE w.id = $1 AND w.shop_id = $2 AND s.shop_id = w.shop_id AND s.lease_token = $3
        RETURNING w.id`, [workOrderId, shopId, leaseToken, nextStatus, currentStep || null, stringifyJsonb(payload),
          error?.message || null, nextAttemptAt, completion.state, completion.method, completion.confirmedAt]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(`UPDATE ordinary_work_order_instances instance SET
        status = $2, runtime_status = $2, current_step = $3,
        payload = $4::jsonb
          || CASE WHEN instance.payload ? 'latestDiscovery'
            THEN jsonb_build_object('latestDiscovery', instance.payload->'latestDiscovery') ELSE '{}'::jsonb END
          || CASE WHEN NOT ($4::jsonb ? 'tmsWorkOrder') AND instance.payload ? 'tmsWorkOrder'
            THEN jsonb_build_object('tmsWorkOrder', instance.payload->'tmsWorkOrder') ELSE '{}'::jsonb END,
        manual_review_reason = $5, next_attempt_at = $6,
        completed_at = CASE WHEN $2 IN ('archived','completed') THEN coalesce(completed_at, now()) ELSE NULL END,
        completion_method = CASE WHEN $2 IN ('archived','completed') THEN $7 ELSE NULL END,
        updated_at = now()
        FROM work_orders work_order
        WHERE work_order.id = $1
          AND instance.id = work_order.current_ordinary_instance_id`, [
        workOrderId,
        nextStatus,
        currentStep || null,
        stringifyJsonb(payload),
        error?.message || null,
        nextAttemptAt,
        completion.method,
      ]);
      await materializeConfirmedTmsTicket(client, { shopId, workOrderId, payload });
      await materializeVerifiedAnalysisSnapshots(client, { shopId, workOrderId, payload });
      if (['archived', 'completed'].includes(nextStatus)) {
        await client.query(`
          WITH resolved AS (
            UPDATE manual_interventions
            SET status = 'resolved', resolved_at = coalesce(resolved_at, now()),
              resolved_by = coalesce(resolved_by, 'worker-completion')
            WHERE work_order_id = $1 AND status IN ('open', 'acknowledged')
              AND (
                ordinary_instance_id IS NULL
                OR ordinary_instance_id = (
                  SELECT current_ordinary_instance_id FROM work_orders WHERE id = $1
                )
              )
            RETURNING id
          )
          UPDATE notification_outbox outbox
          SET status = 'cancelled', updated_at = now()
          FROM resolved
          WHERE outbox.intervention_id = resolved.id
            AND outbox.status IN ('pending', 'sending', 'failed')`, [workOrderId]);
      }
      if (nextStatus === 'retry-ready') {
        await client.query(`
          WITH resolved AS (
            UPDATE manual_interventions intervention
            SET status = 'resolved', resolved_at = coalesce(resolved_at, now()),
              resolved_by = coalesce(resolved_by, 'worker-retry-ready-reclassification')
            WHERE intervention.work_order_id = $1
              AND intervention.status IN ('open', 'acknowledged')
              AND intervention.reason_code = ANY($2::text[])
              AND (
                intervention.ordinary_instance_id IS NULL
                OR intervention.ordinary_instance_id = (
                  SELECT current_ordinary_instance_id FROM work_orders WHERE id = $1
                )
              )
            RETURNING intervention.id
          )
          UPDATE notification_outbox outbox
          SET status = 'cancelled', updated_at = now()
          FROM resolved
          WHERE outbox.intervention_id = resolved.id
            AND outbox.status IN ('pending', 'sending', 'failed')`, [
          workOrderId,
          retryReclassifiedInterventionReasonCodes,
        ]);
      }
      if (['archived', 'completed'].includes(nextStatus)) {
        await resolveTerminalWorkOrderVerifications(client, {
          shopId,
          workOrderId,
          allowActiveLease: true,
          resolvedBy: 'worker-finish-terminal-verification-cleared',
        });
      } else if (payload.verificationTimeout?.status === 'closed') {
        // A timed-out CAPTCHA was explicitly dismissed. Expire its gate so
        // the work order can be retried without treating the challenge as a
        // successful verification or leaving the shop permanently blocked.
        await client.query(`
          UPDATE verification_locations SET status = 'expired', resolved_at = coalesce(resolved_at, now())
          WHERE shop_id = $1 AND work_order_id = $2
            AND status IN ('detected', 'waiting-human', 'verification-required')
            AND resolved_at IS NULL`, [shopId, workOrderId]);
        await resolveClearedVerificationInterventions(client, {
          shopId,
          workOrderId,
          resolvedBy: 'worker-verification-timeout-closed',
        });
      } else if (!payload.verificationLocation
        && !verificationBlockingSteps.has(currentStep || '')) {
        await client.query(`
          UPDATE verification_locations SET status = 'resolved', resolved_at = coalesce(resolved_at, now())
          WHERE shop_id = $1 AND work_order_id = $2
            AND status IN ('detected', 'waiting-human', 'verification-required')
            AND resolved_at IS NULL`, [shopId, workOrderId]);
        await resolveClearedVerificationInterventions(client, {
          shopId,
          workOrderId,
          resolvedBy: 'worker-finish-verification-cleared',
        });
      }
      await client.query(`
        UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL, lease_expires_at = NULL,
          current_work_order_id = NULL, updated_at = now()
        WHERE shop_id = $1 AND lease_token = $2`, [shopId, leaseToken]);
      if (['archived', 'completed'].includes(nextStatus)) {
        await promoteNextDeferredOrdinaryInstance(client, { workOrderId, shopId });
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async checkpointClaimed({ shopId, workOrderId, leaseToken, currentStep, payload = {} }) {
    const client = await this.pool.connect();
    const serialized = stringifyJsonb(payload);
    const checkpointStep = currentStep || 'processing';
    const runtimeStatus = checkpointStep === 'human-verification-required' ? 'verification' : 'processing';
    const sourceUpdatedAt = payload.updatedAt || new Date().toISOString();
    const sourceHash = crypto.createHash('sha256').update(serialized).digest('hex');
    const verification = payload.verificationLocation;
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE work_orders w SET current_step = $4,
          payload = $5::jsonb
            || CASE WHEN w.payload ? 'latestDiscovery'
              THEN jsonb_build_object('latestDiscovery', w.payload->'latestDiscovery') ELSE '{}'::jsonb END
            || CASE WHEN NOT ($5::jsonb ? 'tmsWorkOrder') AND w.payload ? 'tmsWorkOrder'
              THEN jsonb_build_object('tmsWorkOrder', w.payload->'tmsWorkOrder') ELSE '{}'::jsonb END,
          runtime_status = $6, updated_at = now()
        FROM shop_runtime_state s
        WHERE w.id = $1 AND w.shop_id = $2 AND s.shop_id = w.shop_id
          AND s.lease_token = $3 AND w.status = 'processing'
          AND coalesce(w.payload->>'updatedAt', '') <= $7::text
        RETURNING w.id`, [workOrderId, shopId, leaseToken, checkpointStep, serialized, runtimeStatus,
        sourceUpdatedAt]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(`UPDATE ordinary_work_order_instances instance SET
        status = 'processing', runtime_status = $2, current_step = $3,
        payload = $4::jsonb
          || CASE WHEN instance.payload ? 'latestDiscovery'
            THEN jsonb_build_object('latestDiscovery', instance.payload->'latestDiscovery') ELSE '{}'::jsonb END
          || CASE WHEN NOT ($4::jsonb ? 'tmsWorkOrder') AND instance.payload ? 'tmsWorkOrder'
            THEN jsonb_build_object('tmsWorkOrder', instance.payload->'tmsWorkOrder') ELSE '{}'::jsonb END,
        updated_at = now()
        FROM work_orders work_order
        WHERE work_order.id = $1
          AND instance.id = work_order.current_ordinary_instance_id
          AND coalesce(instance.payload->>'updatedAt', '') <= $5::text`, [
        workOrderId,
        runtimeStatus,
        checkpointStep,
        serialized,
        sourceUpdatedAt,
      ]);
      await materializeConfirmedTmsTicket(client, { shopId, workOrderId, payload });
      await materializeVerifiedAnalysisSnapshots(client, { shopId, workOrderId, payload });
      await client.query(`
        INSERT INTO workflow_checkpoints
          (shop_id, work_order_id, ordinary_instance_id, external_order_number,
           current_step, runtime_status, snapshot, source_hash, source_updated_at)
        SELECT $1,$2,current_ordinary_instance_id,$3,$4,$5,$6::jsonb,$7,$8
        FROM work_orders WHERE id = $2
        ON CONFLICT (shop_id) DO UPDATE SET work_order_id = EXCLUDED.work_order_id,
          ordinary_instance_id = EXCLUDED.ordinary_instance_id,
          external_order_number = EXCLUDED.external_order_number,
          current_step = EXCLUDED.current_step, runtime_status = EXCLUDED.runtime_status,
          snapshot = EXCLUDED.snapshot, source_hash = EXCLUDED.source_hash,
          source_updated_at = EXCLUDED.source_updated_at, synchronized_at = now()
        WHERE workflow_checkpoints.source_updated_at <= EXCLUDED.source_updated_at`,
      [shopId, workOrderId, payload.orderNumber || null, checkpointStep, runtimeStatus,
        serialized, sourceHash, sourceUpdatedAt]);

      const validVerificationId = verification?.id
        && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(verification.id));
      const verificationSuppressed = verificationTimeoutSuppressesSnapshot(payload, verification);
      const verificationIsActive = validVerificationId
        && !verificationSuppressed
        && activeVerificationStatuses.has(String(verification?.status || 'waiting-human'))
        && !verification?.resolvedAt;
      if (validVerificationId && !verificationSuppressed) {
        await client.query(`
          UPDATE verification_locations SET status = 'expired', resolved_at = coalesce(resolved_at, $4)
          WHERE shop_id = $1 AND system_name = $2 AND id <> $3::uuid
            AND status IN ('detected', 'waiting-human', 'verification-required')`,
        [shopId, verification.system || 'pdd', verification.id, sourceUpdatedAt]);
        await client.query(`
          INSERT INTO verification_locations
            (id, shop_id, work_order_id, ordinary_instance_id, system_name, stage, status,
             url, frame_url, selector, bounding_box, confidence, detected_at, resolved_at)
          SELECT $1,$2,$3,current_ordinary_instance_id,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13
          FROM work_orders WHERE id = $3
          ON CONFLICT (id) DO UPDATE SET
            work_order_id = coalesce(EXCLUDED.work_order_id, verification_locations.work_order_id),
            -- Verification DOM ids may be reused by another work order. Never
            -- carry an old instance binding across that boundary.
            ordinary_instance_id = CASE
              WHEN EXCLUDED.ordinary_instance_id IS NOT NULL
                THEN EXCLUDED.ordinary_instance_id
              WHEN verification_locations.work_order_id IS NOT DISTINCT FROM EXCLUDED.work_order_id
                THEN verification_locations.ordinary_instance_id
              ELSE NULL
            END,
            system_name = EXCLUDED.system_name, stage = EXCLUDED.stage, status = EXCLUDED.status,
            url = EXCLUDED.url, frame_url = EXCLUDED.frame_url, selector = EXCLUDED.selector,
            bounding_box = EXCLUDED.bounding_box, confidence = EXCLUDED.confidence,
            resolved_at = EXCLUDED.resolved_at`,
        [verification.id, shopId, workOrderId, verification.system || 'pdd',
          verification.stage || checkpointStep, verification.status || 'waiting-human',
          verification.url || payload.currentUrl || '', verification.frameUrl || null,
          verification.selector || null,
          stringifyJsonb(verification.boundingBox || { x: 0, y: 0, width: 0, height: 0 }),
          verification.confidence || 'medium', verification.detectedAt || sourceUpdatedAt,
          verification.resolvedAt || null]);
      } else if (verificationSuppressed || !verificationBlockingSteps.has(checkpointStep)) {
        await client.query(`
          UPDATE verification_locations SET status = 'resolved', resolved_at = coalesce(resolved_at, $2)
          WHERE shop_id = $1 AND work_order_id = $3
            AND status IN ('detected', 'waiting-human', 'verification-required')
            AND resolved_at IS NULL`, [shopId, sourceUpdatedAt, workOrderId]);
      }
      if (!verificationBlockingSteps.has(checkpointStep) && !verificationIsActive) {
        await resolveClearedVerificationInterventions(client, {
          shopId,
          workOrderId,
          resolvedAt: sourceUpdatedAt,
          resolvedBy: 'worker-checkpoint-verification-cleared',
        });
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileCompleted({
    shopId,
    externalOrderNumber,
    ordinaryInstanceId = null,
    platformCaseKey = null,
    currentStep,
    payload = {},
  }) {
    const completion = completionTruth(payload, 'archived');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT work_order.id, work_order.current_ordinary_instance_id,
          instance.platform_case_id, instance.platform_case_key
        FROM work_orders work_order
        LEFT JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
        WHERE work_order.shop_id = $1
          AND work_order.external_order_number = $2
          AND work_order.status = 'processing'
        FOR UPDATE OF work_order`, [shopId, externalOrderNumber]);
      if (!selected.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      const current = selected.rows[0];
      const requestedInstanceId = String(ordinaryInstanceId || '').trim() || null;
      const requestedPlatformCaseKey = String(platformCaseKey || '').trim() || null;
      const currentInstanceId = String(current.current_ordinary_instance_id || '').trim() || null;
      const currentPlatformCaseId = String(current.platform_case_id || '').trim() || null;
      const currentPlatformCaseKey = String(current.platform_case_key || '').trim() || null;
      const identityMismatch = currentInstanceId
        ? (!requestedInstanceId
          || !requestedPlatformCaseKey
          || requestedInstanceId !== currentInstanceId
          || requestedPlatformCaseKey !== currentPlatformCaseKey)
        : Boolean(requestedInstanceId || requestedPlatformCaseKey);
      if (identityMismatch) {
        const legacyIdentityAbsent = !requestedInstanceId && !requestedPlatformCaseKey;
        const completionMarker = payload.lastCompletedOrder || payload.completionArchive || {};
        const markerInstanceId = String(completionMarker.ordinaryInstanceId || '').trim() || null;
        const exactInstanceMarker = requestedInstanceId === currentInstanceId
          && markerInstanceId === currentInstanceId
          && !requestedPlatformCaseKey
          && completionMarker.orderNumber === externalOrderNumber
          && Boolean(String(completionMarker.outcome || '').trim());
        const currentIdentityComplete = Boolean(
          currentInstanceId
          && currentPlatformCaseId
          && currentPlatformCaseKey === `pdd-work-order:${currentPlatformCaseId}`,
        );
        const unresolvedEffects = currentInstanceId
          ? await client.query(`
            SELECT 1 FROM external_effects
            WHERE work_order_id = $1::uuid
              AND status IN ('reserved','unknown')
              AND (
                ordinary_instance_id IS NULL
                OR ordinary_instance_id = $2::uuid
              )
            LIMIT 1`, [current.id, currentInstanceId])
          : { rowCount: 0 };
        const succeededSubmission = legacyIdentityAbsent && currentInstanceId
          ? await client.query(`
            SELECT 1 FROM external_effects
            WHERE work_order_id = $1::uuid
              AND ordinary_instance_id = $2::uuid
              AND effect_type = 'pdd-submit'
              AND status = 'succeeded'
            LIMIT 1`, [current.id, currentInstanceId])
          : { rowCount: 0 };
        const recoverySource = exactInstanceMarker
          ? 'exact-instance-completion-marker'
          : legacyIdentityAbsent && succeededSubmission.rowCount
            ? 'succeeded-pdd-submit-effect'
            : null;
        const recoveryIdentityConfirmed = recoverySource === 'exact-instance-completion-marker'
          || currentIdentityComplete;
        if (!recoveryIdentityConfirmed
          || completion.state !== 'confirmed'
          || unresolvedEffects.rowCount
          || !recoverySource) {
          throw new Error('reconcile-completed-ordinary-instance-mismatch');
        }
        const completedOrder = completionMarker;
        payload = {
          ...payload,
          ordinaryInstanceId: currentInstanceId,
          platformWorkOrderId: currentPlatformCaseId,
          platformCaseKey: currentPlatformCaseKey,
          lastCompletedOrder: {
            ...completedOrder,
            orderNumber: externalOrderNumber,
            ordinaryInstanceId: currentInstanceId,
            platformWorkOrderId: currentPlatformCaseId,
            platformCaseKey: currentPlatformCaseKey,
          },
          completionIdentityRecovery: {
            source: recoverySource,
            recoveredAt: new Date().toISOString(),
          },
        };
      }
      const result = await client.query(`
        UPDATE work_orders SET status = 'archived', runtime_status = 'archived', current_step = $3,
          payload = $4::jsonb, completion_state = $5, completion_confirmation_method = $6,
          completion_confirmed_at = $7, updated_at = now()
        WHERE id = $1::uuid
          AND current_ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
        RETURNING id`, [
        current.id,
        current.current_ordinary_instance_id,
        currentStep || 'full-business-flow-complete',
        stringifyJsonb(payload),
        completion.state,
        completion.method,
        completion.confirmedAt,
      ]);
      if (result.rowCount !== 1) throw new Error('reconcile-completed-work-order-changed');
      await client.query(`
        UPDATE ordinary_work_order_instances SET status = 'archived', runtime_status = 'archived',
          current_step = $2, payload = $3::jsonb, completed_at = coalesce(completed_at, now()),
          completion_method = $4, updated_at = now()
        WHERE id = $1::uuid`, [
        current.current_ordinary_instance_id,
        currentStep || 'full-business-flow-complete',
        stringifyJsonb(payload),
        completion.method,
      ]);
      await client.query(`
        UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL, lease_expires_at = NULL,
          current_work_order_id = NULL, updated_at = now()
        WHERE shop_id = $1 AND current_work_order_id = $2::uuid`, [shopId, current.id]);
      await promoteNextDeferredOrdinaryInstance(client, { workOrderId: current.id, shopId });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveExternalEffect({
    shopId,
    workOrderId,
    effectType,
    idempotencyKey,
    requestHash,
    ordinaryInstanceId = null,
    platformCaseKey = null,
  }) {
    const id = crypto.randomUUID();
    const current = await this.pool.query(`
      SELECT work_order.current_ordinary_instance_id, instance.platform_case_key
      FROM work_orders work_order
      LEFT JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE work_order.id = $1 AND work_order.shop_id = $2`, [workOrderId, shopId]);
    if (!current.rowCount) throw new Error('external-effect-work-order-not-found');
    const currentInstanceId = String(current.rows[0].current_ordinary_instance_id || '').trim() || null;
    const currentPlatformCaseKey = String(current.rows[0].platform_case_key || '').trim() || null;
    const requestedInstanceId = String(ordinaryInstanceId || '').trim() || null;
    const requestedPlatformCaseKey = String(platformCaseKey || '').trim() || null;
    const identityMismatch = currentInstanceId
      ? (!requestedInstanceId
        || !requestedPlatformCaseKey
        || requestedInstanceId !== currentInstanceId
        || requestedPlatformCaseKey !== currentPlatformCaseKey)
      : Boolean(requestedInstanceId || requestedPlatformCaseKey);
    if (identityMismatch) throw new Error('external-effect-current-instance-mismatch');
    const result = await this.pool.query(`
      INSERT INTO external_effects
        (id, shop_id, work_order_id, ordinary_instance_id, effect_type, idempotency_key, status, request_hash)
      SELECT $1,$2,$3,work_order.current_ordinary_instance_id,$4,$5,'reserved',$6
      FROM work_orders work_order
      LEFT JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
      WHERE work_order.id = $3 AND work_order.shop_id = $2
        AND ($7::uuid IS NULL OR work_order.current_ordinary_instance_id = $7::uuid)
        AND ($8::text IS NULL OR instance.platform_case_key = $8::text)
      ON CONFLICT (shop_id, idempotency_key) DO NOTHING
      RETURNING *`, [id, shopId, workOrderId, effectType, idempotencyKey, requestHash,
      requestedInstanceId, requestedPlatformCaseKey]);
    if (result.rowCount) return { reserved: true, effect: result.rows[0] };
    const existing = await this.pool.query('SELECT * FROM external_effects WHERE shop_id = $1 AND idempotency_key = $2', [shopId, idempotencyKey]);
    const effect = existing.rows[0];
    if (String(effect?.ordinary_instance_id || '').trim() !== String(requestedInstanceId || '').trim()) {
      throw new Error('external-effect-ordinary-instance-mismatch');
    }
    if (!effect) throw new Error('external-effect-current-instance-mismatch');
    if (effect?.status === 'succeeded' && effect.request_hash === requestHash) {
      return { reserved: false, alreadySucceeded: true, effect };
    }
    const exactFailedRetry = effect?.status === 'failed'
      && effect.request_hash === requestHash
      && !(effect.effect_type === 'pdd-return-refund'
        && (effect.receipt?.submission?.confirmationDispatchStarted === true
          || effect.receipt?.submission?.confirmationClicked === true))
      && !(effect.effect_type === 'oms-reissue-create'
        && hasVerifiedOmsReissueNotAppliedEvidence(effect));
    const reconciledOmsRequestRefresh = effect?.request_hash !== requestHash
      && hasVerifiedOmsReissueNotAppliedEvidence(effect);
    if (exactFailedRetry || reconciledOmsRequestRefresh) {
      const retried = await this.pool.query(`
        UPDATE external_effects SET status = 'reserved', receipt = NULL, error = NULL,
          request_hash = $2, reserved_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'failed' AND request_hash = $3
          AND ordinary_instance_id IS NOT DISTINCT FROM $4::uuid
          AND error IS NOT DISTINCT FROM $5::jsonb
        RETURNING *`, [effect.id, requestHash, effect.request_hash, requestedInstanceId,
        stringifyJsonb(effect.error)]);
      if (retried.rowCount) {
        return {
          reserved: true,
          effect: retried.rows[0],
          retry: true,
          reconciledRequestRefresh: reconciledOmsRequestRefresh,
        };
      }
    }
    return { reserved: false, effect };
  }

  async completeExternalEffect({
    id,
    status,
    receipt = null,
    error = null,
    ordinaryInstanceId = null,
  }) {
    if (!['succeeded', 'failed', 'unknown'].includes(status)) throw new Error(`Invalid external-effect status: ${status}`);
    const result = await this.pool.query(`
      UPDATE external_effects SET status = $2, receipt = $3::jsonb, error = $4::jsonb, updated_at = now()
      WHERE id = $1 AND status = 'reserved'
        AND ordinary_instance_id IS NOT DISTINCT FROM $5::uuid
      RETURNING *`, [id, status, stringifyJsonb(receipt), stringifyJsonb(error), ordinaryInstanceId]);
    return result.rows[0] || null;
  }

  async hasUnresolvedExternalEffects({
    workOrderId,
    ordinaryInstanceId = null,
  }) {
    const result = await this.pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = $1::uuid
          AND effect.status IN ('reserved','unknown')
          AND (
            effect.ordinary_instance_id IS NULL
            OR effect.ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
          )
      ) AS present`, [workOrderId, ordinaryInstanceId]);
    return result.rows[0]?.present === true;
  }

  async hasAnyExternalEffects({
    workOrderId,
    ordinaryInstanceId = null,
  }) {
    const result = await this.pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM external_effects effect
        WHERE effect.work_order_id = $1::uuid
          AND (
            effect.ordinary_instance_id IS NULL
            OR effect.ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
          )
      ) AS present`, [workOrderId, ordinaryInstanceId]);
    return result.rows[0]?.present === true;
  }

  async handoffClaimed({
    shopId,
    workOrderId,
    leaseToken,
    currentStep,
    payload = {},
    reason,
    retryOnStart = false,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const uncertain = await client.query(`
        UPDATE external_effects SET status = 'unknown',
          error = coalesce(error, '{}'::jsonb) || jsonb_build_object(
            'reason', 'operator-or-shutdown-handoff',
            'markedUnknownAt', now()
          ),
          updated_at = now()
        WHERE shop_id = $1 AND work_order_id = $2 AND status = 'reserved'
          AND ordinary_instance_id IS NOT DISTINCT FROM (
            SELECT current_ordinary_instance_id FROM work_orders
            WHERE id = $2 AND shop_id = $1
          )
        RETURNING id, effect_type`, [shopId, workOrderId]);
      const existingUnknown = await client.query(`
        SELECT count(*)::int AS count FROM external_effects
        WHERE shop_id = $1 AND work_order_id = $2 AND status = 'unknown'
          AND ordinary_instance_id IS NOT DISTINCT FROM (
            SELECT current_ordinary_instance_id FROM work_orders
            WHERE id = $2 AND shop_id = $1
          )`, [shopId, workOrderId]);
      const unknownExternalEffects = Number(existingUnknown.rows[0]?.count || 0);
      const nextStatus = retryOnStart && unknownExternalEffects === 0 ? 'retry-ready' : 'paused';
      const result = await client.query(`
        UPDATE work_orders work_order SET
          status = $4,
          runtime_status = $4,
          current_step = $5,
          payload = $6::jsonb || CASE
            WHEN work_order.payload ? 'latestDiscovery'
              THEN jsonb_build_object('latestDiscovery', work_order.payload->'latestDiscovery')
            ELSE '{}'::jsonb
          END,
          manual_review_reason = CASE WHEN $7::int > 0
            THEN '外部操作结果不确定，必须先只读核对平台状态'
            ELSE $8 END,
          next_attempt_at = CASE WHEN $4 = 'retry-ready' THEN now() ELSE NULL END,
          recovery_state = CASE WHEN $7::int > 0 THEN 'held' ELSE 'ready' END,
          recovery_reason = CASE WHEN $7::int > 0 THEN 'unknown-external-effect' ELSE NULL END,
          recovery_version = recovery_version + 1,
          recovery_updated_at = now(),
          updated_at = now()
        FROM shop_runtime_state runtime
        WHERE work_order.id = $2 AND work_order.shop_id = $1
          AND runtime.shop_id = work_order.shop_id AND runtime.lease_token = $3
        RETURNING work_order.id`, [shopId, workOrderId, leaseToken, nextStatus, currentStep,
          stringifyJsonb(payload), unknownExternalEffects, reason || null]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(`
        UPDATE verification_locations SET status = 'expired', resolved_at = coalesce(resolved_at, now())
        WHERE shop_id = $1 AND work_order_id = $2 AND resolved_at IS NULL
          AND ordinary_instance_id IS NOT DISTINCT FROM (
            SELECT current_ordinary_instance_id FROM work_orders
            WHERE id = $2 AND shop_id = $1
          )`, [shopId, workOrderId]);
      await client.query(`
        UPDATE shop_runtime_state SET status = 'idle', lease_token = NULL, lease_expires_at = NULL,
          current_work_order_id = NULL, updated_at = now()
        WHERE shop_id = $1 AND lease_token = $2`, [shopId, leaseToken]);
      await client.query('COMMIT');
      return {
        status: nextStatus,
        unknownExternalEffects,
        markedUnknownEffectIds: uncertain.rows.map((row) => row.id),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getWorkOrderForReconciliation({ workOrderId, shopId }) {
    const result = await this.pool.query(`
      SELECT w.*,
        ordinary.platform_case_id AS platform_work_order_id,
        ordinary.platform_case_key,
        (
          SELECT jsonb_build_object(
            'effectId', effect.id,
            'effectType', effect.effect_type,
            'idempotencyKey', effect.idempotency_key,
            'status', effect.status,
            'submitAttemptCount', coalesce(
              CASE
                WHEN coalesce(w.payload #>> '{pddResolutionSubmission,submitAttemptCount}', '') ~ '^[0-9]+$'
                  THEN (w.payload #>> '{pddResolutionSubmission,submitAttemptCount}')::int
                ELSE NULL
              END,
              1
            ),
            'maximumAutomaticSubmitAttempts', coalesce(
              CASE
                WHEN coalesce(w.payload #>> '{pddResolutionSubmission,maximumAutomaticSubmitAttempts}', '') ~ '^[0-9]+$'
                  THEN (w.payload #>> '{pddResolutionSubmission,maximumAutomaticSubmitAttempts}')::int
                ELSE NULL
              END,
              2
            ),
            'protectedReadOnly', coalesce(
              w.payload #>> '{externalStateReconciliationTarget,protectedReadOnly}' = 'true',
              false
            ),
            'submittedOption', effect.receipt
              #>> '{result,selectionProof,submitContext,selectedPddOption}',
            'updatedAt', effect.updated_at
          )
          FROM external_effects effect
          WHERE effect.work_order_id = w.id
            AND effect.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
            AND effect.effect_type = 'pdd-submit'
            AND effect.status IN ('succeeded', 'unknown')
            AND effect.idempotency_key NOT LIKE '%-send-script-v1'
          ORDER BY effect.updated_at DESC
          LIMIT 1
        ) AS pdd_submit_reconciliation_target,
        coalesce((
          SELECT array_agg(DISTINCT effect.effect_type ORDER BY effect.effect_type)
          FROM external_effects effect
          WHERE effect.work_order_id = w.id AND effect.status = 'unknown'
            AND effect.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
        ), ARRAY[]::text[]) AS unknown_effect_types
      FROM work_orders w
      LEFT JOIN ordinary_work_order_instances ordinary
        ON ordinary.id = w.current_ordinary_instance_id
      WHERE w.id = $1 AND w.shop_id = $2`, [workOrderId, shopId]);
    return result.rows[0] || null;
  }

  async claimNextExternalStateReconciliation({
    shopId,
    retryAfterMs = 600_000,
    retryWindowMs = 172_800_000,
    maxAttempts = 3,
  }) {
    const listCompletion = await claimUnverifiedListCompletion(this.pool, { shopId });
    if (listCompletion) return listCompletion;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE work_orders SET recovery_state = 'ready', runtime_status = 'paused',
          current_step = 'external-state-reconciliation-retry', recovery_reason = NULL,
          payload = CASE
            WHEN coalesce(payload #>> '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
              AND (payload #>> '{externalStateReconciliationRetry,attempts}')::int > 0
            THEN jsonb_set(
              payload,
              '{externalStateReconciliationRetry}',
              coalesce(payload->'externalStateReconciliationRetry', '{}'::jsonb)
                || jsonb_build_object(
                  'attempts', (payload #>> '{externalStateReconciliationRetry,attempts}')::int - 1,
                  'interruptedAttemptRefundedAt', now()
                ),
              true
            )
            ELSE payload
          END,
          recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
        WHERE shop_id = $1 AND status = 'paused' AND recovery_state = 'reconciling'
          AND recovery_updated_at < now() - interval '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.shop_id = work_orders.shop_id
              AND runtime.current_work_order_id = work_orders.id
              AND runtime.lease_token IS NOT NULL
              AND runtime.lease_expires_at > now()
          )`, [shopId]);
      const result = await client.query(`
        WITH candidate AS (
          SELECT work_order.id
          FROM work_orders work_order
          WHERE work_order.shop_id = $1 AND work_order.status = 'paused'
            AND (
              work_order.recovery_state = 'ready'
              OR (
              work_order.recovery_state = 'held'
                AND (
                  work_order.current_step IN (
                    'external-state-unresolved',
                    'human-verification-required'
                  )
                  OR (
                    work_order.current_step = 'flow-paused'
                    AND EXISTS (
                      SELECT 1 FROM external_effects effect
                      WHERE effect.work_order_id = work_order.id
                        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
                          work_order.current_ordinary_instance_id
                        AND effect.effect_type = 'oms-reissue-create'
                        AND effect.status = 'unknown'
                    )
                  )
                  OR (
                    work_order.current_step = 'system-shutdown-drained'
                    AND work_order.recovery_reason = 'unknown-external-effect'
                  )
                )
                AND work_order.recovery_updated_at < now() - ($2::bigint * interval '1 millisecond')
                AND coalesce(
                  work_order.recovery_updated_at,
                  work_order.updated_at,
                  work_order.created_at
                ) >= now() - ($3::bigint * interval '1 millisecond')
                AND (
                  CASE
                    WHEN coalesce(work_order.payload #>> '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
                      THEN (work_order.payload #>> '{externalStateReconciliationRetry,attempts}')::int
                    ELSE 0
                  END < $4::int
                  OR (
                    CASE
                      WHEN coalesce(work_order.payload #>> '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
                        THEN (work_order.payload #>> '{externalStateReconciliationRetry,attempts}')::int
                      ELSE 0
                    END = $4::int
                    AND work_order.current_step = 'system-shutdown-drained'
                    AND work_order.recovery_reason = 'unknown-external-effect'
                    AND work_order.payload
                      #>> '{externalStateReconciliationRetry,postSubmitUnknownExtensionUsedAt}' IS NULL
                    AND work_order.payload #>> '{externalStateReconciliation,state}' = 'not-applied'
                    AND work_order.payload #>> '{externalStateReconciliation,effectType}' = 'oms-reissue-create'
                    AND work_order.payload #>> '{externalStateReconciliation,readOnly}' = 'true'
                    AND work_order.payload
                      #>> '{externalStateReconciliation,externalActionsReplayed}' = 'false'
                    AND jsonb_typeof(
                      work_order.payload #> '{externalStateReconciliation,queryPasses}'
                    ) = 'array'
                    AND jsonb_array_length(
                      work_order.payload #> '{externalStateReconciliation,queryPasses}'
                    ) >= 2
                    AND EXISTS (
                      SELECT 1
                      FROM external_effects effect
                      WHERE effect.work_order_id = work_order.id
                        AND effect.ordinary_instance_id IS NOT DISTINCT FROM
                          work_order.current_ordinary_instance_id
                        AND effect.effect_type = 'oms-reissue-create'
                        AND effect.status = 'unknown'
                        AND coalesce(effect.error->>'message', '') LIKE
                          '%OMS 补发提交后未回查到新的补发订单标识%'
                        AND effect.reserved_at > CASE
                          WHEN coalesce(
                            work_order.payload #>> '{externalStateReconciliation,observedAt}',
                            ''
                          ) ~ '^\\d{4}-\\d{2}-\\d{2}T'
                          THEN (
                            work_order.payload #>> '{externalStateReconciliation,observedAt}'
                          )::timestamptz
                          ELSE now()
                        END
                    )
                  )
                )
              )
            )
            AND (
              EXISTS (
                SELECT 1 FROM external_effects effect
                WHERE effect.work_order_id = work_order.id AND effect.status = 'unknown'
                  AND effect.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
                  AND effect.effect_type IN (
                    'tms-create', 'pdd-note', 'pdd-submit', 'oms-manual-allocation',
                    'oms-reissue-create'
                  )
              )
              OR (
                (
                  work_order.current_step LIKE 'external-state-%'
                  OR work_order.payload #>> '{manualReview,stage}' IN (
                    'pdd-resolution-submit', 'pdd-resolution-submit-confirmation'
                  )
                )
                AND EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                    AND effect.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
                    AND effect.status IN ('succeeded', 'failed')
                    AND effect.effect_type = 'pdd-submit'
                )
              )
              OR (
                work_order.current_step = 'pdd-detail-read-only-reconciliation-ready'
                AND work_order.payload
                  #>> '{crossShopPddEvidenceReadOnlyRecovery,status}' = 'ready'
                AND EXISTS (
                  SELECT 1
                  FROM ordinary_work_order_instances instance
                  JOIN shops shop ON shop.id = work_order.shop_id
                  JOIN pdd_shop_runtime_bindings binding
                    ON binding.shop_id = work_order.shop_id
                    AND binding.actual_shop_name = shop.expected_shop_name
                    AND binding.binding_token::text = work_order.payload
                      #>> '{latestDiscovery,pddIdentityBindingToken}'
                  WHERE instance.id = work_order.current_ordinary_instance_id
                    AND instance.work_order_id = work_order.id
                    AND instance.shop_id = work_order.shop_id
                    AND instance.identity_status = 'verified'
                    AND instance.platform_case_id IS NOT NULL
                    AND instance.platform_case_key =
                      'pdd-work-order:' || instance.platform_case_id
                    AND instance.detail_url =
                      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
                        || instance.platform_case_id
                )
                AND EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                    AND effect.ordinary_instance_id IS NOT DISTINCT FROM
                      work_order.current_ordinary_instance_id
                    AND effect.effect_type = 'evidence-upload'
                    AND effect.status = 'unknown'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                    AND effect.status = 'unknown'
                    AND effect.effect_type <> 'evidence-upload'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                    AND effect.status = 'reserved'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                    AND effect.effect_type = 'pdd-submit'
                )
              )
              OR (
                work_order.current_step = 'pdd-detail-read-only-reconciliation-ready'
                AND work_order.payload
                  #>> '{crossShopLegacyPddReadOnlyRecovery,status}' = 'ready'
                AND EXISTS (
                  SELECT 1
                  FROM ordinary_work_order_instances instance
                  JOIN shops shop ON shop.id = work_order.shop_id
                  JOIN pdd_shop_runtime_bindings binding
                    ON binding.shop_id = work_order.shop_id
                    AND binding.actual_shop_name = shop.expected_shop_name
                    AND binding.binding_token::text = work_order.payload
                      #>> '{latestDiscovery,pddIdentityBindingToken}'
                  WHERE instance.id = work_order.current_ordinary_instance_id
                    AND instance.work_order_id = work_order.id
                    AND instance.shop_id = work_order.shop_id
                    AND instance.identity_status = 'verified'
                    AND instance.platform_case_id IS NOT NULL
                    AND instance.platform_case_key =
                      'pdd-work-order:' || instance.platform_case_id
                    AND instance.detail_url =
                      'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id='
                        || instance.platform_case_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM external_effects effect
                  WHERE effect.work_order_id = work_order.id
                    AND (
                      effect.status IN ('reserved','unknown')
                      OR (effect.effect_type = 'pdd-submit' AND effect.status = 'succeeded')
                      OR (effect.effect_type = 'evidence-upload' AND effect.status = 'failed')
                    )
                )
              )
            )
          ORDER BY work_order.updated_at DESC
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE work_orders work_order SET runtime_status = 'processing',
          current_step = 'external-state-reconciling', recovery_state = 'reconciling',
          recovery_reason = NULL, recovery_version = recovery_version + 1,
          payload = jsonb_set(
            coalesce(work_order.payload, '{}'::jsonb),
            '{externalStateReconciliationRetry}',
            jsonb_build_object(
              'attempts', CASE
                WHEN coalesce(work_order.payload #>> '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
                  THEN (work_order.payload #>> '{externalStateReconciliationRetry,attempts}')::int + 1
                ELSE 1
              END,
              'maxAttempts', $4::int,
              'claimedAt', now()
            ) || CASE
              WHEN CASE
                WHEN coalesce(work_order.payload #>> '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
                  THEN (work_order.payload #>> '{externalStateReconciliationRetry,attempts}')::int
                ELSE 0
              END >= $4::int
              THEN jsonb_build_object(
                'postSubmitUnknownExtensionUsedAt', now(),
                'postSubmitUnknownExtensionPurpose',
                  'read-only-oms-reconciliation-after-unknown-submit'
              )
              ELSE '{}'::jsonb
            END,
            true
          ),
          recovery_updated_at = now(), updated_at = now()
        FROM candidate WHERE work_order.id = candidate.id
        RETURNING work_order.*`, [shopId, retryAfterMs, retryWindowMs, maxAttempts]);
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async failExternalStateReconciliation({ workOrderId, shopId, ordinaryInstanceId = null, error }) {
    const result = await this.pool.query(`
      UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
        current_step = 'external-state-unresolved',
        manual_review_reason = $3, recovery_state = 'held',
        recovery_reason = 'external-state-reconciliation-retry-pending',
        recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
      WHERE id = $1 AND shop_id = $2 AND recovery_state = 'reconciling'
        AND current_ordinary_instance_id IS NOT DISTINCT FROM $4::uuid
      RETURNING *`, [workOrderId, shopId,
      error?.message || String(error || 'external-state-reconciliation-failed'), ordinaryInstanceId]);
    return result.rows[0] || null;
  }

  async deferExternalStateReconciliationForVerification({
    workOrderId,
    shopId,
    ordinaryInstanceId = null,
    reason,
  }) {
    const result = await this.pool.query(`
      UPDATE work_orders SET status = 'paused', runtime_status = 'verification',
        current_step = 'human-verification-required',
        manual_review_reason = $3, recovery_state = 'held',
        recovery_reason = 'external-state-verification-required',
        payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{externalStateReconciliationRetry}',
          coalesce(payload->'externalStateReconciliationRetry', '{}'::jsonb)
            || jsonb_build_object(
              'attempts', greatest(
                0,
                CASE
                  WHEN coalesce(payload #>> '{externalStateReconciliationRetry,attempts}', '') ~ '^[0-9]+$'
                    THEN (payload #>> '{externalStateReconciliationRetry,attempts}')::int - 1
                  ELSE 0
                END
              ),
              'verificationAttemptRefundedAt', now()
            ),
          true
        ),
        recovery_version = recovery_version + 1,
        recovery_updated_at = now(), updated_at = now()
      WHERE id = $1 AND shop_id = $2 AND recovery_state = 'reconciling'
        AND current_ordinary_instance_id IS NOT DISTINCT FROM $4::uuid
      RETURNING *`, [
      workOrderId,
      shopId,
      reason || '拼多多只读回查遇到人工验证',
      ordinaryInstanceId,
    ]);
    return result.rows[0] || null;
  }

  async checkpointExternalStateReconciliation({
    workOrderId,
    shopId,
    ordinaryInstanceId = null,
    currentStep,
    payload = {},
  }) {
    const result = await this.pool.query(`
      UPDATE work_orders SET current_step = $3,
        payload = $4::jsonb || CASE
          WHEN payload #>> '{externalStateReconciliationTarget,protectedReadOnly}' = 'true'
          THEN jsonb_build_object(
            'externalStateReconciliationTarget',
              payload->'externalStateReconciliationTarget',
            'pddResolutionSubmission', payload->'pddResolutionSubmission'
          )
          ELSE '{}'::jsonb
        END || CASE
          WHEN payload ? 'ordinaryListCompletionReadOnlyRecovery'
          THEN jsonb_build_object('ordinaryListCompletionReadOnlyRecovery',
            payload->'ordinaryListCompletionReadOnlyRecovery')
          ELSE '{}'::jsonb
        END || CASE
          WHEN payload ? 'latestDiscovery'
            THEN jsonb_build_object('latestDiscovery', payload->'latestDiscovery')
          ELSE '{}'::jsonb
        END,
        runtime_status = 'processing', updated_at = now()
      WHERE id = $1 AND shop_id = $2 AND recovery_state = 'reconciling'
        AND current_ordinary_instance_id IS NOT DISTINCT FROM $5::uuid
      RETURNING id`, [workOrderId, shopId, currentStep || 'external-state-reconciling',
      stringifyJsonb(payload), ordinaryInstanceId]);
    return result.rowCount === 1;
  }

  async completeExternalStateReconciliation({
    workOrderId,
    shopId,
    ordinaryInstanceId = null,
    observation,
    payload = {},
  }) {
    if (observation?.effectType === LIST_COMPLETION_PROOF_EFFECT) {
      return completeListCompletionProof(this.pool, {
        workOrderId, shopId, ordinaryInstanceId, observation, payload,
      });
    }
    const confirmed = observation?.state === 'confirmed';
    const notApplied = observation?.state === 'not-applied';
    const reconciledEffectType = String(observation?.effectType || '');
    const intermediateReconciliation = [
      'tms-create',
      'pdd-note',
      'oms-manual-allocation',
      'oms-reissue-create',
    ]
      .includes(reconciledEffectType);
    const retryablePddSubmitNotApplied = reconciledEffectType === 'pdd-submit' && notApplied;
    const retryablePddEvidenceNotApplied = reconciledEffectType === 'evidence-upload'
      && notApplied;
    const retryablePddStateNotApplied = reconciledEffectType === 'pdd-state'
      && notApplied;
    const continuationReconciliation = intermediateReconciliation
      || retryablePddSubmitNotApplied
      || retryablePddEvidenceNotApplied
      || retryablePddStateNotApplied;
    const confirmedStep = reconciledEffectType === 'tms-create'
      ? 'tms-create-reconciled'
      : reconciledEffectType === 'oms-reissue-create'
        ? 'oms-reissue-create-reconciled'
      : reconciledEffectType === 'oms-manual-allocation'
        ? 'oms-manual-allocation-reconciled'
        : 'pdd-order-remark-reconciled';
    const notAppliedStep = reconciledEffectType === 'tms-create'
      ? 'tms-create-not-applied'
        : reconciledEffectType === 'oms-reissue-create'
          ? 'oms-reissue-create-not-applied'
        : reconciledEffectType === 'oms-manual-allocation'
          ? 'oms-manual-allocation-not-applied'
          : reconciledEffectType === 'evidence-upload'
            ? 'pdd-evidence-not-applied'
          : reconciledEffectType === 'pdd-state'
            ? 'pdd-state-not-applied'
          : reconciledEffectType === 'pdd-submit'
            ? 'pdd-submit-not-applied'
            : 'pdd-order-remark-not-applied';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT id, external_order_number, current_ordinary_instance_id,
          payload #>> '{externalStateReconciliationTarget,protectedReadOnly}'
            AS protected_read_only,
          payload #>> '{externalStateReconciliationTarget,submittedOption}'
            AS submitted_option,
          payload->'externalStateReconciliationTarget' AS protected_target,
          payload #>> '{ordinaryListCompletionReadOnlyRecovery,protectedReadOnly}' AS list_proof_only,
          payload->'pddResolutionSubmission' AS protected_submission
        FROM work_orders
        WHERE id = $1 AND shop_id = $2 AND recovery_state = 'reconciling'
          AND current_ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
        FOR UPDATE`, [workOrderId, shopId, ordinaryInstanceId]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      if (selected.rows[0].list_proof_only === 'true') {
        throw new Error('list-completion-reconciliation-effect-type-mismatch');
      }
      if (selected.rows[0].protected_read_only === 'true') {
        const exactCompletedDetail = observation?.state === 'confirmed'
          && observation?.readOnly === true
          && observation?.protectedReadOnlyExactDetail === true
          && observation?.orderNumber === selected.rows[0].external_order_number
          && ['detail-completed', 'refreshed-detail-completed']
            .includes(observation?.confirmationMethod);
        const observedOption = String(observation?.completionEvidence || '').trim();
        const submittedOption = String(selected.rows[0].submitted_option || '').trim();
        if (observation?.state === 'not-applied'
          || (observation?.state === 'confirmed'
            && (!exactCompletedDetail
              || (observedOption && submittedOption && observedOption !== submittedOption)))) {
          throw new Error('protected-pdd-submit-read-only-proof-insufficient');
        }
      }
      const durablePayload = selected.rows[0].protected_read_only === 'true'
        ? {
          ...(payload || {}),
          externalStateReconciliationTarget: selected.rows[0].protected_target,
          pddResolutionSubmission: selected.rows[0].protected_submission,
        }
        : payload;
      const reconciledPayload = confirmed && reconciledEffectType === 'pdd-note'
        ? {
          ...(durablePayload || {}),
          pddOrderRemark: {
            ...(durablePayload?.pddOrderRemark || {}),
            shopId,
            orderNumber: observation?.orderNumber || selected.rows[0].external_order_number,
            text: observation?.remarkText || durablePayload?.pddOrderRemark?.text || null,
            color: observation?.colorLabel || durablePayload?.pddOrderRemark?.color || null,
            status: 'saved',
            detailMode: observation?.detailMode || 'reconciled',
            alreadySucceeded: true,
            savedAt: observation?.observedAt || new Date().toISOString(),
            reconciliationMethod: observation?.confirmationMethod || 'read-only-reconciliation',
          },
        }
        : durablePayload;
      if (continuationReconciliation && (confirmed || notApplied)) {
        await client.query(`
          UPDATE external_effects SET status = $3,
            receipt = CASE WHEN $3 = 'succeeded'
              THEN coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb)
                || jsonb_build_object('readOnlyReconciliation', $4::jsonb)
                || CASE WHEN $5 = 'oms-reissue-create' THEN jsonb_build_object(
                  'result', jsonb_strip_nulls(jsonb_build_object(
                    'salesOrderCode', $4::jsonb->>'salesOrderCode',
                    'trackingNumber', $4::jsonb->>'trackingNumber',
                    'identifiedAt', $4::jsonb->>'observedAt'
                  ))
                ) ELSE '{}'::jsonb END
              ELSE NULL END,
            error = CASE WHEN $3 = 'failed'
              THEN jsonb_build_object('readOnlyReconciliation', $4::jsonb)
              ELSE NULL END,
            updated_at = now()
          WHERE work_order_id = $1 AND shop_id = $2
            AND ordinary_instance_id IS NOT DISTINCT FROM $6::uuid
            AND (status = 'unknown' OR (
              $3 = 'failed' AND $5 = 'pdd-submit' AND status = 'succeeded'
            ))
            AND effect_type = $5
            AND (
              $5 <> 'pdd-submit'
              OR (
                $7::uuid IS NOT NULL
                AND id = $7::uuid
                AND idempotency_key = $8::text
              )
              OR (
                $7::uuid IS NULL
                AND (
                  idempotency_key LIKE '%:resolution'
                  OR idempotency_key LIKE '%:resolution-postcondition-retry-v2'
                )
              )
            )`,
        [
          workOrderId,
          shopId,
          confirmed ? 'succeeded' : 'failed',
          stringifyJsonb(observation),
          reconciledEffectType,
          selected.rows[0].current_ordinary_instance_id,
          observation?.effectId || null,
          observation?.idempotencyKey || null,
        ]);
      } else if (confirmed) {
        await client.query(`
          UPDATE external_effects SET status = 'succeeded', error = NULL,
            receipt = coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb)
              || jsonb_build_object(
              'readOnlyReconciliation', $3::jsonb
            ), updated_at = now()
          WHERE work_order_id = $1 AND shop_id = $2 AND status = 'unknown'
            AND ordinary_instance_id IS NOT DISTINCT FROM $4::uuid
            AND ($5::uuid IS NULL OR id = $5::uuid)`,
        [workOrderId, shopId, stringifyJsonb(observation),
          selected.rows[0].current_ordinary_instance_id, observation?.effectId || null]);
      }
      if (reconciledEffectType === 'pdd-submit' && (confirmed || notApplied)) {
        await client.query(`
          UPDATE external_effects SET status = $3,
            receipt = CASE WHEN $3 = 'succeeded'
              THEN coalesce(nullif(receipt, 'null'::jsonb), '{}'::jsonb)
                || jsonb_build_object(
                'parentPddSubmitReconciliation', $4::jsonb
              )
              ELSE NULL END,
            error = CASE WHEN $3 = 'failed'
              THEN jsonb_build_object('parentPddSubmitReconciliation', $4::jsonb)
              ELSE NULL END,
            updated_at = now()
          WHERE work_order_id = $1 AND shop_id = $2
            AND ordinary_instance_id IS NOT DISTINCT FROM $5::uuid
            AND status = 'unknown' AND effect_type = 'evidence-upload'`, [
          workOrderId,
          shopId,
          confirmed ? 'succeeded' : 'failed',
          stringifyJsonb(observation),
          selected.rows[0].current_ordinary_instance_id,
        ]);
      }
      const result = continuationReconciliation
        ? await client.query(`
          UPDATE work_orders SET
            status = CASE WHEN $3::boolean OR $4::boolean THEN 'retry-ready' ELSE 'paused' END,
            runtime_status = CASE WHEN $3::boolean OR $4::boolean THEN 'retry-ready' ELSE 'paused' END,
            current_step = CASE
              WHEN $3::boolean THEN $6
              WHEN $4::boolean THEN $7
              ELSE 'external-state-unresolved' END,
            payload = $5::jsonb || CASE
              WHEN payload ? 'latestDiscovery'
                THEN jsonb_build_object('latestDiscovery', payload->'latestDiscovery')
              ELSE '{}'::jsonb
            END,
            manual_review_reason = CASE WHEN $3::boolean OR $4::boolean THEN NULL ELSE manual_review_reason END,
            next_attempt_at = CASE WHEN $3::boolean OR $4::boolean THEN now() ELSE NULL END,
            recovery_state = CASE WHEN $3::boolean OR $4::boolean THEN 'ready' ELSE 'held' END,
            recovery_reason = CASE WHEN $3::boolean OR $4::boolean THEN NULL ELSE 'external-state-still-uncertain' END,
            recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
          WHERE id = $1 AND shop_id = $2
          RETURNING *`, [
          workOrderId,
          shopId,
          confirmed,
          notApplied,
          stringifyJsonb(reconciledPayload),
          confirmedStep,
          notAppliedStep,
        ])
        : await client.query(`
        UPDATE work_orders SET
          status = CASE WHEN $3::boolean THEN 'archived' ELSE 'paused' END,
          runtime_status = CASE WHEN $3::boolean THEN 'archived' ELSE 'paused' END,
          current_step = CASE WHEN $3::boolean THEN 'external-state-confirmed' ELSE 'external-state-unresolved' END,
          payload = $4::jsonb || CASE
            WHEN payload ? 'latestDiscovery'
              THEN jsonb_build_object('latestDiscovery', payload->'latestDiscovery')
            ELSE '{}'::jsonb
          END,
          completion_state = CASE WHEN $3::boolean THEN 'confirmed' ELSE completion_state END,
          completion_confirmation_method = CASE WHEN $3::boolean THEN $5 ELSE completion_confirmation_method END,
          completion_confirmed_at = CASE WHEN $3::boolean THEN $6::timestamptz ELSE completion_confirmed_at END,
          manual_review_reason = CASE
            WHEN $3::boolean THEN NULL
            WHEN $7::boolean THEN '拼多多提交结果未确认且已达到本工单自动提交上限，禁止重复提交，转人工核对'
            ELSE manual_review_reason END,
          recovery_state = CASE WHEN $3::boolean THEN 'ready' ELSE 'held' END,
          recovery_reason = CASE WHEN $3::boolean THEN NULL ELSE 'external-state-still-uncertain' END,
          recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
        WHERE id = $1 AND shop_id = $2
        RETURNING *`, [workOrderId, shopId, confirmed, stringifyJsonb(reconciledPayload),
          observation?.confirmationMethod || null, observation?.observedAt || null,
          Boolean(observation?.automaticRetryExhausted)]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      if (confirmed || notApplied) {
        const resolvedInterventions = await client.query(`
          UPDATE manual_interventions intervention SET
            status = 'resolved',
            resolved_at = coalesce(intervention.resolved_at, now()),
            resolved_by = coalesce(intervention.resolved_by,
              'worker-read-only-reconciliation')
          WHERE intervention.work_order_id = $1
            AND intervention.ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
            AND intervention.status IN ('open', 'acknowledged')
          RETURNING intervention.id`, [
          workOrderId,
          selected.rows[0].current_ordinary_instance_id,
        ]);
        if (resolvedInterventions.rowCount) {
          await client.query(`
            UPDATE notification_outbox outbox SET
              status = 'cancelled', updated_at = now(),
              last_error = jsonb_build_object(
                'reason', 'worker-read-only-reconciliation-resolved'
              )
            WHERE outbox.intervention_id = ANY($1::uuid[])
              AND outbox.status IN ('pending', 'sending', 'failed')`, [
            resolvedInterventions.rows.map((row) => row.id),
          ]);
        }
      }
      if (continuationReconciliation && (confirmed || notApplied)) {
        await client.query(`
          UPDATE ordinary_work_order_instances instance SET
            status = 'retry-ready', runtime_status = 'retry-ready',
            current_step = $3, manual_review_reason = NULL,
            next_attempt_at = now(), payload = $4::jsonb, updated_at = now()
          WHERE instance.id = $1::uuid AND instance.work_order_id = $2::uuid`, [
          selected.rows[0].current_ordinary_instance_id,
          workOrderId,
          confirmed ? confirmedStep : notAppliedStep,
          stringifyJsonb(reconciledPayload),
        ]);
      }
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
        VALUES ($1,$2,$3,'worker-read-only-reconciliation','external-state-reconciled',$4::jsonb)`,
      [shopId, workOrderId, selected.rows[0].current_ordinary_instance_id,
        stringifyJsonb(observation || {})]);
      if (!continuationReconciliation && confirmed) {
        await client.query(`
          UPDATE ordinary_work_order_instances SET
            status = 'archived', runtime_status = 'archived',
            current_step = 'external-state-confirmed', payload = $3::jsonb,
            manual_review_reason = NULL, next_attempt_at = NULL,
            completed_at = coalesce(completed_at, now()),
            completion_method = $4, updated_at = now()
          WHERE id = $1::uuid AND work_order_id = $2::uuid`, [
          selected.rows[0].current_ordinary_instance_id,
          workOrderId,
          stringifyJsonb(reconciledPayload),
          observation?.confirmationMethod || 'read-only-reconciliation',
        ]);
        await promoteNextDeferredOrdinaryInstance(client, { workOrderId, shopId });
      }
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async claimPendingCommand({ shopId, workerId, commandTypes = null, activeWorkOrderId = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT id FROM operator_commands
        WHERE shop_id = $1 AND status = 'pending'
          AND ($2::text[] IS NULL OR command_type = ANY($2::text[]))
          AND ($3::uuid IS NULL OR work_order_id = $3::uuid
            OR command_type IN ('pause-shop', 'resume-shop', 'focus-system-login', 'reset-pdd-login'))
        ORDER BY requested_at
        FOR UPDATE SKIP LOCKED LIMIT 1`, [shopId, commandTypes, activeWorkOrderId]);
      if (!selected.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const result = await client.query(`
        UPDATE operator_commands SET status = 'delivered', delivered_at = now(),
          result = jsonb_build_object('deliveredTo', $2::text)
        WHERE id = $1 RETURNING *`, [selected.rows[0].id, workerId]);
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async acknowledgeCommand({ commandId, status = 'acknowledged', result = {} }) {
    if (!['acknowledged', 'failed', 'cancelled'].includes(status)) {
      throw new Error(`Invalid operator-command status: ${status}`);
    }
    const updated = await this.pool.query(`
      UPDATE operator_commands SET status = $2, acknowledged_at = now(), result = $3::jsonb
      WHERE id = $1 AND status = 'delivered' RETURNING *`,
    [commandId, status, stringifyJsonb(result)]);
    return updated.rows[0] || null;
  }

  async setShopOperatorPaused({ shopId, paused, workerId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO shop_runtime_state (shop_id, worker_id, status, metadata)
        VALUES ($1,$2,$3,jsonb_build_object('operatorPaused', $4::boolean))
        ON CONFLICT (shop_id) DO UPDATE SET worker_id = EXCLUDED.worker_id,
          status = EXCLUDED.status,
          lease_token = CASE WHEN $4::boolean THEN NULL ELSE shop_runtime_state.lease_token END,
          lease_expires_at = CASE WHEN $4::boolean THEN NULL ELSE shop_runtime_state.lease_expires_at END,
          current_work_order_id = CASE WHEN $4::boolean THEN NULL ELSE shop_runtime_state.current_work_order_id END,
          metadata = coalesce(shop_runtime_state.metadata, '{}'::jsonb)
            || jsonb_build_object('operatorPaused', $4::boolean),
          updated_at = now()`,
      [shopId, workerId, paused ? 'operator-paused' : 'idle', paused]);
      if (paused) {
        await client.query(`
          UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
            recovery_state = 'held', recovery_reason = coalesce(recovery_reason, 'operator-recovery-freeze'),
            recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
          WHERE shop_id = $1 AND coalesce(runtime_status, status) NOT IN ('archived', 'completed', 'failed', 'paused')`,
        [shopId]);
      } else {
        await client.query(`
          UPDATE work_orders SET
            status = CASE WHEN current_step LIKE 'external-state-%' THEN 'paused' ELSE 'retry-ready' END,
            runtime_status = CASE WHEN current_step LIKE 'external-state-%' THEN 'paused' ELSE 'retry-ready' END,
            current_step = CASE WHEN current_step LIKE 'external-state-%'
              THEN 'external-state-reconciliation-retry'
              ELSE coalesce(current_step, 'operator-resume-requested') END,
            next_attempt_at = CASE WHEN current_step LIKE 'external-state-%' THEN NULL ELSE now() END,
            recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
          WHERE shop_id = $1 AND recovery_state = 'held'
            AND recovery_reason = 'operator-recovery-freeze'`,
        [shopId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async isShopOperatorPaused(shopId) {
    const result = await this.pool.query(`
      SELECT status = 'operator-paused' OR coalesce((metadata->>'operatorPaused')::boolean, false) AS paused
      FROM shop_runtime_state WHERE shop_id = $1`, [shopId]);
    return Boolean(result.rows[0]?.paused);
  }

  async transitionWorkOrderByCommand({
    workOrderId,
    shopId,
    ordinaryInstanceId = null,
    status,
    currentStep,
    reason = null,
  }) {
    const result = await this.pool.query(`
      UPDATE work_orders SET status = $3, runtime_status = $3, current_step = $4,
        manual_review_reason = $5, next_attempt_at = CASE WHEN $3 = 'retry-ready' THEN now() ELSE NULL END,
        recovery_state = CASE WHEN $3 = 'retry-ready' THEN 'ready' ELSE recovery_state END,
        recovery_reason = CASE WHEN $3 = 'retry-ready' THEN NULL ELSE recovery_reason END,
        recovery_version = CASE WHEN $3 = 'retry-ready' THEN recovery_version + 1 ELSE recovery_version END,
        recovery_updated_at = CASE WHEN $3 = 'retry-ready' THEN now() ELSE recovery_updated_at END,
        completion_state = CASE WHEN $3 IN ('archived', 'completed') THEN 'reconciliation-required' ELSE 'pending' END,
        completion_confirmation_method = NULL, completion_confirmed_at = NULL,
        updated_at = now()
      WHERE id = $1 AND shop_id = $2 AND status NOT IN ('processing', 'archived', 'completed')
        AND current_ordinary_instance_id IS NOT DISTINCT FROM $6::uuid
      RETURNING *`, [workOrderId, shopId, status, currentStep, reason, ordinaryInstanceId]);
    return result.rows[0] || null;
  }
}
