import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { canonicalScenarioCode } from '../../../packages/domain/src/scenario-code.mjs';
import {
  resolveClearedVerificationInterventions,
  stringifyJsonb,
} from '../../../packages/adapters/src/postgres/index.mjs';
import { mergeAuthHealthMaps } from '../../../packages/adapters/src/browser-auth-state.mjs';
import { calculateTargetSlots, schedulerConfigFromEnv } from '../../worker/src/scheduler-policy.mjs';
import { ShopSchedulerRepository } from '../../worker/src/scheduler-repository.mjs';
import {
  canonicalDetectedPddShopName,
  normalizeDetectedPddShopName,
} from '../../worker/src/pdd-shop-identity.mjs';
import { analyzeIncompleteWorkflow } from './incomplete-workflow-analysis.mjs';
import { buildDailySummaryDraftText } from './dingtalk-daily-summary.mjs';
import {
  workerEventOrdinaryIdentity,
  workerEventTmsScenario,
} from './worker-event-identity.mjs';

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

const normalizeWorkOrderType = (value) => String(value || '')
  .replace(/^\s*订单问题\s*[:：]?\s*/u, '')
  .replace(/[\s，,。.!！?？:：;；【】\[\]()（）]/gu, '')
  .toLowerCase();

const operationalReasonCodes = new Set(['waiting-logistics', 'rate-limited']);
const uploadFailureReasonCodes = new Set([
  'image-upload-failed',
  'pdd-upload-authorization-failed',
]);
const durableNotifierInterventionReasonCodes = new Set(uploadFailureReasonCodes);
const transientInterventionReasonCodes = new Set([
  ...operationalReasonCodes,
  'verification-required',
  'login-required',
  'return-refund-verification-required',
  'waiting-consumer-response',
  'page-render-deferred',
  'page-crashed',
]);
const authenticationAssistanceReasonCodes = new Set(['verification-required', 'login-required']);
const nonActionableManualInterventionReasonCodes = Object.freeze([
  'verification-required',
  'login-required',
  'return-refund-verification-required',
  'waiting-logistics',
  'waiting-consumer-response',
  'page-render-deferred',
  'rate-limited',
]);
const activeVerificationStatuses = new Set(['detected', 'waiting-human', 'verification-required']);
const liveHeartbeatBlockingSteps = new Set([
  'browser-proxy-unavailable',
  'human-verification-required',
  'manual-login-required',
  'verification-required',
]);
const automaticDingTalkReasonCodes = new Set(['warehouse-out-of-scope', 'unknown-scenario']);
const transientBrowserClosedErrorPattern = /(?:target page, context or browser has been closed|target (?:page|context|browser)[^\r\n]{0,80}(?:has been )?closed|browser has been closed)/iu;
const dateOnlyFilterPattern = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 24 * 60 * 60_000;
const metricsSummaryFilterKeys = [
  'shopId',
  'from',
  'to',
  'dailySummaryDate',
  'scenarioCode',
  'discoveredFrom',
  'discoveredTo',
];
const metricsSummaryCacheKey = (query = {}) => JSON.stringify(
  metricsSummaryFilterKeys.map((key) => String(query?.[key] || '').trim()),
);

export const parseBeijingDateFilterBoundary = (value, { endExclusive = false } = {}) => {
  const text = String(value || '').trim();
  if (!text) return null;
  if (dateOnlyFilterPattern.test(text)) {
    const start = Date.parse(`${text}T00:00:00+08:00`);
    return Number.isFinite(start) ? start + (endExclusive ? DAY_MS : 0) : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
};

export const workflowLogPayloadRequested = (query = {}) => (
  ['true', '1'].includes(String(query?.includePayload || '').trim().toLowerCase())
);

export const workflowLogTotalRequested = (query = {}) => (
  ['true', '1'].includes(String(query?.includeTotal || '').trim().toLowerCase())
);

export const isTransientBrowserClosedError = (reason) => (
  transientBrowserClosedErrorPattern.test(String(reason || '').normalize('NFKC'))
);

export const resolveRecoveredReturnRefundBrowserCloseInterventions = async (client, {
  workOrderId = null,
  resolvedAt = new Date().toISOString(),
} = {}) => {
  if (!client?.query) return { eligibleWorkOrderIds: [], resolvedIds: [] };
  const parsedResolvedAt = Date.parse(String(resolvedAt || ''));
  const resolutionTimestamp = Number.isFinite(parsedResolvedAt)
    ? new Date(parsedResolvedAt).toISOString()
    : new Date().toISOString();
  const result = await client.query(`
    WITH eligible AS MATERIALIZED (
      SELECT work_order.id AS work_order_id
      FROM work_orders work_order
      WHERE ($1::uuid IS NULL OR work_order.id = $1::uuid)
        AND work_order.scenario_code = 'return-refund'
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND coalesce(work_order.handling_classification, 'automated') = 'automated'
        AND coalesce(work_order.classification_source, 'system') <> 'admin-override'
        AND work_order.manual_review_reason IS NULL
        AND nullif(work_order.payload#>>'{manualReview,reason}', '') IS NULL
        AND work_order.status IN ('queued', 'retry-ready', 'waiting', 'completed', 'archived')
        AND work_order.runtime_status IN ('queued', 'retry-ready', 'waiting', 'completed', 'archived')
        AND work_order.current_step IN (
          'return-refund-waiting-logistics',
          'return-refund-auto-complete',
          'return-refund-read-only-complete',
          'return-refund-skipped-not-found'
        )
        AND EXISTS (
          SELECT 1 FROM return_refunds refund
          WHERE refund.work_order_id = work_order.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM return_refunds refund
          WHERE refund.work_order_id = work_order.id
            AND refund.action_state NOT IN (
              'waiting-logistics', 'auto-refunded', 'manual-completed', 'skipped-not-found'
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM external_effects effect
          WHERE effect.work_order_id = work_order.id
            AND effect.status IN ('reserved', 'unknown')
        )
    ), resolved AS (
      UPDATE manual_interventions intervention SET
        status = 'resolved',
        resolved_at = coalesce(intervention.resolved_at, $2::timestamptz),
        resolved_by = coalesce(
          intervention.resolved_by,
          'return-refund-browser-close-auto-recovery'
        )
      FROM eligible
      WHERE intervention.work_order_id = eligible.work_order_id
        AND intervention.ordinary_instance_id IS NOT DISTINCT FROM (
          SELECT current_ordinary_instance_id
          FROM work_orders
          WHERE id = eligible.work_order_id
        )
        AND intervention.status IN ('open', 'acknowledged')
        AND intervention.reason_code = 'external-system-error'
        AND intervention.reason ~* (
          'target page, context or browser has been closed|'
          || 'target (page|context|browser)[^\r\n]{0,80}(has been )?closed|'
          || 'browser has been closed'
        )
        AND intervention.created_at <= $2::timestamptz
      RETURNING intervention.id AS intervention_id, intervention.work_order_id
    ), cancelled AS (
      UPDATE notification_outbox outbox SET
        status = 'cancelled',
        updated_at = now(),
        last_error = jsonb_build_object(
          'reason', 'return-refund-browser-close-auto-recovered'
        )
      FROM resolved
      WHERE outbox.intervention_id = resolved.intervention_id
        AND outbox.status IN ('pending', 'sending', 'failed')
      RETURNING outbox.id
    )
    SELECT eligible.work_order_id,
      coalesce(
        array_agg(resolved.intervention_id)
          FILTER (WHERE resolved.intervention_id IS NOT NULL),
        '{}'::uuid[]
      ) AS resolved_ids,
      (SELECT count(*)::int FROM cancelled) AS cancelled_count
    FROM eligible
    LEFT JOIN resolved ON resolved.work_order_id = eligible.work_order_id
    GROUP BY eligible.work_order_id`, [workOrderId, resolutionTimestamp]);
  return {
    eligibleWorkOrderIds: result.rows.map((row) => row.work_order_id),
    resolvedIds: result.rows.flatMap((row) => row.resolved_ids || []),
  };
};

export const workOrderShopIdentityFromPayload = (payload = {}, fallback = {}) => {
  const nameCandidates = [
    ['pdd-work-order-identity', payload?.pddShopIdentity?.actualShopName],
    ['pdd-latest-discovery', payload?.latestDiscovery?.actualShopName
      || payload?.latestDiscovery?.pddActualShopName],
    ['pdd-shop-snapshot', payload?.shopNameSnapshot],
    ['shop-config-fallback', fallback?.shopName || fallback?.name],
  ];
  const selectedName = nameCandidates
    .map(([source, value]) => [source, String(value || '').normalize('NFKC').trim()])
    .find(([, value]) => value);
  const shopMallId = String(
    payload?.pddShopIdentity?.mallId
      || payload?.latestDiscovery?.mallId
      || payload?.latestDiscovery?.pddMallId
      || payload?.pddMallId
      || fallback?.shopMallId
      || fallback?.mallId
      || '',
  ).trim() || null;
  return {
    shopName: selectedName?.[1] || null,
    shopMallId,
    shopIdentitySource: selectedName?.[0] || 'unavailable',
  };
};

const addPostgresDateFilters = ({ where, params, column, query }) => {
  for (const [key, endExclusive] of [['from', false], ['to', true]]) {
    const value = String(query?.[key] || '').trim();
    if (!value) continue;
    params.push(value);
    const parameter = `$${params.length}`;
    if (dateOnlyFilterPattern.test(value)) {
      where.push(endExclusive
        ? `${column} < ((${parameter}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Shanghai')`
        : `${column} >= (${parameter}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    } else {
      where.push(`${column} ${endExclusive ? '<' : '>='} ${parameter}::timestamptz`);
    }
  }
};

export const hasAutomaticDingTalkEvidence = ({ reasonCode, scenarioCode, stage, snapshot = {} } = {}) => {
  if (reasonCode === 'warehouse-out-of-scope') {
    return snapshot.omsWarehouseParse?.status === 'out-of-scope'
      && Boolean(String(snapshot.omsWarehouseParse?.parsedValue || '').trim());
  }
  if (reasonCode === 'unknown-scenario') {
    const evidenceStage = [stage, snapshot.step, snapshot.manualReview?.stage]
      .filter(Boolean).join(' ');
    const evidenceReason = String(snapshot.manualReview?.reason || '');
    return !canonicalScenarioCode(scenarioCode)
      && (/unknown-scenario|unsupported-scenario/.test(evidenceStage)
        || /未识别.*(?:场景|工单)/u.test(evidenceReason));
  }
  return false;
};

export const isAuthenticationAssistance = ({ reasonCode, reason, stage } = {}) => {
  if (authenticationAssistanceReasonCodes.has(String(reasonCode || '').trim())) return true;
  return /verification-required|human-verification-required|manual-login-required|login-required|验证码|滑块|登录状态(?:不可用|已失效)|需要重新登录/iu
    .test([reason, stage].filter(Boolean).join(' '));
};

export const isActiveVerificationLocation = ({
  location,
  checkpointStep,
  checkpointVerificationId,
} = {}) => {
  if (!location
    || !activeVerificationStatuses.has(String(location.status || 'waiting-human'))
    || location.resolvedAt) return false;
  if (!location.id
    || String(checkpointVerificationId || '') !== String(location.id)) return false;
  if (checkpointStep === 'human-verification-required') return true;
  return checkpointStep === 'manual-login-required'
    && String(location.stage || '') === 'pdd-manual-login';
};

export const hasBusinessHumanReview = (progress = {}) => {
  const review = progress.manualReview || {};
  if (String(progress.step || '').includes('manual-review')) return true;
  if (!review.reason) return false;
  return !isAuthenticationAssistance({
    reasonCode: review.reasonCode,
    reason: review.reason,
    stage: review.stage || progress.step,
  });
};

const latestIsoTimestamp = (...values) => {
  let latestValue = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(String(value || ''));
    if (!Number.isFinite(parsed) || parsed <= latestTime) continue;
    latestValue = value;
    latestTime = parsed;
  }
  return latestValue;
};

export const mergeLiveHeartbeatShopRuntime = (row = {}) => {
  if (row.workerOnline !== true) return row;
  const metadata = row.workerMetadata && typeof row.workerMetadata === 'object'
    ? row.workerMetadata
    : {};
  const workflowStep = String(metadata.workflowStep || '').trim();
  const heartbeatState = String(metadata.state || '').trim();
  const blockingStep = heartbeatState === 'browser-proxy-unavailable'
    ? heartbeatState
    : [workflowStep, heartbeatState].find((value) => liveHeartbeatBlockingSteps.has(value));
  if (!blockingStep) return row;
  const heartbeatOrder = String(metadata.currentOrderNumber || '').trim() || null;
  return {
    ...row,
    step: blockingStep,
    currentOrderNumber: heartbeatOrder || row.currentOrderNumber || null,
    runtimeStatus: blockingStep === 'browser-proxy-unavailable' ? 'paused' : 'verification',
    updatedAt: latestIsoTimestamp(
      row.updatedAt,
      metadata.progressUpdatedAt,
      metadata.runtimeObservedAt,
      row.heartbeatAt,
    ) || row.updatedAt || null,
  };
};

export const derivePublicShopOnboardingStatus = (row = {}) => {
  const persistedStatus = String(row.onboardingStatus || '').trim() || 'waiting-login';
  const onboardingError = String(row.onboardingError || '').trim();
  if (persistedStatus === 'identity-mismatch'
    || /重复登录|店铺.*不一致|identity.{0,20}mismatch/iu.test(onboardingError)) {
    return 'identity-mismatch';
  }
  const metadata = row.workerMetadata && typeof row.workerMetadata === 'object'
    ? row.workerMetadata
    : {};
  const proxyHealth = metadata.browserProxyHealth;
  if (metadata.state === 'browser-proxy-unavailable' || proxyHealth?.ok === false) {
    return persistedStatus;
  }
  const liveStep = [row.step, metadata.workflowStep, metadata.state]
    .map((value) => String(value || '').trim())
    .find((value) => value === 'manual-login-required');
  if (row.authHealth?.pdd?.status === 'expired' || liveStep) return 'waiting-login';
  return persistedStatus;
};

const safeHashEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const canonicalScenarioSql = (expression) => `CASE
  WHEN ${expression} = 'in-transit-no-reason-refund' THEN 'in-transit-refund'
  ELSE ${expression}
END`;

const visibleWorkOrderSqlFor = (alias = 'w') => `NOT (
  coalesce(${alias}.payload->'duplicateReconciliation'->>'status', '') = 'superseded'
  OR coalesce(${alias}.frontend_visibility, 'operational') = 'recovery-audit'
  OR coalesce(${alias}.payload->>'frontendVisibility', '') = 'recovery-audit'
  OR ${alias}.current_step IN ('external-state-confirmed', 'external-state-unresolved')
  OR (
    ${alias}.idempotency_key LIKE 'worker-event:%'
    AND EXISTS (
      SELECT 1 FROM work_orders authoritative
      WHERE authoritative.shop_id = ${alias}.shop_id
        AND authoritative.external_order_number = ${alias}.external_order_number
        AND authoritative.id <> ${alias}.id
        AND authoritative.idempotency_key LIKE 'pdd-discovered:%'
    )
  )
)`;
const visibleWorkOrderSql = visibleWorkOrderSqlFor('w');

const currentOrdinaryRelatedSql = (relatedAlias, workOrderAlias = 'w') => `(
  ${workOrderAlias}.current_ordinary_instance_id IS NULL
  OR ${relatedAlias}.ordinary_instance_id = ${workOrderAlias}.current_ordinary_instance_id
  OR (
    ${relatedAlias}.ordinary_instance_id IS NULL
    AND (
      SELECT count(*) FROM ordinary_work_order_instances legacy_instance
      WHERE legacy_instance.work_order_id = ${workOrderAlias}.id
    ) <= 1
  )
)`;

const returnRefundRepresentativeSql = (scenarioExpression) => `(
  ${scenarioExpression} IS DISTINCT FROM 'return-refund'
  OR w.id = (
    SELECT sibling.id
    FROM work_orders sibling
    JOIN return_refunds sibling_refund ON sibling_refund.work_order_id = sibling.id
    WHERE sibling.shop_id = w.shop_id
      AND sibling.external_order_number = w.external_order_number
      AND sibling.scenario_code = 'return-refund'
      AND ${visibleWorkOrderSqlFor('sibling')}
    ORDER BY sibling.updated_at DESC, sibling.id DESC
    LIMIT 1
  )
)`;

const workOrderFirstDiscoveredAtSql = (scenarioExpression) => `CASE
  WHEN ${scenarioExpression} = 'return-refund' THEN refund.first_discovered_at
  ELSE coalesce((
    SELECT min(discovered_instance.first_discovered_at)
    FROM ordinary_work_order_instances discovered_instance
    WHERE discovered_instance.work_order_id = w.id
  ), w.created_at)
END`;

const overviewMetricPredicates = {
  total: 'included_row_count > 0',
  autoSuccess: 'auto_success',
  strictAutoSuccess: 'strict_auto_success',
  humanConfirmed: 'auto_success AND NOT strict_auto_success',
  manualReview: 'manual_review',
  processing: "unit_runtime_status = 'processing'",
  waiting: "unit_runtime_status = 'waiting'",
  paused: "unit_runtime_status IN ('paused', 'manual-review')",
  failed: "unit_runtime_status = 'failed'",
  verification: "unit_runtime_status = 'verification'",
  notSuccessful: 'included_row_count > 0 AND NOT auto_success',
  notStrictSuccessful: 'included_row_count > 0 AND NOT strict_auto_success',
  refundAutoSuccess: 'refund_auto_success',
  refundManualCompleted: 'refund_manual_completed',
  returnRefundWaiting: 'excluded_waiting_only',
  returnRefundSkipped: 'excluded_skipped_only',
};

const workOrderMetricsCte = ({ scenarioExpression, condition }) => {
  const historicalBusinessInterventionSql = `EXISTS (
    SELECT 1 FROM manual_interventions mi
    WHERE mi.work_order_id = w.id
      AND ${currentOrdinaryRelatedSql('mi')}
      AND mi.reason_code NOT IN (
        'verification-required',
        'login-required',
        'return-refund-verification-required'
      )
  )`;
  const actionableBusinessInterventionSql = `EXISTS (
    SELECT 1 FROM manual_interventions actionable_intervention
    WHERE actionable_intervention.work_order_id = w.id
      AND ${currentOrdinaryRelatedSql('actionable_intervention')}
      AND actionable_intervention.status IN ('open', 'acknowledged')
      AND actionable_intervention.reason_code NOT IN (${nonActionableManualInterventionReasonCodes
    .map((reasonCode) => `'${reasonCode}'`).join(', ')})
  )`;
  const authenticationAssistanceSql = `EXISTS (
    SELECT 1 FROM manual_interventions authentication_intervention
    WHERE authentication_intervention.work_order_id = w.id
      AND ${currentOrdinaryRelatedSql('authentication_intervention')}
      AND authentication_intervention.reason_code IN (
        'verification-required',
        'login-required',
        'return-refund-verification-required'
      )
  )`;
  const deliveredAutomaticDingTalkHandoffSql = `EXISTS (
    SELECT 1
    FROM manual_interventions dingtalk_intervention
    JOIN notification_outbox dingtalk_outbox
      ON dingtalk_outbox.intervention_id = dingtalk_intervention.id
    WHERE dingtalk_intervention.work_order_id = w.id
      AND ${currentOrdinaryRelatedSql('dingtalk_intervention')}
      AND dingtalk_intervention.channel = 'dingtalk'
      AND dingtalk_intervention.reason_code NOT IN (
        'verification-required',
        'login-required',
        'return-refund-verification-required'
      )
      AND dingtalk_outbox.channel = 'dingtalk'
      AND dingtalk_outbox.status = 'sent'
      AND coalesce(dingtalk_outbox.payload->>'deliverySource', 'automatic') <> 'owner-manual'
  )`;
  const readOnlyRefundAutoSuccessSql = `(refund.action_state = 'manual-completed'
    AND refund.completion_method = 'return-refund-read-only-page-completed'
    AND coalesce(w.handling_classification, 'automated') = 'automated'
    AND coalesce(w.classification_source, 'system') = 'system')`;
  const refundAutoSuccessSql = `(refund.action_state = 'auto-refunded'
    OR ${readOnlyRefundAutoSuccessSql})`;
  const refundManualCompletedSql = `(refund.action_state = 'manual-completed'
    AND NOT ${readOnlyRefundAutoSuccessSql})`;
  const requiredSystemsSql = `coalesce(
    w.payload->'ordinaryScenarioDecision'->'requiredSystems',
    w.payload->'pddResolutionDecision'->'requiredSystems',
    '[]'::jsonb
  )`;
  const omsRequiredSql = `(coalesce((scenario_definition.config->>'requiresOms')::boolean, false)
    OR ${requiredSystemsSql} ? 'OMS')`;
  const tmsRequiredSql = `(coalesce((scenario_definition.config->>'requiresTms')::boolean, false)
    OR ${requiredSystemsSql} ? 'TMS')`;
  const omsAllocationSucceededSql = `(coalesce(w.payload->'omsManualAllocation'->>'status', '')
      IN ('succeeded', 'already-allocated')
    AND nullif(w.payload->'omsManualAllocation'->>'orderNumber', '') = w.external_order_number)`;
  const omsSucceededSql = `(${omsAllocationSucceededSql} OR EXISTS (
    SELECT 1 FROM oms_analyses viewer_oms
    WHERE viewer_oms.work_order_id = w.id
      AND viewer_oms.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
      AND viewer_oms.payload->>'warehouseStatus' = 'confirmed'
  ))`;
  const tmsSucceededSql = `EXISTS (
    SELECT 1 FROM tms_work_orders viewer_tms
    WHERE viewer_tms.work_order_id = w.id
      AND viewer_tms.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
      AND viewer_tms.status = 'created'
      AND nullif(viewer_tms.external_ticket_id, '') IS NOT NULL
  )`;
  const legacyOmsTmsSuccessSql = `EXISTS (
    SELECT 1
    FROM oms_analyses legacy_oms
    JOIN tms_work_orders legacy_tms
      ON legacy_tms.work_order_id = legacy_oms.work_order_id
      AND legacy_tms.ordinary_instance_id IS NOT DISTINCT FROM legacy_oms.ordinary_instance_id
      AND legacy_tms.created_at >= legacy_oms.created_at
    WHERE legacy_oms.work_order_id = w.id
      AND legacy_oms.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
      AND legacy_tms.ordinary_instance_id IS NOT DISTINCT FROM w.current_ordinary_instance_id
      AND legacy_oms.payload->>'warehouseStatus' = 'confirmed'
      AND legacy_tms.status = 'created'
      AND nullif(legacy_tms.external_ticket_id, '') IS NOT NULL
  )`;
  const prerequisiteAutoSuccessSql = `(${scenarioExpression} IS DISTINCT FROM 'return-refund'
    AND (${legacyOmsTmsSuccessSql}
      OR ((${omsRequiredSql} OR ${tmsRequiredSql})
        AND (NOT ${omsRequiredSql} OR ${omsSucceededSql})
        AND (NOT ${tmsRequiredSql} OR ${tmsSucceededSql}))))`;
  const manualReviewSql = `(coalesce(w.completion_state, 'pending')
      NOT IN ('confirmed', 'not-applicable')
    AND (coalesce(w.handling_classification, 'automated') = 'manual'
      OR ${actionableBusinessInterventionSql}
      OR EXISTS (SELECT 1 FROM data_corrections dc
        WHERE dc.work_order_id = w.id AND dc.rolled_back_at IS NULL
          AND ${currentOrdinaryRelatedSql('dc')})))`;
  const autoSuccessSql = `((w.completion_state = 'confirmed'
    OR ${prerequisiteAutoSuccessSql})
    AND NOT ${deliveredAutomaticDingTalkHandoffSql})`;
  const strictAutoSuccessSql = `(w.completion_state = 'confirmed'
    AND w.completion_confirmation_method = ANY(ARRAY[
      'detail-completed',
      'absent-from-pending-list',
      'recovery-delayed-detail-check',
      'handover-detail-completed',
      'handover-absent-from-pending-list',
      'return-refund-button-disappeared',
      'return-refund-read-only-page-completed'
    ])
    AND coalesce(w.handling_classification, 'automated') = 'automated'
    AND coalesce(w.classification_source, 'system') = 'system'
    AND coalesce(
      (w.payload->'pddResolutionSubmission'->>'recoveredFromCompletedPage')::boolean,
      (w.payload->'lastCompletedOrder'->>'recoveredFromCompletedPage')::boolean,
      (w.payload->'completionArchive'->>'recoveredFromCompletedPage')::boolean,
      false
    ) = false
    AND NOT ${historicalBusinessInterventionSql}
    AND NOT ${authenticationAssistanceSql}
    AND coalesce(w.completion_confirmation_method, '') NOT LIKE 'owner-%'
    AND NOT EXISTS (SELECT 1 FROM data_corrections dc
      WHERE dc.work_order_id = w.id AND dc.rolled_back_at IS NULL
        AND ${currentOrdinaryRelatedSql('dc')})
    AND NOT EXISTS (SELECT 1 FROM operator_commands oc
      WHERE oc.work_order_id = w.id AND oc.status <> 'cancelled'
        AND ${currentOrdinaryRelatedSql('oc')}))`;
  return `WITH metric_rows AS (
    SELECT w.id, w.shop_id, w.external_order_number, w.updated_at,
      ${scenarioExpression} AS scenario_code,
      (${scenarioExpression} = 'return-refund'
        AND refund.action_state = 'waiting-logistics') AS excluded_waiting,
      (${scenarioExpression} = 'return-refund'
        AND refund.action_state = 'skipped-not-found') AS excluded_skipped,
      (${scenarioExpression} = 'return-refund'
        AND refund.action_state IN ('waiting-logistics', 'skipped-not-found'))
        AS excluded_non_actionable,
      ${autoSuccessSql} AS auto_success,
      (${scenarioExpression} = 'return-refund'
        AND ${refundAutoSuccessSql}) AS refund_auto_success,
      (${scenarioExpression} = 'return-refund'
        AND ${refundManualCompletedSql}) AS refund_manual_completed,
      (${strictAutoSuccessSql}) AS strict_auto_success,
      (${manualReviewSql}) AS manual_review,
      CASE
        WHEN ${scenarioExpression} = 'return-refund' AND refund.action_state = 'page-error' THEN 'failed'
        WHEN ${scenarioExpression} = 'return-refund' AND refund.action_state = 'verification-required' THEN 'verification'
        ELSE coalesce(w.runtime_status, w.status)
      END AS runtime_status,
      (w.completion_state = 'reconciliation-required') AS reconciliation_required,
      (w.classification_source = 'admin-override') AS admin_override
    FROM work_orders w
    LEFT JOIN scenario_definitions scenario_definition
      ON scenario_definition.code = ${scenarioExpression}
    LEFT JOIN return_refunds refund ON refund.work_order_id = w.id
    ${condition}
  ), metric_groups AS (
    SELECT scenario_code,
      CASE WHEN scenario_code = 'return-refund'
        THEN shop_id || ':' || external_order_number ELSE id::text END AS unit_key,
      (array_agg(id ORDER BY excluded_non_actionable ASC NULLS LAST, updated_at DESC, id DESC))[1]
        AS representative_id,
      count(*) FILTER (WHERE NOT excluded_non_actionable) AS included_row_count,
      bool_and(excluded_waiting) AS excluded_waiting_only,
      bool_and(excluded_skipped) AS excluded_skipped_only,
      coalesce(bool_and(auto_success) FILTER (WHERE NOT excluded_non_actionable), false) AS auto_success,
      coalesce(bool_and(refund_auto_success) FILTER (WHERE NOT excluded_non_actionable), false) AS refund_auto_success,
      coalesce(bool_or(refund_manual_completed) FILTER (WHERE NOT excluded_non_actionable), false) AS refund_manual_completed,
      coalesce(bool_and(strict_auto_success) FILTER (WHERE NOT excluded_non_actionable), false) AS strict_auto_success,
      coalesce(bool_or(manual_review) FILTER (WHERE NOT excluded_non_actionable), false) AS manual_review,
      coalesce(bool_or(reconciliation_required) FILTER (WHERE NOT excluded_non_actionable), false) AS reconciliation_required,
      coalesce(bool_or(admin_override) FILTER (WHERE NOT excluded_non_actionable), false) AS admin_override,
      CASE
        WHEN count(*) FILTER (WHERE NOT excluded_non_actionable) = 0
          THEN CASE WHEN bool_and(excluded_skipped) THEN 'excluded-skipped' ELSE 'excluded-waiting' END
        WHEN bool_and(auto_success) FILTER (WHERE NOT excluded_non_actionable) THEN 'completed'
        WHEN bool_or(manual_review) FILTER (WHERE NOT excluded_non_actionable) THEN 'manual-review'
        WHEN bool_or(runtime_status = 'failed') FILTER (WHERE NOT excluded_non_actionable) THEN 'failed'
        WHEN bool_or(runtime_status = 'verification') FILTER (WHERE NOT excluded_non_actionable) THEN 'verification'
        WHEN bool_or(runtime_status = 'processing') FILTER (WHERE NOT excluded_non_actionable) THEN 'processing'
        WHEN bool_or(runtime_status IN ('paused', 'manual-review')) FILTER (WHERE NOT excluded_non_actionable) THEN 'paused'
        WHEN bool_or(runtime_status = 'waiting') FILTER (WHERE NOT excluded_non_actionable) THEN 'waiting'
        ELSE 'queued'
      END AS unit_runtime_status
    FROM metric_rows
    GROUP BY scenario_code,
      CASE WHEN scenario_code = 'return-refund'
        THEN shop_id || ':' || external_order_number ELSE id::text END
  )`;
};

const defaultShopScenarioCodes = [
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
const defaultWorkOrderTitle = '订单问题：在途无理由退款处理';
const configuredMaxEnabledShops = Number(process.env.WORKER_SUPERVISOR_MAX_SHOPS || 0);
const maxEnabledShops = Number.isFinite(configuredMaxEnabledShops) && configuredMaxEnabledShops > 0
  ? Math.floor(configuredMaxEnabledShops)
  : null;

export function normalizeShopSchedulerTelemetry(row, schedulerMode) {
  if (String(schedulerMode || 'legacy').toLowerCase() !== 'legacy') return row;
  const enabled = row.enabled !== false;
  const workerOnline = row.workerOnline === true;
  const preservedReason = ['verification-waiting', 'login-required'].includes(row.overdueReason)
    ? row.overdueReason
    : null;
  return {
    ...row,
    scheduleState: !enabled ? 'disabled' : workerOnline ? 'resident' : 'offline',
    nextOrdinaryScanAt: null,
    nextRefundScanAt: null,
    queueEnteredAt: null,
    capacityBlockedReason: !enabled || workerOnline
      ? null
      : row.capacityBlockedReason || 'worker-offline',
    overdueReason: !enabled
      ? null
      : preservedReason || (workerOnline ? null : 'worker-offline'),
    queuePosition: null,
  };
}

export function runtimeCapacityTelemetry({ schedulerMode, snapshot, activeWorkers }) {
  if (String(schedulerMode || 'legacy').toLowerCase() !== 'legacy') return snapshot;
  const unavailableWorkers = Math.max(0,
    Number(snapshot.enabledShops || 0) - Number(activeWorkers || 0));
  return {
    ...snapshot,
    dueShops: unavailableWorkers,
    overdueShops: unavailableWorkers,
  };
}
const completionConfirmationMethods = new Set([
  'detail-completed',
  'absent-from-pending-list',
  'recovery-delayed-detail-check',
  'handover-detail-completed',
  'handover-absent-from-pending-list',
  'return-refund-button-disappeared',
  'return-refund-manual-completed',
  'return-refund-read-only-page-completed',
]);
const warehouseAliases = ['简卓', '众邦', '铭如', '瞳琪', '捷佑', '亿哈', '筑越'];

const cleanWarehouseValue = (value) => {
  const warehouse = String(value || '').replace(/\s+/g, ' ').trim();
  if (!warehouse || warehouse.length > 160 || /登录|用户名|密码|验证码|Loading/i.test(warehouse)) return null;
  if (/^(?:发货仓库|仓库|发货信息|物流信息|发货时间)$/u.test(warehouse)) return null;
  return warehouse;
};

const warehouseIdentity = (value) => {
  const warehouse = cleanWarehouseValue(value);
  if (!warehouse) return null;
  const matched = warehouseAliases.filter((alias) => warehouse.includes(alias));
  if (matched.length === 1) return matched[0];
  return warehouse.normalize('NFKC').replace(/[\s\-_:：/\\]+/g, '').replace(/仓库?$/u, '').toLowerCase();
};

export const completionInfoFromPayload = (payload = {}, fallback = {}) => {
  const submission = payload?.pddResolutionSubmission || {};
  const archive = payload?.completionArchive || {};
  const completedOrder = payload?.lastCompletedOrder || {};
  const confirmationMethod = submission.confirmationMethod || archive.confirmationMethod
    || completedOrder.confirmationMethod || fallback.confirmationMethod || null;
  const confirmed = (submission.status === 'succeeded'
    || Boolean(archive.orderNumber)
    || Boolean(completedOrder.orderNumber))
    && completionConfirmationMethods.has(confirmationMethod);
  const fallbackState = fallback.state || fallback.completionState || null;
  const state = confirmed ? 'confirmed'
    : fallbackState || (['completed', 'archived'].includes(fallback.runtimeStatus) ? 'reconciliation-required' : 'pending');
  return {
    state,
    confirmationMethod,
    confirmedAt: confirmed
      ? submission.completedAt || archive.completedAt || completedOrder.completedAt
        || fallback.confirmedAt || null
      : fallback.confirmedAt || null,
    involvedHumanReview: Boolean(fallback.involvedHumanReview),
  };
};

export const warehouseInfoFromFacts = ({ payload = {}, logistics = null, oms = null, updatedAt = null } = {}) => {
  const logisticsFact = logistics || payload?.logisticsAnalysis || {};
  const omsFact = oms || payload?.omsAnalysis || {};
  const parse = payload?.omsWarehouseParse || {};
  const tmsVerification = payload?.tmsAutofillVerification || {};
  const hasShippingLogistics = Boolean(
    logisticsFact.trackingNumber
    || logisticsFact.carrier
    || logisticsFact.stageAnalysis
    || logisticsFact.timelineRecords?.length
    || logisticsFact.traceRecords?.length
  );
  const omsValue = cleanWarehouseValue(
    omsFact.shippingWarehouse || omsFact.warehouse || omsFact.warehouseName,
  );
  const tmsValue = cleanWarehouseValue(tmsVerification?.actual?.warehouse);
  let status = 'pending';
  if (!hasShippingLogistics) status = 'not-applicable';
  else if (parse.status === 'ambiguous' || omsFact.warehouseStatus === 'ambiguous') status = 'ambiguous';
  else if (omsValue) status = 'confirmed';
  else if (['read-failed', 'invalid-or-missing'].includes(parse.status)
    || omsFact.warehouseStatus === 'read-failed'
    || Object.keys(omsFact).length > 0) status = 'read-failed';

  let comparison = 'not-checked';
  if (omsValue && tmsValue) {
    comparison = warehouseIdentity(omsValue) === warehouseIdentity(tmsValue) ? 'matched' : 'conflict';
    if (comparison === 'conflict') status = 'conflict';
  }
  return {
    status,
    omsValue,
    omsObservedAt: parse.checkedAt || omsFact.observedAt || updatedAt,
    omsSource: omsFact.warehouseSource || parse.source || (omsValue ? 'oms-order-detail' : null),
    failureReason: status === 'read-failed' ? parse.reason || 'OMS 已有物流信息，但仓库读取失败'
      : status === 'ambiguous' ? 'OMS 返回多个仓库，无法唯一确认'
        : status === 'conflict' ? 'OMS 与 TMS 仓库不一致' : null,
    tmsValue,
    tmsObservedAt: tmsVerification.verifiedAt || null,
    comparison,
    manualValue: cleanWarehouseValue(payload?.manualOverrides?.warehouse),
  };
};

const assertKnownShops = async (client, shopIds) => {
  const uniqueShopIds = [...new Set((shopIds || []).map(String).map((value) => value.trim()).filter(Boolean))];
  if (!uniqueShopIds.length) return;
  const result = await client.query('SELECT id FROM shops WHERE id = ANY($1::text[])', [uniqueShopIds]);
  const known = new Set(result.rows.map((row) => row.id));
  const unknownShopIds = uniqueShopIds.filter((shopId) => !known.has(shopId));
  if (!unknownShopIds.length) return;
  const error = new Error(`unknown-shop: ${unknownShopIds.join(',')}`);
  error.code = 'UNKNOWN_SHOP';
  error.shopIds = unknownShopIds;
  throw error;
};

export const remoteDesktopPathForSlot = (displaySlot) => {
  const parsedSlot = Number(displaySlot || 0);
  const slot = Number.isInteger(parsedSlot) && parsedSlot >= 0 ? parsedSlot : 0;
  const websocketPath = encodeURIComponent(`remote-desktop/websockify?token=shop-${slot}`);
  return `/remote-desktop/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=1000&resize=scale&path=${websocketPath}`;
};

const normalizeShopId = (value) => String(value || '').trim().toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .replace(/-{2,}/g, '-')
  .slice(0, 63);

class LegacyJsonBackend {
  constructor({ root, dataRoot }) {
    this.root = root;
    this.dataRoot = dataRoot;
  }

  async health() {
    return { ok: true, backend: 'legacy-json', readOnlyBusinessData: false };
  }

  async getSystemSettings() {
    const settings = readJson(path.join(this.root, 'config', 'system-settings.json')) || {};
    return {
      verificationAlertsEnabled: settings.verificationAlertsEnabled !== false,
      dingtalkAutomaticEnabled: settings.dingtalkAutomaticEnabled === true,
      dingtalkDailySummaryAutomaticEnabled: settings.dingtalkDailySummaryAutomaticEnabled === true,
      dingtalkDailySummaryAutomaticStartDate:
        settings.dingtalkDailySummaryAutomaticStartDate || null,
      returnRefundScanEnabled: settings.returnRefundScanEnabled !== false,
      returnRefundAutoApproveEnabled: settings.returnRefundAutoApproveEnabled === true,
      returnRefundDingtalkEnabled: settings.returnRefundDingtalkEnabled === true,
    };
  }

  async updateSystemSettings({
    verificationAlertsEnabled,
    returnRefundScanEnabled,
    returnRefundAutoApproveEnabled,
  }) {
    const updates = {
      ...(typeof verificationAlertsEnabled === 'boolean' ? { verificationAlertsEnabled } : {}),
      ...(typeof returnRefundScanEnabled === 'boolean' ? { returnRefundScanEnabled } : {}),
      ...(typeof returnRefundAutoApproveEnabled === 'boolean' ? { returnRefundAutoApproveEnabled } : {}),
    };
    if (!Object.keys(updates).length) throw new Error('system-setting-invalid');
    const file = path.join(this.root, 'config', 'system-settings.json');
    const current = readJson(file) || {};
    const settings = { ...current, ...updates, updatedAt: new Date().toISOString() };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return this.getSystemSettings();
  }

  async updateDingTalkSettings({ dingtalkAutomaticEnabled }) {
    if (typeof dingtalkAutomaticEnabled !== 'boolean') throw new Error('dingtalk-setting-invalid');
    const file = path.join(this.root, 'config', 'system-settings.json');
    const current = readJson(file) || {};
    const settings = { ...current, dingtalkAutomaticEnabled, updatedAt: new Date().toISOString() };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return this.getSystemSettings();
  }

  async updateDingTalkDailySummarySettings({ automaticEnabled, startDate }) {
    if (typeof automaticEnabled !== 'boolean'
      || (automaticEnabled && !/^\d{4}-\d{2}-\d{2}$/u.test(String(startDate || '')))) {
      throw new Error('dingtalk-daily-summary-setting-invalid');
    }
    const file = path.join(this.root, 'config', 'system-settings.json');
    const current = readJson(file) || {};
    const settings = {
      ...current,
      dingtalkDailySummaryAutomaticEnabled: automaticEnabled,
      ...(automaticEnabled ? { dingtalkDailySummaryAutomaticStartDate: startDate } : {}),
      updatedAt: new Date().toISOString(),
    };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return this.getSystemSettings();
  }

  async listShops() {
    const config = readJson(path.join(this.root, 'shops.config.json')) || { shops: [] };
    return config.shops.map((shop) => {
      const progress = readJson(path.join(this.dataRoot, 'shops', shop.shopId, 'state', 'workflow-progress.json')) || {};
      return {
        shopId: shop.shopId,
        name: shop.expectedShopName,
        enabled: shop.enabled,
        step: progress.step || 'not-started',
        currentOrderNumber: progress.orderNumber || progress.loopState?.currentOrderNumber || null,
        updatedAt: progress.updatedAt || null,
        authHealth: progress.authHealth || {},
      };
    });
  }

  async progressRows() {
    const shops = await this.listShops();
    return shops.map((shop) => ({
      shop,
      progress: readJson(path.join(this.dataRoot, 'shops', shop.shopId, 'state', 'workflow-progress.json')) || {},
    }));
  }

  async listScenarios() {
    return readJson(path.join(this.root, 'config', 'scenarios.json'))?.scenarios || [];
  }

  async metricsSummary() {
    const rows = await this.progressRows();
    const byScenarioMap = new Map();
    const summary = {
      total: rows.length, autoSuccess: 0, strictAutoSuccess: 0, humanConfirmed: 0,
      manualReview: 0, failed: 0, processing: 0, waiting: 0, verification: 0, paused: 0,
      reconciliationRequired: 0, averageDurationSeconds: null, byScenario: [],
    };
    for (const { progress } of rows) {
      const scenarioCode = progress.workOrderType || 'unknown';
      const scenario = byScenarioMap.get(scenarioCode) || {
        scenarioCode, total: 0, autoSuccess: 0, strictAutoSuccess: 0,
        humanConfirmed: 0, manualReview: 0, failed: 0, paused: 0,
      };
      scenario.total += 1;
      const completion = completionInfoFromPayload(progress, { runtimeStatus: progress.runtimeStatus || progress.status });
      const involvedHumanReview = hasBusinessHumanReview(progress);
      if (completion.state === 'confirmed') {
        summary.autoSuccess += 1;
        scenario.autoSuccess += 1;
        if (involvedHumanReview) {
          summary.humanConfirmed += 1;
          scenario.humanConfirmed += 1;
        } else {
          summary.strictAutoSuccess += 1;
          scenario.strictAutoSuccess += 1;
        }
      }
      if (involvedHumanReview || String(progress.step || '').includes('manual-review')) {
        summary.manualReview += 1;
        scenario.manualReview += 1;
      } else if (progress.step === 'flow-paused') {
        summary.failed += 1;
        scenario.failed += 1;
      } else summary.processing += 1;
      byScenarioMap.set(scenarioCode, scenario);
    }
    summary.byScenario = [...byScenarioMap.values()];
    return summary;
  }

  async listWorkOrders(query = {}, { includeIncompleteAnalysis = false } = {}) {
    const fromTime = parseBeijingDateFilterBoundary(query.from);
    const toTime = parseBeijingDateFilterBoundary(query.to, { endExclusive: true });
    const rows = (await this.progressRows())
      .filter(({ shop }) => !query.shopId || shop.shopId === query.shopId)
      .filter(({ progress }) => !query.status || progress.step === query.status)
      .filter(({ progress }) => !Number.isFinite(fromTime) || !progress.updatedAt || Date.parse(progress.updatedAt) >= fromTime)
      .filter(({ progress }) => !Number.isFinite(toTime) || !progress.updatedAt || Date.parse(progress.updatedAt) < toTime)
      .map(({ shop, progress }) => {
        const row = {
          id: `${shop.shopId}:${progress.orderNumber || 'none'}`,
          shopId: shop.shopId,
          ...workOrderShopIdentityFromPayload(progress, {
            shopName: shop.name || shop.expectedShopName || shop.shopId,
          }),
          orderNumber: progress.orderNumber || progress.lastCompletedOrder?.orderNumber || null,
          scenarioCode: progress.workOrderType || null,
          status: progress.step || 'not-started',
          runtimeStatus: progress.runtimeStatus || progress.status || progress.step || 'not-started',
          currentStep: progress.step || 'not-started',
          carrier: progress.logisticsAnalysis?.carrier || null,
          trackingNumber: progress.logisticsAnalysis?.trackingNumber || null,
          warehouse: progress.omsAnalysis?.shippingWarehouse || null,
          warehouseInfo: warehouseInfoFromFacts({ payload: progress, updatedAt: progress.updatedAt }),
          scenarioInfo: {
            code: progress.scenarioCode || null,
            status: progress.scenarioCode ? 'confirmed' : 'pending',
            source: 'workflow-analysis',
            observedAt: progress.updatedAt || null,
          },
          completionInfo: completionInfoFromPayload(progress, {
            runtimeStatus: progress.runtimeStatus || progress.status || progress.step,
          }),
          dataFreshness: {
            latestEventAt: progress.updatedAt || null,
            lastSyncedAt: progress.updatedAt || null,
            syncLagSeconds: 0,
            stale: false,
          },
          ordinaryInstanceCount: progress.platformCaseKey ? 1 : 0,
          currentOrdinaryInstanceId: progress.ordinaryInstanceId || null,
          currentPlatformCaseId: String(progress.platformCaseKey || '').replace(/^pdd-work-order:/u, '') || null,
          currentPlatformCaseKey: progress.platformCaseKey || null,
          currentInstanceIdentityStatus: progress.platformCaseKey ? 'verified' : 'legacy-unverified',
          currentInstanceStatus: progress.status || progress.runtimeStatus || progress.step || null,
          manualReviewReason: progress.manualReview?.reason || null,
          updatedAt: progress.updatedAt || null,
        };
        return includeIncompleteAnalysis
          ? { ...row, incompleteAnalysis: analyzeIncompleteWorkflow({ ...progress, ...row, payload: progress }) }
          : row;
      });
    return { data: rows, page: Number(query.page || 1), pageSize: Number(query.pageSize || 20), total: rows.length };
  }

  async getWorkOrder(id) {
    const separator = id.indexOf(':');
    if (separator < 1) return null;
    const shopId = id.slice(0, separator);
    const progress = readJson(path.join(this.dataRoot, 'shops', shopId, 'state', 'workflow-progress.json'));
    if (!progress) return null;
    const warehouseInfo = warehouseInfoFromFacts({ payload: progress, updatedAt: progress.updatedAt });
    return {
      id, shopId, ...progress,
      warehouse: warehouseInfo.omsValue,
      warehouseInfo,
      completionInfo: completionInfoFromPayload(progress, { runtimeStatus: progress.runtimeStatus || progress.status || progress.step }),
      dataFreshness: {
        latestEventAt: progress.updatedAt || null,
        lastSyncedAt: progress.updatedAt || null,
        syncLagSeconds: 0,
        stale: false,
      },
      logistics: progress.logisticsAnalysis || null,
      oms: progress.omsAnalysis || null,
      ordinaryInstances: progress.platformCaseKey ? [{
        id: progress.ordinaryInstanceId || null,
        platformCaseId: String(progress.platformCaseKey).replace(/^pdd-work-order:/u, ''),
        platformCaseKey: progress.platformCaseKey,
        workOrderType: progress.workOrderType || null,
        scenarioCode: progress.scenarioCode || null,
        identityStatus: 'verified',
        status: progress.status || progress.step || null,
        runtimeStatus: progress.runtimeStatus || progress.status || null,
        currentStep: progress.step || null,
        payload: progress,
        isCurrent: true,
        events: [],
        evidence: [],
        interventions: [],
      }] : [],
    };
  }

  async listVerifications({ activeOnly = false } = {}) {
    const rows = [];
    for (const { shop, progress } of await this.progressRows()) {
      const location = progress.verificationLocation;
      const locationIsActive = isActiveVerificationLocation({
        location,
        checkpointStep: progress.step,
        checkpointVerificationId: progress.verificationLocation?.id,
      });
      if (location && (!activeOnly || locationIsActive)) rows.push({
        ...location,
        active: locationIsActive,
        screenshotUrl: location.screenshotFileId
          ? `/api/v1/verifications/${encodeURIComponent(location.id)}/screenshot`
          : null,
      });
      else if ((!activeOnly || progress.step === 'human-verification-required') && progress.authHealth) {
        for (const [system, health] of Object.entries(progress.authHealth)) {
          if (health?.status === 'verification-required') rows.push({ shopId: shop.shopId, system, stage: health.stage, status: health.status, url: health.url });
        }
      }
    }
    return rows;
  }

  async getVerificationScreenshot(id) {
    for (const { shop, progress } of await this.progressRows()) {
      const location = progress.verificationLocation;
      if (location?.id !== id || !location.screenshotFileId) continue;
      const relative = String(location.screenshotFileId).replaceAll('\\', '/');
      const file = path.resolve(this.dataRoot, 'shops', shop.shopId, relative);
      const shopRoot = path.resolve(this.dataRoot, 'shops', shop.shopId);
      if (!file.startsWith(`${shopRoot}${path.sep}`) || !fs.existsSync(file)) return null;
      return { contentType: 'image/png', body: await fsp.readFile(file) };
    }
    return null;
  }

  async resolveVerification(id) {
    for (const { shop } of await this.progressRows()) {
      const file = path.join(this.dataRoot, 'shops', shop.shopId, 'state', 'workflow-progress.json');
      const progress = readJson(file);
      if (progress?.verificationLocation?.id !== id) continue;
      const location = { ...progress.verificationLocation, status: 'resolved', resolvedAt: new Date().toISOString() };
      const next = { ...progress, verificationLocation: location, step: 'human-verification-resume' };
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
      return location;
    }
    return null;
  }

  async listLogs() { return { data: [], total: 0, nextCursor: null }; }
  async listAuditEvents() { return { data: [], total: 0 }; }
  async recordAuditEvent() { return null; }
  async listManualInterventions() { return { data: [], total: 0 }; }
  async ingestWorkerEvents() { throw new Error('Worker event ingestion requires DATA_BACKEND=postgres'); }
  async updateClassification() { throw new Error('Classification updates require DATA_BACKEND=postgres'); }
  async bulkUpdateClassification() { throw new Error('Classification updates require DATA_BACKEND=postgres'); }
  async deleteWorkOrders() { throw new Error('Work-order deletion requires DATA_BACKEND=postgres'); }
  async rollbackClassification() { throw new Error('Classification updates require DATA_BACKEND=postgres'); }
  async createOperatorCommand() { throw new Error('Operator commands require DATA_BACKEND=postgres'); }
  async reviewExternalState() { throw new Error('External-state review requires DATA_BACKEND=postgres'); }
  async createCorrection() { throw new Error('Data corrections require DATA_BACKEND=postgres'); }
  async requestVerificationRecheck() { throw new Error('Verification commands require DATA_BACKEND=postgres'); }
  async requestVerificationForceClear() { throw new Error('Verification commands require DATA_BACKEND=postgres'); }
  async requestVerificationRefreshNext() { throw new Error('Verification commands require DATA_BACKEND=postgres'); }
  async ingestWorkerAsset() { throw new Error('Worker asset ingestion requires DATA_BACKEND=postgres'); }
  async getEvidenceAsset() { return null; }
  async deleteEvidenceAsset() { throw new Error('Evidence screenshot deletion requires DATA_BACKEND=postgres'); }
  async purgeExpiredEvidenceScreenshots() { return { deleted: 0 }; }
  async deleteVerificationScreenshot() { throw new Error('Verification screenshot deletion requires DATA_BACKEND=postgres'); }
  async deleteVerificationScreenshots() { throw new Error('Verification screenshot deletion requires DATA_BACKEND=postgres'); }
  async purgeExpiredVerificationScreenshots() { return { deleted: 0 }; }
  async updateInterventionStatus() { throw new Error('Intervention updates require DATA_BACKEND=postgres'); }
  async createDingTalkNotification() { throw new Error('DingTalk notifications require DATA_BACKEND=postgres'); }
  async getDingTalkDailySummary() { return null; }
  async updateDingTalkDailySummary() { throw new Error('DingTalk daily summaries require DATA_BACKEND=postgres'); }
  async claimDingTalkDailySummary() { throw new Error('DingTalk daily summaries require DATA_BACKEND=postgres'); }
  async finishDingTalkDailySummary() { throw new Error('DingTalk daily summaries require DATA_BACKEND=postgres'); }
  async recordSyncHeartbeat() { throw new Error('Sync heartbeat requires DATA_BACKEND=postgres'); }
  async createShop() { throw new Error('Shop management requires DATA_BACKEND=postgres'); }
  async updateShop() { throw new Error('Shop management requires DATA_BACKEND=postgres'); }
  async deleteShop() { throw new Error('Shop management requires DATA_BACKEND=postgres'); }
  async requestShopLogin() { throw new Error('Shop management requires DATA_BACKEND=postgres'); }
  async requestShopSystemLogin() { throw new Error('Shop management requires DATA_BACKEND=postgres'); }
  async synchronizeShopLoginObservation() { return null; }
  async requestShopSession() { throw new Error('Shop scheduling requires DATA_BACKEND=postgres'); }
  async runtimeCapacity() {
    return {
      schedulerMode: 'legacy', enabledShops: (await this.listShops()).filter((shop) => shop.enabled).length,
      hotShops: 0, coldShops: 0, dueShops: 0, overdueShops: 0,
      slots: { active: 0, target: 0, hardLimit: 0 },
    };
  }

  async close() {}
}

class PostgresBackend {
  static async create(options) {
    let pg;
    try { pg = await import('pg'); } catch (error) {
      throw new Error('DATA_BACKEND=postgres requires the pg package', { cause: error });
    }
    const { Pool } = pg.default || pg;
    const instance = new PostgresBackend(options, new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Math.max(1, Number(process.env.API_DB_POOL_MAX || 10)),
      application_name: 'pdd-api',
    }));
    await instance.pool.query('SELECT 1');
    return instance;
  }

  constructor(options, pool) {
    this.options = options;
    this.pool = pool;
    this._s3 = null;
    const configuredMetricsCacheTtlMs = Number(process.env.API_METRICS_CACHE_TTL_MS ?? 30_000);
    this._metricsSummaryCacheTtlMs = Number.isFinite(configuredMetricsCacheTtlMs)
      ? Math.max(0, configuredMetricsCacheTtlMs)
      : 30_000;
    this._metricsSummaryCache = new Map();
    this._metricsSummaryInflight = new Map();
  }

  async s3() {
    if (this._s3) return this._s3;
    let aws;
    try { aws = await import('@aws-sdk/client-s3'); } catch (error) {
      throw new Error('Object storage requires @aws-sdk/client-s3', { cause: error });
    }
    const readSecret = async (name) => process.env[`${name}_FILE`]
      ? (await fsp.readFile(process.env[`${name}_FILE`], 'utf8')).trim()
      : process.env[name] || '';
    const client = new aws.S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
      credentials: { accessKeyId: await readSecret('S3_ACCESS_KEY'), secretAccessKey: await readSecret('S3_SECRET_KEY') },
    });
    this._s3 = { client, aws };
    return this._s3;
  }

  async health() {
    await this.pool.query('SELECT 1');
    return { ok: true, backend: 'postgres', readOnlyBusinessData: false };
  }

  async getSystemSettings() {
    const result = await this.pool.query(`
      SELECT key, value FROM system_settings
      WHERE key IN (
        'verification-alerts-enabled',
        'dingtalk-automatic-enabled',
        'dingtalk-daily-summary-automatic-enabled',
        'dingtalk-daily-summary-automatic-start-date',
        'return-refund-scan-enabled',
        'return-refund-auto-approve-enabled',
        'return-refund-dingtalk-enabled'
      )`);
    const settings = new Map(result.rows.map((row) => [row.key, row.value]));
    return {
      verificationAlertsEnabled: settings.has('verification-alerts-enabled')
        ? settings.get('verification-alerts-enabled') === true : true,
      dingtalkAutomaticEnabled: settings.get('dingtalk-automatic-enabled') === true,
      dingtalkDailySummaryAutomaticEnabled:
        settings.get('dingtalk-daily-summary-automatic-enabled') === true,
      dingtalkDailySummaryAutomaticStartDate:
        String(settings.get('dingtalk-daily-summary-automatic-start-date') || '').trim() || null,
      returnRefundScanEnabled: settings.has('return-refund-scan-enabled')
        ? settings.get('return-refund-scan-enabled') === true : true,
      returnRefundAutoApproveEnabled: settings.get('return-refund-auto-approve-enabled') === true,
      returnRefundDingtalkEnabled: settings.get('return-refund-dingtalk-enabled') === true,
    };
  }

  async updateSystemSettings({
    verificationAlertsEnabled,
    returnRefundScanEnabled,
    returnRefundAutoApproveEnabled,
  }, { actorId }) {
    const updates = [
      ['verification-alerts-enabled', verificationAlertsEnabled],
      ['return-refund-scan-enabled', returnRefundScanEnabled],
      ['return-refund-auto-approve-enabled', returnRefundAutoApproveEnabled],
    ].filter(([, value]) => typeof value === 'boolean');
    if (!updates.length) throw new Error('system-setting-invalid');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of updates) {
        await client.query(`
          INSERT INTO system_settings (key, value, updated_at, updated_by)
          VALUES ($1, $2::jsonb, now(), $3)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(value), actorId]);
      }
      await client.query(`
        INSERT INTO audit_events (actor_id, event_type, payload)
        VALUES ($1, $2, $3::jsonb)`,
      [
        actorId,
        updates.length === 1 && updates[0][0] === 'verification-alerts-enabled'
          ? 'verification-alert-settings-updated'
          : 'return-refund-settings-updated',
        JSON.stringify(Object.fromEntries(updates)),
      ]);
      await client.query('COMMIT');
      return { ...await this.getSystemSettings(), updatedAt: new Date().toISOString(), updatedBy: actorId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateDingTalkSettings({ dingtalkAutomaticEnabled }, { actorId }) {
    if (typeof dingtalkAutomaticEnabled !== 'boolean') throw new Error('dingtalk-setting-invalid');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO system_settings (key, value, updated_at, updated_by)
        VALUES ('dingtalk-automatic-enabled', $1::jsonb, now(), $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(dingtalkAutomaticEnabled), actorId]);
      await client.query(`
        INSERT INTO audit_events (actor_id, event_type, payload)
        VALUES ($1, 'dingtalk-settings-updated', $2::jsonb)`,
      [actorId, JSON.stringify({ dingtalkAutomaticEnabled })]);
      await client.query('COMMIT');
      return { ...await this.getSystemSettings(), updatedAt: new Date().toISOString(), updatedBy: actorId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateDingTalkDailySummarySettings({ automaticEnabled, startDate }, { actorId }) {
    if (typeof automaticEnabled !== 'boolean'
      || (automaticEnabled && !/^\d{4}-\d{2}-\d{2}$/u.test(String(startDate || '')))) {
      throw new Error('dingtalk-daily-summary-setting-invalid');
    }
    const updates = [
      ['dingtalk-daily-summary-automatic-enabled', automaticEnabled],
      ...(automaticEnabled
        ? [['dingtalk-daily-summary-automatic-start-date', String(startDate)]]
        : []),
    ];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of updates) {
        await client.query(`
          INSERT INTO system_settings (key, value, updated_at, updated_by)
          VALUES ($1, $2::jsonb, now(), $3)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(value), actorId]);
      }
      await client.query(`
        INSERT INTO audit_events (actor_id, event_type, payload)
        VALUES ($1, 'dingtalk-daily-summary-settings-updated', $2::jsonb)`,
      [actorId, JSON.stringify({ automaticEnabled, startDate: automaticEnabled ? startDate : null })]);
      await client.query('COMMIT');
      return { ...await this.getSystemSettings(), updatedAt: new Date().toISOString(), updatedBy: actorId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listShops() {
    const result = await this.pool.query(`
      SELECT s.id AS "shopId", s.name, s.enabled,
        s.expected_shop_name AS "expectedShopName",
        s.work_order_title AS "workOrderTitle",
        s.scenario_codes AS "scenarioCodes",
        s.onboarding_status AS "onboardingStatus",
        s.onboarding_error AS "onboardingError",
        s.login_requested_at AS "loginRequestedAt",
        s.onboarding_completed_at AS "onboardingCompletedAt",
        s.config_version AS "configVersion",
        s.display_slot AS "displaySlot",
        identity.expected_shop_name AS "confirmedShopName",
        identity.mall_id AS "confirmedMallId",
        identity.status AS "identityBindingStatus",
        pdd_binding.actual_shop_name AS "boundShopName",
        pdd_binding.mall_id AS "boundMallId",
        coalesce(
          nullif(heartbeat.metadata->>'mallId', ''),
          pdd_binding.mall_id,
          identity.mall_id,
          nullif(cp.snapshot->'pddShopIdentity'->>'mallId', '')
        ) AS "mallId",
        schedule.heat_state AS "heatState",
        schedule.schedule_state AS "scheduleState",
        schedule.next_ordinary_scan_at AS "nextOrdinaryScanAt",
        schedule.next_refund_scan_at AS "nextRefundScanAt",
        schedule.queue_entered_at AS "queueEnteredAt",
        schedule.assignment_kind AS "assignmentKind",
        slot.kind AS "slotKind",
        slot.slot_index AS "slotIndex",
        slot.browser_started_at AS "browserStartedAt",
        slot.lease_expires_at AS "slotExpiresAt",
        coalesce(schedule.ordinary_overdue_reason, schedule.refund_overdue_reason) AS "capacityBlockedReason",
        CASE WHEN s.enabled AND schedule.assigned_slot_id IS NULL
          AND (schedule.next_ordinary_scan_at <= now() OR schedule.next_refund_scan_at <= now())
          THEN coalesce(
            schedule.ordinary_overdue_reason,
            schedule.refund_overdue_reason,
            CASE WHEN EXISTS (
              SELECT 1 FROM verification_locations verification
              WHERE verification.shop_id = s.id
                AND verification.status IN ('detected','waiting-human','verification-required')
            ) THEN 'verification-waiting'
            WHEN s.onboarding_status IN ('waiting-login','identity-mismatch') THEN 'login-required'
            WHEN runtime.current_work_order_id IS NOT NULL AND runtime.status <> 'idle' THEN 'business-processing'
            ELSE 'scheduler-not-running' END
          ) ELSE NULL END AS "overdueReason",
        CASE WHEN s.enabled AND schedule.assigned_slot_id IS NULL
          AND schedule.schedule_state <> 'disabled' THEN 1 + (
            SELECT count(*)::int FROM shop_schedule_state queued
            JOIN shops queued_shop ON queued_shop.id = queued.shop_id
            WHERE queued_shop.enabled = true AND queued.assigned_slot_id IS NULL
              AND queued.schedule_state <> 'disabled'
              AND (
                queued.queue_entered_at < schedule.queue_entered_at
                OR (queued.queue_entered_at = schedule.queue_entered_at AND queued.shop_id < schedule.shop_id)
              )
          ) ELSE NULL END AS "queuePosition",
        count(*) FILTER (WHERE s.enabled) OVER ()::int AS "enabledShopCount",
        s.created_at AS "createdAt", s.updated_at AS "configUpdatedAt",
        CASE WHEN runtime.shop_id IS NOT NULL THEN
          CASE
            WHEN runtime.current_work_order_id IS NOT NULL AND runtime.status <> 'idle'
              THEN coalesce(
                CASE WHEN heartbeat.metadata->>'currentOrderNumber' = current_order.external_order_number
                  AND nullif(heartbeat.metadata->>'progressUpdatedAt', '')::timestamptz
                    >= current_order.updated_at
                  THEN nullif(heartbeat.metadata->>'workflowStep', '')
                END,
                current_order.current_step,
                'processing'
              )
            WHEN runtime.status = 'operator-paused' THEN 'operator-paused'
            ELSE 'queue-empty'
          END
          ELSE coalesce(latest.current_step, cp.current_step, 'not-started')
        END AS step,
        CASE WHEN runtime.shop_id IS NOT NULL THEN
          CASE WHEN runtime.status <> 'idle' THEN current_order.external_order_number ELSE NULL END
          ELSE coalesce(latest.external_order_number, cp.external_order_number)
        END AS "currentOrderNumber",
        CASE WHEN current_order.external_order_number = heartbeat.metadata->>'currentOrderNumber'
          THEN greatest(
            current_order.updated_at,
            nullif(heartbeat.metadata->>'progressUpdatedAt', '')::timestamptz
          )
          ELSE coalesce(current_order.updated_at, runtime.updated_at, latest.updated_at, cp.source_updated_at, s.updated_at)
        END AS "updatedAt",
        CASE WHEN runtime.shop_id IS NOT NULL THEN runtime.status
          ELSE coalesce(latest.runtime_status, latest.status, cp.runtime_status, 'queued')
        END AS "runtimeStatus",
        coalesce(
          nullif(heartbeat.metadata->'authHealth', '{}'::jsonb),
          heartbeat_auth.metadata->'authHealth',
          cp.snapshot->'authHealth',
          '{}'::jsonb
        ) AS "authHealth",
        heartbeat.metadata->'authHealth' AS "heartbeatAuthHealth",
        heartbeat_auth.metadata->'authHealth' AS "latestHeartbeatAuthHealth",
        cp.snapshot->'authHealth' AS "checkpointAuthHealth",
        coalesce(
          nullif(heartbeat.metadata->'systemTabs', '{}'::jsonb),
          heartbeat_tabs.metadata->'systemTabs',
          cp.snapshot->'systemTabs',
          '{}'::jsonb
        ) AS "systemTabs",
        heartbeat.worker_id AS "workerId", heartbeat.mode AS "workerMode",
        heartbeat.metadata AS "workerMetadata", heartbeat.heartbeat_at AS "heartbeatAt",
        heartbeat.heartbeat_at > now() - interval '45 seconds' AS "workerOnline",
        extract(epoch FROM (now() - heartbeat.heartbeat_at))::int AS "heartbeatAgeSeconds",
        coalesce(
          nullif(heartbeat.metadata->>'runtimeObservedAt', '')::timestamptz,
          nullif(heartbeat.metadata->>'progressUpdatedAt', '')::timestamptz,
          cp.source_updated_at
        ) AS "runtimeObservedAt",
        extract(epoch FROM (now() - coalesce(
          nullif(heartbeat.metadata->>'runtimeObservedAt', '')::timestamptz,
          nullif(heartbeat.metadata->>'progressUpdatedAt', '')::timestamptz,
          cp.source_updated_at
        )))::int AS "runtimeObservationAgeSeconds",
        cp.synchronized_at AS "checkpointSynchronizedAt", sync.source_id AS "syncSourceId",
        coalesce(sync.last_success_at, heartbeat.heartbeat_at, cp.synchronized_at) AS "lastSyncedAt",
        extract(epoch FROM (now() - coalesce(sync.last_success_at, heartbeat.heartbeat_at, cp.synchronized_at)))::int AS "syncLagSeconds",
        extract(epoch FROM (now() - coalesce(current_order.updated_at, runtime.updated_at, latest.updated_at, cp.source_updated_at, s.updated_at)))::int AS "activityAgeSeconds"
      FROM shops s
      LEFT JOIN shop_schedule_state schedule ON schedule.shop_id = s.id
      LEFT JOIN shop_identity_bindings identity ON identity.shop_id = s.id
      LEFT JOIN pdd_shop_runtime_bindings pdd_binding ON pdd_binding.shop_id = s.id
      LEFT JOIN browser_slots slot ON slot.id = schedule.assigned_slot_id
        AND slot.state <> 'stopped' AND slot.lease_expires_at > now()
      LEFT JOIN workflow_checkpoints cp ON cp.shop_id = s.id
      LEFT JOIN shop_runtime_state runtime ON runtime.shop_id = s.id
      LEFT JOIN work_orders current_order
        ON current_order.id = runtime.current_work_order_id AND current_order.shop_id = s.id
      LEFT JOIN LATERAL (
        SELECT current_step, external_order_number, runtime_status, status, updated_at
        FROM work_orders w WHERE w.shop_id = s.id AND w.status NOT IN ('archived', 'completed')
          AND coalesce(w.frontend_visibility, 'operational') <> 'recovery-audit'
          AND coalesce(w.current_step, '') NOT IN ('external-state-confirmed', 'external-state-unresolved')
        ORDER BY updated_at DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT worker_id, mode, metadata, heartbeat_at
        FROM worker_heartbeats WHERE shop_id = s.id
        ORDER BY heartbeat_at DESC LIMIT 1
      ) heartbeat ON true
      LEFT JOIN LATERAL (
        SELECT metadata FROM worker_heartbeats
        WHERE shop_id = s.id AND metadata->'authHealth' IS NOT NULL
          AND metadata->'authHealth' <> '{}'::jsonb
        ORDER BY heartbeat_at DESC LIMIT 1
      ) heartbeat_auth ON true
      LEFT JOIN LATERAL (
        SELECT metadata FROM worker_heartbeats
        WHERE shop_id = s.id AND metadata->'systemTabs' IS NOT NULL
          AND metadata->'systemTabs' <> '{}'::jsonb
        ORDER BY heartbeat_at DESC LIMIT 1
      ) heartbeat_tabs ON true
      LEFT JOIN LATERAL (
        SELECT source_id, last_success_at FROM sync_cursors
        WHERE shop_id = s.id ORDER BY last_success_at DESC NULLS LAST LIMIT 1
      ) sync ON true
      ORDER BY s.created_at, s.id`);
    return result.rows.map((rawRow) => {
      const {
        heartbeatAuthHealth,
        latestHeartbeatAuthHealth,
        checkpointAuthHealth,
        ...publicRow
      } = rawRow;
      const row = normalizeShopSchedulerTelemetry(mergeLiveHeartbeatShopRuntime({
        ...publicRow,
        authHealth: mergeAuthHealthMaps(
          checkpointAuthHealth,
          latestHeartbeatAuthHealth,
          heartbeatAuthHealth,
        ),
      }), process.env.WORKER_SCHEDULER_MODE);
      const onboardingStatus = derivePublicShopOnboardingStatus(row);
      return {
      ...row,
      onboardingStatus,
      runtimeObservationStale: row.workerOnline !== true
        || row.runtimeObservationAgeSeconds == null
        || Number(row.runtimeObservationAgeSeconds) > 60,
      remoteDesktopPath: remoteDesktopPathForSlot(row.slotIndex ?? row.displaySlot),
      scenarioCodes: row.scenarioCodes?.length ? row.scenarioCodes : defaultShopScenarioCodes,
      workerCapacity: {
        limit: maxEnabledShops,
        enabled: Number(row.enabledShopCount || 0),
        available: maxEnabledShops == null
          ? null
          : Math.max(0, maxEnabledShops - Number(row.enabledShopCount || 0)),
        unlimited: maxEnabledShops == null,
      },
    };
    });
  }

  async createShop(input, { actorId }) {
    const name = String(input?.name || '').trim();
    const expectedShopName = String(input?.expectedShopName || name).trim();
    const requestedId = normalizeShopId(input?.shopId);
    const shopId = requestedId || `shop-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const enabled = input?.enabled !== false;
    if (name.length < 2 || name.length > 120) throw new Error('shop-name-invalid');
    if (expectedShopName.length < 2 || expectedShopName.length > 120) throw new Error('expected-shop-name-invalid');
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(shopId)) throw new Error('shop-id-invalid');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pdd-workflow:shop-display-slot'))");
      if (enabled && maxEnabledShops != null) {
        const enabledCount = Number((await client.query('SELECT count(*)::int AS count FROM shops WHERE enabled')).rows[0].count);
        if (enabledCount >= maxEnabledShops) {
          const capacityError = new Error('shop-capacity-reached');
          capacityError.code = 'SHOP_CAPACITY_REACHED';
          throw capacityError;
        }
      }
      const slotResult = await client.query(`
        WITH occupied AS (
          SELECT display_slot FROM shops
          UNION
          SELECT display_slot FROM shop_deletion_requests
        ), candidates AS (
          SELECT generate_series(0, (SELECT count(*)::int FROM occupied)) AS slot
        )
        SELECT candidate.slot::int AS slot
        FROM candidates candidate
        WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot = candidate.slot)
          AND NOT EXISTS (
            SELECT 1 FROM shop_deletion_requests WHERE display_slot = candidate.slot
          )
        ORDER BY candidate.slot
        LIMIT 1`);
      if (!slotResult.rowCount) throw new Error('shop-capacity-reached');
      const displaySlot = Number(slotResult.rows[0].slot);
      const inserted = await client.query(`
        INSERT INTO shops (
          id, name, enabled, expected_shop_name, work_order_title, scenario_codes,
          onboarding_status, login_requested_at, created_by, display_slot
        ) VALUES ($1,$2,$3,$4,$5,$6::text[],$7,CASE WHEN $3 THEN now() ELSE NULL END,$8,$9)
        RETURNING id`, [
        shopId,
        name,
        enabled,
        expectedShopName,
        defaultWorkOrderTitle,
        defaultShopScenarioCodes,
        enabled ? 'waiting-login' : 'disabled',
        actorId,
        displaySlot,
      ]);
      await client.query(`
        INSERT INTO shop_runtime_state (shop_id, status)
        VALUES ($1, 'idle')
        ON CONFLICT (shop_id) DO NOTHING`, [shopId]);
      await client.query(`
        INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
        VALUES ($1,$2,'shop-created',$3::jsonb)`, [
        shopId,
        actorId,
        JSON.stringify({ name, expectedShopName, enabled, displaySlot, scenarioCodes: defaultShopScenarioCodes }),
      ]);
      await client.query('COMMIT');
      return (await this.listShops()).find((shop) => shop.shopId === inserted.rows[0].id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') {
        const conflict = new Error('shop-already-exists');
        conflict.code = 'SHOP_CONFLICT';
        throw conflict;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateShop(shopId, input, { actorId }) {
    const current = (await this.listShops()).find((shop) => shop.shopId === shopId);
    if (!current) return null;
    const name = input?.name == null ? current.name : String(input.name).trim();
    const expectedShopName = input?.expectedShopName == null
      ? current.expectedShopName
      : String(input.expectedShopName).trim();
    const enabled = input?.enabled == null ? current.enabled : Boolean(input.enabled);
    if (name.length < 2 || name.length > 120) throw new Error('shop-name-invalid');
    if (expectedShopName.length < 2 || expectedShopName.length > 120) throw new Error('expected-shop-name-invalid');
    if (enabled && !current.enabled && maxEnabledShops != null) {
      const enabledCount = Number((await this.pool.query('SELECT count(*)::int AS count FROM shops WHERE enabled')).rows[0].count);
      if (enabledCount >= maxEnabledShops) {
        const capacityError = new Error('shop-capacity-reached');
        capacityError.code = 'SHOP_CAPACITY_REACHED';
        throw capacityError;
      }
    }
    const identityChanged = expectedShopName !== current.expectedShopName;
    try {
      const result = await this.pool.query(`
        UPDATE shops SET name = $2, expected_shop_name = $3, enabled = $4,
          onboarding_status = CASE
            WHEN NOT $4 THEN 'disabled'
            WHEN $5 THEN 'waiting-login'
            WHEN onboarding_status = 'disabled' THEN 'waiting-login'
            ELSE onboarding_status
          END,
          onboarding_error = CASE WHEN $5 THEN NULL ELSE onboarding_error END,
          login_requested_at = CASE WHEN $4 AND ($5 OR onboarding_status = 'disabled') THEN now() ELSE login_requested_at END,
          config_version = config_version + 1,
          updated_at = now()
        WHERE id = $1
        RETURNING id`, [shopId, name, expectedShopName, enabled, identityChanged]);
      if (!result.rowCount) return null;
      if (identityChanged) {
        await this.pool.query(`UPDATE shop_identity_bindings SET status = 'revoked', updated_at = now() WHERE shop_id = $1`, [shopId]);
      }
      await this.pool.query(`
        INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
        VALUES ($1,$2,'shop-updated',$3::jsonb)`, [
        shopId,
        actorId,
        JSON.stringify({ name, expectedShopName, enabled, identityChanged }),
      ]);
      return (await this.listShops()).find((shop) => shop.shopId === shopId);
    } catch (error) {
      if (error.code === '23505') {
        const conflict = new Error('shop-already-exists');
        conflict.code = 'SHOP_CONFLICT';
        throw conflict;
      }
      throw error;
    }
  }

  async deleteShop(shopId, { actorId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const shopResult = await client.query(`
        SELECT id, name, display_slot AS "displaySlot"
        FROM shops WHERE id = $1 FOR UPDATE`, [shopId]);
      if (!shopResult.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const businessData = await client.query(`
        SELECT
          (SELECT count(*) FROM work_orders WHERE shop_id = $1) +
          (SELECT count(*) FROM verification_locations WHERE shop_id = $1) +
          (SELECT count(*) FROM evidence_assets WHERE shop_id = $1) +
          (SELECT count(*) FROM external_effects WHERE shop_id = $1) +
          (SELECT count(*) FROM manual_interventions WHERE shop_id = $1) +
          (SELECT count(*) FROM workflow_events WHERE shop_id = $1) +
          (SELECT count(*) FROM cross_shop_order_conflicts
            WHERE discovered_shop_id = $1 OR resolved_shop_id = $1) AS count`, [shopId]);
      if (Number(businessData.rows[0].count) > 0) {
        const conflict = new Error('shop-has-business-data');
        conflict.code = 'SHOP_HAS_BUSINESS_DATA';
        throw conflict;
      }
      await client.query(`
        INSERT INTO shop_deletion_requests (shop_id, display_slot, requested_by)
        VALUES ($1,$2,$3)
        ON CONFLICT (shop_id) DO UPDATE SET
          display_slot = EXCLUDED.display_slot,
          requested_by = EXCLUDED.requested_by,
          requested_at = now()`, [shopId, shopResult.rows[0].displaySlot, actorId]);
      await client.query('UPDATE shops SET enabled = false, updated_at = now() WHERE id = $1', [shopId]);
      for (const table of [
        'operator_commands',
        'shop_identity_bindings',
        'shop_runtime_state',
        'sync_cursors',
        'worker_heartbeats',
        'workflow_checkpoints',
        'rule_versions',
        'audit_events',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE shop_id = $1`, [shopId]);
      }
      const deleted = await client.query(`
        DELETE FROM shops WHERE id = $1
        RETURNING id AS "shopId", name, display_slot AS "displaySlot"`, [shopId]);
      await client.query('COMMIT');
      return deleted.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async requestShopLogin(shopId, { actorId }) {
    const current = (await this.listShops()).find((shop) => shop.shopId === shopId);
    if (!current) return null;
    if (!current.enabled && maxEnabledShops != null) {
      const enabledCount = Number((await this.pool.query('SELECT count(*)::int AS count FROM shops WHERE enabled')).rows[0].count);
      if (enabledCount >= maxEnabledShops) {
        const capacityError = new Error('shop-capacity-reached');
        capacityError.code = 'SHOP_CAPACITY_REACHED';
        throw capacityError;
      }
    }
    const result = await this.pool.query(`
      UPDATE shops SET enabled = true, onboarding_status = 'waiting-login',
        onboarding_error = NULL, login_requested_at = now(), config_version = config_version + 1,
        onboarding_completed_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING id, login_requested_at AS "loginRequestedAt"`, [shopId]);
    if (!result.rowCount) return null;
    await this.pool.query(`
      UPDATE shop_identity_bindings
      SET status = 'revoked', updated_at = now()
      WHERE shop_id = $1 AND status <> 'revoked'`, [shopId]);
    await this.pool.query(`
      INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
      VALUES ($1,$2,'shop-login-requested',jsonb_build_object('requestedAt', $3::timestamptz))`,
    [shopId, actorId, result.rows[0].loginRequestedAt]);
    await this.requestShopSession(shopId, 'login');
    return (await this.listShops()).find((shop) => shop.shopId === shopId);
  }

  async requestShopSystemLogin(shopId, system, { actorId }) {
    const normalizedSystem = String(system || '').trim().toLowerCase();
    if (!['oms', 'tms'].includes(normalizedSystem)) {
      const error = new Error('shop-system-login-invalid');
      error.code = 'SHOP_SYSTEM_LOGIN_INVALID';
      throw error;
    }
    const shop = (await this.listShops()).find((item) => item.shopId === shopId);
    if (!shop) return null;
    if (!shop.enabled) {
      const error = new Error('shop-worker-disabled');
      error.code = 'SHOP_WORKER_DISABLED';
      throw error;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pdd-workflow:system-login:${shopId}:${normalizedSystem}`]);
      let command = (await client.query(`
        SELECT id, shop_id AS "shopId", command_type AS "commandType", payload,
          status, requested_at AS "requestedAt"
        FROM operator_commands
        WHERE shop_id = $1 AND work_order_id IS NULL
          AND command_type = 'focus-system-login'
          AND payload->>'system' = $2
          AND status IN ('pending', 'delivered')
        ORDER BY requested_at DESC LIMIT 1`, [shopId, normalizedSystem])).rows[0] || null;
      if (!command) {
        command = (await client.query(`
          INSERT INTO operator_commands
            (id, shop_id, work_order_id, ordinary_instance_id, command_type, payload, requested_by)
          VALUES ($1,$2,NULL,NULL,'focus-system-login',jsonb_build_object('system',$3),$4)
          RETURNING id, shop_id AS "shopId", command_type AS "commandType", payload,
            status, requested_at AS "requestedAt"`,
        [crypto.randomUUID(), shopId, normalizedSystem, actorId])).rows[0];
        await client.query(`
          INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
          VALUES ($1,$2,'shop-system-login-requested',jsonb_build_object('system',$3,'commandId',$4::text))`,
        [shopId, actorId, normalizedSystem, command.id]);
      }
      await client.query('COMMIT');
      return { shop, command };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async synchronizeShopLoginObservation(shopId, observation = {}) {
    const status = String(observation.status || '').trim();
    if (!['authenticated', 'identity-mismatch'].includes(status)) return null;
    const actualShopName = normalizeDetectedPddShopName(observation.actualShopName);
    const mallId = /^\d{5,30}$/u.test(String(observation.mallId || '').trim())
      ? String(observation.mallId).trim() : null;
    const profileFingerprint = String(observation.profileFingerprint || '').trim();
    if (actualShopName.length < 2 || actualShopName.length > 120
      || actualShopName.includes('***') || /(?:\.{3}|…)/u.test(actualShopName)) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pdd-workflow:dynamic-shop-binding'))");
      const currentResult = await client.query(`
        SELECT shop.name, shop.expected_shop_name AS "expectedShopName",
          shop.login_requested_at AS "loginRequestedAt", shop.onboarding_status AS "onboardingStatus",
          binding.identity_key AS "identityKey", binding.binding_token AS "bindingToken",
          binding.bound_at AS "boundAt"
        FROM shops shop
        LEFT JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = shop.id
        WHERE shop.id = $1
        FOR UPDATE OF shop`, [shopId]);
      if (!currentResult.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const current = currentResult.rows[0];
      const currentLoginRequestedAt = current.loginRequestedAt instanceof Date
        ? current.loginRequestedAt.toISOString() : String(current.loginRequestedAt || '');
      if (currentLoginRequestedAt
        && String(observation.loginRequestedAt || '') !== currentLoginRequestedAt) {
        await client.query('ROLLBACK');
        return null;
      }
      const expectedCanonical = canonicalDetectedPddShopName(current.expectedShopName);
      const actualCanonical = canonicalDetectedPddShopName(actualShopName);
      const configuredMismatch = Boolean(expectedCanonical && expectedCanonical !== actualCanonical);
      const identityKey = mallId
        ? `mall:${mallId}`
        : `name:${actualCanonical.toLocaleLowerCase('zh-CN')}`;
      const duplicateResult = await client.query(`
        SELECT runtime.shop_id AS "shopId"
        FROM pdd_shop_runtime_bindings runtime
        WHERE runtime.shop_id <> $1
          AND (runtime.identity_key = $2 OR ($3::text IS NOT NULL AND runtime.mall_id = $3))
        LIMIT 1`, [shopId, identityKey, mallId]);
      const duplicateShopId = duplicateResult.rows[0]?.shopId || null;
      if (status === 'identity-mismatch' || configuredMismatch || duplicateShopId) {
        const reason = duplicateShopId
          ? `当前拼多多身份已绑定其他店铺：${duplicateShopId}`
          : `应登录“${current.expectedShopName}”，实际登录“${actualShopName}”`;
        const changed = current.onboardingStatus !== 'identity-mismatch';
        await client.query(`
          UPDATE shops SET onboarding_status = 'identity-mismatch', onboarding_error = $2,
            onboarding_completed_at = NULL, updated_at = now()
          WHERE id = $1`, [shopId, reason]);
        await client.query(`
          INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
          VALUES ($1,'native-login-browser','shop-login-identity-mismatch',$2::jsonb)`, [
          shopId,
          JSON.stringify({
            expectedShopName: current.expectedShopName,
            actualShopName,
            mallId,
            duplicateShopId,
            sessionId: observation.sessionId || null,
          }),
        ]);
        await client.query('COMMIT');
        return { changed, status: 'identity-mismatch', shop: (await this.listShops()).find((item) => item.shopId === shopId) };
      }

      if (!profileFingerprint) {
        await client.query('ROLLBACK');
        return null;
      }
      const bindingToken = current.identityKey === identityKey && current.bindingToken
        ? String(current.bindingToken) : crypto.randomUUID();
      const boundAt = current.identityKey === identityKey && current.boundAt
        ? new Date(current.boundAt).toISOString() : new Date().toISOString();
      const changed = current.name !== actualShopName
        || current.expectedShopName !== actualShopName
        || current.onboardingStatus !== 'ready';
      await client.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = $1 AND identity_key <> $2', [shopId, identityKey]);
      await client.query(`
        INSERT INTO pdd_shop_runtime_bindings
          (identity_key, shop_id, actual_shop_name, mall_id, binding_token, profile_fingerprint, bound_at, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT (identity_key) DO UPDATE SET
          shop_id = EXCLUDED.shop_id, actual_shop_name = EXCLUDED.actual_shop_name,
          mall_id = EXCLUDED.mall_id, binding_token = EXCLUDED.binding_token,
          profile_fingerprint = EXCLUDED.profile_fingerprint, bound_at = EXCLUDED.bound_at,
          last_seen_at = now()`, [
        identityKey, shopId, actualShopName, mallId, bindingToken, profileFingerprint, boundAt,
      ]);
      await client.query(`
        UPDATE shops SET name = $2, expected_shop_name = $2,
          onboarding_status = 'ready', onboarding_error = NULL,
          onboarding_completed_at = now(), updated_at = CASE
            WHEN name IS DISTINCT FROM $2 OR expected_shop_name IS DISTINCT FROM $2
              OR onboarding_status IS DISTINCT FROM 'ready' OR onboarding_error IS NOT NULL
            THEN now() ELSE updated_at END
        WHERE id = $1`, [shopId, actualShopName]);
      await client.query(`
        INSERT INTO shop_identity_bindings
          (shop_id, expected_shop_name, mall_id, profile_fingerprint, status, confirmed_by, confirmed_at, updated_at)
        VALUES ($1,$2,$3,$4,'confirmed','native-login-browser',now(),now())
        ON CONFLICT (shop_id) DO UPDATE SET
          expected_shop_name = EXCLUDED.expected_shop_name, mall_id = EXCLUDED.mall_id,
          profile_fingerprint = EXCLUDED.profile_fingerprint, status = 'confirmed',
          confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at,
          updated_at = now()`, [shopId, actualShopName, mallId, profileFingerprint]);
      await client.query(`
        INSERT INTO shop_runtime_state (shop_id, status, metadata)
        VALUES ($1, 'idle', jsonb_build_object('pddIdentityBinding', jsonb_build_object(
          'actualShopName', $2::text, 'mallId', $3::text, 'bindingToken', $4::text, 'boundAt', $5::text
        )))
        ON CONFLICT (shop_id) DO UPDATE SET
          metadata = coalesce(shop_runtime_state.metadata, '{}'::jsonb)
            || jsonb_build_object('pddIdentityBinding', jsonb_build_object(
              'actualShopName', $2::text, 'mallId', $3::text,
              'bindingToken', $4::text, 'boundAt', $5::text
            ))`, [shopId, actualShopName, mallId, bindingToken, boundAt]);
      if (changed) {
        await client.query(`
          INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
          VALUES ($1,'native-login-browser','shop-identity-synchronized',$2::jsonb)`, [
          shopId,
          JSON.stringify({
            previousName: current.name,
            previousExpectedShopName: current.expectedShopName,
            actualShopName,
            mallId,
            sessionId: observation.sessionId || null,
            source: observation.source || null,
          }),
        ]);
      }
      await client.query('COMMIT');
      return { changed, status: 'ready', shop: (await this.listShops()).find((item) => item.shopId === shopId) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async requestShopSession(shopId, kind = 'login') {
    const repository = new ShopSchedulerRepository(this.pool, {
      config: schedulerConfigFromEnv(),
      supervisorId: 'api',
    });
    const queued = await repository.requestSession(shopId, kind);
    if (!queued) return null;
    const shop = (await this.listShops()).find((item) => item.shopId === shopId);
    return shop ? {
      mode: 'windows-local',
      status: shop.slotKind ? 'running' : 'queued',
      shopId,
      queuePosition: shop.queuePosition,
      slotKind: shop.slotKind,
      expiresAt: shop.slotExpiresAt || null,
      requestedAt: new Date().toISOString(),
    } : null;
  }

  async runtimeCapacity() {
    const config = schedulerConfigFromEnv();
    const repository = new ShopSchedulerRepository(this.pool, { config, supervisorId: 'api' });
    const snapshot = await repository.snapshot();
    const schedulerMode = String(process.env.WORKER_SCHEDULER_MODE || 'legacy').toLowerCase();
    const legacyWorkers = schedulerMode === 'legacy'
      ? (await this.pool.query(`
        WITH latest AS (
          SELECT DISTINCT ON (heartbeat.shop_id)
            heartbeat.shop_id, heartbeat.heartbeat_at,
            coalesce(heartbeat.metadata->>'state', '') AS state
          FROM worker_heartbeats heartbeat
          JOIN shops shop ON shop.id = heartbeat.shop_id AND shop.enabled = true
          ORDER BY heartbeat.shop_id, heartbeat.heartbeat_at DESC
        )
        SELECT
          count(*) FILTER (WHERE heartbeat_at > now() - interval '45 seconds')::int AS active,
          count(*) FILTER (WHERE heartbeat_at > now() - interval '45 seconds'
            AND state LIKE '%verification%')::int AS verification,
          count(*) FILTER (WHERE heartbeat_at > now() - interval '45 seconds'
            AND state LIKE '%login%')::int AS login
        FROM latest`)).rows[0]
      : null;
    const activeWorkers = schedulerMode === 'legacy'
      ? Number(legacyWorkers?.active || 0)
      : snapshot.activeSlots;
    const telemetry = runtimeCapacityTelemetry({ schedulerMode, snapshot, activeWorkers });
    const verificationWorkers = schedulerMode === 'legacy'
      ? Number(legacyWorkers?.verification || 0)
      : snapshot.verificationSlots;
    const loginWorkers = schedulerMode === 'legacy'
      ? Number(legacyWorkers?.login || 0)
      : snapshot.loginSlots;
    const businessWorkers = schedulerMode === 'legacy'
      ? Math.max(0, activeWorkers - verificationWorkers - loginWorkers)
      : snapshot.businessSlots;
    const totalMemoryMb = os.totalmem() / 1024 / 1024;
    const freeMemoryMb = os.freemem() / 1024 / 1024;
    const capacity = calculateTargetSlots({
      totalMemoryMb,
      freeMemoryMb,
      cpuRatio: 0,
      dueCount: config.keepEnabledShopsResident
        ? snapshot.unassignedEnabledShops
        : snapshot.unassignedDueShops,
      activeCount: activeWorkers,
      slotMemorySamplesMb: snapshot.slotMemorySamplesMb,
      config,
    });
    return {
      schedulerMode,
      capacityMode: capacity.capacityMode,
      enabledShops: snapshot.enabledShops,
      hotShops: telemetry.hotShops,
      coldShops: telemetry.coldShops,
      dueShops: telemetry.dueShops,
      overdueShops: telemetry.overdueShops,
      slots: {
        active: activeWorkers,
        business: businessWorkers,
        verification: verificationWorkers,
        login: loginWorkers,
        target: schedulerMode === 'legacy' ? snapshot.enabledShops : capacity.target,
        hardLimit: schedulerMode === 'legacy' ? null : capacity.hardLimit,
        unlimited: schedulerMode === 'legacy' || capacity.hardLimit == null,
      },
      resources: {
        totalMemoryMb: Math.round(totalMemoryMb),
        freeMemoryMb: Math.round(freeMemoryMb),
        usedMemoryRatio: capacity.usedMemoryRatio,
        slotBudgetMb: Math.round(capacity.slotBudgetMb),
        memorySlotLimit: capacity.memoryLimit,
        blockedReason: capacity.blockedReason,
        warningReason: capacity.warningReason,
      },
      sla: {
        hotOrdinaryMinutes: config.hotOrdinaryIntervalMs / 60_000,
        coldOrdinaryMinutes: config.coldOrdinaryIntervalMs / 60_000,
        refundMinutes: config.refundIntervalMs / 60_000,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  async listScenarios() {
    const result = await this.pool.query(`
      SELECT code, title_patterns AS "titlePatterns", policy_version AS "policyVersion",
        enabled, config
      FROM scenario_definitions`);
    return result.rows
      .map(({ config = {}, ...scenario }) => ({ ...scenario, ...config, config }))
      .sort((left, right) => Number(left.displayOrder ?? 999) - Number(right.displayOrder ?? 999)
        || String(left.code).localeCompare(String(right.code), 'zh-CN'));
  }

  async metricsSummary(query = {}) {
    const cacheKey = metricsSummaryCacheKey(query);
    const now = Date.now();
    const cached = this._metricsSummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) this._metricsSummaryCache.delete(cacheKey);

    const inflight = this._metricsSummaryInflight.get(cacheKey);
    if (inflight) return inflight;

    const load = this._loadMetricsSummary(query)
      .then((value) => {
        if (this._metricsSummaryCacheTtlMs > 0) {
          for (const [key, entry] of this._metricsSummaryCache) {
            if (entry.expiresAt <= Date.now()) this._metricsSummaryCache.delete(key);
          }
          while (this._metricsSummaryCache.size >= 128) {
            this._metricsSummaryCache.delete(this._metricsSummaryCache.keys().next().value);
          }
          this._metricsSummaryCache.set(cacheKey, {
            expiresAt: Date.now() + this._metricsSummaryCacheTtlMs,
            value,
          });
        }
        return value;
      })
      .finally(() => this._metricsSummaryInflight.delete(cacheKey));
    this._metricsSummaryInflight.set(cacheKey, load);
    return load;
  }

  async _loadMetricsSummary(query = {}) {
    const where = [visibleWorkOrderSql];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (query.shopId) add('w.shop_id = ?', String(query.shopId));
    const dailySummaryDate = String(query.dailySummaryDate || '').trim();
    if (dailySummaryDate) {
      if (!dateOnlyFilterPattern.test(dailySummaryDate)) {
        throw new Error('invalid-daily-summary-date');
      }
      params.push(dailySummaryDate);
      const summaryDateParameter = `$${params.length}`;
      where.push(`w.updated_at >= (((${summaryDateParameter}::date - 1) + time '18:30')
        AT TIME ZONE 'Asia/Shanghai')`);
      where.push(`w.updated_at < ((${summaryDateParameter}::date + time '18:30')
        AT TIME ZONE 'Asia/Shanghai')`);
    } else {
      addPostgresDateFilters({ where, params, column: 'w.updated_at', query });
    }
    const scenarioExpression = canonicalScenarioSql(`coalesce(
      nullif(w.payload->'manualOverrides'->>'scenarioCode', ''),
      nullif(w.scenario_code, ''),
      nullif(w.payload->>'scenarioCode', ''),
      nullif(w.payload->'pddResolutionFlow'->>'code', ''),
      nullif(w.payload->'pddResolutionDecision'->>'scenarioCode', ''),
      nullif(w.payload->'tmsFormDecision'->>'scenarioCode', ''),
      'unknown'
    )`);
    if (query.scenarioCode) add(`${scenarioExpression} = ?`, canonicalScenarioCode(query.scenarioCode));
    const discoveredAtExpression = workOrderFirstDiscoveredAtSql(scenarioExpression);
    if (query.discoveredFrom) add(`${discoveredAtExpression} >= ?::timestamptz`, String(query.discoveredFrom));
    if (query.discoveredTo) add(`${discoveredAtExpression} < ?::timestamptz`, String(query.discoveredTo));
    const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const metricsCte = workOrderMetricsCte({ scenarioExpression, condition });
    const result = await this.pool.query(`${metricsCte}
      SELECT grouping(scenario_code)::int AS "summaryLevel",
        scenario_code AS "scenarioCode",
        count(*) FILTER (WHERE included_row_count > 0)::int AS total,
        count(*) FILTER (WHERE auto_success)::int AS "autoSuccess",
        count(*) FILTER (WHERE refund_auto_success)::int AS "refundAutoSuccess",
        count(*) FILTER (WHERE refund_manual_completed)::int AS "refundManualCompleted",
        count(*) FILTER (WHERE strict_auto_success)::int AS "strictAutoSuccess",
        count(*) FILTER (WHERE auto_success AND NOT strict_auto_success)::int AS "humanConfirmed",
        count(*) FILTER (WHERE manual_review)::int AS "manualReview",
        count(*) FILTER (WHERE unit_runtime_status = 'failed')::int AS failed,
        count(*) FILTER (WHERE unit_runtime_status = 'processing')::int AS processing,
        count(*) FILTER (WHERE unit_runtime_status = 'waiting')::int AS waiting,
        count(*) FILTER (WHERE unit_runtime_status = 'verification')::int AS verification,
        count(*) FILTER (WHERE unit_runtime_status IN ('paused', 'manual-review'))::int AS paused,
        count(*) FILTER (WHERE excluded_waiting_only)::int AS "excludedWaiting",
        count(*) FILTER (WHERE excluded_skipped_only)::int AS "excludedSkipped",
        count(*) FILTER (WHERE reconciliation_required)::int AS "reconciliationRequired",
        count(*) FILTER (WHERE admin_override)::int AS "adminOverrides",
        (count(*) FILTER (WHERE included_row_count > 0)
          - count(*) FILTER (WHERE auto_success))::int AS "notSuccessful"
      FROM metric_groups
      GROUP BY GROUPING SETS ((), (scenario_code))
      ORDER BY grouping(scenario_code) DESC,
        count(*) FILTER (WHERE included_row_count > 0) DESC,
        scenario_code`, params);
    const total = result.rows.find((row) => Number(row.summaryLevel) === 1) || {};
    const byScenario = result.rows
      .filter((row) => Number(row.summaryLevel) === 0)
      .map(({
        summaryLevel,
        processing,
        verification,
        reconciliationRequired,
        adminOverrides,
        ...row
      }) => row);
    return {
      total: total.total || 0,
      autoSuccess: total.autoSuccess || 0,
      refundAutoSuccess: total.refundAutoSuccess || 0,
      refundManualCompleted: total.refundManualCompleted || 0,
      strictAutoSuccess: total.strictAutoSuccess || 0,
      humanConfirmed: total.humanConfirmed || 0,
      manualReview: total.manualReview || 0,
      failed: total.failed || 0,
      processing: total.processing || 0,
      waiting: total.waiting || 0,
      verification: total.verification || 0,
      paused: total.paused || 0,
      returnRefundWaiting: total.excludedWaiting || 0,
      returnRefundSkipped: total.excludedSkipped || 0,
      reconciliationRequired: total.reconciliationRequired || 0,
      adminOverrides: total.adminOverrides || 0,
      notSuccessful: total.notSuccessful || 0,
      averageDurationSeconds: null,
      byScenario,
    };
  }

  async listWorkOrders(query = {}, {
    includeIncompleteAnalysis = false,
  } = {}) {
    const where = [visibleWorkOrderSql];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (query.shopId) add('w.shop_id = ?', String(query.shopId));
    if (query.status) add('w.status = ?', String(query.status));
    if (query.runtimeStatus) add('coalesce(w.runtime_status, w.status) = ?', String(query.runtimeStatus));
    if (query.classification) add('w.handling_classification = ?', String(query.classification));
    const scenarioExpression = canonicalScenarioSql(`coalesce(
      nullif(w.payload->'manualOverrides'->>'scenarioCode', ''),
      nullif(w.scenario_code, ''),
      nullif(w.payload->>'scenarioCode', ''),
      nullif(w.payload->'pddResolutionFlow'->>'code', ''),
      nullif(w.payload->'pddResolutionDecision'->>'scenarioCode', ''),
      nullif(w.payload->'tmsFormDecision'->>'scenarioCode', '')
    )`);
    if (query.scenarioCode) add(`${scenarioExpression} = ?`, canonicalScenarioCode(query.scenarioCode));
    const discoveredAtExpression = workOrderFirstDiscoveredAtSql(scenarioExpression);
    if (query.discoveredFrom) add(`${discoveredAtExpression} >= ?::timestamptz`, String(query.discoveredFrom));
    if (query.discoveredTo) add(`${discoveredAtExpression} < ?::timestamptz`, String(query.discoveredTo));
    if (query.q) {
      params.push(String(query.q));
      const queryParameter = `$${params.length}`;
      where.push(`(
        w.external_order_number ILIKE '%' || ${queryParameter} || '%'
        OR EXISTS (
          SELECT 1 FROM return_refunds search_refund
          WHERE search_refund.shop_id = w.shop_id
            AND search_refund.external_order_number = w.external_order_number
            AND search_refund.aftersale_number ILIKE '%' || ${queryParameter} || '%'
        )
        OR coalesce(w.payload->'manualOverrides'->>'workOrderType', w.work_order_type) ILIKE '%' || ${queryParameter} || '%'
        OR coalesce(w.payload->'manualOverrides'->>'trackingNumber', w.payload->'logisticsAnalysis'->>'trackingNumber', '') ILIKE '%' || ${queryParameter} || '%'
        OR EXISTS (
          SELECT 1 FROM logistics_analyses search_logistics
          WHERE search_logistics.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('search_logistics')}
            AND coalesce(search_logistics.payload->>'trackingNumber', '') ILIKE '%' || ${queryParameter} || '%'
        )
        OR EXISTS (
          SELECT 1 FROM ordinary_work_order_instances search_instance
          WHERE search_instance.work_order_id = w.id
            AND (
              coalesce(search_instance.platform_case_id, '') ILIKE '%' || ${queryParameter} || '%'
              OR coalesce(search_instance.platform_case_key, '') ILIKE '%' || ${queryParameter} || '%'
              OR coalesce(search_instance.work_order_type, '') ILIKE '%' || ${queryParameter} || '%'
            )
        )
      )`);
    }
    addPostgresDateFilters({ where, params, column: 'w.updated_at', query });
    const page = Math.max(1, Number(query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize || 20)));
    const baseCondition = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const filterJoins = `LEFT JOIN return_refunds refund ON refund.work_order_id = w.id`;
    const overviewMetricPredicate = overviewMetricPredicates[String(query.overviewMetric || '')];
    let condition;
    if (overviewMetricPredicate) {
      const metricsCte = workOrderMetricsCte({
        scenarioExpression,
        condition: baseCondition,
      });
      condition = `WHERE w.id IN (
        ${metricsCte}
        SELECT representative_id FROM metric_groups WHERE ${overviewMetricPredicate}
      )`;
    } else {
      where.push(returnRefundRepresentativeSql(scenarioExpression));
      condition = `WHERE ${where.join(' AND ')}`;
    }
    const joins = `
      LEFT JOIN ordinary_work_order_instances current_ordinary
        ON current_ordinary.id = w.current_ordinary_instance_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS count
        FROM ordinary_work_order_instances ordinary_instance
        WHERE ordinary_instance.work_order_id = w.id
      ) ordinary_group ON true
      LEFT JOIN LATERAL (
        SELECT analysis.payload FROM logistics_analyses analysis
        WHERE analysis.work_order_id = w.id
          AND ${currentOrdinaryRelatedSql('analysis')}
        ORDER BY analysis.created_at DESC LIMIT 1
      ) logistics ON true
      LEFT JOIN LATERAL (
        SELECT analysis.payload FROM oms_analyses analysis
        WHERE analysis.work_order_id = w.id
          AND ${currentOrdinaryRelatedSql('analysis')}
        ORDER BY analysis.created_at DESC LIMIT 1
      ) oms ON true
      LEFT JOIN return_refunds refund ON refund.work_order_id = w.id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS count,
          jsonb_agg(jsonb_build_object(
            'workOrderId', grouped_refund.work_order_id,
            'aftersaleNumber', grouped_refund.aftersale_number,
            'refundAmount', grouped_refund.refund_amount,
            'aftersaleType', grouped_refund.aftersale_type,
            'aftersaleStatus', grouped_refund.aftersale_status,
            'returnCarrier', grouped_refund.return_carrier,
            'returnTrackingNumber', grouped_refund.return_tracking_number,
            'earliestLogisticsAt', grouped_refund.earliest_logistics_at,
            'latestLogisticsAt', grouped_refund.latest_logistics_at,
            'logisticsTransitSpanHours', grouped_refund.logistics_transit_span_hours,
            'logisticsContainsChangsha', grouped_refund.logistics_contains_changsha,
            'logisticsContainsHengshuiJizhou', grouped_refund.logistics_contains_hengshui_jizhou,
            'logisticsDirectionMatched', grouped_refund.logistics_direction_matched,
            'logisticsTimeline', grouped_refund.logistics_timeline,
            'ruleResults', grouped_refund.rule_results,
            'decision', grouped_refund.decision,
            'riskLevel', grouped_refund.risk_level,
            'actionState', grouped_refund.action_state,
            'nextCheckAt', grouped_refund.next_check_at,
            'firstDiscoveredAt', grouped_refund.first_discovered_at,
            'completedAt', grouped_refund.completed_at,
            'completionMethod', grouped_refund.completion_method,
            'evidence', grouped_refund.evidence,
            'updatedAt', grouped_refund.updated_at
          ) ORDER BY grouped_refund.updated_at DESC, grouped_refund.aftersale_number) AS items
        FROM return_refunds grouped_refund
        WHERE ${scenarioExpression} = 'return-refund'
          AND grouped_refund.shop_id = w.shop_id
          AND grouped_refund.external_order_number = w.external_order_number
      ) refund_group ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object(
          'interventionId', intervention.id,
          'status', outbox.status,
          'attemptCount', outbox.attempt_count,
          'deliverySource', outbox.payload->>'deliverySource',
          'createdAt', outbox.created_at,
          'lastError', outbox.last_error
        ) AS notification
        FROM manual_interventions intervention
        JOIN notification_outbox outbox ON outbox.intervention_id = intervention.id
        WHERE intervention.work_order_id = w.id AND intervention.channel = 'dingtalk'
          AND ${currentOrdinaryRelatedSql('intervention')}
        ORDER BY outbox.created_at DESC LIMIT 1
      ) dingtalk ON true
      LEFT JOIN LATERAL (
        SELECT last_success_at FROM sync_cursors WHERE shop_id = w.shop_id
        ORDER BY last_success_at DESC NULLS LAST LIMIT 1
      ) sync ON true`;
    const totalResult = await this.pool.query(`
      SELECT count(*)::int AS total
      FROM work_orders w
      ${filterJoins}
      ${condition}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const diagnosticJoins = includeIncompleteAnalysis ? `
      LEFT JOIN LATERAL (
        SELECT stage, event_type, reason_code, message, occurred_at
        FROM workflow_events diagnostic
        WHERE diagnostic.work_order_id = w.id
          AND ${currentOrdinaryRelatedSql('diagnostic')}
          AND event_type NOT IN ('workflow.progress', 'workflow.snapshot-synchronized')
          AND (nullif(reason_code, '') IS NOT NULL OR nullif(message, '') IS NOT NULL)
        ORDER BY occurred_at DESC LIMIT 1
      ) diagnostic_event ON true
      LEFT JOIN LATERAL (
        SELECT reason_code, reason, status, created_at
        FROM manual_interventions diagnostic
        WHERE diagnostic.work_order_id = w.id
          AND ${currentOrdinaryRelatedSql('diagnostic')}
          AND nullif(reason, '') IS NOT NULL
        ORDER BY CASE WHEN status IN ('open', 'acknowledged') THEN 0 ELSE 1 END, created_at DESC LIMIT 1
      ) diagnostic_intervention ON true` : '';
    const diagnosticColumns = includeIncompleteAnalysis ? `,
        w.payload AS "_analysisPayload",
        CASE WHEN diagnostic_event.stage IS NULL THEN NULL ELSE jsonb_build_object(
          'stage', diagnostic_event.stage, 'eventType', diagnostic_event.event_type,
          'reasonCode', diagnostic_event.reason_code, 'message', diagnostic_event.message,
          'occurredAt', diagnostic_event.occurred_at
        ) END AS "_analysisEvent",
        CASE WHEN diagnostic_intervention.reason IS NULL THEN NULL ELSE jsonb_build_object(
          'reasonCode', diagnostic_intervention.reason_code, 'reason', diagnostic_intervention.reason,
          'status', diagnostic_intervention.status, 'createdAt', diagnostic_intervention.created_at
        ) END AS "_analysisIntervention"` : '';
    const result = await this.pool.query(`
      WITH page_work_orders AS MATERIALIZED (
        SELECT w.id, w.updated_at
        FROM work_orders w
        ${filterJoins}
        ${condition}
        ORDER BY w.updated_at DESC, w.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      )
      SELECT w.id, w.shop_id AS "shopId",
        coalesce(nullif(w.payload->>'shopNameSnapshot', ''), shop.name) AS "shopName",
        w.external_order_number AS "orderNumber",
        ${scenarioExpression} AS "scenarioCode",
        coalesce(nullif(w.payload->'manualOverrides'->>'workOrderType', ''), nullif(w.work_order_type, ''),
          nullif(w.payload->>'workOrderType', ''), nullif(w.payload->>'targetWorkOrderTitle', '')) AS "workOrderType", w.status,
        coalesce(w.runtime_status, w.status) AS "runtimeStatus", w.current_step AS "currentStep",
        w.handling_classification AS "handlingClassification", w.classification_source AS "classificationSource",
        w.classification_reason AS "classificationReason", w.classification_version AS "classificationVersion",
        w.completion_state AS "completionState", w.completion_confirmation_method AS "completionConfirmationMethod",
        w.completion_confirmed_at AS "completionConfirmedAt",
        w.current_ordinary_instance_id AS "currentOrdinaryInstanceId",
        coalesce(ordinary_group.count, 0) AS "ordinaryInstanceCount",
        current_ordinary.platform_case_id AS "currentPlatformCaseId",
        current_ordinary.platform_case_key AS "currentPlatformCaseKey",
        current_ordinary.identity_status AS "currentInstanceIdentityStatus",
        current_ordinary.status AS "currentInstanceStatus",
        current_ordinary.runtime_status AS "currentInstanceRuntimeStatus",
        w.recovery_state AS "recoveryState", w.recovery_reason AS "recoveryReason",
        w.recovery_version AS "recoveryVersion", w.recovery_updated_at AS "recoveryUpdatedAt",
        coalesce(nullif(w.payload->'manualOverrides'->>'carrier', ''), nullif(logistics.payload->>'carrier', ''),
          nullif(w.payload->'logisticsAnalysis'->>'carrier', '')) AS carrier,
        coalesce(nullif(w.payload->'manualOverrides'->>'trackingNumber', ''), nullif(logistics.payload->>'trackingNumber', ''),
          nullif(w.payload->'logisticsAnalysis'->>'trackingNumber', '')) AS "trackingNumber",
        coalesce(nullif(oms.payload->>'shippingWarehouse', ''),
          nullif(oms.payload->>'matchedWarehouse', ''), nullif(oms.payload->>'warehouse', ''), nullif(oms.payload->>'warehouseName', ''),
          nullif(w.payload->'omsAnalysis'->>'shippingWarehouse', ''), nullif(w.payload->'omsAnalysis'->>'matchedWarehouse', ''),
          nullif(w.payload->'omsAnalysis'->>'warehouse', ''), nullif(w.payload->'omsAnalysis'->>'warehouseName', '')) AS warehouse,
        w.manual_review_reason AS "manualReviewReason", w.latest_event_at AS "latestEventAt", w.updated_at AS "updatedAt",
        CASE WHEN refund.work_order_id IS NULL THEN NULL ELSE jsonb_build_object(
          'aftersaleNumber', refund.aftersale_number,
          'refundAmount', refund.refund_amount,
          'aftersaleType', refund.aftersale_type,
          'aftersaleStatus', refund.aftersale_status,
          'returnCarrier', refund.return_carrier,
          'returnTrackingNumber', refund.return_tracking_number,
          'earliestLogisticsAt', refund.earliest_logistics_at,
          'latestLogisticsAt', refund.latest_logistics_at,
          'logisticsTransitSpanHours', refund.logistics_transit_span_hours,
          'logisticsContainsChangsha', refund.logistics_contains_changsha,
          'logisticsContainsHengshuiJizhou', refund.logistics_contains_hengshui_jizhou,
          'logisticsDirectionMatched', refund.logistics_direction_matched,
          'logisticsTimeline', refund.logistics_timeline,
          'ruleResults', refund.rule_results,
          'decision', refund.decision,
          'riskLevel', refund.risk_level,
          'actionState', refund.action_state,
          'nextCheckAt', refund.next_check_at,
          'firstDiscoveredAt', refund.first_discovered_at,
          'completedAt', refund.completed_at,
          'completionMethod', refund.completion_method,
          'evidence', refund.evidence
        ) END AS "returnRefund",
        refund_group.items AS "returnRefunds",
        coalesce(refund_group.count, 0) AS "aftersaleCount",
        dingtalk.notification AS "dingtalkNotification",
        sync.last_success_at AS "lastSyncedAt",
        extract(epoch FROM (now() - sync.last_success_at))::int AS "syncLagSeconds",
        w.payload AS "_snapshotPayload", logistics.payload AS "_logisticsPayload", oms.payload AS "_omsPayload"
        ${diagnosticColumns}
      FROM page_work_orders page_work_order
      JOIN work_orders w ON w.id = page_work_order.id
      JOIN shops shop ON shop.id = w.shop_id
      ${joins}
      ${diagnosticJoins}
      ORDER BY w.updated_at DESC, w.id DESC`, params);
    const rows = result.rows.map((row) => {
      const {
        _snapshotPayload, _logisticsPayload, _omsPayload,
        _analysisPayload, _analysisEvent, _analysisIntervention, ...publicRow
      } = row;
      const warehouseInfo = warehouseInfoFromFacts({
        payload: _snapshotPayload,
        logistics: _logisticsPayload,
        oms: _omsPayload,
        updatedAt: row.latestEventAt || row.updatedAt,
      });
      const completionInfo = completionInfoFromPayload(_snapshotPayload, {
        state: row.completionState,
        confirmationMethod: row.completionConfirmationMethod,
        confirmedAt: row.completionConfirmedAt,
        runtimeStatus: row.runtimeStatus,
        involvedHumanReview: row.handlingClassification === 'manual',
      });
      const enriched = {
        ...publicRow,
        ...workOrderShopIdentityFromPayload(_snapshotPayload, {
          shopName: publicRow.shopName,
          shopMallId: publicRow.shopMallId,
        }),
        warehouse: warehouseInfo.omsValue,
        warehouseInfo,
        scenarioInfo: {
          code: row.scenarioCode,
          status: row.scenarioCode && row.scenarioCode !== 'unknown' ? 'confirmed' : 'pending',
          source: _snapshotPayload?.manualOverrides?.scenarioCode ? 'manual-review' : 'workflow-analysis',
          observedAt: row.latestEventAt || row.updatedAt,
        },
        completionInfo,
        dataFreshness: {
          latestEventAt: row.latestEventAt,
          lastSyncedAt: row.lastSyncedAt,
          syncLagSeconds: row.syncLagSeconds,
          stale: !row.lastSyncedAt || Number(row.syncLagSeconds) > 15,
        },
      };
      if (!includeIncompleteAnalysis) return enriched;
      return {
        ...enriched,
        incompleteAnalysis: analyzeIncompleteWorkflow({
          ...row,
          payload: _analysisPayload || _snapshotPayload,
          diagnosticEvent: _analysisEvent,
          diagnosticIntervention: _analysisIntervention,
        }),
      };
    });
    return { data: rows, page, pageSize, total: totalResult.rows[0].total };
  }

  async getWorkOrder(id) {
    const result = await this.pool.query(`
      SELECT w.*, shop.name AS "configuredShopName", shop.display_slot AS "displaySlot",
        logistics.payload AS logistics, oms.payload AS oms,
        (SELECT jsonb_agg(jsonb_build_object(
          'id', instance.id,
          'platformCaseId', instance.platform_case_id,
          'platformCaseKey', instance.platform_case_key,
          'detailUrl', instance.detail_url,
          'workOrderType', instance.work_order_type,
          'scenarioCode', instance.scenario_code,
          'identityStatus', instance.identity_status,
          'status', instance.status,
          'runtimeStatus', instance.runtime_status,
          'currentStep', instance.current_step,
          'decision', instance.decision,
          'payload', instance.payload,
          'manualReviewReason', instance.manual_review_reason,
          'nextAttemptAt', instance.next_attempt_at,
          'firstDiscoveredAt', instance.first_discovered_at,
          'lastDiscoveredAt', instance.last_discovered_at,
          'startedAt', instance.started_at,
          'completedAt', instance.completed_at,
          'completionMethod', instance.completion_method,
          'isCurrent', instance.id = w.current_ordinary_instance_id,
          'events', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', event.id,
              'stage', event.stage,
              'eventType', event.event_type,
              'severity', event.severity,
              'reasonCode', event.reason_code,
              'message', event.message,
              'payload', event.payload,
              'occurredAt', event.occurred_at
            ) ORDER BY event.occurred_at)
            FROM workflow_events event
            WHERE event.ordinary_instance_id = instance.id
          ), '[]'::jsonb),
          'evidence', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', evidence.id,
              'kind', evidence.kind,
              'status', evidence.status,
              'objectKey', evidence.object_key,
              'mimeType', evidence.mime_type,
              'createdAt', evidence.created_at
            ) ORDER BY evidence.created_at DESC)
            FROM evidence_assets evidence
            WHERE evidence.ordinary_instance_id = instance.id
              AND evidence.deleted_at IS NULL
          ), '[]'::jsonb),
          'interventions', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', intervention.id,
              'channel', intervention.channel,
              'reasonCode', intervention.reason_code,
              'reason', intervention.reason,
              'riskLevel', intervention.risk_level,
              'status', intervention.status,
              'createdAt', intervention.created_at,
              'resolvedAt', intervention.resolved_at
            ) ORDER BY intervention.created_at DESC)
            FROM manual_interventions intervention
            WHERE intervention.ordinary_instance_id = instance.id
          ), '[]'::jsonb),
          'logisticsAnalyses', coalesce((
            SELECT jsonb_agg(analysis.payload ORDER BY analysis.created_at DESC)
            FROM logistics_analyses analysis
            WHERE analysis.ordinary_instance_id = instance.id
          ), '[]'::jsonb),
          'omsAnalyses', coalesce((
            SELECT jsonb_agg(analysis.payload ORDER BY analysis.created_at DESC)
            FROM oms_analyses analysis
            WHERE analysis.ordinary_instance_id = instance.id
          ), '[]'::jsonb),
          'tmsWorkOrders', coalesce((
            SELECT jsonb_agg(to_jsonb(tms_instance) ORDER BY tms_instance.created_at DESC)
            FROM tms_work_orders tms_instance
            WHERE tms_instance.ordinary_instance_id = instance.id
          ), '[]'::jsonb)
        ) ORDER BY instance.last_discovered_at DESC, instance.created_at DESC)
        FROM ordinary_work_order_instances instance
        WHERE instance.work_order_id = w.id) AS "ordinaryInstances",
        (SELECT to_jsonb(refund) FROM return_refunds refund WHERE refund.work_order_id = w.id) AS "returnRefund",
        (SELECT jsonb_agg(jsonb_build_object(
          'workOrderId', grouped_refund.work_order_id,
          'aftersaleNumber', grouped_refund.aftersale_number,
          'refundAmount', grouped_refund.refund_amount,
          'aftersaleType', grouped_refund.aftersale_type,
          'aftersaleStatus', grouped_refund.aftersale_status,
          'returnCarrier', grouped_refund.return_carrier,
          'returnTrackingNumber', grouped_refund.return_tracking_number,
          'earliestLogisticsAt', grouped_refund.earliest_logistics_at,
          'latestLogisticsAt', grouped_refund.latest_logistics_at,
          'logisticsTransitSpanHours', grouped_refund.logistics_transit_span_hours,
          'logisticsContainsChangsha', grouped_refund.logistics_contains_changsha,
          'logisticsContainsHengshuiJizhou', grouped_refund.logistics_contains_hengshui_jizhou,
          'logisticsDirectionMatched', grouped_refund.logistics_direction_matched,
          'logisticsTimeline', grouped_refund.logistics_timeline,
          'ruleResults', grouped_refund.rule_results,
          'decision', grouped_refund.decision,
          'riskLevel', grouped_refund.risk_level,
          'actionState', grouped_refund.action_state,
          'nextCheckAt', grouped_refund.next_check_at,
          'firstDiscoveredAt', grouped_refund.first_discovered_at,
          'completedAt', grouped_refund.completed_at,
          'completionMethod', grouped_refund.completion_method,
          'evidence', grouped_refund.evidence,
          'updatedAt', grouped_refund.updated_at
        ) ORDER BY grouped_refund.updated_at DESC, grouped_refund.aftersale_number)
        FROM return_refunds grouped_refund
        WHERE grouped_refund.shop_id = w.shop_id
          AND grouped_refund.external_order_number = w.external_order_number) AS "returnRefunds",
        sync.last_success_at AS "lastSyncedAt",
        extract(epoch FROM (now() - sync.last_success_at))::int AS "syncLagSeconds",
        (SELECT jsonb_agg(to_jsonb(tms) ORDER BY tms.created_at DESC)
          FROM tms_work_orders tms WHERE tms.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('tms')}) AS tms,
        (SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence.created_at DESC) FROM evidence_assets evidence
          WHERE evidence.work_order_id = w.id AND evidence.deleted_at IS NULL
            AND ${currentOrdinaryRelatedSql('evidence')}) AS evidence,
        (SELECT jsonb_agg(to_jsonb(history) ORDER BY history.created_at DESC)
          FROM classification_history history WHERE history.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('history')}) AS "classificationHistory",
        (SELECT jsonb_agg(to_jsonb(correction) ORDER BY correction.created_at DESC)
          FROM data_corrections correction WHERE correction.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('correction')}) AS corrections,
        (SELECT jsonb_agg(to_jsonb(events) ORDER BY events.occurred_at ASC)
          FROM workflow_events events WHERE events.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('events')}) AS events,
        (SELECT jsonb_agg(to_jsonb(interventions) ORDER BY interventions.created_at DESC)
          FROM manual_interventions interventions WHERE interventions.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('interventions')}) AS interventions,
        (SELECT jsonb_build_object(
          'interventionId', intervention.id,
          'status', outbox.status,
          'attemptCount', outbox.attempt_count,
          'deliverySource', outbox.payload->>'deliverySource',
          'createdAt', outbox.created_at,
          'lastError', outbox.last_error
        ) FROM manual_interventions intervention
          JOIN notification_outbox outbox ON outbox.intervention_id = intervention.id
          WHERE intervention.work_order_id = w.id AND intervention.channel = 'dingtalk'
            AND ${currentOrdinaryRelatedSql('intervention')}
          ORDER BY outbox.created_at DESC LIMIT 1) AS "dingtalkNotification"
      FROM work_orders w
      JOIN shops shop ON shop.id = w.shop_id
      LEFT JOIN LATERAL (
        SELECT analysis.payload FROM logistics_analyses analysis
        WHERE analysis.work_order_id = w.id
          AND ${currentOrdinaryRelatedSql('analysis')}
        ORDER BY analysis.created_at DESC LIMIT 1
      ) logistics ON true
      LEFT JOIN LATERAL (
        SELECT analysis.payload FROM oms_analyses analysis
        WHERE analysis.work_order_id = w.id
          AND ${currentOrdinaryRelatedSql('analysis')}
        ORDER BY analysis.created_at DESC LIMIT 1
      ) oms ON true
      LEFT JOIN LATERAL (
        SELECT last_success_at FROM sync_cursors WHERE shop_id = w.shop_id
        ORDER BY last_success_at DESC NULLS LAST LIMIT 1
      ) sync ON true
      WHERE w.id = $1::uuid AND ${visibleWorkOrderSql}`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const latestEventAt = row.latest_event_at || row.events?.at(-1)?.occurred_at || null;
    const warehouseInfo = warehouseInfoFromFacts({
      payload: row.payload,
      logistics: row.logistics,
      oms: row.oms,
      updatedAt: latestEventAt || row.updated_at,
    });
    const shopIdentity = workOrderShopIdentityFromPayload(row.payload, {
      shopName: row.configuredShopName,
    });
    return {
      ...row,
      shopId: row.shop_id,
      ...shopIdentity,
      ordinaryInstances: row.ordinaryInstances || [],
      ordinaryInstanceCount: row.ordinaryInstances?.length || 0,
      currentOrdinaryInstanceId: row.current_ordinary_instance_id || null,
      currentPlatformCaseId: row.ordinaryInstances?.find((instance) => instance.isCurrent)?.platformCaseId || null,
      currentPlatformCaseKey: row.ordinaryInstances?.find((instance) => instance.isCurrent)?.platformCaseKey || null,
      currentInstanceStatus: row.ordinaryInstances?.find((instance) => instance.isCurrent)?.status || null,
      latest_event_at: latestEventAt,
      warehouse: warehouseInfo.omsValue,
      warehouseInfo,
      scenarioInfo: {
        code: canonicalScenarioCode(row.payload?.manualOverrides?.scenarioCode || row.scenario_code),
        status: row.scenario_code ? 'confirmed' : 'pending',
        source: row.payload?.manualOverrides?.scenarioCode ? 'manual-review' : 'workflow-analysis',
        observedAt: latestEventAt || row.updated_at,
      },
      completionInfo: completionInfoFromPayload(row.payload, {
        state: row.completion_state,
        confirmationMethod: row.completion_confirmation_method,
        confirmedAt: row.completion_confirmed_at,
        runtimeStatus: row.runtime_status || row.status,
        involvedHumanReview: row.handling_classification === 'manual',
      }),
      dataFreshness: {
        latestEventAt,
        lastSyncedAt: row.lastSyncedAt,
        syncLagSeconds: row.syncLagSeconds,
        stale: !row.lastSyncedAt || Number(row.syncLagSeconds) > 15,
      },
      remoteDesktopPath: remoteDesktopPathForSlot(row.displaySlot),
    };
  }

  async listVerifications({ activeOnly = false } = {}) {
    const activeCondition = activeOnly ? `WHERE v.status IN ('detected', 'waiting-human', 'verification-required')
        AND v.resolved_at IS NULL
        AND shop.enabled = true
        AND (
          checkpoint.current_step = 'human-verification-required'
          OR (
            checkpoint.current_step = 'manual-login-required'
            AND v.stage = 'pdd-manual-login'
          )
        )
        AND checkpoint.snapshot->'verificationLocation'->>'id' = v.id::text` : '';
    const result = await this.pool.query(`
      SELECT v.id, v.shop_id AS "shopId", v.work_order_id AS "workOrderId",
        shop.name AS "shopName", shop.display_slot AS "displaySlot",
        v.system_name AS system, v.stage, v.status, v.url,
        v.frame_url AS "frameUrl", v.selector, v.bounding_box AS "boundingBox", v.confidence,
        v.detected_at AS "detectedAt", v.resolved_at AS "resolvedAt",
        (v.status IN ('detected', 'waiting-human', 'verification-required')
          AND v.resolved_at IS NULL
          AND shop.enabled = true
          AND (
            checkpoint.current_step = 'human-verification-required'
            OR (
              checkpoint.current_step = 'manual-login-required'
              AND v.stage = 'pdd-manual-login'
            )
          )
          AND checkpoint.snapshot->'verificationLocation'->>'id' = v.id::text) AS active,
        command.status AS "recheckStatus", command.requested_at AS "recheckRequestedAt",
        handoff.status AS "handoffStatus", handoff.requested_at AS "handoffRequestedAt",
        force_clear.status AS "forceClearStatus", force_clear.requested_at AS "forceClearRequestedAt",
        CASE WHEN v.screenshot_file_id IS NULL THEN NULL ELSE '/api/v1/verifications/' || v.id || '/screenshot' END AS "screenshotUrl"
      FROM verification_locations v
      JOIN shops shop ON shop.id = v.shop_id
      LEFT JOIN workflow_checkpoints checkpoint ON checkpoint.shop_id = v.shop_id
      LEFT JOIN LATERAL (
        SELECT status, requested_at FROM operator_commands
        WHERE command_type = 'verification-recheck' AND payload->>'verificationId' = v.id::text
        ORDER BY requested_at DESC LIMIT 1
      ) command ON true
      LEFT JOIN LATERAL (
        SELECT status, requested_at FROM operator_commands
        WHERE command_type = 'refresh-next-order' AND payload->>'verificationId' = v.id::text
        ORDER BY requested_at DESC LIMIT 1
      ) handoff ON true
      LEFT JOIN LATERAL (
        SELECT status, requested_at FROM operator_commands
        WHERE command_type = 'force-clear-verification' AND payload->>'verificationId' = v.id::text
        ORDER BY requested_at DESC LIMIT 1
      ) force_clear ON true
      ${activeCondition}
      ORDER BY v.detected_at DESC LIMIT 500`);
    return result.rows.map((row) => ({ ...row, remoteDesktopPath: remoteDesktopPathForSlot(row.displaySlot) }));
  }

  async getVerificationScreenshot(id) {
    const result = await this.pool.query(`
      SELECT e.object_key, e.mime_type FROM verification_locations v
      JOIN evidence_assets e ON e.id = v.screenshot_file_id WHERE v.id = $1::uuid`, [id]);
    if (!result.rowCount) return null;
    const { client, aws } = await this.s3();
    const object = await client.send(new aws.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: result.rows[0].object_key }));
    return { contentType: result.rows[0].mime_type, body: Buffer.from(await object.Body.transformToByteArray()) };
  }

  async deleteVerificationScreenshots(ids, { actorId, reason = 'operator-deleted' } = {}) {
    const verificationIds = [...new Set((ids || []).map(String))];
    if (!verificationIds.length) return [];
    const lookup = await this.pool.query(`
      SELECT v.id, v.shop_id, v.work_order_id, v.screenshot_file_id,
        e.object_key, e.deleted_at
      FROM verification_locations v
      LEFT JOIN evidence_assets e ON e.id = v.screenshot_file_id
      WHERE v.id = ANY($1::uuid[])`, [verificationIds]);
    if (!lookup.rowCount) return [];
    const storedObjects = lookup.rows.filter((row) => row.object_key && !row.deleted_at);
    if (storedObjects.length) {
      const { client: objectStore, aws } = await this.s3();
      for (const row of storedObjects) {
        await objectStore.send(new aws.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: row.object_key }));
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const evidenceIds = lookup.rows.map((row) => row.screenshot_file_id).filter(Boolean);
      if (evidenceIds.length) {
        await client.query(`UPDATE evidence_assets SET status = 'deleted', deleted_at = coalesce(deleted_at, now())
          WHERE id = ANY($1::uuid[])`, [evidenceIds]);
      }
      await client.query('UPDATE verification_locations SET screenshot_file_id = NULL WHERE id = ANY($1::uuid[])', [verificationIds]);
      await client.query(`INSERT INTO audit_events (shop_id, work_order_id, actor_id, event_type, payload)
        SELECT v.shop_id, v.work_order_id, $2::text, 'verification-screenshot-deleted',
          jsonb_build_object('verificationId', v.id::text, 'reason', $3::text, 'bulkCount', $4::int)
        FROM verification_locations v WHERE v.id = ANY($1::uuid[])`,
      [verificationIds, actorId || 'system', reason, lookup.rowCount]);
      await client.query('COMMIT');
      return lookup.rows.map((row) => ({
        id: row.id,
        shopId: row.shop_id,
        screenshotDeleted: Boolean(row.screenshot_file_id),
      }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteVerificationScreenshot(id, options = {}) {
    const [result] = await this.deleteVerificationScreenshots([id], options);
    return result || null;
  }

  async purgeExpiredVerificationScreenshots({ retentionDays = 7 } = {}) {
    const days = Math.max(1, Math.min(365, Number(retentionDays) || 7));
    const candidates = await this.pool.query(`
      SELECT v.id FROM verification_locations v
      WHERE v.screenshot_file_id IS NOT NULL
        AND v.status IN ('resolved', 'expired')
        AND coalesce(v.resolved_at, v.detected_at) < now() - ($1::int * interval '1 day')
      ORDER BY coalesce(v.resolved_at, v.detected_at) ASC LIMIT 200`, [days]);
    let deleted = 0;
    for (const candidate of candidates.rows) {
      const result = await this.deleteVerificationScreenshot(candidate.id, {
        actorId: 'verification-retention', reason: `retention-${days}-days`,
      });
      if (result?.screenshotDeleted) deleted += 1;
    }
    return { deleted, retentionDays: days };
  }

  async getEvidenceAsset(id) {
    const result = await this.pool.query(`SELECT object_key, mime_type FROM evidence_assets WHERE id = $1::uuid AND deleted_at IS NULL`, [id]);
    if (!result.rowCount) return null;
    const { client, aws } = await this.s3();
    const object = await client.send(new aws.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: result.rows[0].object_key }));
    return { contentType: result.rows[0].mime_type, body: Buffer.from(await object.Body.transformToByteArray()) };
  }

  async deleteEvidenceAsset(id, { actorId = 'system', reason = 'operator-deleted' } = {}) {
    const lookup = await this.pool.query(`
      SELECT id, shop_id, work_order_id, kind, object_key, mime_type, size_bytes, created_at
      FROM evidence_assets
      WHERE id = $1::uuid
        AND kind IN ('pdd-evidence', 'tms-evidence')
        AND deleted_at IS NULL`, [id]);
    if (!lookup.rowCount) return null;
    const asset = lookup.rows[0];
    const { client: objectStore, aws } = await this.s3();
    await objectStore.send(new aws.DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: asset.object_key,
    }));

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(`
        DELETE FROM evidence_assets
        WHERE id = $1::uuid
          AND kind IN ('pdd-evidence', 'tms-evidence')
          AND deleted_at IS NULL
        RETURNING id`, [id]);
      if (!deleted.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(`
        INSERT INTO audit_events (shop_id, work_order_id, actor_id, event_type, payload)
        VALUES ($1,$2,$3,'evidence-screenshot-deleted',$4::jsonb)`, [
        asset.shop_id,
        asset.work_order_id,
        actorId,
        JSON.stringify({
          evidenceId: asset.id,
          kind: asset.kind,
          mimeType: asset.mime_type,
          sizeBytes: asset.size_bytes,
          createdAt: asset.created_at,
          reason,
        }),
      ]);
      await client.query('COMMIT');
      return {
        id: asset.id,
        shopId: asset.shop_id,
        workOrderId: asset.work_order_id,
        kind: asset.kind,
        deleted: true,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async purgeExpiredEvidenceScreenshots({ retentionDays = 7 } = {}) {
    const days = Math.max(1, Math.min(365, Number(retentionDays) || 7));
    let deleted = 0;
    while (true) {
      const candidates = await this.pool.query(`
        SELECT id FROM evidence_assets
        WHERE kind IN ('pdd-evidence', 'tms-evidence')
          AND deleted_at IS NULL
          AND created_at < now() - ($1::int * interval '1 day')
        ORDER BY created_at ASC LIMIT 200`, [days]);
      if (!candidates.rowCount) break;
      let batchDeleted = 0;
      for (const candidate of candidates.rows) {
        const result = await this.deleteEvidenceAsset(candidate.id, {
          actorId: 'evidence-retention', reason: `retention-${days}-days`,
        });
        if (result?.deleted) batchDeleted += 1;
      }
      deleted += batchDeleted;
      if (!batchDeleted) break;
    }
    return { deleted, retentionDays: days, kinds: ['pdd-evidence', 'tms-evidence'] };
  }

  async ingestWorkerAsset(input) {
    const shopId = String(input.shopId || '').trim();
    const sourcePath = String(input.sourcePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
    const mimeType = String(input.mimeType || 'image/png');
    const bytes = Buffer.from(String(input.contentBase64 || ''), 'base64');
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!shopId || !bytes.length) throw new Error('worker-asset-invalid');
    if (input.sha256 && !safeHashEqual(String(input.sha256), actualHash)) throw new Error('worker-asset-hash-mismatch');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new Error('worker-asset-mime-invalid');
    const baseName = path.basename(sourcePath || `${actualHash}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    let workOrderId = null;
    let ordinaryInstanceId = null;
    const orderNumber = String(input.orderNumber || '').trim();
    if (orderNumber) {
      const candidates = await this.pool.query(`SELECT id, work_order_type, current_ordinary_instance_id FROM work_orders
        WHERE shop_id = $1 AND external_order_number = $2 ORDER BY updated_at DESC`, [shopId, orderNumber]);
      const normalizedType = normalizeWorkOrderType(input.workOrderType);
      const selectedWorkOrder = (normalizedType
        ? candidates.rows.find((candidate) => normalizeWorkOrderType(candidate.work_order_type) === normalizedType)
        : candidates.rows[0]) || null;
      workOrderId = selectedWorkOrder?.id || null;
      if (workOrderId) {
        const requestedInstanceId = String(input.ordinaryInstanceId || '').trim();
        const requestedPlatformCaseKey = String(input.platformCaseKey || '').trim();
        const validInstanceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
          .test(requestedInstanceId) ? requestedInstanceId : null;
        const validPlatformCaseKey = /^pdd-work-order:[0-9]{6,30}$/u.test(requestedPlatformCaseKey)
          ? requestedPlatformCaseKey : null;
        if ((requestedInstanceId && !validInstanceId) || (requestedPlatformCaseKey && !validPlatformCaseKey)) {
          throw new Error('worker-asset-ordinary-instance-mismatch');
        }
        if (validInstanceId || validPlatformCaseKey) {
          const instance = await this.pool.query(`
            SELECT id FROM ordinary_work_order_instances
            WHERE work_order_id = $1
              AND ($2::uuid IS NULL OR id = $2::uuid)
              AND ($3::text IS NULL OR platform_case_key = $3)
            LIMIT 1`, [workOrderId, validInstanceId, validPlatformCaseKey]);
          if (!instance.rowCount) throw new Error('worker-asset-ordinary-instance-mismatch');
          ordinaryInstanceId = instance.rows[0].id;
        } else {
          ordinaryInstanceId = selectedWorkOrder.current_ordinary_instance_id || null;
        }
      }
    }
    if (!workOrderId && (String(input.ordinaryInstanceId || '').trim() || String(input.platformCaseKey || '').trim())) {
      throw new Error('worker-asset-ordinary-instance-mismatch');
    }
    const objectScope = ordinaryInstanceId || workOrderId || 'unbound';
    const objectKey = `windows/${shopId}/${objectScope}/${actualHash}/${baseName}`;

    const { client: s3Client, aws } = await this.s3();
    await s3Client.send(new aws.PutObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: objectKey, Body: bytes, ContentType: mimeType,
      Metadata: { sha256: actualHash, shopid: shopId },
    }));

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const evidence = await client.query(`
        INSERT INTO evidence_assets
          (id, work_order_id, ordinary_instance_id, shop_id, kind, status,
           object_key, mime_type, size_bytes, sha256, source_path)
        VALUES ($1,$2,$3,$4,$5,'ready',$6,$7,$8,$9,$10)
        ON CONFLICT (shop_id, object_key, sha256) WHERE shop_id IS NOT NULL AND sha256 IS NOT NULL
        DO UPDATE SET work_order_id = EXCLUDED.work_order_id,
          ordinary_instance_id = EXCLUDED.ordinary_instance_id,
          status = 'ready', deleted_at = NULL
        RETURNING id, work_order_id AS "workOrderId", ordinary_instance_id AS "ordinaryInstanceId",
          object_key AS "objectKey", size_bytes AS "sizeBytes", sha256`,
      [crypto.randomUUID(), workOrderId, ordinaryInstanceId, shopId,
        input.kind || 'diagnostic-screenshot', objectKey, mimeType, bytes.length,
        actualHash, sourcePath || null]);
      if (input.verificationId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(input.verificationId))) {
        await client.query(`UPDATE verification_locations SET screenshot_file_id = $2
          WHERE id = $1::uuid AND shop_id = $3
            AND ordinary_instance_id IS NOT DISTINCT FROM $4::uuid`,
        [input.verificationId, evidence.rows[0].id, shopId, ordinaryInstanceId]);
      }
      await client.query('COMMIT');
      return evidence.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveVerification(id) {
    const result = await this.pool.query(`
      UPDATE verification_locations SET status = 'resolved', resolved_at = now()
      WHERE id = $1::uuid RETURNING id, shop_id AS "shopId", system_name AS system, stage, status, url, resolved_at AS "resolvedAt"`, [id]);
    return result.rows[0] || null;
  }

  async requestVerificationRecheck(id, { actorId }) {
    const result = await this.pool.query(`
      INSERT INTO operator_commands
        (id, shop_id, work_order_id, ordinary_instance_id, command_type, payload, requested_by)
      SELECT $2, v.shop_id, v.work_order_id, v.ordinary_instance_id, 'verification-recheck',
        jsonb_build_object(
          'verificationId', v.id::text,
          'ordinaryInstanceId', v.ordinary_instance_id::text
        ), $3
      FROM verification_locations v
      JOIN work_orders work_order ON work_order.id = v.work_order_id
      WHERE v.id = $1::uuid
        AND v.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
      RETURNING id, shop_id AS "shopId", work_order_id AS "workOrderId",
        command_type AS "commandType", status, requested_at AS "requestedAt"`,
    [id, crypto.randomUUID(), actorId]);
    return result.rows[0] || null;
  }

  async requestVerificationForceClear(id, { actorId, reason = '' }) {
    const verification = await this.pool.query(`
      SELECT work_order_id, ordinary_instance_id
      FROM verification_locations WHERE id = $1::uuid`, [id]);
    const workOrderId = verification.rows[0]?.work_order_id;
    if (!workOrderId) return null;
    return this.createOperatorCommand(workOrderId, {
      commandType: 'force-clear-verification',
      ordinaryInstanceId: verification.rows[0].ordinary_instance_id || null,
      payload: {
        verificationId: id,
        ordinaryInstanceId: verification.rows[0].ordinary_instance_id || null,
        reason: reason || '所有者确认页面已无验证码，强制解除并继续当前工单',
      },
      actorId,
    });
  }

  async requestVerificationRefreshNext(id, { actorId, reason = '' }) {
    const verification = await this.pool.query(`
      SELECT work_order_id, ordinary_instance_id
      FROM verification_locations WHERE id = $1::uuid`, [id]);
    const workOrderId = verification.rows[0]?.work_order_id;
    if (!workOrderId) return null;
    return this.createOperatorCommand(workOrderId, {
      commandType: 'refresh-next-order',
      ordinaryInstanceId: verification.rows[0].ordinary_instance_id || null,
      payload: {
        verificationId: id,
        ordinaryInstanceId: verification.rows[0].ordinary_instance_id || null,
        reason: reason || '所有者要求刷新当前页面并处理下一单',
      },
      actorId,
    });
  }

  async listLogs(query = {}) {
    const where = [];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (query.shopId) add('e.shop_id = ?', String(query.shopId));
    if (query.workOrderId) add('e.work_order_id = ?::uuid', String(query.workOrderId));
    if (query.orderNumber) add('e.external_order_number = ?', String(query.orderNumber));
    if (query.system) add('e.system_name = ?', String(query.system));
    if (query.severity) add('e.severity = ?', String(query.severity));
    if (query.reasonCode) add('e.reason_code = ?', String(query.reasonCode));
    if (query.scenarioCode) add(`EXISTS (
      SELECT 1 FROM work_orders scenario_order
      LEFT JOIN ordinary_work_order_instances scenario_instance
        ON scenario_instance.id = e.ordinary_instance_id
      WHERE scenario_order.id = e.work_order_id
        AND coalesce(scenario_instance.scenario_code, scenario_order.scenario_code) = ?
    )`, canonicalScenarioCode(query.scenarioCode));
    addPostgresDateFilters({ where, params, column: 'e.occurred_at', query });
    if (query.q) add(`(
      coalesce(e.external_order_number,'') ILIKE '%' || ? || '%'
      OR coalesce(e.stage,'') ILIKE '%' || $${params.length + 1} || '%'
      OR coalesce(e.message,'') ILIKE '%' || $${params.length + 1} || '%'
      OR EXISTS (
        SELECT 1 FROM ordinary_work_order_instances search_instance
        WHERE search_instance.id = e.ordinary_instance_id
          AND coalesce(search_instance.platform_case_key, '') ILIKE '%' || $${params.length + 1} || '%'
      )
    )`, String(query.q));
    const page = Math.max(1, Number(query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize || 50)));
    const payloadColumn = workflowLogPayloadRequested(query) ? ', e.payload' : '';
    const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let total = null;
    let totalIsEstimate = false;
    if (workflowLogTotalRequested(query)) {
      if (where.length) {
        total = Number((await this.pool.query(
          `SELECT count(*)::int AS total FROM workflow_events e ${condition}`,
          params,
        )).rows[0].total);
      } else {
        total = Number((await this.pool.query(`
          SELECT greatest(round(reltuples), 0)::bigint AS total
          FROM pg_class
          WHERE oid = 'workflow_events'::regclass`)).rows[0]?.total || 0);
        totalIsEstimate = true;
      }
    }
    params.push(pageSize, (page - 1) * pageSize);
    const result = await this.pool.query(`
      SELECT e.id, e.event_key AS "eventKey", e.shop_id AS "shopId", e.work_order_id AS "workOrderId",
        e.ordinary_instance_id AS "ordinaryInstanceId",
        ordinary.platform_case_id AS "platformCaseId", ordinary.platform_case_key AS "platformCaseKey",
        e.external_order_number AS "orderNumber", e.system_name AS system, e.stage, e.event_type AS "eventType",
        e.severity, e.reason_code AS "reasonCode", e.message${payloadColumn},
        e.occurred_at AS "occurredAt", e.received_at AS "receivedAt"
      FROM workflow_events e
      LEFT JOIN ordinary_work_order_instances ordinary ON ordinary.id = e.ordinary_instance_id
      ${condition}
      ORDER BY e.occurred_at DESC, e.received_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    if (totalIsEstimate) total = Math.max(total, ((page - 1) * pageSize) + result.rows.length);
    return { data: result.rows, page, pageSize, total, totalIsEstimate };
  }

  async listAuditEvents(query = {}) {
    const where = [];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (query.shopId) add('a.shop_id = ?', String(query.shopId));
    addPostgresDateFilters({ where, params, column: 'a.created_at', query });
    if (query.q) {
      params.push(String(query.q));
      where.push(`(
        coalesce(a.actor_id, '') ILIKE '%' || $${params.length} || '%'
        OR a.event_type ILIKE '%' || $${params.length} || '%'
        OR a.payload::text ILIKE '%' || $${params.length} || '%'
        OR coalesce(w.external_order_number, '') ILIKE '%' || $${params.length} || '%'
      )`);
    }
    const page = Math.max(1, Number(query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize || 100)));
    const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.pool.query(`
      SELECT count(*)::int AS total
      FROM audit_events a
      LEFT JOIN work_orders w ON w.id = a.work_order_id
      ${condition}`, params)).rows[0].total);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await this.pool.query(`
      SELECT a.id, a.shop_id AS "shopId", a.work_order_id AS "workOrderId",
        w.external_order_number AS "orderNumber", a.actor_id AS "actorId",
        a.event_type AS "eventType", a.payload, a.created_at AS "createdAt"
      FROM audit_events a
      LEFT JOIN work_orders w ON w.id = a.work_order_id
      ${condition}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { data: result.rows, page, pageSize, total };
  }

  async recordAuditEvent({ shopId = null, workOrderId = null, actorId = null, eventType, payload = {} }) {
    const result = await this.pool.query(`
      INSERT INTO audit_events (shop_id, work_order_id, actor_id, event_type, payload)
      VALUES ($1,$2,$3,$4,$5::jsonb)
      RETURNING id, shop_id AS "shopId", work_order_id AS "workOrderId",
        actor_id AS "actorId", event_type AS "eventType", payload, created_at AS "createdAt"`,
    [shopId, workOrderId, actorId, eventType, JSON.stringify(payload)]);
    return result.rows[0] || null;
  }

  async listManualInterventions(query = {}) {
    const params = [];
    const where = [];
    const includeNonActionable = ['true', '1'].includes(
      String(query.includeNonActionable || '').trim().toLowerCase(),
    );
    if (!includeNonActionable) {
      params.push(nonActionableManualInterventionReasonCodes);
      where.push(`coalesce(i.reason_code, '') <> ALL($${params.length}::text[])`);
    }
    if (query.channel) { params.push(String(query.channel)); where.push(`i.channel = $${params.length}`); }
    if (query.status) { params.push(String(query.status)); where.push(`i.status = $${params.length}`); }
    if (query.shopId) { params.push(String(query.shopId)); where.push(`i.shop_id = $${params.length}`); }
    if (query.scenarioCode) {
      params.push(canonicalScenarioCode(query.scenarioCode));
      where.push(`coalesce(instance.scenario_code, w.scenario_code) = $${params.length}`);
    }
    addPostgresDateFilters({ where, params, column: 'i.created_at', query });
    const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.pool.query(`
      SELECT i.id, i.shop_id AS "shopId", i.work_order_id AS "workOrderId", i.channel,
        i.ordinary_instance_id AS "ordinaryInstanceId",
        instance.platform_case_id AS "platformCaseId", instance.platform_case_key AS "platformCaseKey",
        i.reason_code AS "reasonCode", i.reason, i.risk_level AS "riskLevel", i.status,
        i.created_at AS "createdAt", i.acknowledged_at AS "acknowledgedAt", i.resolved_at AS "resolvedAt",
        w.external_order_number AS "orderNumber",
        coalesce(instance.work_order_type, w.work_order_type) AS "workOrderType",
        coalesce(instance.scenario_code, w.scenario_code) AS "scenarioCode",
        refund.aftersale_number AS "aftersaleNumber",
        refund.refund_amount AS "refundAmount", refund.action_state AS "refundActionState",
        refund.completed_at AS "closedAt",
        n.status AS "notificationStatus", n.attempt_count AS "notificationAttempts", n.last_error AS "notificationError",
        n.payload->>'deliverySource' AS "deliverySource"
      FROM manual_interventions i
      LEFT JOIN work_orders w ON w.id = i.work_order_id
      LEFT JOIN ordinary_work_order_instances instance ON instance.id = i.ordinary_instance_id
      LEFT JOIN return_refunds refund ON refund.work_order_id = w.id
      LEFT JOIN LATERAL (
        SELECT status, attempt_count, last_error, payload FROM notification_outbox
        WHERE intervention_id = i.id ORDER BY created_at DESC LIMIT 1
      ) n ON true
      ${condition} ORDER BY i.created_at DESC LIMIT 500`, params);
    return { data: result.rows, total: result.rowCount };
  }

  async ingestWorkerEvents(events, { sourceId = 'windows-native' } = {}) {
    const client = await this.pool.connect();
    const accepted = [];
    const duplicates = [];
    const rejected = [];
    const eventOnlySourceIds = new Set(String(process.env.WORKER_EVENT_ONLY_SOURCE_IDS || 'windows-native')
      .split(',').map((value) => value.trim()).filter(Boolean));
    const lifecycleAuthoritative = !eventOnlySourceIds.has(sourceId);
    try {
      await client.query('BEGIN');
      const dingtalkSetting = await client.query(`
        SELECT value FROM system_settings WHERE key = 'dingtalk-automatic-enabled'`);
      const dingtalkAutomaticEnabled = dingtalkSetting.rows[0]?.value === true;
      await assertKnownShops(client, events.map((event) => event?.shopId));
      for (const raw of events.slice(0, 500)) {
        const eventKey = String(raw.eventKey || '').trim();
        const shopId = String(raw.shopId || '').trim();
        const stage = String(raw.stage || '').trim();
        const occurredAt = raw.occurredAt || new Date().toISOString();
        if (!eventKey || !shopId || !stage) continue;

        const orderNumber = String(raw.orderNumber || '').trim() || null;
        const scenarioCode = canonicalScenarioCode(raw.scenarioCode) || null;
        const workOrderType = String(raw.workOrderType || scenarioCode || 'pdd-work-order').trim();
        const runtimeStatus = String(raw.runtimeStatus || 'processing');
        const legacyStatus = runtimeStatus === 'completed' ? 'archived'
          : runtimeStatus === 'failed' ? 'failed'
            : runtimeStatus === 'processing' ? 'processing'
              : runtimeStatus === 'queued' ? 'queued' : 'paused';
        const snapshot = raw.payload?.snapshot || {};
        const completionInfo = completionInfoFromPayload(snapshot, { runtimeStatus });
        const systemClassification = runtimeStatus === 'manual-review' || snapshot.manualReview?.reason ? 'manual' : 'automated';
        const ordinaryIdentity = workerEventOrdinaryIdentity(raw);
        if (ordinaryIdentity.malformed) {
          rejected.push({
            eventKey,
            code: 'ORDINARY_INSTANCE_INVALID',
            orderNumber,
          });
          continue;
        }
        if (ordinaryIdentity.supplied && !orderNumber) {
          rejected.push({
            eventKey,
            code: 'ORDINARY_INSTANCE_ORDER_REQUIRED',
            orderNumber: null,
          });
          continue;
        }
        let workOrderId = null;
        let ordinaryInstanceId = null;
        let eventTargetsCurrentInstance = true;
        if (orderNumber) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${shopId}:${orderNumber}`]);
          if (ordinaryIdentity.supplied) {
            const boundIdentity = await client.query(`
              SELECT instance.id AS ordinary_instance_id, instance.work_order_id,
                work_order.current_ordinary_instance_id,
                instance.id = work_order.current_ordinary_instance_id AS is_current
              FROM ordinary_work_order_instances instance
              JOIN work_orders work_order ON work_order.id = instance.work_order_id
              WHERE instance.shop_id = $1
                AND work_order.shop_id = $1
                AND work_order.external_order_number = $2
                AND coalesce(work_order.frontend_visibility, 'operational') <> 'recovery-audit'
                AND ($3::uuid IS NULL OR instance.id = $3::uuid)
                AND ($4::text IS NULL OR instance.platform_case_key = $4)
              LIMIT 1`, [
              shopId,
              orderNumber,
              ordinaryIdentity.ordinaryInstanceId,
              ordinaryIdentity.platformCaseKey,
            ]);
            if (!boundIdentity.rowCount) {
              rejected.push({
                eventKey,
                code: 'ORDINARY_INSTANCE_MISMATCH',
                orderNumber,
              });
              continue;
            }
            workOrderId = boundIdentity.rows[0].work_order_id;
            ordinaryInstanceId = boundIdentity.rows[0].ordinary_instance_id;
            eventTargetsCurrentInstance = boundIdentity.rows[0].is_current === true;
          } else {
            const candidates = await client.query(`
              SELECT id, shop_id, work_order_type, scenario_code, idempotency_key, status, updated_at,
                frontend_visibility, current_step
              FROM work_orders
              WHERE external_order_number = $1 AND shop_id = $2
              ORDER BY CASE WHEN idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END, updated_at DESC`,
            [orderNumber, shopId]);
            const deletionTombstone = candidates.rows.some((candidate) => (
              candidate.frontend_visibility === 'recovery-audit' && candidate.current_step === 'owner-deleted'
            ));
            const activeCandidates = candidates.rows.filter((candidate) => candidate.frontend_visibility !== 'recovery-audit');
            const normalizedType = normalizeWorkOrderType(workOrderType);
            const scenarioMatch = scenarioCode
              ? activeCandidates.find((candidate) => canonicalScenarioCode(candidate.scenario_code) === scenarioCode)
              : null;
            const typeMatch = activeCandidates.find(
              (candidate) => normalizeWorkOrderType(candidate.work_order_type) === normalizedType,
            );
            const discoveredMatch = activeCandidates.find(
              (candidate) => String(candidate.idempotency_key || '').startsWith('pdd-discovered:'),
            );
            workOrderId = scenarioMatch?.id || typeMatch?.id || discoveredMatch?.id
              || (lifecycleAuthoritative ? activeCandidates[0]?.id : null) || null;
            if (!workOrderId && lifecycleAuthoritative && !deletionTombstone) {
              const proposedId = crypto.randomUUID();
              const idempotencyKey = `worker-event:${shopId}:${orderNumber}:${normalizedType || workOrderType}`;
              await client.query(`
                INSERT INTO work_orders
                  (id, shop_id, external_order_number, work_order_type, scenario_code, status, runtime_status,
                   handling_classification, classification_source, classification_updated_at,
                   idempotency_key, current_step, payload, latest_event_at,
                   completion_state, completion_confirmation_method, completion_confirmed_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'system',$9,$10,$11,$12::jsonb,$9,$13,$14,$15)
                ON CONFLICT DO NOTHING`,
              [proposedId, shopId, orderNumber, workOrderType, scenarioCode, legacyStatus, runtimeStatus,
                systemClassification, occurredAt, idempotencyKey, stage, stringifyJsonb(snapshot),
                completionInfo.state, completionInfo.confirmationMethod, completionInfo.confirmedAt]);
              const selected = await client.query(`
                SELECT id FROM work_orders
                WHERE shop_id = $3
                  AND coalesce(frontend_visibility, 'operational') <> 'recovery-audit'
                  AND (idempotency_key = $1 OR external_order_number = $2)
                ORDER BY CASE WHEN idempotency_key = $1 THEN 0 ELSE 1 END,
                  CASE WHEN idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END,
                  updated_at DESC
                LIMIT 1`,
              [idempotencyKey, orderNumber, shopId]);
              workOrderId = selected.rows[0]?.id || null;
            }
          }
        }

        if (workOrderId && !ordinaryIdentity.supplied) {
          const boundInstance = await client.query(`
            SELECT current_ordinary_instance_id
            FROM work_orders work_order
            WHERE work_order.id = $1
            LIMIT 1`, [workOrderId]);
          eventTargetsCurrentInstance = !boundInstance.rows[0]?.current_ordinary_instance_id;
        }
        const eventHasSafeInstanceBinding = eventTargetsCurrentInstance || Boolean(ordinaryInstanceId);

        const eventId = crypto.randomUUID();
        const inserted = await client.query(`
          INSERT INTO workflow_events
            (id, event_key, shop_id, work_order_id, ordinary_instance_id, external_order_number, run_id, sequence,
             system_name, stage, event_type, severity, reason_code, message, payload, source_hash, occurred_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)
          ON CONFLICT (event_key) DO NOTHING RETURNING id`,
        [eventId, eventKey, shopId, workOrderId, ordinaryInstanceId, orderNumber,
          raw.sessionId || null, Number(raw.sequence || 0),
          raw.system || 'pdd', stage, raw.eventType || 'workflow.progress', raw.severity || 'info',
          raw.reasonCode || null, raw.message || null, stringifyJsonb(raw.payload || {}),
          raw.sourceHash || crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex'), occurredAt]);
        if (!inserted.rowCount) {
          duplicates.push(eventKey);
          continue;
        }
        accepted.push(eventKey);

        if (workOrderId && eventTargetsCurrentInstance) {
          await client.query(`
            UPDATE work_orders
            SET latest_event_at = $2, updated_at = now()
            WHERE id = $1 AND frontend_visibility = 'operational'
              AND (latest_event_at IS NULL OR latest_event_at < $2)`,
          [workOrderId, occurredAt]);
        }

        if (workOrderId && lifecycleAuthoritative && eventTargetsCurrentInstance) {
          await client.query(`
            UPDATE work_orders SET status = $2, runtime_status = $3, current_step = $4,
              scenario_code = coalesce($5, scenario_code),
              payload = $6::jsonb || CASE WHEN payload ? 'manualOverrides'
                THEN jsonb_build_object('manualOverrides', payload->'manualOverrides') ELSE '{}'::jsonb END,
              handling_classification = CASE WHEN classification_source = 'admin-override' THEN handling_classification ELSE $7 END,
              classification_updated_at = CASE WHEN classification_source = 'admin-override' THEN classification_updated_at ELSE $8 END,
              completion_state = $9, completion_confirmation_method = $10,
              completion_confirmed_at = $11, latest_event_at = $8, updated_at = now()
            WHERE id = $1 AND frontend_visibility = 'operational'
              AND (latest_event_at IS NULL OR latest_event_at <= $8)`,
          [workOrderId, legacyStatus, runtimeStatus, stage, scenarioCode,
            stringifyJsonb(raw.payload?.snapshot || {}), systemClassification, occurredAt,
            completionInfo.state, completionInfo.confirmationMethod, completionInfo.confirmedAt]);
        }

        if (workOrderId && eventHasSafeInstanceBinding && snapshot.logisticsAnalysis) {
          const sourceHash = crypto.createHash('sha256').update(JSON.stringify(snapshot.logisticsAnalysis)).digest('hex');
          await client.query(`
            INSERT INTO logistics_analyses (work_order_id, ordinary_instance_id, payload, source_hash)
            VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
          [workOrderId, ordinaryInstanceId, stringifyJsonb(snapshot.logisticsAnalysis), sourceHash]);
        }
        if (workOrderId && eventHasSafeInstanceBinding && snapshot.omsAnalysis) {
          const sourceHash = crypto.createHash('sha256').update(JSON.stringify(snapshot.omsAnalysis)).digest('hex');
          await client.query(`
            INSERT INTO oms_analyses (work_order_id, ordinary_instance_id, payload, source_hash)
            VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
          [workOrderId, ordinaryInstanceId, stringifyJsonb(snapshot.omsAnalysis), sourceHash]);
        }
        if (workOrderId && eventHasSafeInstanceBinding && snapshot.tmsWorkOrder) {
          const tmsPayload = snapshot.tmsWorkOrder;
          let tmsScenario = workerEventTmsScenario(raw);
          if (tmsScenario.scenarioCode === 'unknown') {
            const persistedScenario = await client.query(`
              SELECT instance.scenario_code AS ordinary_instance_scenario_code,
                work_order.scenario_code AS work_order_scenario_code
              FROM work_orders work_order
              LEFT JOIN ordinary_work_order_instances instance
                ON instance.work_order_id = work_order.id
                AND instance.id = $2::uuid
              WHERE work_order.id = $1
              LIMIT 1`, [workOrderId, ordinaryInstanceId]);
            tmsScenario = workerEventTmsScenario(raw, {
              ordinaryInstanceScenarioCode: persistedScenario.rows[0]?.ordinary_instance_scenario_code,
              workOrderScenarioCode: persistedScenario.rows[0]?.work_order_scenario_code,
            });
          }
          const requestHash = crypto.createHash('sha256').update(JSON.stringify({
            orderNumber, scenarioCode: tmsScenario.scenarioCode,
            problemType: tmsPayload.problemType, customerRemark: tmsPayload.customerRemark,
          })).digest('hex');
          await client.query(`
            INSERT INTO tms_work_orders
              (id, work_order_id, ordinary_instance_id, scenario_code,
               external_ticket_id, status, request_hash, payload)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
            ON CONFLICT (
              work_order_id,
              coalesce(ordinary_instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
              scenario_code,
              request_hash
            ) DO UPDATE SET
              external_ticket_id = coalesce(EXCLUDED.external_ticket_id, tms_work_orders.external_ticket_id),
              status = EXCLUDED.status, payload = EXCLUDED.payload`,
          [crypto.randomUUID(), workOrderId, ordinaryInstanceId,
            tmsScenario.scenarioCode,
            tmsPayload.ticketId || tmsPayload.ticketNo || null, tmsPayload.status || 'observed', requestHash,
            stringifyJsonb(tmsPayload)]);
        }
        const verification = snapshot.verificationLocation;
        if (eventHasSafeInstanceBinding
          && verification?.id
          && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(verification.id))) {
          await client.query(`
            UPDATE verification_locations SET status = 'expired', resolved_at = coalesce(resolved_at, $4)
            WHERE shop_id = $1 AND system_name = $2 AND id <> $3::uuid
              AND ordinary_instance_id IS NOT DISTINCT FROM $5::uuid
              AND status IN ('detected', 'waiting-human')`,
          [shopId, verification.system || raw.system || 'pdd', verification.id, occurredAt, ordinaryInstanceId]);
          await client.query(`
            INSERT INTO verification_locations
              (id, shop_id, work_order_id, ordinary_instance_id, system_name, stage, status, url, frame_url, selector,
               bounding_box, confidence, detected_at, resolved_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
            ON CONFLICT (id) DO UPDATE SET work_order_id = coalesce(EXCLUDED.work_order_id, verification_locations.work_order_id),
              ordinary_instance_id = coalesce(EXCLUDED.ordinary_instance_id, verification_locations.ordinary_instance_id),
              system_name = EXCLUDED.system_name, stage = EXCLUDED.stage, status = EXCLUDED.status,
              url = EXCLUDED.url, frame_url = EXCLUDED.frame_url, selector = EXCLUDED.selector,
              bounding_box = EXCLUDED.bounding_box, confidence = EXCLUDED.confidence,
              resolved_at = EXCLUDED.resolved_at`,
          [verification.id, shopId, workOrderId, ordinaryInstanceId, verification.system || raw.system || 'pdd',
            verification.stage || stage, verification.status || 'waiting-human', verification.url || snapshot.currentUrl || '',
            verification.frameUrl || null, verification.selector || null,
            stringifyJsonb(verification.boundingBox || { x: 0, y: 0, width: 0, height: 0 }),
            verification.confidence || 'medium', verification.detectedAt || occurredAt,
            verification.resolvedAt || null]);
        } else if (eventHasSafeInstanceBinding
          && !/^(?:human-verification-required|manual-login-required|required-login)$/u.test(String(stage || ''))) {
          await client.query(`
            UPDATE verification_locations SET status = 'resolved', resolved_at = coalesce(resolved_at, $2)
            WHERE shop_id = $1 AND work_order_id IS NOT DISTINCT FROM $4::uuid
              AND status IN ('detected', 'waiting-human', 'verification-required')
              AND detected_at <= $2
              AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid`,
          [shopId, occurredAt, ordinaryInstanceId, workOrderId]);
        }
        const snapshotVerificationIsActive = snapshot.verificationLocation
          && activeVerificationStatuses.has(String(snapshot.verificationLocation.status || 'waiting-human'))
          && !snapshot.verificationLocation.resolvedAt;
        if (eventTargetsCurrentInstance) {
          await client.query(`
            INSERT INTO workflow_checkpoints
              (shop_id, work_order_id, ordinary_instance_id, external_order_number,
               current_step, runtime_status, snapshot, source_hash, source_updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
            ON CONFLICT (shop_id) DO UPDATE SET work_order_id = EXCLUDED.work_order_id,
              ordinary_instance_id = EXCLUDED.ordinary_instance_id,
              external_order_number = EXCLUDED.external_order_number, current_step = EXCLUDED.current_step,
              runtime_status = EXCLUDED.runtime_status, snapshot = EXCLUDED.snapshot,
              source_hash = EXCLUDED.source_hash, source_updated_at = EXCLUDED.source_updated_at, synchronized_at = now()
            WHERE workflow_checkpoints.source_updated_at <= EXCLUDED.source_updated_at`,
          [shopId, workOrderId, ordinaryInstanceId, orderNumber, stage, runtimeStatus, stringifyJsonb(snapshot),
            raw.sourceHash || crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), occurredAt]);
        }

        const verificationClearedByCurrentEvent = workOrderId
          && eventTargetsCurrentInstance
          && eventHasSafeInstanceBinding
          && !snapshotVerificationIsActive
          && !/^(?:human-verification-required|manual-login-required|required-login)$/u.test(stage);
        if (verificationClearedByCurrentEvent) {
          await resolveClearedVerificationInterventions(client, {
            shopId,
            workOrderId,
            resolvedAt: occurredAt,
            resolvedBy: 'worker-event-verification-cleared',
          });
          const resumed = await client.query(`
            UPDATE work_orders work_order SET
              status = 'retry-ready',
              runtime_status = 'retry-ready',
              current_step = 'verification-cleared-retry-ready',
              next_attempt_at = now(),
              manual_review_reason = NULL,
              payload = (
                coalesce(work_order.payload, '{}'::jsonb)
                  - 'verificationLocation'
                  - 'verificationStage'
                  - 'verificationFocus'
                  - 'verificationRecovery'
              ) || jsonb_build_object(
                'step', 'verification-cleared-retry-ready',
                'updatedAt', now(),
                'verificationRecheck',
                  coalesce(work_order.payload->'verificationRecheck', '{}'::jsonb)
                    || jsonb_build_object(
                      'trigger', 'worker-event-verification-cleared',
                      'status', 'retry-ready',
                      'verificationState', 'resolved',
                      'completedAt', $2::timestamptz
                    )
              ),
              updated_at = now()
            WHERE work_order.id = $1
              AND work_order.status IN ('retry-ready', 'paused', 'failed')
              AND work_order.current_step = 'human-verification-required'
              AND work_order.current_ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
              AND NOT EXISTS (
                SELECT 1 FROM verification_locations verification
                WHERE verification.shop_id = work_order.shop_id
                  AND verification.work_order_id = work_order.id
                  AND verification.ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
                  AND verification.status IN ('detected', 'waiting-human', 'verification-required')
                  AND verification.resolved_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM external_effects effect
                WHERE effect.work_order_id = work_order.id
                  AND effect.ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
                  AND effect.status IN ('reserved', 'unknown')
              )
            RETURNING work_order.id, work_order.current_ordinary_instance_id, work_order.payload`,
          [workOrderId, occurredAt, ordinaryInstanceId]);
          if (resumed.rowCount) {
            await client.query(`
              UPDATE ordinary_work_order_instances instance SET
                status = 'retry-ready',
                runtime_status = 'retry-ready',
                current_step = 'verification-cleared-retry-ready',
                next_attempt_at = now(),
                manual_review_reason = NULL,
                payload = $2::jsonb,
                updated_at = now()
              WHERE instance.id = $1`, [
              resumed.rows[0].current_ordinary_instance_id,
              stringifyJsonb(resumed.rows[0].payload),
            ]);
          }
        }

        await client.query(`
          INSERT INTO sync_cursors (source_id, shop_id, last_sequence, last_event_key, last_snapshot_hash, backlog_count, last_success_at)
          VALUES ($1,$2,$3,$4,$5,0,now())
          ON CONFLICT (source_id, shop_id) DO UPDATE SET
            last_sequence = greatest(sync_cursors.last_sequence, EXCLUDED.last_sequence),
            last_event_key = EXCLUDED.last_event_key, last_snapshot_hash = EXCLUDED.last_snapshot_hash,
            backlog_count = 0, last_success_at = now(), last_error = NULL, updated_at = now()`,
        [sourceId, shopId, Number(raw.sequence || 0), eventKey, raw.sourceHash || null]);

        const transientBrowserCloseEvent = raw.reasonCode === 'external-system-error'
          && isTransientBrowserClosedError(raw.message);
        const returnRefundRecoverySignal = transientBrowserCloseEvent
          || operationalReasonCodes.has(raw.reasonCode)
          || runtimeStatus === 'completed';
        const returnRefundBrowserCloseReconciliation = workOrderId
          && eventHasSafeInstanceBinding
          && returnRefundRecoverySignal
          ? await resolveRecoveredReturnRefundBrowserCloseInterventions(client, {
            workOrderId,
            resolvedAt: occurredAt,
          })
          : { eligibleWorkOrderIds: [], resolvedIds: [] };
        const suppressRecoveredReturnRefundBrowserClose = transientBrowserCloseEvent
          && returnRefundBrowserCloseReconciliation.eligibleWorkOrderIds.includes(workOrderId);

        if (workOrderId && eventHasSafeInstanceBinding && runtimeStatus === 'completed') {
          await client.query(`
            UPDATE manual_interventions SET status = 'resolved', resolved_at = coalesce(resolved_at, $2)
            WHERE work_order_id = $1 AND status = 'open'
              AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
              AND created_at <= $2::timestamptz`,
          [workOrderId, occurredAt, ordinaryInstanceId]);
        } else if (workOrderId && eventHasSafeInstanceBinding) {
          const resolvedReasonCodes = operationalReasonCodes.has(raw.reasonCode)
            ? [...transientInterventionReasonCodes]
            : raw.reasonCode ? [] : [...transientInterventionReasonCodes];
          if (resolvedReasonCodes.length) {
            await client.query(`
              UPDATE manual_interventions SET status = 'resolved', resolved_at = coalesce(resolved_at, $3)
              WHERE work_order_id = $1 AND status = 'open' AND reason_code = ANY($2::text[])
                AND ordinary_instance_id IS NOT DISTINCT FROM $4::uuid
                AND created_at <= $3::timestamptz`,
            [workOrderId, resolvedReasonCodes, occurredAt, ordinaryInstanceId]);
          }
        }

        if (workOrderId && eventHasSafeInstanceBinding
          && uploadFailureReasonCodes.has(raw.reasonCode)) {
          await client.query(`
            UPDATE manual_interventions SET status = 'resolved',
              resolved_at = coalesce(resolved_at, $3),
              resolved_by = coalesce(resolved_by, 'specific-upload-failure-superseded')
            WHERE work_order_id = $1
              AND ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
              AND status IN ('open', 'acknowledged')
              AND reason_code = 'external-system-error'
              AND reason ~* '(48143|非法请求|凭证.*上传|图片.*上传|附件.*上传)'
              AND created_at <= $3::timestamptz`,
          [workOrderId, ordinaryInstanceId, occurredAt]);
        }

        if (eventHasSafeInstanceBinding
          && raw.reasonCode
          && !['completed', 'archived'].includes(runtimeStatus)
          && !suppressRecoveredReturnRefundBrowserClose
          && !nonActionableManualInterventionReasonCodes.includes(raw.reasonCode)
          && !durableNotifierInterventionReasonCodes.has(raw.reasonCode)) {
          const dashboardDeduplicationKey = `dashboard:${shopId}:${orderNumber || 'none'}:${ordinaryInstanceId || 'no-instance'}:${stage}:${raw.reasonCode}`;
          await client.query(`
            INSERT INTO manual_interventions
              (id, shop_id, work_order_id, ordinary_instance_id, channel,
               reason_code, reason, risk_level, deduplication_key)
            SELECT $1,$2,$3,$4,'dashboard',$5,$6,$7,$8
            WHERE EXISTS (
              SELECT 1 FROM work_orders current_work_order
              WHERE current_work_order.id = $3
                AND current_work_order.status NOT IN ('completed', 'archived')
                AND coalesce(current_work_order.completion_state, 'pending')
                  NOT IN ('confirmed', 'not-applicable')
            )
            AND NOT (
              $5 = 'external-system-error'
              AND $6 ~* '(48143|非法请求|凭证.*上传|图片.*上传|附件.*上传)'
              AND EXISTS (
                SELECT 1 FROM manual_interventions specific
                WHERE specific.work_order_id = $3
                  AND specific.ordinary_instance_id IS NOT DISTINCT FROM $4::uuid
                  AND specific.reason_code IN (
                    'image-upload-failed', 'pdd-upload-authorization-failed'
                  )
              )
            )
            ON CONFLICT (deduplication_key) DO NOTHING`,
          [crypto.randomUUID(), shopId, workOrderId, ordinaryInstanceId, raw.reasonCode,
            raw.message || raw.reasonCode, raw.severity === 'error' ? 'high' : 'medium', dashboardDeduplicationKey]);
        }

        if (dingtalkAutomaticEnabled && workOrderId
          && !['completed', 'archived'].includes(runtimeStatus)
          && eventTargetsCurrentInstance
          && automaticDingTalkReasonCodes.has(raw.reasonCode)
          && hasAutomaticDingTalkEvidence({
            reasonCode: raw.reasonCode,
            scenarioCode,
            stage,
            snapshot,
          })) {
          const deduplicationKey = `dingtalk:automatic:${workOrderId}:${ordinaryInstanceId || 'no-instance'}:${raw.reasonCode}`;
          const interventionId = crypto.randomUUID();
          const intervention = await client.query(`
            INSERT INTO manual_interventions
              (id, shop_id, work_order_id, ordinary_instance_id, channel,
               reason_code, reason, risk_level, deduplication_key)
            SELECT $1,$2,$3,$4,'dingtalk',$5,$6,$7,$8
            WHERE EXISTS (
              SELECT 1 FROM work_orders current_work_order
              WHERE current_work_order.id = $3
                AND current_work_order.status NOT IN ('completed', 'archived')
                AND coalesce(current_work_order.completion_state, 'pending')
                  NOT IN ('confirmed', 'not-applicable')
            )
            AND NOT EXISTS (
              SELECT 1 FROM manual_interventions existing
              WHERE existing.work_order_id = $3
                AND existing.ordinary_instance_id IS NOT DISTINCT FROM $4::uuid
                AND existing.channel = 'dingtalk'
                AND existing.reason_code = $5
            )
            ON CONFLICT (deduplication_key) DO NOTHING RETURNING id`,
          [interventionId, shopId, workOrderId, ordinaryInstanceId, raw.reasonCode,
            raw.message || (raw.reasonCode === 'unknown-scenario' ? '未识别的业务场景' : 'OMS 发货仓库不在业务处理范围'),
            'high', deduplicationKey]);
          if (intervention.rowCount) {
            const incompleteAnalysis = analyzeIncompleteWorkflow({
              runtimeStatus,
              currentStep: stage,
              payload: snapshot,
              diagnosticEvent: {
                stage,
                eventType: raw.eventType,
                reasonCode: raw.reasonCode,
                message: raw.message,
                occurredAt,
              },
            });
            const notificationPayload = {
              workOrderId,
              shopId,
              orderNumber,
              warehouse: snapshot.omsAnalysis?.shippingWarehouse || snapshot.omsAnalysis?.warehouse
                || snapshot.omsAnalysis?.warehouseName || snapshot.omsWarehouseParse?.parsedValue || null,
              trackingNumber: snapshot.logisticsAnalysis?.trackingNumber || null,
              workOrderType: raw.workOrderType || snapshot.workOrderType || null,
              problemZh: incompleteAnalysis?.reasonZh || '自动流程未完成，需要人工核查。',
              incompleteAnalysis,
              reasonCode: raw.reasonCode,
              riskLevel: 'high',
              system: raw.system || 'pdd',
              stage,
              occurredAt,
              deliverySource: 'automatic',
            };
            await client.query(`
              INSERT INTO notification_outbox (id, intervention_id, payload)
              VALUES ($1,$2,$3::jsonb)`, [crypto.randomUUID(), interventionId, JSON.stringify(notificationPayload)]);
          }
        }
      }
      await client.query('COMMIT');
      return { accepted, duplicates, rejected };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createDingTalkNotification(workOrderId, { actorId, reason = '', message = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        SELECT w.id, w.shop_id, w.external_order_number, w.work_order_type, w.scenario_code,
          w.status, w.runtime_status, w.completion_state, w.current_step,
          w.manual_review_reason, w.payload, w.current_ordinary_instance_id, shop.name AS shop_name,
          logistics.payload AS logistics, oms.payload AS oms,
          event.reason_code, event.message AS event_message, event.system_name,
          event.stage AS event_stage, event.occurred_at
        FROM work_orders w
        JOIN shops shop ON shop.id = w.shop_id
        LEFT JOIN LATERAL (
          SELECT analysis.payload FROM logistics_analyses analysis
          WHERE analysis.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('analysis')}
          ORDER BY analysis.created_at DESC LIMIT 1
        ) logistics ON true
        LEFT JOIN LATERAL (
          SELECT analysis.payload FROM oms_analyses analysis
          WHERE analysis.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('analysis')}
          ORDER BY analysis.created_at DESC LIMIT 1
        ) oms ON true
        LEFT JOIN LATERAL (
          SELECT event.reason_code, event.message, event.system_name, event.stage, event.occurred_at
          FROM workflow_events event
          WHERE event.work_order_id = w.id
            AND ${currentOrdinaryRelatedSql('event')}
          ORDER BY event.occurred_at DESC, event.received_at DESC LIMIT 1
        ) event ON true
        WHERE w.id = $1::uuid FOR UPDATE OF w`, [workOrderId]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = result.rows[0];
      const existing = await client.query(`
        SELECT intervention.id AS intervention_id, outbox.id AS outbox_id, outbox.status,
          outbox.attempt_count, outbox.created_at
        FROM manual_interventions intervention
        JOIN notification_outbox outbox ON outbox.intervention_id = intervention.id
        WHERE intervention.work_order_id = $1::uuid AND intervention.channel = 'dingtalk'
          AND intervention.ordinary_instance_id IS NOT DISTINCT FROM $2::uuid
          AND outbox.payload->>'deliverySource' = 'owner-manual'
          AND outbox.status IN ('pending', 'sending')
        ORDER BY outbox.created_at DESC LIMIT 1`, [workOrderId, row.current_ordinary_instance_id]);
      const snapshot = row.payload || {};
      const warehouseInfo = warehouseInfoFromFacts({ payload: snapshot, logistics: row.logistics, oms: row.oms });
      const trackingNumber = row.logistics?.trackingNumber || snapshot.logisticsAnalysis?.trackingNumber || null;
      const rawShippingLines = String(snapshot.omsWarehouseParse?.rawShippingText || '')
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      const trackingIndex = trackingNumber ? rawShippingLines.lastIndexOf(String(trackingNumber)) : -1;
      const warehouseAfterTracking = trackingIndex >= 0 ? cleanWarehouseValue(rawShippingLines[trackingIndex + 1]) : null;
      const warehouse = warehouseInfo.omsValue
        || cleanWarehouseValue(snapshot.omsWarehouseParse?.parsedValue)
        || warehouseAfterTracking;
      const sourceReason = String(reason || snapshot.manualReview?.reason
        || row.manual_review_reason || row.event_message || '').trim();
      const warehouseOutOfScope = /warehouse-out-of-scope/.test(String(
        snapshot.manualReview?.stage || row.reason_code || row.current_step || '',
      )) || snapshot.omsWarehouseParse?.status === 'out-of-scope'
        || /仓库.*不在.*(?:范围|业务)|不在业务处理范围/.test(sourceReason);
      const manualReason = warehouseOutOfScope && (!sourceReason || /\?{3,}|�/.test(sourceReason))
        ? `OMS 发货仓库${warehouse ? `“${warehouse}”` : ''}不在业务处理范围，已禁止进入 TMS 和拼多多提交`
        : sourceReason || '系统所有者发起钉钉群协作';
      const reasonCode = warehouseOutOfScope ? 'warehouse-out-of-scope'
        : row.reason_code || (row.scenario_code ? 'owner-manual' : 'unknown-scenario');
      const incompleteAnalysis = analyzeIncompleteWorkflow({
        runtimeStatus: row.runtime_status || row.status,
        completionState: row.completion_state,
        currentStep: row.current_step,
        payload: snapshot,
        manualReviewReason: sourceReason,
        diagnosticEvent: {
          stage: row.event_stage,
          reasonCode,
          message: row.event_message,
          occurredAt: row.occurred_at,
        },
      });
      const problemZh = message?.problemZh || incompleteAnalysis?.reasonZh || '所有者请求人工核查。';
      const notificationAnalysis = {
        ...(incompleteAnalysis || {}),
        reason: problemZh,
        reasonZh: problemZh,
        descriptionZh: message?.descriptionZh || incompleteAnalysis?.descriptionZh || problemZh,
        descriptionEn: message?.descriptionEn || incompleteAnalysis?.descriptionEn
          || 'The work order requires manual review.',
      };
      const pending = existing.rows[0];
      const interventionId = pending?.intervention_id || crypto.randomUUID();
      const outboxId = pending?.outbox_id || crypto.randomUUID();
      const now = new Date().toISOString();
      const payload = {
        workOrderId: row.id,
        ordinaryInstanceId: row.current_ordinary_instance_id || null,
        shopId: row.shop_id,
        shopName: row.shop_name,
        orderNumber: row.external_order_number,
        warehouse,
        trackingNumber,
        workOrderType: row.work_order_type,
        problemZh,
        incompleteAnalysis: notificationAnalysis,
        reasonCode,
        riskLevel: 'high',
        system: warehouseOutOfScope ? 'oms' : row.system_name || 'pdd',
        stage: snapshot.manualReview?.stage || row.event_stage || row.current_step,
        occurredAt: snapshot.manualReview?.createdAt || row.occurred_at || now,
        deliverySource: 'owner-manual',
        requestedBy: actorId,
        requestedAt: now,
      };
      if (pending) {
        await client.query(`
          UPDATE manual_interventions SET reason_code = $2, reason = $3, risk_level = 'high'
          WHERE id = $1`, [interventionId, reasonCode, manualReason]);
        await client.query(`
          UPDATE notification_outbox SET payload = $2::jsonb, updated_at = now()
          WHERE id = $1`, [outboxId, JSON.stringify(payload)]);
      } else {
        await client.query(`
          INSERT INTO manual_interventions
            (id, shop_id, work_order_id, ordinary_instance_id, channel,
             reason_code, reason, risk_level, deduplication_key)
          VALUES ($1,$2,$3,$4,'dingtalk',$5,$6,'high',$7)`,
        [interventionId, row.shop_id, row.id, row.current_ordinary_instance_id, reasonCode, manualReason,
          `dingtalk:owner-manual:${row.id}:${outboxId}`]);
        await client.query(`
          INSERT INTO notification_outbox (id, intervention_id, payload)
          VALUES ($1,$2,$3::jsonb)`, [outboxId, interventionId, JSON.stringify(payload)]);
      }
      await client.query(`
        INSERT INTO audit_events (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [row.shop_id, row.id, row.current_ordinary_instance_id, actorId,
        pending ? 'dingtalk-notification-refreshed' : 'dingtalk-notification-queued',
        JSON.stringify({ interventionId, outboxId, reasonCode, reason: manualReason, message: notificationAnalysis })]);
      await client.query('COMMIT');
      return {
        interventionId,
        outboxId,
        status: pending?.status || 'pending',
        attemptCount: pending?.attempt_count || 0,
        createdAt: pending?.created_at || now,
        alreadyQueued: Boolean(pending),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getDingTalkDailySummary(summaryDate = null) {
    const result = await this.pool.query(`
      SELECT summary_date::text AS "summaryDate", timezone,
        today_processed AS "todayProcessed",
        today_completed AS "todayCompleted",
        today_strict_automated AS "todayStrictAutomated",
        historical_processed AS "historicalProcessed",
        message_text AS "messageText", status,
        attempt_count AS "attemptCount",
        edited_by AS "editedBy", edited_at AS "editedAt",
        send_requested_by AS "sendRequestedBy",
        send_requested_at AS "sendRequestedAt",
        sent_at AS "sentAt", last_error AS "lastError",
        statistics_refreshed_at AS "statisticsRefreshedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM dingtalk_daily_summaries
      WHERE summary_date = coalesce(
        $1::date,
        (now() AT TIME ZONE 'Asia/Shanghai')::date
      )`, [summaryDate]);
    const storedSummary = result.rows[0] || null;
    if (!storedSummary) return null;

    // Reuse the relaxed autoSuccess totals shown in the ordinary viewer dashboard.
    // A summary day runs from 18:30 on the previous Beijing day to 18:30 on this day.
    const [todayViewerMetrics, historicalViewerMetrics] = await Promise.all([
      this.metricsSummary({ dailySummaryDate: storedSummary.summaryDate }),
      this.metricsSummary({}),
    ]);
    const viewerSummary = {
      ...storedSummary,
      todayProcessed: Number(todayViewerMetrics.autoSuccess || 0),
      historicalProcessed: Number(historicalViewerMetrics.autoSuccess || 0),
    };
    if (!storedSummary.editedAt && !storedSummary.sendRequestedAt) {
      viewerSummary.messageText = buildDailySummaryDraftText(viewerSummary);
    }
    return viewerSummary;
  }

  async updateDingTalkDailySummary(summaryDate, { actorId, messageText }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`
        SELECT status FROM dingtalk_daily_summaries
        WHERE summary_date = $1::date FOR UPDATE`, [summaryDate]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      if (current.rows[0].status === 'sent') {
        const error = new Error('daily-summary-already-sent');
        error.code = 'DAILY_SUMMARY_IMMUTABLE';
        throw error;
      }
      if (current.rows[0].status === 'sending') {
        const error = new Error('daily-summary-send-in-progress');
        error.code = 'DAILY_SUMMARY_IMMUTABLE';
        throw error;
      }
      await client.query(`
        UPDATE dingtalk_daily_summaries SET
          message_text = $2, edited_by = $3, edited_at = now(),
          status = 'pending', last_error = NULL, updated_at = now()
        WHERE summary_date = $1::date`, [summaryDate, messageText, actorId]);
      await client.query(`
        INSERT INTO audit_events (actor_id, event_type, payload)
        VALUES ($1, 'dingtalk-daily-summary-edited', jsonb_build_object(
          'summaryDate', $2::text, 'messageLength', char_length($3::text)
        ))`, [actorId, summaryDate, messageText]);
      await client.query('COMMIT');
      return this.getDingTalkDailySummary(summaryDate);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDingTalkDailySummary(summaryDate, { actorId, messageText }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`
        SELECT * FROM dingtalk_daily_summaries
        WHERE summary_date = $1::date FOR UPDATE`, [summaryDate]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      if (current.rows[0].status === 'sent') {
        const error = new Error('daily-summary-already-sent');
        error.code = 'DAILY_SUMMARY_ALREADY_SENT';
        throw error;
      }
      if (current.rows[0].status === 'sending') {
        const error = new Error('daily-summary-send-in-progress');
        error.code = 'DAILY_SUMMARY_SEND_IN_PROGRESS';
        throw error;
      }
      const claimed = await client.query(`
        UPDATE dingtalk_daily_summaries SET
          message_text = $2,
          edited_by = CASE WHEN message_text IS DISTINCT FROM $2 THEN $3 ELSE edited_by END,
          edited_at = CASE WHEN message_text IS DISTINCT FROM $2 THEN now() ELSE edited_at END,
          status = 'sending', attempt_count = attempt_count + 1,
          send_requested_by = $3, send_requested_at = now(),
          last_error = NULL, updated_at = now()
        WHERE summary_date = $1::date
        RETURNING summary_date::text AS "summaryDate", timezone,
          today_processed AS "todayProcessed",
          today_completed AS "todayCompleted",
          today_strict_automated AS "todayStrictAutomated",
          historical_processed AS "historicalProcessed",
          message_text AS "messageText", status,
          attempt_count AS "attemptCount", updated_at AS "updatedAt"`,
      [summaryDate, messageText, actorId]);
      await client.query(`
        INSERT INTO audit_events (actor_id, event_type, payload)
        VALUES ($1, 'dingtalk-daily-summary-send-requested', jsonb_build_object(
          'summaryDate', $2::text, 'attemptCount', $3::int,
          'messageLength', char_length($4::text)
        ))`, [actorId, summaryDate, claimed.rows[0].attemptCount, messageText]);
      await client.query('COMMIT');
      return claimed.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async finishDingTalkDailySummary(summaryDate, {
    actorId,
    succeeded,
    responseStatus = null,
    responsePayload = null,
    deliveryError = null,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE dingtalk_daily_summaries SET
          status = $2,
          response_status = $3,
          response_payload = $4::jsonb,
          last_error = $5::jsonb,
          sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
          updated_at = now()
        WHERE summary_date = $1::date AND status = 'sending'
        RETURNING summary_date::text AS "summaryDate", status,
          sent_at AS "sentAt", attempt_count AS "attemptCount"`, [
        summaryDate,
        succeeded ? 'sent' : 'failed',
        responseStatus,
        JSON.stringify(responsePayload),
        JSON.stringify(deliveryError),
      ]);
      if (!result.rowCount) throw new Error('daily-summary-send-state-changed');
      await client.query(`
        INSERT INTO audit_events (actor_id, event_type, payload)
        VALUES ($1, $2, jsonb_build_object(
          'summaryDate', $3::text, 'attemptCount', $4::int,
          'responseStatus', $5::int
        ))`, [
        actorId,
        succeeded ? 'dingtalk-daily-summary-sent' : 'dingtalk-daily-summary-failed',
        summaryDate,
        result.rows[0].attemptCount,
        responseStatus,
      ]);
      await client.query('COMMIT');
      return this.getDingTalkDailySummary(summaryDate);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recordSyncHeartbeat({ sourceId = 'windows-native', shopIds = [], backlogCount = 0 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const uniqueShopIds = [...new Set(shopIds.map(String).filter(Boolean))];
      await assertKnownShops(client, uniqueShopIds);
      for (const shopId of uniqueShopIds) {
        await client.query(`
          INSERT INTO sync_cursors (source_id, shop_id, backlog_count, last_success_at)
          VALUES ($1,$2,$3,now())
          ON CONFLICT (source_id, shop_id) DO UPDATE SET backlog_count = EXCLUDED.backlog_count,
            last_success_at = now(), last_error = NULL, updated_at = now()`, [sourceId, shopId, Number(backlogCount || 0)]);
      }
      await client.query('COMMIT');
      return { sourceId, shops: shopIds.length, recordedAt: new Date().toISOString() };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateClassification(id, { classification, reason, expectedVersion, actorId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT * FROM work_orders WHERE id = $1::uuid FOR UPDATE`, [id]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return null; }
      const row = current.rows[0];
      if (Number(row.classification_version) !== Number(expectedVersion)) {
        const error = new Error('classification-version-conflict');
        error.code = 'VERSION_CONFLICT';
        error.currentVersion = row.classification_version;
        throw error;
      }
      const nextVersion = Number(row.classification_version) + 1;
      const historyId = crypto.randomUUID();
      await client.query(`
        INSERT INTO classification_history
          (id, work_order_id, ordinary_instance_id, previous_classification,
           next_classification, reason, actor_id, version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [historyId, id, row.current_ordinary_instance_id, row.handling_classification,
        classification, reason, actorId, nextVersion]);
      const updated = await client.query(`
        UPDATE work_orders SET handling_classification = $2, classification_source = 'admin-override',
          classification_reason = $3, classification_version = $4,
          classification_updated_at = now(), classification_updated_by = $5, updated_at = now()
        WHERE id = $1 RETURNING id, handling_classification AS "handlingClassification",
          classification_source AS "classificationSource", classification_reason AS "classificationReason",
          classification_version AS "classificationVersion", classification_updated_at AS "classificationUpdatedAt",
          classification_updated_by AS "classificationUpdatedBy"`,
      [id, classification, reason, nextVersion, actorId]);
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
        VALUES ($1,$2,$3,$4,'classification-updated',$5::jsonb)`,
      [row.shop_id, id, row.current_ordinary_instance_id, actorId,
        JSON.stringify({ previous: row.handling_classification, next: classification, reason, version: nextVersion })]);
      await client.query('COMMIT');
      return { ...updated.rows[0], historyId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async bulkUpdateClassification({ ids, classification, reason, expectedVersions, actorId }) {
    const results = [];
    for (const id of ids) {
      results.push(await this.updateClassification(id, {
        classification,
        reason,
        expectedVersion: expectedVersions?.[id],
        actorId,
      }));
    }
    return results;
  }

  async deleteWorkOrders({ ids, reason, actorId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT w.id, w.shop_id, w.external_order_number, w.status,
          EXISTS (
            SELECT 1 FROM shop_runtime_state runtime
            WHERE runtime.current_work_order_id = w.id
              AND (runtime.status = 'processing'
                OR (runtime.lease_token IS NOT NULL AND runtime.lease_expires_at > now()))
          ) AS has_active_runtime,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = w.id AND effect.status = 'reserved'
          ) AS has_reserved_external_effect,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = w.id AND effect.status = 'unknown'
          ) AS has_unknown_external_effect,
          EXISTS (
            SELECT 1 FROM operator_commands command
            WHERE command.work_order_id = w.id AND command.status = 'delivered'
          ) AS has_delivered_command
        FROM work_orders w
        WHERE w.id = ANY($1::uuid[]) AND coalesce(w.frontend_visibility, 'operational') = 'operational'
        FOR UPDATE OF w`, [ids]);
      const foundIds = new Set(selected.rows.map((row) => row.id));
      const missingIds = ids.filter((id) => !foundIds.has(id));
      if (missingIds.length) {
        const error = new Error('work-order-delete-not-found');
        error.code = 'WORK_ORDER_DELETE_NOT_FOUND';
        error.missingIds = missingIds;
        throw error;
      }

      const blockers = selected.rows.flatMap((row) => {
        const reasons = [];
        if (row.status === 'processing' || row.has_active_runtime) reasons.push('active-processing');
        if (row.has_reserved_external_effect) reasons.push('reserved-external-effect');
        if (row.has_unknown_external_effect) reasons.push('unknown-external-effect');
        if (row.has_delivered_command) reasons.push('delivered-operator-command');
        return reasons.map((blockerReason) => ({
          id: row.id,
          orderNumber: row.external_order_number,
          reason: blockerReason,
        }));
      });
      if (blockers.length) {
        const error = new Error('work-order-delete-blocked');
        error.code = 'WORK_ORDER_DELETE_BLOCKED';
        error.blockers = blockers;
        throw error;
      }

      const deletedAt = new Date().toISOString();
      const deletion = { reason, actorId, deletedAt, mode: 'owner-soft-delete' };
      await client.query(`
        UPDATE operator_commands SET status = 'cancelled',
          result = coalesce(result, '{}'::jsonb) || jsonb_build_object('ownerDeletion', $2::jsonb)
        WHERE work_order_id = ANY($1::uuid[]) AND status = 'pending'`,
      [ids, JSON.stringify(deletion)]);
      await client.query(`
        UPDATE notification_outbox outbox SET status = 'cancelled', updated_at = now()
        FROM manual_interventions intervention
        WHERE outbox.intervention_id = intervention.id
          AND intervention.work_order_id = ANY($1::uuid[])
          AND outbox.status IN ('pending', 'failed')`, [ids]);
      await client.query(`
        UPDATE manual_interventions SET status = 'cancelled', resolved_at = now(), resolved_by = $2
        WHERE work_order_id = ANY($1::uuid[]) AND status IN ('open', 'acknowledged')`, [ids, actorId]);
      await client.query(`
        UPDATE verification_locations SET status = 'resolved', resolved_at = coalesce(resolved_at, now())
        WHERE work_order_id = ANY($1::uuid[]) AND status IN ('detected', 'waiting-human', 'verification-required')`,
      [ids]);
      await client.query(`
        UPDATE shop_runtime_state SET
          status = CASE WHEN status = 'operator-paused' THEN status ELSE 'idle' END,
          lease_token = NULL, lease_expires_at = NULL, current_work_order_id = NULL, updated_at = now()
        WHERE current_work_order_id = ANY($1::uuid[])`, [ids]);
      await client.query(`
        UPDATE workflow_checkpoints SET work_order_id = NULL, external_order_number = NULL,
          current_step = 'owner-deleted', runtime_status = 'idle',
          snapshot = jsonb_build_object('ownerDeletion', $2::jsonb),
          source_hash = 'owner-deleted:' || shop_id || ':' || $3, source_updated_at = now(), synchronized_at = now()
        WHERE work_order_id = ANY($1::uuid[])`, [ids, JSON.stringify(deletion), deletedAt]);
      const deleted = await client.query(`
        UPDATE work_orders SET status = 'archived', runtime_status = 'archived',
          current_step = 'owner-deleted', next_attempt_at = NULL, manual_review_reason = NULL,
          recovery_state = 'held', recovery_reason = 'owner-deleted',
          recovery_version = recovery_version + 1, recovery_updated_at = now(),
          frontend_visibility = 'recovery-audit',
          payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{ownerDeletion}', $2::jsonb, true),
          updated_at = now()
        WHERE id = ANY($1::uuid[])
        RETURNING id, shop_id AS "shopId", external_order_number AS "orderNumber"`,
      [ids, JSON.stringify(deletion)]);
      await client.query(`
        INSERT INTO audit_events (shop_id, work_order_id, actor_id, event_type, payload)
        SELECT w.shop_id, w.id, $1, 'work-order-owner-deleted',
          jsonb_build_object(
            'orderNumber', w.external_order_number,
            'reason', $2::text,
            'deletedAt', $3::timestamptz,
            'previousStatus', previous.previous_status,
            'mode', 'owner-soft-delete'
          )
        FROM work_orders w
        JOIN jsonb_to_recordset($4::jsonb) AS previous(id uuid, previous_status text)
          ON previous.id = w.id`,
      [actorId, reason, deletedAt, JSON.stringify(selected.rows.map((row) => ({
        id: row.id,
        previous_status: row.status,
      })))]);
      await client.query('COMMIT');
      return deleted.rows.map((row) => ({ ...row, deletedAt }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async rollbackClassification(workOrderId, historyId, { reason, actorId, expectedVersion }) {
    const history = await this.pool.query(`
      SELECT previous_classification FROM classification_history
      WHERE id = $1::uuid AND work_order_id = $2::uuid
        AND ordinary_instance_id IS NOT DISTINCT FROM (
          SELECT current_ordinary_instance_id FROM work_orders WHERE id = $2::uuid
        )`, [historyId, workOrderId]);
    if (!history.rowCount || !history.rows[0].previous_classification) return null;
    return this.updateClassification(workOrderId, {
      classification: history.rows[0].previous_classification,
      reason: reason || `回滚分类修改 ${historyId}`,
      expectedVersion,
      actorId,
    });
  }

  async createOperatorCommand(workOrderId, {
    commandType,
    payload = {},
    actorId,
    ordinaryInstanceId = null,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT id, shop_id, current_ordinary_instance_id, recovery_state, recovery_reason,
          recovery_version, completion_state,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_orders.id AND effect.status = 'unknown'
              AND ${currentOrdinaryRelatedSql('effect', 'work_orders')}
          ) AS has_unknown_external_effect,
          EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_orders.id AND effect.status = 'reserved'
              AND ${currentOrdinaryRelatedSql('effect', 'work_orders')}
          ) AS has_reserved_external_effect
        FROM work_orders WHERE id = $1::uuid FOR UPDATE`, [workOrderId]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const workOrder = selected.rows[0];
      const requestedOrdinaryInstanceId = String(ordinaryInstanceId || '').trim() || null;
      if (requestedOrdinaryInstanceId
        && requestedOrdinaryInstanceId !== String(workOrder.current_ordinary_instance_id || '')) {
        const error = new Error('operator-command-ordinary-instance-mismatch');
        error.code = 'ORDINARY_INSTANCE_MISMATCH';
        error.workOrderId = workOrderId;
        throw error;
      }
      const existingCommand = await client.query(`
        SELECT id, shop_id AS "shopId", work_order_id AS "workOrderId", command_type AS "commandType",
          status, requested_by AS "requestedBy", requested_at AS "requestedAt"
        FROM operator_commands
        WHERE work_order_id = $1::uuid AND command_type = $2 AND status IN ('pending', 'delivered')
          AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
        ORDER BY requested_at DESC LIMIT 1`, [workOrderId, commandType, workOrder.current_ordinary_instance_id]);
      if (existingCommand.rowCount) {
        await client.query('COMMIT');
        return existingCommand.rows[0];
      }
      const blockers = [];
      if (['retry-stage', 'resume-auto'].includes(commandType)) {
        if (!['ready', 'retry-authorized'].includes(workOrder.recovery_state)) {
          blockers.push(workOrder.recovery_reason || `recovery-state:${workOrder.recovery_state}`);
        }
        if (workOrder.has_unknown_external_effect) blockers.push('unknown-external-effect');
        if (workOrder.completion_state === 'reconciliation-required') blockers.push('completion-evidence-required');
      }
      if (commandType === 'force-clear-verification') {
        if (workOrder.has_reserved_external_effect) blockers.push('reserved-external-effect');
        if (workOrder.has_unknown_external_effect) blockers.push('unknown-external-effect');
      }
      if (blockers.length) {
        const error = new Error('work-order-recovery-blocked');
        error.code = 'WORK_ORDER_BLOCKED';
        error.blockers = [...new Set(blockers)];
        error.recoveryVersion = workOrder.recovery_version;
        throw error;
      }
      const result = await client.query(`
        INSERT INTO operator_commands
          (id, shop_id, work_order_id, ordinary_instance_id, command_type, payload, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
        RETURNING id, shop_id AS "shopId", work_order_id AS "workOrderId", command_type AS "commandType",
          status, requested_by AS "requestedBy", requested_at AS "requestedAt"`,
      [crypto.randomUUID(), workOrder.shop_id, workOrderId, workOrder.current_ordinary_instance_id,
        commandType, JSON.stringify(payload), actorId]);
      if (['retry-stage', 'resume-auto'].includes(commandType) && workOrder.recovery_state === 'retry-authorized') {
        await client.query(`
          UPDATE work_orders SET recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = recovery_version + 1, recovery_updated_at = now()
          WHERE id = $1`, [workOrderId]);
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async reviewExternalState(workOrderId, {
    decision, observationMethod, reason, evidence = {}, expectedRecoveryVersion, actorId,
  }) {
    const allowedDecisions = new Set(['applied', 'not-applied', 'uncertain']);
    if (!allowedDecisions.has(decision)) throw new Error('external-state-decision-invalid');
    if (!observationMethod || !reason) throw new Error('external-state-review-evidence-required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`SELECT * FROM work_orders WHERE id = $1::uuid FOR UPDATE`, [workOrderId]);
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const workOrder = selected.rows[0];
      if (Number(workOrder.recovery_version) !== Number(expectedRecoveryVersion)) {
        const error = new Error('recovery-version-conflict');
        error.code = 'VERSION_CONFLICT';
        error.currentVersion = workOrder.recovery_version;
        throw error;
      }
      const reviewedAt = new Date().toISOString();
      const review = { decision, observationMethod, reason, evidence, reviewedAt, actorId };
      if (decision === 'applied') {
        await client.query(`
          UPDATE external_effects SET status = 'succeeded',
            receipt = coalesce(receipt, '{}'::jsonb) || jsonb_build_object('ownerReview', $2::jsonb),
            error = NULL, updated_at = now()
          WHERE work_order_id = $1 AND status = 'unknown'
            AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid`,
        [workOrderId, JSON.stringify(review), workOrder.current_ordinary_instance_id]);
        await client.query(`
          UPDATE work_orders SET status = 'archived', runtime_status = 'archived',
            current_step = 'owner-platform-confirmed', completion_state = 'confirmed',
            completion_confirmation_method = 'owner-platform-confirmed', completion_confirmed_at = now(),
            recovery_state = 'ready', recovery_reason = NULL,
            recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
          WHERE id = $1`, [workOrderId]);
      } else if (decision === 'not-applied') {
        const reviewedSubmitAttemptCount = Number(evidence?.actualSubmitAttemptCount);
        const previousSubmission = workOrder.payload?.pddResolutionSubmission || {};
        const correctedSubmitAttemptCount = Number.isInteger(reviewedSubmitAttemptCount)
          && reviewedSubmitAttemptCount >= 1
          && reviewedSubmitAttemptCount <= 2
          ? reviewedSubmitAttemptCount
          : Math.max(1, Number(previousSubmission.submitAttemptCount || 0));
        const correctedPayload = {
          ...(workOrder.payload || {}),
          pddResolutionSubmission: {
            ...previousSubmission,
            status: 'retry-authorized',
            submitAttemptCount: correctedSubmitAttemptCount,
            notAppliedAt: reviewedAt,
            notAppliedRetryAuthorizedAt: reviewedAt,
            confirmationMethod: observationMethod,
          },
          externalStateReconciliation: {
            state: 'not-applied',
            effectType: 'pdd-submit',
            confirmationMethod: observationMethod,
            submitAttemptCount: correctedSubmitAttemptCount,
            evidence,
            observedAt: reviewedAt,
            reviewedBy: actorId,
            readOnly: true,
          },
          manualReview: null,
          error: null,
        };
        await client.query(`
          UPDATE external_effects SET status = 'failed', receipt = NULL,
            error = jsonb_build_object('ownerReview', $2::jsonb), updated_at = now()
          WHERE work_order_id = $1
            AND ordinary_instance_id IS NOT DISTINCT FROM $3::uuid
            AND effect_type = 'pdd-submit'
            AND (
              idempotency_key LIKE '%:resolution'
              OR idempotency_key LIKE '%:resolution-postcondition-retry-v2'
            )
            AND status IN ('unknown', 'succeeded')`,
        [workOrderId, JSON.stringify(review), workOrder.current_ordinary_instance_id]);
        await client.query(`
          UPDATE work_orders SET status = 'paused', runtime_status = 'paused',
            current_step = 'pdd-submit-not-applied', payload = $2::jsonb,
            manual_review_reason = NULL, recovery_state = 'retry-authorized',
            recovery_reason = 'owner-confirmed-not-applied', recovery_version = recovery_version + 1,
            recovery_updated_at = now(), updated_at = now()
          WHERE id = $1`, [workOrderId, JSON.stringify(correctedPayload)]);
      } else {
        await client.query(`
          UPDATE work_orders SET recovery_state = 'held', recovery_reason = 'external-state-still-uncertain',
            recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
          WHERE id = $1`, [workOrderId]);
      }
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
        VALUES ($1,$2,$3,$4,'external-state-owner-reviewed',$5::jsonb)`,
      [workOrder.shop_id, workOrderId, workOrder.current_ordinary_instance_id,
        actorId, JSON.stringify(review)]);
      const result = await client.query(`
        SELECT id, shop_id AS "shopId", external_order_number AS "orderNumber",
          status, runtime_status AS "runtimeStatus", completion_state AS "completionState",
          recovery_state AS "recoveryState", recovery_reason AS "recoveryReason",
          recovery_version AS "recoveryVersion", recovery_updated_at AS "recoveryUpdatedAt"
        FROM work_orders WHERE id = $1`, [workOrderId]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createCorrection(workOrderId, { patch, reason, expectedVersion, actorId }) {
    const allowed = new Set(['carrier', 'trackingNumber', 'warehouse', 'workOrderType', 'scenarioCode', 'note', 'nextAttemptAt']);
    const normalizedPatch = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => allowed.has(key)));
    if (!Object.keys(normalizedPatch).length) throw new Error('correction-patch-empty');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT * FROM work_orders WHERE id = $1::uuid FOR UPDATE`, [workOrderId]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return null; }
      const row = current.rows[0];
      if (Number(row.data_version) !== Number(expectedVersion)) {
        const error = new Error('data-version-conflict');
        error.code = 'VERSION_CONFLICT';
        error.currentVersion = row.data_version;
        throw error;
      }
      const previousOverrides = row.payload?.manualOverrides || {};
      const previousValues = Object.fromEntries(Object.keys(normalizedPatch).map((key) => [key, previousOverrides[key] ?? null]));
      const nextOverrides = { ...previousOverrides, ...normalizedPatch };
      const nextVersion = Number(row.data_version) + 1;
      const correctionId = crypto.randomUUID();
      await client.query(`
        INSERT INTO data_corrections
          (id, work_order_id, ordinary_instance_id, patch, previous_values, reason, actor_id, version)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
      [correctionId, workOrderId, row.current_ordinary_instance_id,
        JSON.stringify(normalizedPatch), JSON.stringify(previousValues), reason, actorId, nextVersion]);
      const updated = await client.query(`
        UPDATE work_orders SET payload = jsonb_set(coalesce(payload,'{}'::jsonb), '{manualOverrides}', $2::jsonb, true),
          data_version = $3, updated_at = now() WHERE id = $1
        RETURNING id, data_version AS "dataVersion", payload->'manualOverrides' AS "manualOverrides"`,
      [workOrderId, JSON.stringify(nextOverrides), nextVersion]);
      await client.query(`
        INSERT INTO audit_events
          (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
        VALUES ($1,$2,$3,$4,'work-order-data-corrected',$5::jsonb)`,
      [row.shop_id, workOrderId, row.current_ordinary_instance_id, actorId,
        JSON.stringify({ patch: normalizedPatch, previousValues, reason, version: nextVersion })]);
      await client.query('COMMIT');
      return { ...updated.rows[0], correctionId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateInterventionStatus(id, { status, actorId }) {
    const result = await this.pool.query(`
      UPDATE manual_interventions SET status = $2,
        acknowledged_at = CASE WHEN $2 = 'acknowledged' THEN coalesce(acknowledged_at, now()) ELSE acknowledged_at END,
        resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END,
        resolved_by = CASE WHEN $2 = 'resolved' THEN $3 ELSE resolved_by END
      WHERE id = $1::uuid
      RETURNING id, shop_id AS "shopId", work_order_id AS "workOrderId",
        ordinary_instance_id AS "ordinaryInstanceId", channel,
        reason_code AS "reasonCode", status, acknowledged_at AS "acknowledgedAt",
        resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"`, [id, status, actorId]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    await this.pool.query(`INSERT INTO audit_events
      (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
      VALUES ($1,$2,$3,$4,'manual-intervention-status-updated',$5::jsonb)`,
    [row.shopId, row.workOrderId, row.ordinaryInstanceId, actorId,
      JSON.stringify({ interventionId: id, status })]);
    return row;
  }

  async close() { await this.pool.end(); }
}

export async function createDataBackend(options) {
  const mode = String(process.env.DATA_BACKEND || 'legacy-json').toLowerCase();
  if (mode === 'legacy-json') return new LegacyJsonBackend(options);
  if (mode === 'postgres') return PostgresBackend.create(options);
  throw new Error(`Unsupported DATA_BACKEND: ${mode}`);
}
