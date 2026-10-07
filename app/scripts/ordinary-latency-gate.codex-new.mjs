import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(scriptRoot);

const plannedWaitStages = Object.freeze([
  'logistics-waiting',
  'logistics-waiting-released',
  'rate-limited-waiting',
  'pdd-consumer-negotiation-followup-waiting',
  'consumer-response-waiting-released',
  'oms-shared-session-waiting',
  'oms-login-retry-deferred',
]);

const sqlLiteralList = (values) => values
  .map((value) => `'${String(value).replaceAll("'", "''")}'`)
  .join(',\n              ');

const numberArgument = (args, name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(args[index + 1]);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} requires a non-negative number`);
  return parsed;
};

const stringArgument = (args, name, fallback = null) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : String(args[index + 1] || '').trim();
};

const percentile = (values, ratio) => {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
};

const elapsedMs = (from, to) => {
  const start = Date.parse(from || '');
  const end = Date.parse(to || '');
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
};

const finiteNonNegative = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const interruptionMs = (record) => [
  record.plannedWaitMs,
  record.operatorWaitMs,
  record.businessHoldMs,
  record.infrastructureWaitMs,
].reduce((total, value) => total + (finiteNonNegative(value) || 0), 0);

const hasProcessingTelemetry = (record) => [
  record.activeProcessingMs,
  record.plannedWaitMs,
  record.operatorWaitMs,
  record.businessHoldMs,
  record.infrastructureWaitMs,
  record.unobservedMs,
].some((value) => finiteNonNegative(value) !== null);

const eligibleAt = (record) => record.nextAttemptAt
  || record.recoveryUpdatedAt
  || record.updatedAt
  || record.firstDiscoveredAt;

export const evaluateOrdinaryLatency = (records, {
  now = new Date(),
  minSamples = 1,
  claimP95Ms = 120_000,
  claimHardMs = 300_000,
  completeP95Ms = 900_000,
  completeHardMs = 1_800_000,
} = {}) => {
  const nowIso = now.toISOString();
  const completed = records.filter((record) => record.completedAt);
  const nowMs = now.getTime();
  const runnableStatuses = new Set(['queued', 'retry-ready', 'processing']);
  const active = records.filter((record) => {
    if (record.completedAt
      || record.verificationBlocked === true
      || !runnableStatuses.has(String(record.runtimeStatus || '').toLowerCase())) return false;
    const nextAttemptMs = Date.parse(record.nextAttemptAt || '');
    return !Number.isFinite(nextAttemptMs) || nextAttemptMs <= nowMs;
  });
  const nonRunnable = records.filter((record) => !record.completedAt
    && !active.includes(record));
  const verificationBlockedActive = records.filter((record) => !record.completedAt
    && record.verificationBlocked === true);
  const claimLatencies = completed
    .map((record) => elapsedMs(record.firstDiscoveredAt, record.startedAt))
    .filter(Number.isFinite);
  const wallCompleteLatencies = completed
    .map((record) => elapsedMs(record.startedAt, record.completedAt))
    .filter(Number.isFinite);
  const latencyEligibleCompleted = completed.filter((record) => !hasProcessingTelemetry(record)
    || (interruptionMs(record) === 0 && (finiteNonNegative(record.unobservedMs) || 0) <= 60_000));
  const eligibleWallCompleteLatencies = latencyEligibleCompleted
    .map((record) => elapsedMs(record.startedAt, record.completedAt))
    .filter(Number.isFinite);
  const activeCompleteLatencies = completed
    .map((record) => finiteNonNegative(record.activeProcessingMs)
      ?? elapsedMs(record.startedAt, record.completedAt))
    .filter(Number.isFinite);
  const cumulativeActiveLatencies = completed
    .map((record) => finiteNonNegative(record.cumulativeActiveProcessingMs))
    .filter(Number.isFinite);
  const overdueClaim = active.filter((record) => {
    const status = String(record.runtimeStatus || '').toLowerCase();
    return status !== 'processing' && elapsedMs(eligibleAt(record), nowIso) > claimHardMs;
  });
  const overdueComplete = active.filter((record) => {
    if (String(record.runtimeStatus || '').toLowerCase() !== 'processing') return false;
    const currentActiveMs = finiteNonNegative(record.currentAttemptActiveMs);
    return (currentActiveMs ?? elapsedMs(record.currentAttemptStartedAt || record.startedAt, nowIso)) > completeHardMs;
  });
  const hardClaimViolations = completed.filter((record) =>
    elapsedMs(record.firstDiscoveredAt, record.startedAt) > claimHardMs);
  const hardCompleteViolations = completed.filter((record) =>
    (finiteNonNegative(record.activeProcessingMs)
      ?? elapsedMs(record.startedAt, record.completedAt)) > completeHardMs);
  const wallHardCompleteDiagnostics = completed.filter((record) =>
    elapsedMs(record.startedAt, record.completedAt) > completeHardMs);
  const claimP95 = percentile(claimLatencies, 0.95);
  const completeP95 = percentile(eligibleWallCompleteLatencies, 0.95);
  const wallCompleteP95 = percentile(wallCompleteLatencies, 0.95);
  const activeCompleteP95 = percentile(activeCompleteLatencies, 0.95);
  const enoughSamples = completed.length >= minSamples;
  const enoughLatencyEligibleSamples = latencyEligibleCompleted.length >= minSamples;
  const passed = enoughSamples && enoughLatencyEligibleSamples
    && claimP95 !== null
    && completeP95 !== null
    && activeCompleteP95 !== null
    && claimP95 <= claimP95Ms
    && completeP95 <= completeP95Ms
    && activeCompleteP95 <= completeP95Ms
    && !overdueClaim.length
    && !overdueComplete.length
    && !hardClaimViolations.length
    && !hardCompleteViolations.length;
  return {
    status: enoughSamples && enoughLatencyEligibleSamples ? (passed ? 'passed' : 'failed') : 'insufficient-data',
    passed: enoughSamples && enoughLatencyEligibleSamples ? passed : null,
    sampleCount: completed.length,
    latencyEligibleSampleCount: latencyEligibleCompleted.length,
    interruptedSampleCount: completed.length - latencyEligibleCompleted.length,
    activeSampleCount: active.length,
    nonRunnableSampleCount: nonRunnable.length,
    verificationBlockedActiveCount: verificationBlockedActive.length,
    thresholdsMs: { claimP95Ms, claimHardMs, completeP95Ms, completeHardMs },
    observedMs: {
      claimP95,
      completeP95,
      wallCompleteP95,
      activeCompleteP95,
      cumulativeActiveP95: percentile(cumulativeActiveLatencies, 0.95),
      claimMax: claimLatencies.length ? Math.max(...claimLatencies) : null,
      completeMax: eligibleWallCompleteLatencies.length ? Math.max(...eligibleWallCompleteLatencies) : null,
      wallCompleteMax: wallCompleteLatencies.length ? Math.max(...wallCompleteLatencies) : null,
      activeCompleteMax: activeCompleteLatencies.length ? Math.max(...activeCompleteLatencies) : null,
      cumulativeActiveMax: cumulativeActiveLatencies.length
        ? Math.max(...cumulativeActiveLatencies)
        : null,
    },
    interruptions: {
      plannedWait: completed.filter((record) => (finiteNonNegative(record.plannedWaitMs) || 0) > 0).length,
      operatorWait: completed.filter((record) => (finiteNonNegative(record.operatorWaitMs) || 0) > 0).length,
      businessHold: completed.filter((record) => (finiteNonNegative(record.businessHoldMs) || 0) > 0).length,
      infrastructureWait: completed.filter((record) => (finiteNonNegative(record.infrastructureWaitMs) || 0) > 0).length,
      unobserved: completed.filter((record) => (finiteNonNegative(record.unobservedMs) || 0) > 60_000).length,
    },
    violations: {
      overdueClaim: overdueClaim.map((record) => record.orderNumber),
      overdueComplete: overdueComplete.map((record) => record.orderNumber),
      hardClaim: hardClaimViolations.map((record) => record.orderNumber),
      hardComplete: hardCompleteViolations.map((record) => record.orderNumber),
      wallHardCompleteDiagnostic: wallHardCompleteDiagnostics.map((record) => record.orderNumber),
    },
  };
};

const readNativeEnvironmentValue = (name) => {
  const envFile = path.join(appRoot, '.env.native');
  if (!fs.existsSync(envFile)) return null;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1).trim();
    return value.replace(/^(['"])(.*)\1$/u, '$2');
  }
  return null;
};

const runSelfTest = () => {
  assert(plannedWaitStages.includes('logistics-waiting-released')
    && plannedWaitStages.includes('consumer-response-waiting-released')
    && plannedWaitStages.includes('oms-shared-session-waiting')
    && plannedWaitStages.includes('oms-login-retry-deferred'),
  'released deferred waits must remain classified as planned waits');
  const base = Date.parse('2026-08-21T00:00:00.000Z');
  const record = (orderNumber, discoveredSeconds, claimedSeconds, completedSeconds, runtimeStatus = null) => ({
    orderNumber,
    firstDiscoveredAt: new Date(base + discoveredSeconds * 1000).toISOString(),
    startedAt: claimedSeconds === null ? null : new Date(base + claimedSeconds * 1000).toISOString(),
    completedAt: completedSeconds === null ? null : new Date(base + completedSeconds * 1000).toISOString(),
    runtimeStatus: runtimeStatus || (completedSeconds === null
      ? (claimedSeconds === null ? 'queued' : 'processing')
      : 'completed'),
  });
  const passing = evaluateOrdinaryLatency([
    record('a', 0, 5, 100),
    record('b', 20, 30, 200),
    record('c', 40, 55, 300),
    record('manual-review', 0, 1, null, 'paused'),
  ], { now: new Date(base + 400_000), minSamples: 3 });
  assert.equal(passing.status, 'passed');
  assert.equal(passing.activeSampleCount, 0);
  assert.equal(passing.nonRunnableSampleCount, 1);
  const interrupted = {
    ...record('verification-assisted', 0, 5, 3_700),
    activeProcessingMs: 95_000,
    plannedWaitMs: 0,
    operatorWaitMs: 3_600_000,
    businessHoldMs: 0,
    infrastructureWaitMs: 0,
    unobservedMs: 0,
  };
  const interruptionAware = evaluateOrdinaryLatency([
    record('clean', 0, 5, 100),
    interrupted,
    {
      ...record('future-retry', 0, 1, null, 'retry-ready'),
      nextAttemptAt: new Date(base + 700_000).toISOString(),
    },
  ], { now: new Date(base + 400_000), minSamples: 1 });
  assert.equal(interruptionAware.status, 'passed');
  assert.equal(interruptionAware.latencyEligibleSampleCount, 1);
  assert.equal(interruptionAware.interruptedSampleCount, 1);
  assert.equal(interruptionAware.interruptions.operatorWait, 1);
  assert.equal(interruptionAware.nonRunnableSampleCount, 1);
  assert.equal(interruptionAware.observedMs.wallCompleteMax, 3_695_000);
  assert.equal(interruptionAware.observedMs.activeCompleteMax, 95_000);
  const verificationBlocked = evaluateOrdinaryLatency([
    record('clean-before-verification', 0, 5, 100),
    {
      ...record('shop-verification-blocked', 0, null, null, 'retry-ready'),
      verificationBlocked: true,
    },
  ], { now: new Date(base + 600_000), minSamples: 1 });
  assert.equal(verificationBlocked.status, 'passed');
  assert.equal(verificationBlocked.verificationBlockedActiveCount, 1);
  assert.deepEqual(verificationBlocked.violations.overdueClaim, []);
  const failing = evaluateOrdinaryLatency([
    record('a', 0, 5, 100),
    record('stalled', 0, null, null),
  ], { now: new Date(base + 600_000), minSamples: 1 });
  assert.equal(failing.status, 'failed');
  assert.deepEqual(failing.violations.overdueClaim, ['stalled']);
  console.log('ordinary latency gate self-test passed');
};

const run = async () => {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return runSelfTest();
  const since = stringArgument(args, '--since', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
  if (!Number.isFinite(Date.parse(since))) throw new Error('--since requires an ISO timestamp');
  const until = stringArgument(args, '--until', null);
  if (until && !Number.isFinite(Date.parse(until))) throw new Error('--until requires an ISO timestamp');
  if (until && Date.parse(until) <= Date.parse(since)) throw new Error('--until must be after --since');
  const databaseUrl = process.env.DATABASE_URL || readNativeEnvironmentValue('DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(`
      WITH selected_instances AS MATERIALIZED (
        SELECT instance.id,
          work_order.shop_id,
          work_order.external_order_number AS order_number,
          instance.first_discovered_at,
          coalesce(
            (
              SELECT min(start_event.occurred_at)
              FROM workflow_events start_event
              WHERE start_event.ordinary_instance_id = instance.id
                AND start_event.event_type IN (
                  'workflow.progress',
                  'workflow.progress-replaced',
                  'workflow.snapshot-synchronized'
                )
                AND start_event.stage = 'resident-order-starting'
            ),
            instance.started_at
          ) AS started_at,
          instance.completed_at,
          instance.status,
          instance.runtime_status,
          instance.current_step,
          instance.next_attempt_at,
          work_order.recovery_updated_at,
          instance.updated_at,
          coalesce(instance.completed_at, now()) AS telemetry_end_at,
          EXISTS (
            SELECT 1
            FROM verification_locations verification
            WHERE verification.shop_id = work_order.shop_id
              AND verification.system_name = 'pdd'
              AND verification.status IN (
                'detected', 'waiting-human', 'verification-required'
              )
              AND verification.resolved_at IS NULL
          ) AS verification_blocked
        FROM ordinary_work_order_instances instance
        JOIN work_orders work_order ON work_order.id = instance.work_order_id
        WHERE work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
          AND coalesce(work_order.handling_classification, 'automated') = 'automated'
          AND instance.first_discovered_at >= $1::timestamptz
          AND ($2::timestamptz IS NULL OR instance.first_discovered_at < $2::timestamptz)
      ), timeline_points AS MATERIALIZED (
        SELECT instance.id AS ordinary_instance_id,
          instance.started_at AS occurred_at,
          'processing-started'::text AS stage,
          0::bigint AS sequence
        FROM selected_instances instance
        WHERE instance.started_at IS NOT NULL
          AND instance.telemetry_end_at >= instance.started_at
        UNION ALL
        SELECT event.ordinary_instance_id,
          event.occurred_at,
          event.stage,
          coalesce(event.sequence, 0)
        FROM workflow_events event
        JOIN selected_instances instance ON instance.id = event.ordinary_instance_id
        WHERE instance.started_at IS NOT NULL
          AND event.event_type IN ('workflow.progress', 'workflow.progress-replaced')
          AND event.occurred_at > instance.started_at
          AND event.occurred_at < instance.telemetry_end_at
      ), ordered_points AS (
        SELECT point.ordinary_instance_id,
          point.occurred_at AS segment_start_at,
          count(*) FILTER (WHERE point.stage = 'resident-order-starting') OVER (
            PARTITION BY point.ordinary_instance_id
            ORDER BY point.occurred_at, point.sequence, point.stage
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS attempt_number,
          lead(point.occurred_at) OVER (
            PARTITION BY point.ordinary_instance_id
            ORDER BY point.occurred_at, point.sequence, point.stage
          ) AS next_point_at,
          point.stage
        FROM timeline_points point
      ), raw_segments AS (
        SELECT point.ordinary_instance_id,
          point.stage,
          point.attempt_number,
          point.segment_start_at,
          least(
            coalesce(point.next_point_at, instance.telemetry_end_at),
            instance.telemetry_end_at
          ) AS segment_end_at
        FROM ordered_points point
        JOIN selected_instances instance ON instance.id = point.ordinary_instance_id
      ), classified_segments AS (
        SELECT segment.*,
          greatest(0, extract(epoch FROM (
            segment.segment_end_at - segment.segment_start_at
          )) * 1000) AS duration_ms,
          CASE
            WHEN segment.stage IN (
              ${sqlLiteralList(plannedWaitStages)}
            ) THEN 'planned-wait'
            WHEN segment.stage IN (
              'human-verification-required',
              'manual-login-required'
            ) THEN 'operator-wait'
            WHEN segment.stage IN (
              'flow-paused',
              'manual-review-required',
              'manual-review-waiting',
              'manual-review-blocked'
            ) THEN 'business-hold'
            WHEN segment.stage LIKE 'system-shutdown%'
              OR segment.stage LIKE 'browser-proxy-%'
              OR segment.stage IN (
                'worker-preflight-failed',
                'browser-process-exited'
              ) THEN 'infrastructure-wait'
            ELSE 'active'
          END AS segment_class
        FROM raw_segments segment
        WHERE segment.segment_end_at > segment.segment_start_at
      ), attempt_starts AS (
        SELECT instance.id AS ordinary_instance_id,
          coalesce(
            max(point.occurred_at) FILTER (
              WHERE point.stage = 'resident-order-starting'
            ),
            instance.started_at
          ) AS current_attempt_started_at
        FROM selected_instances instance
        LEFT JOIN timeline_points point ON point.ordinary_instance_id = instance.id
        GROUP BY instance.id, instance.started_at
      ), attempt_telemetry AS (
        SELECT segment.ordinary_instance_id,
          segment.attempt_number,
          coalesce(sum(least(segment.duration_ms, 60000)) FILTER (
            WHERE segment.segment_class = 'active'
          ), 0)::bigint AS active_processing_ms
        FROM classified_segments segment
        GROUP BY segment.ordinary_instance_id, segment.attempt_number
      ), segment_telemetry AS (
        SELECT segment.ordinary_instance_id,
          coalesce(sum(segment.duration_ms) FILTER (
            WHERE segment.segment_class = 'planned-wait'
          ), 0)::bigint AS planned_wait_ms,
          coalesce(sum(segment.duration_ms) FILTER (
            WHERE segment.segment_class = 'operator-wait'
          ), 0)::bigint AS operator_wait_ms,
          coalesce(sum(segment.duration_ms) FILTER (
            WHERE segment.segment_class = 'business-hold'
          ), 0)::bigint AS business_hold_ms,
          coalesce(sum(segment.duration_ms) FILTER (
            WHERE segment.segment_class = 'infrastructure-wait'
          ), 0)::bigint AS infrastructure_wait_ms,
          coalesce(sum(greatest(segment.duration_ms - 60000, 0)) FILTER (
            WHERE segment.segment_class = 'active'
          ), 0)::bigint AS unobserved_ms,
          coalesce(sum(
            least(
              greatest(0, extract(epoch FROM (
                segment.segment_end_at - greatest(
                  segment.segment_start_at,
                  attempt.current_attempt_started_at
                )
              )) * 1000),
              60000
            )
          ) FILTER (
            WHERE segment.segment_class = 'active'
              AND segment.segment_end_at > attempt.current_attempt_started_at
          ), 0)::bigint AS current_attempt_active_ms,
          attempt.current_attempt_started_at
        FROM classified_segments segment
        JOIN attempt_starts attempt ON attempt.ordinary_instance_id = segment.ordinary_instance_id
        GROUP BY segment.ordinary_instance_id, attempt.current_attempt_started_at
      ), telemetry AS (
        SELECT segment.*,
          coalesce(max(attempt.active_processing_ms), 0)::bigint AS active_processing_ms,
          coalesce(sum(attempt.active_processing_ms), 0)::bigint AS cumulative_active_processing_ms
        FROM segment_telemetry segment
        LEFT JOIN attempt_telemetry attempt
          ON attempt.ordinary_instance_id = segment.ordinary_instance_id
        GROUP BY segment.ordinary_instance_id,
          segment.planned_wait_ms,
          segment.operator_wait_ms,
          segment.business_hold_ms,
          segment.infrastructure_wait_ms,
          segment.unobserved_ms,
          segment.current_attempt_active_ms,
          segment.current_attempt_started_at
      )
      SELECT instance.order_number AS "orderNumber",
        instance.first_discovered_at AS "firstDiscoveredAt",
        instance.started_at AS "startedAt",
        instance.completed_at AS "completedAt",
        instance.status,
        instance.runtime_status AS "runtimeStatus",
        instance.current_step AS "currentStep",
        instance.next_attempt_at AS "nextAttemptAt",
        instance.recovery_updated_at AS "recoveryUpdatedAt",
        instance.updated_at AS "updatedAt",
        instance.verification_blocked AS "verificationBlocked",
        telemetry.active_processing_ms AS "activeProcessingMs",
        telemetry.cumulative_active_processing_ms AS "cumulativeActiveProcessingMs",
        telemetry.planned_wait_ms AS "plannedWaitMs",
        telemetry.operator_wait_ms AS "operatorWaitMs",
        telemetry.business_hold_ms AS "businessHoldMs",
        telemetry.infrastructure_wait_ms AS "infrastructureWaitMs",
        telemetry.unobserved_ms AS "unobservedMs",
        telemetry.current_attempt_active_ms AS "currentAttemptActiveMs",
        telemetry.current_attempt_started_at AS "currentAttemptStartedAt"
      FROM selected_instances instance
      LEFT JOIN telemetry ON telemetry.ordinary_instance_id = instance.id
      ORDER BY instance.first_discovered_at`, [since, until]);
    const report = evaluateOrdinaryLatency(result.rows, {
      minSamples: numberArgument(args, '--min-samples', 1),
      claimP95Ms: numberArgument(args, '--claim-p95-ms', 120_000),
      claimHardMs: numberArgument(args, '--claim-hard-ms', 300_000),
      completeP95Ms: numberArgument(args, '--complete-p95-ms', 900_000),
      completeHardMs: numberArgument(args, '--complete-hard-ms', 1_800_000),
    });
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), since, until, ...report }, null, 2));
    if (report.status === 'insufficient-data') process.exitCode = 2;
    else if (!report.passed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

await run();
