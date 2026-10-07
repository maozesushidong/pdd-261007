import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, PostgresWorkflowRepository } from '../../../packages/adapters/src/postgres/index.mjs';
import { canonicalScenarioCode } from '../../../packages/domain/src/scenario-code.mjs';
import { classifyReturnRefundUnexpectedFailure } from '../../../packages/adapters/src/pdd/return-refund.mjs';
import { discoveryWaitsForRateLimit } from './discovery-wait-state.mjs';
import {
  createBrowserHealthMonitor,
  normalizeBrowserProcessExitCode,
} from './browser-health-monitor.mjs';
import {
  advanceBrowserProxyNavigationFailureCircuit,
  detectBrowserProxyNavigationFailure,
  probeBrowserProxyConnectivity,
  resolveBrowserProxyConfig,
} from '../../../packages/adapters/src/browser-runtime-config.mjs';
import { schedulerConfigFromEnv } from './scheduler-policy.mjs';
import { consumeCodeReloadScanCadence } from './worker-code-reload-cadence.mjs';
import { readBrowserProxyEnvironmentFile } from '../../../scripts/browser-proxy-preflight.mjs';
import { ShopSchedulerRepository } from './scheduler-repository.mjs';
import {
  canonicalDetectedPddShopName,
  normalizeDetectedPddShopName,
  pddIdentityMatches,
  pddIdentityNameSet,
} from './pdd-shop-identity.mjs';
import { canTrustCorrectedPddProfile } from './pdd-profile-rotation-policy.mjs';
import {
  isPddTabUnavailableFailure,
  pddTabUnavailableRetryAt,
} from './pdd-tab-availability-policy.mjs';
import {
  advanceReturnRefundWaitBudget,
  createReturnRefundWaitTimeoutError,
  returnRefundClaimCommandUnsettled,
} from './return-refund-wait-state.mjs';
import {
  isReturnRefundScanDue,
  nextReturnRefundScanRetry,
  returnRefundScanBatchDurationMs,
  returnRefundScanEffectiveStartCursor,
  returnRefundPartialScanCooldownMs,
  returnRefundSessionRunwayCooldownUntil,
  returnRefundVerificationCooldownUntil,
  returnRefundScanStartupDelay,
  shouldPrioritizeReturnRefundScan,
  shouldResumePartialReturnRefundScan,
} from './return-refund-scan-policy.mjs';
import {
  workflowAuthenticationState,
  workflowHeartbeatState,
  workflowStallExemption,
} from './workflow-stall-policy.mjs';
import {
  classifyClearedResidentVerification,
  classifyDetachedClearedReturnRefundVerification,
  classifyInterruptedVerification,
  classifyResidentLoginInterruption,
  classifyRestoredPreClaimVerification,
  classifyStaleBoundPreClaimVerificationGate,
  classifyStalePreClaimVerificationGate,
  classifyWaitingResidentVerification,
  isHumanVerificationInterruptionReason,
  preClaimVerificationRecoveryRetryCooldownMs,
  shouldReusePreClaimVerificationRecovery,
} from './verification-recovery-policy.mjs';
import {
  classifyResidentCommandRetryRelease,
  classifyResidentTerminalPauseAfterSessionRecovery,
  residentReconciliationTerminalOutcome,
} from './resident-command-recovery-policy.mjs';
import { isRetryableCreatedTmsFilterFailure } from './tms-filter-retry-policy.mjs';
import { abnormalUnshippedVerificationRetryAt } from './abnormal-unshipped-verification-policy.mjs';
import { pddVerificationPressureCooldownUntil } from './pdd-verification-pressure-policy.mjs';
import { writeTextAtomic } from '../../../packages/adapters/src/atomic-file.mjs';
import { retryPostgresCheckpoint } from './postgres-checkpoint-retry.mjs';
import { ChatRepository } from '../../../packages/adapters/src/chat-analysis/repository.mjs';
import { chatPolicies } from '../../../packages/adapters/src/chat-analysis/rules.mjs';

// Older server deployments expose the registry but not the convenience
// lookup export. Keep worker startup compatible while using the same
// version-aware scenario selection when that method is unavailable.
const chatPolicyForScenario = (scenarioCode) => {
  if (typeof chatPolicies?.forScenario === 'function') return chatPolicies.forScenario(scenarioCode);
  const normalized = String(scenarioCode || '').trim();
  return [...(chatPolicies?.policies?.values?.() || [])]
    .filter((policy) => policy?.scenarioCode === normalized)
    .sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0))[0] || null;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const scenarioCatalog = JSON.parse(fs.readFileSync(path.join(root, 'config', 'scenarios.json'), 'utf8'));
const pausedScenarioCodes = new Set((scenarioCatalog.scenarios || [])
  .filter((scenario) => scenario?.enabled !== false && scenario?.processingEnabled === false)
  .map((scenario) => canonicalScenarioCode(scenario.code))
  .filter(Boolean));
const runnerStartedAt = Date.now();
const runnerSourceSha256 = crypto.createHash('sha256')
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');
const workerId = process.env.WORKER_ID || `playwright-worker-${process.pid}`;
const shopId = String(process.env.WORKER_SHOP_ID || '').trim();
const schedulerMode = String(process.env.WORKER_SCHEDULER_MODE || 'legacy').toLowerCase();
const slotSession = schedulerMode === 'slots';
const slotId = String(process.env.WORKER_SLOT_ID || '').trim();
let slotKind = String(process.env.WORKER_SLOT_KIND || '').trim();
const slotLeaseToken = String(process.env.WORKER_SLOT_LEASE_TOKEN || '').trim();
let assignmentKind = String(process.env.WORKER_ASSIGNMENT_KIND || '').trim();
const sessionMaxMs = Math.max(60_000, Number(process.env.WORKER_SESSION_MAX_MS || 10 * 60_000));
const identityBindingWaitMs = Math.max(5 * 60_000, sessionMaxMs);
const keepEnabledShopsResident = String(
  process.env.WORKER_KEEP_ENABLED_SHOPS_RESIDENT || 'false',
).toLowerCase() === 'true';
const persistentSlotSession = slotSession && keepEnabledShopsResident;
const boundedSlotSession = slotSession && !persistentSlotSession;
const mixedBusinessSlotSession = !slotSession
  || persistentSlotSession
  || (boundedSlotSession && ['ordinary', 'recovery'].includes(assignmentKind));
const sessionDeadline = boundedSlotSession ? Date.now() + sessionMaxMs : Number.POSITIVE_INFINITY;
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT || path.join(root, '.codex'));
const pollMs = Math.max(1_000, Number(process.env.WORKER_POLL_INTERVAL_MS || 2_000));
const configuredMaxOrders = Number(process.env.WORKER_MAX_ORDERS || 0);
const maxOrders = Number.isFinite(configuredMaxOrders) && configuredMaxOrders > 0
  ? Math.floor(configuredMaxOrders)
  : 0;
const browserMode = process.env.WORKFLOW_BROWSER_MODE || 'server-headed';
const residentBrowser = String(process.env.WORKER_RESIDENT_BROWSER || 'true').toLowerCase() === 'true';
const browserProxyProbeTimeoutMs = Math.max(
  1_000,
  Number(process.env.WORKER_BROWSER_PROXY_PROBE_TIMEOUT_MS || 5_000),
);
const browserProxyRetryMs = Math.max(
  10_000,
  Number(process.env.WORKER_BROWSER_PROXY_RETRY_MS || 30_000),
);
const browserProxyNavigationFailureLimit = Math.max(
  2,
  Math.min(10, Number(process.env.WORKER_BROWSER_PROXY_NAVIGATION_FAILURE_LIMIT || 3)),
);
const browserProxyNavigationFailureWindowMs = Math.max(
  30_000,
  Number(process.env.WORKER_BROWSER_PROXY_NAVIGATION_FAILURE_WINDOW_MS || 2 * 60_000),
);
const browserProxyNavigationCooldownMs = Math.max(
  browserProxyRetryMs,
  Number(process.env.WORKER_BROWSER_PROXY_NAVIGATION_COOLDOWN_MS || 2 * 60_000),
);
const browserProxyNavigationMaxCooldownMs = Math.max(
  browserProxyNavigationCooldownMs,
  Number(process.env.WORKER_BROWSER_PROXY_NAVIGATION_MAX_COOLDOWN_MS || 10 * 60_000),
);
let browserProxyConfig = null;
let browserProxyConfigurationError = null;
try {
  // Configuration reloads retain the parent supervisor. Read its current
  // on-disk proxy settings so the preflight checks the same endpoint as Chrome.
  const nativeProxyEnvFile = path.join(root, '.env.native');
  const proxyEnv = process.platform === 'win32' && fs.existsSync(nativeProxyEnvFile)
    ? { ...process.env, ...readBrowserProxyEnvironmentFile(nativeProxyEnvFile) }
    : process.env;
  browserProxyConfig = resolveBrowserProxyConfig({ env: proxyEnv });
} catch (error) {
  browserProxyConfigurationError = {
    errorCode: 'PROXY_CONFIGURATION_INVALID',
    error: error.message,
    checkedAt: new Date().toISOString(),
  };
}
let browserProxyHealth = null;
let browserProxyNextProbeAt = 0;
let browserProxyWasUnavailable = false;
let browserProxyNavigationCircuit = null;
let browserProxyNavigationFailureObservedThisTurn = false;
let browserProxyNavigationRecoveryPending = false;
const leaseSeconds = Math.max(120, Number(process.env.WORKER_LEASE_SECONDS || 180));
const leaseRenewMs = Math.max(30_000, Number(process.env.WORKER_LEASE_RENEW_MS || Math.floor(leaseSeconds * 1000 / 3)));
const heartbeatIntervalMs = Math.max(5_000, Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 15_000));
const browserHealthCheckIntervalMs = Math.max(1_000, Number(process.env.WORKER_BROWSER_HEALTH_CHECK_INTERVAL_MS || 2_500));
const browserHealthTimeoutMs = Math.max(
  60_000,
  browserHealthCheckIntervalMs * 2,
  Number(process.env.WORKER_BROWSER_HEALTH_TIMEOUT_MS || 60_000),
);
const browserHealthStartupGraceMs = Math.max(
  browserHealthTimeoutMs,
  Number(process.env.WORKER_BROWSER_HEALTH_STARTUP_GRACE_MS || 90_000),
);
const discoveryIntervalMs = Math.max(60_000, Number(process.env.PDD_DISCOVERY_INTERVAL_MS || 60_000));
const returnRefundScanIntervalMs = Math.max(60_000, Number(process.env.RETURN_REFUND_SCAN_INTERVAL_MS || 1_800_000));
const returnRefundScanForceIntervalMs = Math.max(
  returnRefundScanIntervalMs,
  Math.min(
    12 * 60 * 60_000,
    Number(process.env.RETURN_REFUND_SCAN_FORCE_INTERVAL_MS || 2 * 60 * 60_000),
  ),
);
const configuredReturnRefundScanStartupJitterMaxMs = Number(
  process.env.RETURN_REFUND_SCAN_STARTUP_JITTER_MAX_MS,
);
const returnRefundVerificationRetryMs = Math.max(
  5_000,
  Math.min(60_000, Number(process.env.RETURN_REFUND_VERIFICATION_RETRY_MS || 10_000)),
);
const returnRefundScanVerificationRetryMs = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.RETURN_REFUND_SCAN_VERIFICATION_RETRY_MS || 5 * 60_000)),
);
const returnRefundScanFailureRetryMs = Math.max(
  30_000,
  Math.min(30 * 60_000, Number(process.env.RETURN_REFUND_SCAN_FAILURE_RETRY_MS || 120_000)),
);
const returnRefundScanEnabledFallback = String(process.env.RETURN_REFUND_SCAN_ENABLED || 'true').toLowerCase() === 'true';
const returnRefundScanOnce = String(process.env.RETURN_REFUND_SCAN_ONCE || 'false').toLowerCase() === 'true';
const returnRefundValidationDetailUrl = String(process.env.RETURN_REFUND_VALIDATE_DETAIL_URL || '').trim();
const returnRefundValidationOrderNumber = String(process.env.RETURN_REFUND_VALIDATE_ORDER_NUMBER || '').trim();
const returnRefundValidationAftersaleNumber = String(process.env.RETURN_REFUND_VALIDATE_AFTERSALE_NUMBER || '').trim();
const returnRefundOnly = String(process.env.RETURN_REFUND_ONLY || 'false').toLowerCase() === 'true';
const directRefundExecutionSession = boundedSlotSession && assignmentKind === 'refund-execution';
const dynamicPddShopBinding = String(process.env.PDD_DYNAMIC_SHOP_BINDING || 'false').toLowerCase() === 'true';
const returnRefundPddOnly = returnRefundScanOnce || returnRefundOnly || directRefundExecutionSession;
const returnRefundKeepBrowserOpen = returnRefundScanOnce
  && String(process.env.RETURN_REFUND_KEEP_BROWSER_OPEN || 'false').toLowerCase() === 'true';
const returnRefundAutoApproveEnabledFallback = String(
  returnRefundScanOnce ? 'false' : process.env.RETURN_REFUND_AUTO_APPROVE_ENABLED || 'false',
).toLowerCase() === 'true';
const returnRefundScanMaxItems = Math.max(1, Math.min(10_000, Number(process.env.RETURN_REFUND_SCAN_MAX_ITEMS || 10_000)));
const returnRefundCombinedBatchItems = Math.max(
  1,
  Math.min(50, Number(process.env.RETURN_REFUND_COMBINED_BATCH_ITEMS || 3)),
);
const returnRefundCombinedBatchMaxDurationMs = Math.max(
  30_000,
  Math.min(10 * 60_000, Number(process.env.RETURN_REFUND_COMBINED_BATCH_MAX_DURATION_MS || 90_000)),
);
// A partial scan advances a durable cursor. Give ordinary discovery and
// queued work a chance before continuing that cursor, otherwise a large
// return/refund backlog can occupy a resident shop indefinitely.
const returnRefundPartialBatchCooldownMs = Math.max(
  30_000,
  Math.min(
    30 * 60_000,
    Number(process.env.RETURN_REFUND_PARTIAL_BATCH_COOLDOWN_MS || 5 * 60_000),
  ),
);
const returnRefundPostVerificationCooldownMs = Math.max(
  returnRefundPartialBatchCooldownMs,
  Math.min(
    2 * 60 * 60_000,
    Number(process.env.RETURN_REFUND_POST_VERIFICATION_COOLDOWN_MS || 5 * 60_000),
  ),
);
// A CAPTCHA is an operator/plugin interaction, not part of the scan batch
// wall-time budget.  Capping it by RETURN_REFUND_COMBINED_BATCH_MAX_DURATION_MS
// made a normal 30-second scan batch close a newly-rendered challenge before
// the operator could even start dragging.  Keep the platform-wide two-minute
// verification window for mixed scans; workflow.mjs applies the same hard cap
// for every verification surface.
const returnRefundCombinedScanVerificationBudgetMs = 120_000;
const returnRefundDirectClaimsBeforeScan = Math.max(
  1,
  Math.min(20, Number(process.env.RETURN_REFUND_DIRECT_CLAIMS_BEFORE_SCAN || 4)),
);
// Bounded scheduler sessions keep their existing one-for-one fairness. A
// resident shop can amortize browser context switches across a short ordinary
// batch without changing any refund decision or submission behavior.
const ordinaryClaimsBeforeRefund = boundedSlotSession
  ? 1
  : Math.max(1, Math.min(20, Number(process.env.ORDINARY_CLAIMS_BEFORE_REFUND || 3)));
// Drain claimable ordinary work before starting another refund scan. A refund
// cursor can remain due across many partial batches; repeatedly entering that
// scan while ordinary work is available makes visible PDD work orders wait.
const drainOrdinaryQueueBeforeRefund = String(
  process.env.ORDINARY_DRAIN_QUEUE_BEFORE_REFUND || 'true',
).toLowerCase() === 'true';
const returnRefundScanMaxDurationMs = Math.max(
  30_000,
  Math.min(4 * 60 * 60_000, Number(process.env.RETURN_REFUND_SCAN_MAX_DURATION_MS || 2 * 60 * 60_000)),
);
const maxBrowserRecoveryAttempts = Math.max(1, Number(process.env.WORKER_BROWSER_RECOVERY_ATTEMPTS || 3));
const maxTransientWorkflowRecoveryAttempts = Math.max(
  1,
  Number(process.env.WORKER_TRANSIENT_WORKFLOW_RECOVERY_ATTEMPTS || 5),
);
const transientWorkflowRetryMs = Math.max(
  30_000,
  Number(process.env.WORKER_TRANSIENT_WORKFLOW_RETRY_MS || 120_000),
);
const tmsFilterTransientRetryMs = Math.max(
  120_000,
  Math.min(15 * 60_000, Number(process.env.WORKER_TMS_FILTER_TRANSIENT_RETRY_MS || 5 * 60_000)),
);
const fastTransientWorkflowRetryMs = Math.max(
  10_000,
  Number(process.env.WORKER_FAST_TRANSIENT_WORKFLOW_RETRY_MS || 30_000),
);
const verificationRetryDelaysMs = [10 * 60_000, 30 * 60_000, 60 * 60_000];
const verificationGateTimeoutMs = 120_000;
const verificationGatePostTimeoutSuppressionMs = 10 * 60_000;
// A live CAPTCHA must remain an active shop gate until the resident browser
// confirms that it disappeared. Elapsed time alone is not evidence that the
// operator or plugin completed the challenge.
const verificationGateTimeoutReleaseEnabled = false;
const externalStateRetryMs = Math.max(
  60_000,
  Number(process.env.WORKER_EXTERNAL_STATE_RETRY_MS || 600_000),
);
const externalStateRetryWindowMs = Math.max(
  externalStateRetryMs,
  Number(process.env.WORKER_EXTERNAL_STATE_RETRY_WINDOW_MS || 2_592_000_000),
);
const externalStateMaxAttempts = Math.max(
  1,
  Number(process.env.WORKER_EXTERNAL_STATE_MAX_ATTEMPTS || 6),
);
const externalStateFairnessClaims = Math.max(
  1,
  Math.min(50, Number(process.env.WORKER_EXTERNAL_STATE_FAIRNESS_CLAIMS || 3)),
);
const discoveryFile = path.join(dataRoot, 'shops', shopId, 'state', 'pdd-discovery.json');
const returnRefundOutputFile = path.join(dataRoot, 'shops', shopId, 'state', 'return-refund-result.json');
const browserDisconnectedExitCode = 90;
const progressFile = path.join(dataRoot, 'shops', shopId, 'state', 'workflow-progress.json');
const checkpointBackupDir = path.join(dataRoot, 'shops', shopId, 'state', 'order-checkpoints');
const browserProfileMarkerFile = path.join(dataRoot, 'shops', shopId, 'browser-profile', '.workflow-profile.json');

const isMaskedDetectedPddShopName = (value) => {
  const normalized = normalizeDetectedPddShopName(value);
  return normalized.includes('***') || /(?:\.{3}|\u2026)/u.test(normalized);
};

const normalizePddMallId = (value) => {
  const normalized = String(value ?? '').trim();
  return /^\d{5,30}$/u.test(normalized) ? normalized : null;
};

const pddIdentityKey = ({ mallId, actualShopName }) => {
  const normalizedMallId = normalizePddMallId(mallId);
  return normalizedMallId
    ? `mall:${normalizedMallId}`
    : canonicalDetectedPddShopName(actualShopName).toLocaleLowerCase('zh-CN');
};

async function readSecret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    const value = await fsp.readFile(file, 'utf8');
    if (value.trim()) return value.trim();
  }
  const secretDirectory = String(process.env.WORKFLOW_SECRETS_DIR || '').trim();
  if (secretDirectory) {
    const secretPath = path.join(secretDirectory, name);
    try {
      const value = await fsp.readFile(secretPath, 'utf8');
      if (value.trim()) return value.trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return process.env[name] || '';
}

const readCredentialPair = async (prefixes) => {
  for (const prefix of prefixes) {
    const account = await readSecret(`${prefix}_ACCOUNT`);
    const password = await readSecret(`${prefix}_PASSWORD`);
    if (account && password) return { account, password, prefix };
    if (account || password) {
      console.warn(`Incomplete OMS credential pair ignored: ${prefix}`);
    }
  }
  return { account: '', password: '', prefix: null };
};

async function ensureRetrySchema(pool) {
  const client = await pool.connect();
  try {
    const expectedEffectTypes = [
      'tms-create',
      'pdd-submit',
      'pdd-note',
      'pdd-return-refund',
      'evidence-upload',
      'oms-manual-allocation',
      'oms-reissue-create',
    ];
    const readSchemaState = async () => {
      const state = await client.query(`
        SELECT
          EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = 'work_orders'::regclass
              AND attname = 'next_attempt_at'
              AND NOT attisdropped
          ) AS has_next_attempt_at,
          to_regclass('idx_work_orders_retry_queue') IS NOT NULL AS has_retry_index,
          to_regclass('pdd_shop_runtime_bindings') IS NOT NULL AS has_binding_table,
          EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('pdd_shop_runtime_bindings')
              AND attname = 'mall_id'
              AND NOT attisdropped
          ) AS has_runtime_mall_id,
          EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('shop_identity_bindings')
              AND attname = 'mall_id'
              AND NOT attisdropped
          ) AS has_identity_mall_id,
          (
            SELECT pg_get_constraintdef(constraint_row.oid)
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = 'external_effects'::regclass
              AND constraint_row.conname = 'external_effects_effect_type_check'
          ) AS effect_type_constraint`);
      const row = state.rows[0] || {};
      const constraint = String(row.effect_type_constraint || '');
      return {
        ...row,
        effect_type_constraint_current: expectedEffectTypes.every(
          (effectType) => constraint.includes(`'${effectType}'`),
        ),
      };
    };
    let state = await readSchemaState();
    if (state.has_next_attempt_at
      && state.has_retry_index
      && state.has_binding_table
      && state.has_runtime_mall_id
      && state.has_identity_mall_id
      && state.effect_type_constraint_current) return;

    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pdd-workflow:ensure-retry-schema'))");
    state = await readSchemaState();
    if (!state.has_next_attempt_at) {
      await client.query('ALTER TABLE work_orders ADD COLUMN next_attempt_at timestamptz');
    }
    if (!state.has_retry_index) {
      await client.query('CREATE INDEX idx_work_orders_retry_queue ON work_orders (shop_id, status, next_attempt_at, created_at)');
    }
    if (!state.has_binding_table) {
      await client.query(`CREATE TABLE pdd_shop_runtime_bindings (
        identity_key text PRIMARY KEY,
        shop_id text NOT NULL UNIQUE REFERENCES shops(id),
        actual_shop_name text NOT NULL,
        mall_id text,
        binding_token uuid NOT NULL,
        profile_fingerprint text,
        bound_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )`);
    }
    if (state.has_binding_table && !state.has_runtime_mall_id) {
      await client.query('ALTER TABLE pdd_shop_runtime_bindings ADD COLUMN mall_id text');
    }
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdd_shop_runtime_bindings_mall_id
      ON pdd_shop_runtime_bindings (mall_id) WHERE mall_id IS NOT NULL`);
    if (!state.has_identity_mall_id) {
      await client.query('ALTER TABLE shop_identity_bindings ADD COLUMN mall_id text');
    }
    if (!state.effect_type_constraint_current) {
      await client.query("ALTER TABLE external_effects DROP CONSTRAINT IF EXISTS external_effects_effect_type_check");
      await client.query("ALTER TABLE external_effects ADD CONSTRAINT external_effects_effect_type_check CHECK (effect_type IN ('tms-create','pdd-submit','pdd-note','pdd-return-refund','evidence-upload','oms-manual-allocation','oms-reissue-create'))");
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function discoverPendingOrder(excludedPlatformCaseKeys = [], excludedOrdinaryCandidates = [], chatCommand = null) {
  const discoveryStartedAt = Date.now();
  await fsp.mkdir(path.dirname(discoveryFile), { recursive: true, mode: 0o700 });
  await fsp.rm(discoveryFile, { force: true });
  let run = null;
  let residentRequestId = null;
  if (residentBrowser) {
    try {
      if (!activeChildRunning()) {
        run = startLegacyPlaywright(null, {
          discoverOnly: true,
          excludedPlatformCaseKeys,
          excludedOrdinaryCandidates,
        });
      }
      await waitForActiveResidentReady();
      const accepted = await sendWorkflowCommand({
        action: chatCommand ? 'chat-collect' : 'discover',
        excludedPlatformCaseKeys,
        excludedOrdinaryCandidates,
        ...(chatCommand || {}),
      });
      residentRequestId = accepted.requestId;
      run = { child: activeChild, exitPromise: activeChildExitPromise };
    } catch (error) {
      console.error('[resident-browser] ' + shopId + ' discovery reuse failed: ' + error.message);
      const discoveryError = new Error(
        `PDD resident discovery command failed: ${error.message}`,
        { cause: error },
      );
      discoveryError.code = error.code || null;
      discoveryError.requestId = error.requestId || null;
      return recoverDiscoveryFailure(discoveryError);
    }
  } else {
    run = startLegacyPlaywright(null, {
      discoverOnly: true,
      excludedPlatformCaseKeys,
      excludedOrdinaryCandidates,
    });
  }
  let remainingMs = discoveryResultTimeoutMs;
  let checkedAt = Date.now();
  while (true) {
    await observeOnboardingProgress().catch((error) => {
      console.error(`[shop-onboarding] ${shopId}: ${error.message}`);
    });
    let discovery = null;
    try { discovery = JSON.parse(await fsp.readFile(discoveryFile, 'utf8')); } catch { /* wait for discovery output */ }
    const progress = await readProgress().catch(() => ({}));
    const residentCommandSettled = !residentBrowser || (
      discovery?.requestId === residentRequestId
      && progress.residentCommand?.requestId === residentRequestId
      && progress.residentCommand?.status === 'idle'
    );
    if (discovery && residentCommandSettled) {
      if (!residentBrowser) {
        const result = await run.exitPromise;
        if (result.code !== 0) throw new Error(`PDD discovery exited with code ${result.code || result.signal}`);
      }
      return discovery;
    }
    const result = await Promise.race([
      run.exitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    if (result) {
      try {
        const discovery = JSON.parse(await fsp.readFile(discoveryFile, 'utf8'));
        if (result.code === 0) return discovery;
      } catch { /* report the child exit below */ }
      if (residentBrowser) {
        return {
          mode: 'discovery',
          status: 'retryable-error',
          shopId,
          error: `PDD discovery browser exited with code ${result.code || result.signal}`,
          failedAt: new Date().toISOString(),
        };
      }
      throw new Error(`PDD discovery exited with code ${result.code || result.signal}`);
    }
    const now = Date.now();
    const verificationWaiting = ['human-verification-required', 'manual-login-required']
      .includes(progress.step)
      || ['detected', 'waiting-human', 'verification-required']
        .includes(progress.verificationLocation?.status)
      || ['expired', 'verification-required'].includes(progress.authHealth?.pdd?.status);
    const rateLimitWaiting = discoveryWaitsForRateLimit(progress, {
      requestId: residentRequestId, startedAt: discoveryStartedAt, now,
    });
    if (!verificationWaiting && !rateLimitWaiting) remainingMs -= now - checkedAt;
    checkedAt = now;
    if (remainingMs <= 0) {
      return recoverDiscoveryFailure(
        new Error(`PDD discovery did not complete within ${discoveryResultTimeoutMs}ms`),
      );
    }
  }
}

if (!shopId) throw new Error('WORKER_SHOP_ID is required for live single-shop gray run');
if (String(process.env.WORKER_LIVE_APPROVED || 'false').toLowerCase() !== 'true') {
  throw new Error('WORKER_LIVE_APPROVED=true is required for Playwright live mode');
}
if (!['headed', 'server-headed'].includes(browserMode)) throw new Error('Live Playwright worker requires headed or server-headed mode');

const pool = await createPostgresPool(undefined, {
  max: slotSession ? 2 : undefined,
  applicationName: slotSession ? `pdd-slot-runner-${shopId}` : undefined,
});
let nextVerificationPressureCheckAt = 0;
let verificationPressureCooldownUntil = 0;
let lastVerificationPressureHeartbeatAt = 0;
let verificationPressureCaseCount = 0;
let verificationPressureHourCaseCount = 0;
const shouldCoolDownPddAfterVerification = async () => {
  const now = Date.now();
  if (now >= nextVerificationPressureCheckAt) {
    try {
      const { rows } = await pool.query(`
        WITH recent AS (
          SELECT id, work_order_id, resolved_at
          FROM verification_locations
          WHERE shop_id = $1 AND system_name = 'pdd' AND status = 'resolved'
            AND resolved_at >= now() - interval '90 minutes'
        ), latest AS (
          SELECT max(resolved_at) AS latest_resolved_at FROM recent
        )
        SELECT
          (SELECT count(DISTINCT coalesce(work_order_id::text, id::text))::int
           FROM recent WHERE resolved_at >= latest.latest_resolved_at - interval '30 minutes')
            AS case_count,
          (SELECT count(DISTINCT coalesce(work_order_id::text, id::text))::int
           FROM recent WHERE resolved_at >= latest.latest_resolved_at - interval '1 hour')
            AS hour_case_count,
          latest.latest_resolved_at
        FROM latest
      `, [shopId]);
      verificationPressureCaseCount = Number(rows[0]?.case_count || 0);
      verificationPressureHourCaseCount = Number(rows[0]?.hour_case_count || 0);
      verificationPressureCooldownUntil = pddVerificationPressureCooldownUntil({
        distinctResolvedCases: verificationPressureCaseCount,
        distinctResolvedCasesHour: verificationPressureHourCaseCount,
        latestResolvedAt: rows[0]?.latest_resolved_at,
        now,
      });
      nextVerificationPressureCheckAt = now + 15_000;
    } catch (error) {
      console.error(`[verification-pressure][${shopId}] ${error.message}`);
      nextVerificationPressureCheckAt = now + 30_000;
      return false;
    }
  }
  if (verificationPressureCooldownUntil <= now) return false;
  if (now - lastVerificationPressureHeartbeatAt >= 10_000) {
    lastVerificationPressureHeartbeatAt = now;
    await heartbeat('pdd-verification-pressure-cooldown', {
      distinctResolvedCases: verificationPressureCaseCount,
      distinctResolvedCasesHour: verificationPressureHourCaseCount,
      nextBusinessAt: new Date(verificationPressureCooldownUntil).toISOString(),
      scope: 'this-shop-only; no-active-claim',
      externalActionsReplayed: false,
    });
  }
  return true;
};
const hasRecoverableStartupLease = async () => {
  if (!startupLeaseRecoveryPending) return false;
  const { rows } = await pool.query(`
    SELECT lease_token IS NOT NULL
      AND current_work_order_id IS NOT NULL
      AND lease_expires_at > now()
      AND worker_id = $2 AS recoverable
    FROM shop_runtime_state WHERE shop_id = $1
  `, [shopId, workerId]);
  return rows[0]?.recoverable === true;
};
const chatRepository = new ChatRepository(pool);
let lastChatCollectionAt = Date.now() - 9 * 60_000;
async function collectDueChatCase({ requestedOnly = false } = {}) {
  if (process.env.CHAT_ANALYSIS_ENABLED !== 'true' || !residentBrowser) return false;
  if ((await chatRepository.settings())?.mode === 'off') return false;
  const requested = await chatRepository.requested(shopId);
  if (requestedOnly && !requested) return false;
  // Explicit requests must get a turn even when ordinary retries keep the
  // queue nonempty.  Keep a cooldown so a failed collection cannot hammer PDD.
  const collectionIntervalMs = requested ? 2 * 60_000 : 10 * 60_000;
  if (Date.now() - lastChatCollectionAt < collectionIntervalMs) return false;
  lastChatCollectionAt = Date.now();
  const excluded = await chatRepository.excluded(shopId);
  const target = requested ? { orderNumber: requested.order_number, platformCaseKey: requested.platform_case_key,
    platformWorkOrderId: requested.platform_case_id, detailUrl: requested.detail_url,
    scenarioCode: requested.scenario_code || 'product-shortage', workOrderType: requested.work_order_type || null } : null;
  const result = await discoverPendingOrder(excluded.map((row) => row.platformCaseKey), excluded, { target });
  const scenarioCode = result?.scenarioCode || target?.scenarioCode || null;
  // Chat collection is opt-in per registered policy. If the ordinary
  // discovery returned a normal work order, release it to the regular queue
  // instead of stealing a processing turn from existing automation.
  if (result?.status === 'discovered' && !chatPolicyForScenario(scenarioCode)) return false;
  if (result?.status === 'chat-collected') {
    const row = await chatRepository.claimCollection(result);
    if (row) await chatRepository.saveSnapshot(row, result.snapshot, result.images || [], {
      model: process.env.CHAT_ANALYSIS_MODEL || 'deepseek-flash',
      baseUrl: process.env.CHAT_ANALYSIS_BASE_URL || 'http://47.251.247.220/v1',
    });
    await heartbeat('queue-discovery', { chatAnalysis: 'queued', orderNumber: null });
  }
  return true;
}
 const shopResult = await pool.query(`
   SELECT id, name, enabled, config_version, expected_shop_name, work_order_title, scenario_codes, onboarding_status,
     login_requested_at, display_slot,
     (SELECT mall_id FROM shop_identity_bindings WHERE shop_id = shops.id) AS "expectedMallId",
     (SELECT count(*)::int FROM shops WHERE enabled = true) AS enabled_shop_count
  FROM shops WHERE id = $1`, [shopId]);
const shopRow = shopResult.rows[0];
if (!shopRow?.enabled) {
  await pool.end().catch(() => {});
  throw new Error(`Enabled shop not found: ${shopId}`);
}
let legacyShop = null;
try {
  const config = JSON.parse(await fsp.readFile(path.join(root, 'shops.config.json'), 'utf8'));
  legacyShop = config.shops.find((item) => item.shopId === shopId) || null;
} catch { /* dynamic shops do not require the legacy config file */ }
const shop = {
  shopId,
  displayShopName: shopRow.name,
  enabled: shopRow.enabled,
  expectedShopName: shopRow.expected_shop_name,
  expectedMallId: shopRow.expectedMallId || null,
  configuredPddIdentityNames: pddIdentityNameSet(shopRow.expected_shop_name),
  loginRequestedAt: shopRow.login_requested_at instanceof Date
    ? shopRow.login_requested_at.toISOString()
    : String(shopRow.login_requested_at || ''),
  workOrderTitle: shopRow.work_order_title || '订单问题：在途无理由退款处理',
  scenarioCodes: (shopRow.scenario_codes?.length ? shopRow.scenario_codes : [
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
    'promise-reissue',
    'consumer-address-change',
    'consumer-address-change-in-transit',
    'delivered-address-change',
  ]).filter((scenarioCode) => !pausedScenarioCodes.has(canonicalScenarioCode(scenarioCode))),
  pddSecretPrefix: legacyShop?.pddSecretPrefix || null,
  displaySlot: Number(shopRow.display_slot),
  enabledShopCount: Math.max(1, Number(shopRow.enabled_shop_count) || 1),
};
const returnRefundScanStartupJitterMaxMs = Number.isFinite(
  configuredReturnRefundScanStartupJitterMaxMs,
)
  ? Math.max(0, Math.min(30 * 60_000, configuredReturnRefundScanStartupJitterMaxMs))
  : Math.min(30 * 60_000, Math.max(60_000, shop.enabledShopCount * 45_000));
const returnRefundScanStartupDelayMs = returnRefundScanStartupDelay({
  shopKey: shopId,
  maxDelayMs: returnRefundScanStartupJitterMaxMs,
  slotIndex: shop.displaySlot,
  slotCount: shop.enabledShopCount,
});
const returnRefundScanStartupCadence = await consumeCodeReloadScanCadence({
  pool, shopId, configVersion: Number(shopRow.config_version), runnerStartedAt,
}).catch((error) => {
  console.warn(`[code-reload-scan-cadence][${shopId}] ${error.message}`);
  return { anchorAt: runnerStartedAt, source: 'fresh-process' };
});
const pddAccount = shop.pddSecretPrefix ? await readSecret(`${shop.pddSecretPrefix}_ACCOUNT`) : '';
const pddPassword = shop.pddSecretPrefix ? await readSecret(`${shop.pddSecretPrefix}_PASSWORD`) : '';
const omsMode = String(process.env.OMS_MODE || 'per-shop').trim().toLowerCase();
const omsShopKey = String(shopId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const omsLegacyKey = String(shop.pddSecretPrefix || '')
  .replace(/^PDD_/u, '')
  .replace(/[^A-Z0-9]+/g, '_');
const omsCredential = returnRefundPddOnly
  ? { account: '', password: '', prefix: null }
  : await readCredentialPair(omsMode === 'shared'
    ? ['JEOMS']
    : [...new Set([
      `JEOMS_${omsShopKey}`,
      ...(omsLegacyKey ? [`JEOMS_${omsLegacyKey}`] : []),
    ])]);
const omsAccount = omsCredential.account;
const omsPassword = omsCredential.password;
const tmsAccount = returnRefundPddOnly ? '' : await readSecret('TMS_ACCOUNT');
const tmsPassword = returnRefundPddOnly ? '' : await readSecret('TMS_PASSWORD');
const pddLoginMode = String(process.env.PDD_LOGIN_MODE || 'manual').toLowerCase();
if (pddLoginMode === 'auto' && (!pddAccount || !pddPassword)) {
  await pool.end().catch(() => {});
  throw new Error(`Dynamic shop ${shopId} requires PDD_LOGIN_MODE=manual or configured credentials`);
}
if (!returnRefundPddOnly && (!omsAccount || !omsPassword)) {
  console.warn(`Per-shop OMS credentials are unavailable for ${shopId}; the isolated browser profile must already be logged in or be completed manually.`);
}
if (!returnRefundPddOnly && (!tmsAccount || !tmsPassword)) console.warn('TMS credentials are unavailable; TMS-dependent scenarios will fail when claimed.');

await ensureRetrySchema(pool);
const repository = new PostgresWorkflowRepository(pool);
const schedulerRepository = slotSession
  ? new ShopSchedulerRepository(pool, { config: schedulerConfigFromEnv(), supervisorId: workerId })
  : null;
let returnRefundScanEnabled = returnRefundScanEnabledFallback;
let returnRefundAutoApproveEnabled = returnRefundAutoApproveEnabledFallback;
let lastReturnRefundSettingsRefreshAt = 0;
let stopped = false;
let stopSignal = null;
let completedCount = 0;
let activeChild = null;
let residentWorkflowSourceSha256 = null;
let residentReturnRefundAdapterSha256 = null;
let activeChildExitPromise = null;
const workflowCommandRequests = new Map();
// A resident command can be acknowledged by the child before its command
// loop is ready to apply it. Keep a small marker after the bounded apply
// timeout so the next scheduler turn waits for that command to settle
// instead of sending a duplicate and recycling a healthy browser.
const residentCommandDeferrals = new Map();
const runtimeControlRequests = new Map();
const activeExternalEffects = new Map();
const childRunTokens = new WeakMap();
const browserHealthFailures = new WeakMap();
const minimumDurationMs = (value, fallback, minimum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
};
const residentReadyTimeoutMs = minimumDurationMs(
  process.env.WORKER_RESIDENT_READY_TIMEOUT_MS,
  180_000,
  30_000,
);
const residentCommandApplyTimeoutMs = minimumDurationMs(
  process.env.WORKER_RESIDENT_COMMAND_APPLY_TIMEOUT_MS,
  60_000,
  30_000,
);
const residentCommandReadyTimeoutMs = minimumDurationMs(
  process.env.WORKER_RESIDENT_COMMAND_READY_TIMEOUT_MS,
  10 * 60_000,
  30_000,
);
const discoveryResultTimeoutMs = minimumDurationMs(
  process.env.PDD_DISCOVERY_RESULT_TIMEOUT_MS,
  240_000,
  60_000,
);
const discoveryRecoveryCooldownMs = minimumDurationMs(
  process.env.PDD_DISCOVERY_RECOVERY_COOLDOWN_MS,
  Math.max(120_000, discoveryIntervalMs),
  60_000,
);
const authenticationBrowserLaunchCooldownMs = minimumDurationMs(
  process.env.PDD_AUTHENTICATION_BROWSER_LAUNCH_COOLDOWN_MS,
  60_000,
  30_000,
);
const returnRefundResultTimeoutMs = minimumDurationMs(
  process.env.WORKER_RETURN_REFUND_RESULT_TIMEOUT_MS,
  5 * 60_000,
  60_000,
);
const returnRefundHardTimeoutMs = minimumDurationMs(
  process.env.WORKER_RETURN_REFUND_HARD_TIMEOUT_MS,
  20 * 60_000,
  returnRefundResultTimeoutMs,
);
const workflowStallTimeoutMs = minimumDurationMs(
  process.env.WORKER_WORKFLOW_STALL_TIMEOUT_MS,
  5 * 60_000,
  2 * 60_000,
);
let activeChildReadyPromise = null;
let activeClaim = null;
let activeLeaseLost = null;
let leaseTimer = null;
let heartbeatTimer = null;
let lastDiscoveryAt = 0;
let discoveryRetryNotBefore = 0;
let authenticationBrowserLaunchNotBefore = 0;
let lastReturnRefundScanAt = 0;
let returnRefundScanRetryNotBefore = 0;
let pddTabUnavailableNotBefore = 0;
let pddSessionRunwayNotBefore = 0;
let returnRefundCycleCursor = null;
let returnRefundScanCursorHydrated = slotSession;
let returnRefundCycleTotals = null;
let returnRefundCycleVisitedCursors = new Set();
let returnRefundDirectClaimsSinceScan = 0;
// Start by checking ordinary work. When none is eligible, the post-discovery
// fallback still claims return/refund work without adding an idle cycle.
let ordinaryOpportunitySinceRefundTurn = false;
let ordinaryClaimsSinceRefundTurn = 0;
let lastKnownRefundOpportunityAt = runnerStartedAt;
let processedClaimsSinceExternalStateReconciliationCheck = 0;
let externalStateReconciliationCheckedSinceStartup = false;
let lastProcessedScenarioCode = null;
let returnRefundScanOnceCompleted = false;
let lastSynchronizedPddIdentity = null;
let operatorCommandGraceUntil = 0;
let startupLeaseRecoveryPending = true;
let lastCheckpointHash = null;
let lastDatabaseCheckpointHash = null;
let lastCheckpointAt = 0;
let lastCheckpointState = null;
let pendingBrowserProgressSnapshot = null;
let browserProgressCheckpointTimer = null;
let browserProgressCheckpointQueue = Promise.resolve();
const browserProgressSync = {
  lastReceivedAt: null,
  lastReceivedSourceUpdatedAt: null,
  lastAttemptAt: null,
  lastAttemptSource: null,
  lastOutcome: null,
  lastSucceededAt: null,
  lastSucceededSourceUpdatedAt: null,
  lastRejectedAt: null,
  lastRejectedReason: null,
  lastErrorAt: null,
  lastError: null,
};
let lastOnboardingObservation = '';
let lastOnboardingHeartbeatAt = 0;
let currentPddIdentityMetadata = {};
let currentPddIdentityBindingToken = null;
let currentPddIdentityValidatedAt = null;
let currentPddIdentityConflict = null;
const effectTypes = new Set([
  'oms-manual-allocation',
  'oms-reissue-create',
  'tms-create',
  'pdd-submit',
  'pdd-note',
  'pdd-return-refund',
  'evidence-upload',
]);

const platformWorkOrderIdPattern = /^\d{6,30}$/;
const platformCaseKeyPattern = /^pdd-work-order:(\d{6,30})$/;

const ordinaryIdentityForClaim = (claim = {}) => {
  const payload = claim.payload && typeof claim.payload === 'object' ? claim.payload : {};
  const latestDiscovery = payload.latestDiscovery && typeof payload.latestDiscovery === 'object'
    ? payload.latestDiscovery : {};
  const platformCaseKey = String(
    claim.platform_case_key
      || payload.platformCaseKey
      || latestDiscovery.platformCaseKey
      || '',
  ).trim() || null;
  const platformCaseIdFromKey = platformCaseKey?.match(platformCaseKeyPattern)?.[1] || null;
  const platformWorkOrderId = String(
    claim.platform_work_order_id
      || claim.platform_case_id
      || payload.platformWorkOrderId
      || payload.platformCaseId
      || latestDiscovery.platformWorkOrderId
      || latestDiscovery.platformCaseId
      || platformCaseIdFromKey
      || '',
  ).trim() || null;
  return {
    ordinaryInstanceId: String(
      claim.current_ordinary_instance_id || claim.ordinary_instance_id || payload.ordinaryInstanceId || '',
    ).trim() || null,
    platformWorkOrderId,
    platformCaseKey: platformCaseKey || (platformWorkOrderId ? `pdd-work-order:${platformWorkOrderId}` : null),
  };
};

const ordinaryFirstDiscoveredAtForClaim = (claim = {}) => {
  const payload = claim.payload && typeof claim.payload === 'object' ? claim.payload : {};
  const raw = claim.ordinary_first_discovered_at ?? payload.workOrderFirstDiscoveredAt ?? null;
  const timestampMs = raw instanceof Date ? raw.getTime() : Date.parse(String(raw || ''));
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
};

const verifiedPddDetailUrlForOrdinaryIdentity = (identity = {}) => {
  const platformWorkOrderId = String(identity.platformWorkOrderId || '').trim();
  if (!identity.ordinaryInstanceId
    || !platformWorkOrderIdPattern.test(platformWorkOrderId)
    || identity.platformCaseKey !== `pdd-work-order:${platformWorkOrderId}`) return null;
  return `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${platformWorkOrderId}`;
};

const ordinaryIdentityFromExternalEffectMessage = (message = {}) => ({
  ordinaryInstanceId: String(message.ordinaryInstanceId || '').trim() || null,
  platformWorkOrderId: String(message.platformWorkOrderId || '').trim() || null,
  platformCaseKey: String(message.platformCaseKey || '').trim() || null,
});

const ordinaryIdentityValidationError = (identity, { requireComplete = false } = {}) => {
  if (requireComplete && !identity.ordinaryInstanceId) return 'missing ordinaryInstanceId';
  if (requireComplete && !identity.platformWorkOrderId) return 'missing platformWorkOrderId';
  if (requireComplete && !identity.platformCaseKey) return 'missing platformCaseKey';
  if (identity.platformWorkOrderId && !platformWorkOrderIdPattern.test(identity.platformWorkOrderId)) {
    return 'invalid platformWorkOrderId';
  }
  const keyId = identity.platformCaseKey?.match(platformCaseKeyPattern)?.[1] || null;
  if (identity.platformCaseKey && !keyId) return 'invalid platformCaseKey';
  if (identity.platformWorkOrderId && keyId && identity.platformWorkOrderId !== keyId) {
    return 'platformWorkOrderId does not match platformCaseKey';
  }
  return null;
};

const ordinaryIdentitiesMatch = (expected, actual) => (
  expected.ordinaryInstanceId === actual.ordinaryInstanceId
  && expected.platformWorkOrderId === actual.platformWorkOrderId
  && expected.platformCaseKey === actual.platformCaseKey
);

const progressBelongsToClaim = (progress, claim) => {
  if (!progress || !claim || progress.orderNumber !== claim.external_order_number) return false;
  const progressAssignmentId = String(progress.residentCommand?.assignmentId || '').trim() || null;
  // Read-only reconciliation has no execution lease. A missing token in both
  // snapshots is the same identity; an actual execution lease must still match.
  const claimAssignmentId = String(claim.leaseToken || '').trim() || null;
  if (residentBrowser
    && ['pending', 'active'].includes(progress.residentCommand?.status)
    && progressAssignmentId !== claimAssignmentId) return false;
  if (canonicalScenarioCode(claim.scenario_code) === 'return-refund') return true;
  const expected = ordinaryIdentityForClaim(claim);
  const actual = {
    ordinaryInstanceId: String(progress.ordinaryInstanceId || '').trim() || null,
    platformWorkOrderId: String(progress.platformWorkOrderId || '').trim() || null,
    platformCaseKey: String(progress.platformCaseKey || '').trim() || null,
  };
  if (!expected.ordinaryInstanceId || actual.ordinaryInstanceId !== expected.ordinaryInstanceId) return false;
  if (expected.platformWorkOrderId && actual.platformWorkOrderId !== expected.platformWorkOrderId) return false;
  if (expected.platformCaseKey && actual.platformCaseKey !== expected.platformCaseKey) return false;
  return ordinaryIdentityValidationError(actual) === null;
};

const platformWorkOrderIdFromDetailUrl = (value) => {
  const matched = String(value || '').match(/[?&]id=([0-9]{6,30})(?:&|$)/u);
  return matched?.[1] || null;
};

const releasedDeferredWaitSteps = new Set([
  'logistics-waiting-released',
  'consumer-response-waiting-released',
]);

// A resident PDD verification can finish after the business workflow has
// already recorded a deferred logistics wait. The browser recovery checkpoint
// may then publish `pdd-session-recovered` over that wait before the claim is
// released. Keep that exact, identity-bound logistics wait recoverable; it is
// still governed by retryAfterAt in logisticsWaitReleaseForClaim below.
const isDeferredWaitProgress = (progress) => (
  releasedDeferredWaitSteps.has(progress?.step)
  || (progress?.step === 'pdd-session-recovered'
    && progress?.logisticsWait?.waitKind === 'logistics')
);

const logisticsWaitBelongsToClaim = (progress, claim) => {
  const wait = progress?.logisticsWait;
  if (!progress || !claim
    || !isDeferredWaitProgress(progress)
    || wait?.orderNumber !== claim.external_order_number) return false;
  if (canonicalScenarioCode(claim.scenario_code) === 'return-refund') return false;
  if (progressBelongsToClaim(progress, claim)) return true;

  const expected = ordinaryIdentityForClaim(claim);
  const actualPlatformWorkOrderId = String(
    wait.platformWorkOrderId
      || progress.platformWorkOrderId
      || platformWorkOrderIdFromDetailUrl(wait.detailUrl),
  ).trim() || null;
  const actualPlatformCaseKey = String(
    wait.platformCaseKey
      || progress.platformCaseKey
      || (actualPlatformWorkOrderId ? `pdd-work-order:${actualPlatformWorkOrderId}` : ''),
  ).trim() || null;

  // Legacy wait snapshots cleared the database instance UUID. Their PDD
  // detail id is still a stable platform instance identity, so recovery is
  // allowed only when both platform identity fields match the leased claim.
  return Boolean(
    expected.ordinaryInstanceId
      && expected.platformWorkOrderId
      && expected.platformCaseKey
      && actualPlatformWorkOrderId === expected.platformWorkOrderId
      && actualPlatformCaseKey === expected.platformCaseKey,
  );
};

const completedProgressBelongsToClaim = (progress, claim) => {
  if (!progress || !claim) return false;
  const completionMarker = progress.lastCompletedOrder?.orderNumber === claim.external_order_number
    ? progress.lastCompletedOrder
    : progress.completionArchive?.orderNumber === claim.external_order_number
      ? progress.completionArchive
      : null;
  if (!completionMarker) return false;
  if (canonicalScenarioCode(claim.scenario_code) === 'return-refund') return true;
  const expected = ordinaryIdentityForClaim(claim);
  const actual = {
    ordinaryInstanceId: String(completionMarker.ordinaryInstanceId || '').trim() || null,
    platformWorkOrderId: String(completionMarker.platformWorkOrderId || '').trim() || null,
    platformCaseKey: String(completionMarker.platformCaseKey || '').trim() || null,
  };
  if (!expected.ordinaryInstanceId || actual.ordinaryInstanceId !== expected.ordinaryInstanceId) return false;
  if (expected.platformWorkOrderId && actual.platformWorkOrderId !== expected.platformWorkOrderId) return false;
  if (expected.platformCaseKey && actual.platformCaseKey !== expected.platformCaseKey) return false;
  return ordinaryIdentityValidationError(actual) === null;
};

const commandIdentityValidationError = (command, expectedIdentity) => {
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
  const columnInstanceId = String(command.ordinary_instance_id || '').trim() || null;
  const payloadInstanceId = String(payload.ordinaryInstanceId || '').trim() || null;
  if (columnInstanceId && payloadInstanceId && columnInstanceId !== payloadInstanceId) {
    return 'command ordinaryInstanceId fields conflict';
  }
  const commandInstanceId = columnInstanceId || payloadInstanceId;
  if (!commandInstanceId) return 'command is not bound to an ordinaryInstanceId';
  if (commandInstanceId !== expectedIdentity.ordinaryInstanceId) {
    return 'command ordinaryInstanceId does not match the current instance';
  }
  const suppliedPlatformWorkOrderId = String(
    payload.platformWorkOrderId || payload.platformCaseId || '',
  ).trim() || null;
  const suppliedPlatformCaseKey = String(payload.platformCaseKey || '').trim() || null;
  const suppliedKeyId = suppliedPlatformCaseKey?.match(platformCaseKeyPattern)?.[1] || null;
  if (suppliedPlatformCaseKey && !suppliedKeyId) return 'command platformCaseKey is invalid';
  if (suppliedPlatformWorkOrderId && !platformWorkOrderIdPattern.test(suppliedPlatformWorkOrderId)) {
    return 'command platformWorkOrderId is invalid';
  }
  if (suppliedPlatformWorkOrderId && suppliedKeyId && suppliedPlatformWorkOrderId !== suppliedKeyId) {
    return 'command platform identity fields conflict';
  }
  const effectivePlatformWorkOrderId = suppliedPlatformWorkOrderId || suppliedKeyId;
  if (effectivePlatformWorkOrderId && effectivePlatformWorkOrderId !== expectedIdentity.platformWorkOrderId) {
    return 'command platformWorkOrderId does not match the current instance';
  }
  if (suppliedPlatformCaseKey && suppliedPlatformCaseKey !== expectedIdentity.platformCaseKey) {
    return 'command platformCaseKey does not match the current instance';
  }
  return null;
};

const activeEffectsForClaim = (claim = activeClaim, child = activeChild) => {
  if (!claim) return [];
  const childRunToken = child ? childRunTokens.get(child) : null;
  return [...activeExternalEffects.entries()].filter(([, effect]) => (
    effect.orderNumber === claim.external_order_number
    && effect.assignmentId === claim.leaseToken
    && (!childRunToken || effect.childRunToken === childRunToken)
  ));
};

async function listDiscoveryExcludedPlatformCaseKeys() {
  const table = await pool.query("SELECT to_regclass('ordinary_work_order_instances')::text AS name");
  const instanceResult = table.rows[0]?.name
    ? await pool.query(`SELECT DISTINCT platform_case_key
        FROM ordinary_work_order_instances
        WHERE nullif(platform_case_key, '') IS NOT NULL`)
    : { rows: [] };
  const payloadResult = await pool.query(`
    SELECT DISTINCT coalesce(
      nullif(payload->>'platformCaseKey', ''),
      nullif(payload->'latestDiscovery'->>'platformCaseKey', '')
    ) AS platform_case_key
    FROM work_orders
    WHERE scenario_code IS DISTINCT FROM 'return-refund'`);
  const rediscoveryResult = table.rows[0]?.name && currentPddIdentityBindingToken
    ? await pool.query(`
        SELECT DISTINCT instance.platform_case_key
        FROM work_orders work_order
        JOIN ordinary_work_order_instances instance
          ON instance.id = work_order.current_ordinary_instance_id
          AND instance.work_order_id = work_order.id
          AND instance.shop_id = work_order.shop_id
        JOIN pdd_shop_runtime_bindings binding
          ON binding.shop_id = $1
          AND binding.binding_token = $2::uuid
        WHERE work_order.shop_id <> $1
          AND work_order.scenario_code IS DISTINCT FROM 'return-refund'
          AND work_order.status = 'paused'
          AND work_order.completion_state = 'pending'
          AND work_order.recovery_state IN ('ready','retry-authorized')
          AND work_order.frontend_visibility = 'operational'
          AND instance.identity_status = 'verified'
          AND nullif(instance.platform_case_key, '') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
            WHERE effect.work_order_id = work_order.id
              AND (
                effect.status IN ('reserved','unknown')
                OR (effect.effect_type = 'pdd-submit' AND effect.status = 'succeeded')
                OR (effect.effect_type = 'evidence-upload' AND effect.status = 'failed')
              )
          )
          AND coalesce(work_order.manual_review_reason, work_order.payload->>'error', '')
            !~ '48143|凭证上传[^，。；;]*失败|截图上传[^，。；;]*失败'
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
          )`, [shopId, currentPddIdentityBindingToken])
    : { rows: [] };
  const rediscoverableKeys = new Set(rediscoveryResult.rows
    .map((row) => String(row.platform_case_key || '').trim())
    .filter(Boolean));
  return [...new Set([...instanceResult.rows, ...payloadResult.rows]
    .map((row) => String(row.platform_case_key || '').trim())
    .filter((platformCaseKey) => platformCaseKey && !rediscoverableKeys.has(platformCaseKey)))];
}

async function listDiscoveryExcludedOrdinaryCandidates() {
  const table = await pool.query("SELECT to_regclass('ordinary_work_order_instances')::text AS name");
  if (!table.rows[0]?.name) return [];
  const result = await pool.query(`
    SELECT DISTINCT
      work_order.external_order_number AS "orderNumber",
      instance.scenario_code AS "scenarioCode",
      instance.platform_case_key AS "platformCaseKey",
      instance.first_discovered_at AS "firstDiscoveredAt"
    FROM ordinary_work_order_instances instance
    JOIN work_orders work_order ON work_order.id = instance.work_order_id
    WHERE instance.shop_id = $1
      AND nullif(instance.platform_case_key, '') IS NOT NULL
      AND instance.first_discovered_at IS NOT NULL`, [shopId]);
  return result.rows;
}

if (slotSession) {
  if (!slotId || !slotLeaseToken) throw new Error('Slot runner requires WORKER_SLOT_ID and WORKER_SLOT_LEASE_TOKEN');
  const schedule = await pool.query(`
    SELECT refund_scan_cursor, refund_scan_in_progress, refund_cycle_totals
    FROM shop_schedule_state
    WHERE shop_id = $1 AND assigned_slot_id = $2::uuid AND assignment_token = $3::uuid`,
  [shopId, slotId, slotLeaseToken]);
  if (!schedule.rowCount) throw new Error(`Slot assignment is not active for ${shopId}`);
  if (assignmentKind === 'refund-scan'
    || (persistentSlotSession && schedule.rows[0].refund_scan_in_progress)) {
    returnRefundCycleCursor = schedule.rows[0].refund_scan_cursor || { page: 1, itemOffset: 0 };
    returnRefundCycleTotals = schedule.rows[0].refund_cycle_totals
      && Object.keys(schedule.rows[0].refund_cycle_totals).length
      ? schedule.rows[0].refund_cycle_totals
      : { scannedItems: 0, persistedItems: 0, examinedItems: 0 };
  }
}

const deferDiscoveryForOperatorCommand = () => {
  operatorCommandGraceUntil = Math.max(
    operatorCommandGraceUntil,
    Date.now() + Math.max(60_000, pollMs * 2),
  );
};

let lastDetachedVerificationRecoveryKey = null;
const recoverDetachedClearedReturnRefundVerification = async (progress = null) => {
  const observedProgress = progress || await readProgress().catch(() => ({}));
  const detachedVerification = classifyDetachedClearedReturnRefundVerification({
    progress: observedProgress,
  });
  if (!detachedVerification) return null;
  const recoveryKey = `${detachedVerification.assignmentId}:${detachedVerification.verificationId}`;
  if (recoveryKey === lastDetachedVerificationRecoveryKey) return null;
  try {
    const recovery = await repository.resolveDetachedClearedReturnRefundVerification({
      shopId,
      ...detachedVerification,
    });
    if (recovery?.verificationResolved) {
      lastDetachedVerificationRecoveryKey = recoveryKey;
    }
    return recovery;
  } catch (error) {
    console.error(`[return-refund-verification-recovery][${shopId}] ${error.message}`);
    return { error: error.message };
  }
};
let lastPreClaimVerificationBrowserRecovery = null;
const resolveRestoredPreClaimVerification = async (persistedVerification, progress) => {
  const restoredVerification = classifyRestoredPreClaimVerification({
    persistedVerification,
    progress,
  });
  if (!restoredVerification) return null;
  try {
    return await repository.resolveRestoredPreClaimPddVerification({
      shopId,
      ...restoredVerification,
    });
  } catch (error) {
    console.error(`[pre-claim-verification-browser-recovery][${shopId}] ${error.message}`);
    return { error: error.message };
  }
};
const queryLatestActiveVerification = () => pool.query(`
  SELECT verification.id, verification.work_order_id, verification.system_name,
    verification.stage, verification.status, verification.url,
    verification.frame_url, verification.selector,
    verification.detected_at, verification.resolved_at,
    work_order.external_order_number AS order_number,
    work_order.scenario_code
  FROM verification_locations verification
  LEFT JOIN work_orders work_order ON work_order.id = verification.work_order_id
  WHERE verification.shop_id = $1
    AND verification.status IN ('detected', 'waiting-human', 'verification-required')
    AND verification.resolved_at IS NULL
  ORDER BY verification.detected_at DESC
  LIMIT 1`, [shopId]);
const heartbeat = async (state, metadata = {}) => {
  const progress = await readProgress().catch(() => ({}));
  const authentication = workflowAuthenticationState(progress);
  const heartbeatClaim = activeClaim;
  const progressMatchesActiveClaim = Boolean(
    heartbeatClaim && progressBelongsToClaim(progress, heartbeatClaim),
  );
  if (progressMatchesActiveClaim) {
    await checkpointBrowserProgress(progress, 'heartbeat-fallback').catch((error) => {
      browserProgressSync.lastOutcome = 'error';
      browserProgressSync.lastErrorAt = new Date().toISOString();
      browserProgressSync.lastError = error.message;
      console.error(`[browser-progress-sync][${shopId}] heartbeat-fallback: ${error.message}`);
    });
  }
  const detachedVerificationRecovery = await recoverDetachedClearedReturnRefundVerification(
    progress,
  );
  const observedState = workflowHeartbeatState(state, progress);
  const activeProgressVerification = observedState === 'human-verification-required';
  const heartbeatMetadata = {
    processId: process.pid,
    runnerStartedAt: new Date(runnerStartedAt).toISOString(),
    returnRefundScanStartup: {
      ...returnRefundScanStartupCadence,
      anchorAt: new Date(returnRefundScanStartupCadence.anchorAt).toISOString(),
      notBefore: new Date(returnRefundScanStartupCadence.anchorAt
        + returnRefundScanStartupDelayMs).toISOString(),
    },
    codeBuild: {
      runnerSha256: runnerSourceSha256,
      workflowSha256: residentWorkflowSourceSha256,
      returnRefundAdapterSha256: residentReturnRefundAdapterSha256,
    },
    ...currentPddIdentityMetadata,
    ...(progress.authHealth ? { authHealth: progress.authHealth } : {}),
    ...(progress.systemTabs ? { systemTabs: progress.systemTabs } : {}),
    workflowStep: progress.step || null,
    currentOrderNumber: progressMatchesActiveClaim || activeProgressVerification
      ? progress.orderNumber || null
      : null,
    currentAssignmentId: progressMatchesActiveClaim ? heartbeatClaim.leaseToken : null,
    progressUpdatedAt: progress.updatedAt || null,
    runtimeObservedAt: progress.runtimeObservation?.observedAt || progress.updatedAt || null,
    browserProgressSync: { ...browserProgressSync },
    authenticationSystem: authentication.blocked ? authentication.system : null,
    authenticationStatus: authentication.blocked
      ? authentication.health.status
        || (authentication.humanVerificationRequired
          ? 'verification-required'
          : authentication.manualLoginRequired ? 'expired' : null)
      : null,
    ...(detachedVerificationRecovery ? { detachedVerificationRecovery } : {}),
    state: observedState,
    ...metadata,
  };
  await repository.writeHeartbeat({ workerId, mode: 'live', shopId, metadata: heartbeatMetadata });
  const file = process.env.WORKER_HEARTBEAT_FILE || '/tmp/pdd-worker-heartbeat.json';
  fs.writeFileSync(file, JSON.stringify({
    ...heartbeatMetadata,
    mode: 'live',
    workerId,
    shopId,
    updatedAt: new Date().toISOString(),
  }));
};

const inspectConfiguredBrowserProxy = async ({ force = false } = {}) => {
  if (browserProxyConfigurationError) {
    return {
      ok: false,
      enabled: true,
      required: true,
      ...browserProxyConfigurationError,
    };
  }
  if (!force && browserProxyHealth && Date.now() < browserProxyNextProbeAt) {
    return browserProxyHealth;
  }
  browserProxyHealth = await probeBrowserProxyConnectivity({
    runtime: browserProxyConfig.runtime,
    timeoutMs: browserProxyProbeTimeoutMs,
  });
  browserProxyNextProbeAt = Date.now() + browserProxyRetryMs;
  return browserProxyHealth;
};

const recordBrowserProxyNavigationFailure = (error) => {
  const previousOpenUntilMs = Date.parse(String(browserProxyNavigationCircuit?.openUntil || ''));
  const result = advanceBrowserProxyNavigationFailureCircuit({
    state: browserProxyNavigationCircuit,
    error,
    proxyEnabled: browserProxyConfig?.runtime?.enabled === true,
    failureWindowMs: browserProxyNavigationFailureWindowMs,
    failureLimit: browserProxyNavigationFailureLimit,
    cooldownMs: browserProxyNavigationCooldownMs,
    maxCooldownMs: browserProxyNavigationMaxCooldownMs,
  });
  if (!result.matched) return null;
  browserProxyNavigationCircuit = result.state;
  browserProxyNavigationFailureObservedThisTurn = true;
  const openedForFirstTime = result.opened
    && (!Number.isFinite(previousOpenUntilMs) || previousOpenUntilMs <= Date.now());
  if (openedForFirstTime) {
    console.error(
      `[browser-proxy] ${shopId} ${result.failure.errorCode} repeated ${result.state.count} times; pausing new work until ${result.state.openUntil}`,
    );
  }
  return { ...result.state, opened: result.opened, errorCode: result.failure.errorCode };
};

const resetBrowserProxyNavigationFailuresAfterSuccess = () => {
  if (browserProxyNavigationFailureObservedThisTurn) return;
  browserProxyNavigationCircuit = null;
};

const rethrowReturnRefundScanProxyFailure = (error) => {
  if (browserProxyConfig?.runtime?.enabled === true
    && detectBrowserProxyNavigationFailure(error)) throw error;
};

const browserHealthMonitor = createBrowserHealthMonitor({
  heartbeatTimeoutMs: browserHealthTimeoutMs,
  startupGraceMs: browserHealthStartupGraceMs,
  checkIntervalMs: browserHealthCheckIntervalMs,
  onFailure: async ({ child, reason, ageMs, timeoutMs, lastMessage }) => {
    if (child !== activeChild || child.exitCode !== null || child.signalCode !== null) return;
    const failure = {
      reason,
      ageMs: ageMs ?? null,
      timeoutMs: timeoutMs ?? null,
      reportedAt: new Date().toISOString(),
      lastMessage: lastMessage || null,
    };
    browserHealthFailures.set(child, failure);
    console.error(`[browser-health] ${failure.reportedAt} ${shopId} ${reason}; `
      + `ageMs=${failure.ageMs ?? 'unknown'} timeoutMs=${failure.timeoutMs ?? 'unknown'} `
      + `lastSequence=${failure.lastMessage?.sequence ?? 'none'} `
      + `lastSentAt=${failure.lastMessage?.sentAt ?? 'none'}; `
      + 'restarting this shop workflow');
    await heartbeat('browser-health-recovery', {
      orderNumber: activeClaim?.external_order_number || null,
      browserHealthFailure: failure,
    }).catch(() => {});
    if (child.connected) {
      try {
        child.send({ type: 'browser-health-restart', reason }, () => {});
      } catch { /* the workflow IPC channel has already closed */ }
    }
    const terminateTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, 1_000);
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 4_000);
    terminateTimer.unref?.();
    killTimer.unref?.();
  },
});

async function readBrowserProfileMarker() {
  return JSON.parse(await fsp.readFile(browserProfileMarkerFile, 'utf8'));
}

const persistedMarkerIdentityConflict = (
  marker,
  expectedShopName,
  loginRequestedAt,
  expectedMallId = null,
  configuredNames = [],
) => {
  const observation = marker?.lastUnmaskedIdentityObservation || {};
  const actualShopName = normalizeDetectedPddShopName(observation.actualShopName);
  const observedMallId = normalizePddMallId(observation.mallId);
  const normalizedExpectedMallId = normalizePddMallId(expectedMallId);
  const expectedCanonical = canonicalDetectedPddShopName(expectedShopName);
  const actualCanonical = canonicalDetectedPddShopName(actualShopName);
  const markerFingerprint = String(marker?.profileFingerprint || '').trim();
  const observedFingerprint = String(observation.profileFingerprint || '').trim();
  const observedLoginRequestedAt = String(observation.loginRequestedAt || '');
  const currentLoginRequestedAt = loginRequestedAt instanceof Date
    ? loginRequestedAt.toISOString() : String(loginRequestedAt || '');
  const observedAt = Date.parse(observation.detectedAt || '');
  const nameConflict = expectedCanonical && actualCanonical
    && !pddIdentityMatches(
      configuredNames.length ? configuredNames : expectedShopName,
      actualShopName,
    )
    && expectedCanonical !== actualCanonical;
  const mallConflict = normalizedExpectedMallId && observedMallId
    && normalizedExpectedMallId !== observedMallId;
  if ((!nameConflict && !mallConflict)
    || !expectedCanonical
    || !actualCanonical
    || isMaskedDetectedPddShopName(actualShopName)
    || !markerFingerprint
    || observedFingerprint !== markerFingerprint
    || observedLoginRequestedAt !== currentLoginRequestedAt
    || !Number.isFinite(observedAt)) return null;
  return {
    actualShopName,
    mallId: observedMallId,
    source: 'browser-profile-last-unmasked-observation',
    observedAt: new Date(observedAt).toISOString(),
  };
};

async function restoreConfirmedPddShopIdentityBinding() {
  if (!dynamicPddShopBinding) return null;
  const marker = await readBrowserProfileMarker().catch(() => null);
  if (!marker || String(marker.shopId || '') !== shopId) return null;
  const result = await pool.query(`
    SELECT shop.name, shop.expected_shop_name AS "expectedShopName",
      shop.login_requested_at AS "loginRequestedAt",
      identity.expected_shop_name AS "confirmedShopName",
      identity.mall_id AS "confirmedMallId",
      identity.profile_fingerprint AS "confirmedFingerprint",
      identity.status AS "identityStatus",
      binding.actual_shop_name AS "actualShopName",
      binding.mall_id AS "runtimeMallId",
      binding.binding_token AS "bindingToken",
      binding.profile_fingerprint AS "runtimeFingerprint",
      binding.bound_at AS "boundAt",
      runtime.metadata->'pddIdentityBinding' AS "runtimeIdentityBinding"
    FROM shops shop
    JOIN shop_identity_bindings identity ON identity.shop_id = shop.id
    JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = shop.id
    JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
    WHERE shop.id = $1`, [shopId]);
  const binding = result.rows[0];
  if (!binding || binding.identityStatus !== 'confirmed') return null;
  const persistedConflict = persistedMarkerIdentityConflict(
    marker,
    binding.expectedShopName,
    binding.loginRequestedAt,
    binding.confirmedMallId || binding.runtimeMallId,
    shop.configuredPddIdentityNames,
  );
  if (persistedConflict) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pdd-workflow:dynamic-shop-binding'))");
      const owner = await client.query(`
        SELECT shop_id
        FROM pdd_shop_runtime_bindings
        WHERE identity_key = $1`, [
        pddIdentityKey(persistedConflict),
      ]);
      const conflict = await persistDuplicatePddIdentity(client, {
        ...persistedConflict,
        conflictingShopId: owner.rows[0]?.shop_id || null,
      });
      await client.query('COMMIT');
      await heartbeat('pdd-identity-duplicate', {
        ...conflict,
        dynamicShopBinding: true,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return null;
  }
  const runtimeBinding = binding.runtimeIdentityBinding || {};
  const markerBinding = marker.identityBinding || {};
  const expectedCanonical = canonicalDetectedPddShopName(binding.expectedShopName);
  const markerCanonical = canonicalDetectedPddShopName(markerBinding.expectedShopName);
  const markerNameMasked = isMaskedDetectedPddShopName(markerBinding.expectedShopName);
  const persistedIdentityNames = [
    binding.confirmedShopName,
    binding.actualShopName,
    runtimeBinding.actualShopName,
  ].map((value) => canonicalDetectedPddShopName(value));
  const namesMatch = pddIdentityMatches(
    shop.configuredPddIdentityNames,
    persistedIdentityNames,
  )
    && persistedIdentityNames.every(Boolean)
    && persistedIdentityNames.every((value) => pddIdentityMatches(
      shop.configuredPddIdentityNames,
      value,
    ))
    && (markerNameMasked || pddIdentityMatches(
      shop.configuredPddIdentityNames,
      markerCanonical,
    ));
  const fingerprints = [
    binding.confirmedFingerprint,
    binding.runtimeFingerprint,
    marker.profileFingerprint,
  ].map((value) => String(value || '').trim());
  const fingerprintsMatch = fingerprints.every(Boolean)
    && new Set(fingerprints).size === 1;
  const mallIds = [
    binding.confirmedMallId,
    binding.runtimeMallId,
    runtimeBinding.mallId,
    markerBinding.mallId,
  ].map(normalizePddMallId).filter(Boolean);
  const mallIdsMatch = new Set(mallIds).size <= 1;
  const bindingToken = String(binding.bindingToken || '').trim();
  const runtimeBindingToken = String(runtimeBinding.bindingToken || '').trim();
  const markerLoginRequestedAt = String(markerBinding.loginRequestedAt || '');
  const loginRequestedAt = binding.loginRequestedAt instanceof Date
    ? binding.loginRequestedAt.toISOString() : String(binding.loginRequestedAt || '');
  const markerMatchesLogin = !loginRequestedAt || markerLoginRequestedAt === loginRequestedAt;
  if (!namesMatch
    || !fingerprintsMatch
    || !mallIdsMatch
    || !bindingToken
    || bindingToken !== runtimeBindingToken
    || markerBinding.status !== 'confirmed'
    || String(markerBinding.shopId || '') !== shopId
    || !markerMatchesLogin) return null;
  const boundAt = binding.boundAt instanceof Date
    ? binding.boundAt.toISOString() : String(binding.boundAt || runtimeBinding.boundAt || '');
  currentPddIdentityBindingToken = bindingToken;
  currentPddIdentityValidatedAt = null;
  currentPddIdentityConflict = null;
  currentPddIdentityMetadata = {
    actualShopName: binding.actualShopName,
    mallId: normalizePddMallId(binding.confirmedMallId || binding.runtimeMallId),
    profileFingerprint: fingerprints[0],
    identityStatus: 'confirmed-restored',
    dynamicShopBinding: true,
    identityBindingToken: bindingToken,
    identityBoundAt: boundAt,
  };
  return { ...currentPddIdentityMetadata };
}

async function recoverMaskedPddShopIdentityBinding(identity = {}, authHealth = {}) {
  if (!dynamicPddShopBinding || authHealth?.pdd?.status !== 'authenticated') return null;
  const detectedShopName = normalizeDetectedPddShopName(identity.actualShopName);
  if (!isMaskedDetectedPddShopName(detectedShopName)) return null;
  const detectedAt = Date.parse(identity.detectedAt || identity.checkedAt || '');
  if (!Number.isFinite(detectedAt) || detectedAt < runnerStartedAt) return null;
  if (shop.loginRequestedAt && String(identity.loginRequestedAt || '') !== shop.loginRequestedAt) return null;

  const marker = await readBrowserProfileMarker().catch(() => null);
  const markerBinding = marker?.identityBinding || {};
  const configuredShopName = normalizeDetectedPddShopName(shop.expectedShopName);
  const markerShopName = normalizeDetectedPddShopName(markerBinding.expectedShopName);
  const configuredCanonical = canonicalDetectedPddShopName(configuredShopName);
  const markerCanonical = canonicalDetectedPddShopName(markerShopName);
  const detectedFingerprint = String(identity.profileFingerprint || '').trim();
  const markerFingerprint = String(marker?.profileFingerprint || '').trim();
  const markerLoginRequestedAt = String(markerBinding.loginRequestedAt || '');
  if (!marker
    || String(marker.shopId || '') !== shopId
    || markerBinding.status !== 'confirmed'
    || String(markerBinding.shopId || '') !== shopId
    || !configuredCanonical
    || isMaskedDetectedPddShopName(configuredShopName)
    || isMaskedDetectedPddShopName(markerShopName)
    || !pddIdentityMatches(shop.configuredPddIdentityNames, markerShopName)
    || !detectedFingerprint
    || detectedFingerprint !== markerFingerprint
    || (shop.loginRequestedAt && markerLoginRequestedAt !== shop.loginRequestedAt)) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pdd-workflow:dynamic-shop-binding'))");
    const current = await client.query(`
      SELECT shop.name, shop.expected_shop_name AS "expectedShopName",
        shop.login_requested_at AS "loginRequestedAt",
        confirmed.expected_shop_name AS "confirmedShopName",
        confirmed.profile_fingerprint AS "confirmedFingerprint",
        confirmed.status AS "identityStatus",
        runtime_binding.actual_shop_name AS "runtimeShopName",
        runtime_binding.binding_token AS "bindingToken",
        runtime_binding.profile_fingerprint AS "runtimeFingerprint",
        runtime_binding.bound_at AS "boundAt"
      FROM shops shop
      JOIN shop_identity_bindings confirmed ON confirmed.shop_id = shop.id
      JOIN pdd_shop_runtime_bindings runtime_binding ON runtime_binding.shop_id = shop.id
      WHERE shop.id = $1
      FOR UPDATE OF shop, confirmed, runtime_binding`, [shopId]);
    const binding = current.rows[0];
    const databaseLoginRequestedAt = binding?.loginRequestedAt instanceof Date
      ? binding.loginRequestedAt.toISOString() : String(binding?.loginRequestedAt || '');
    const databaseConfiguredCanonical = canonicalDetectedPddShopName(binding?.expectedShopName);
    const databaseNameCanonical = canonicalDetectedPddShopName(binding?.name);
    const fingerprints = [
      binding?.confirmedFingerprint,
      binding?.runtimeFingerprint,
      detectedFingerprint,
      markerFingerprint,
    ].map((value) => String(value || '').trim());
    const bindingToken = String(binding?.bindingToken || '').trim();
    const recoverable = binding
      && binding.identityStatus === 'revoked'
      && isMaskedDetectedPddShopName(binding.confirmedShopName)
      && isMaskedDetectedPddShopName(binding.runtimeShopName)
      && pddIdentityMatches(shop.configuredPddIdentityNames, [
        binding?.expectedShopName,
        binding?.name,
      ])
      && fingerprints.every(Boolean)
      && new Set(fingerprints).size === 1
      && bindingToken
      && (!databaseLoginRequestedAt || databaseLoginRequestedAt === markerLoginRequestedAt);
    if (!recoverable) {
      await client.query('ROLLBACK');
      return null;
    }

    const otherBindings = await client.query(`
      SELECT identity.shop_id AS "shopId", identity.expected_shop_name AS "shopName",
        identity.profile_fingerprint AS fingerprint
      FROM shop_identity_bindings identity
      WHERE identity.shop_id <> $1
      UNION ALL
      SELECT runtime_binding.shop_id, runtime_binding.actual_shop_name,
        runtime_binding.profile_fingerprint
      FROM pdd_shop_runtime_bindings runtime_binding
      WHERE runtime_binding.shop_id <> $1`, [shopId]);
    const hasCrossShopConflict = otherBindings.rows.some((other) => (
      String(other.fingerprint || '').trim() === detectedFingerprint
      || pddIdentityMatches(shop.configuredPddIdentityNames, other.shopName)
    ));
    if (hasCrossShopConflict) {
      await client.query('ROLLBACK');
      return null;
    }

    const identityKey = configuredCanonical.toLocaleLowerCase('zh-CN');
    const identityBoundAt = binding.boundAt instanceof Date
      ? binding.boundAt.toISOString() : String(binding.boundAt || new Date().toISOString());
    await client.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = $1', [shopId]);
    await client.query(`
      INSERT INTO pdd_shop_runtime_bindings
        (identity_key, shop_id, actual_shop_name, binding_token, profile_fingerprint,
         bound_at, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,now())`, [
      identityKey,
      shopId,
      configuredShopName,
      bindingToken,
      detectedFingerprint,
      identityBoundAt,
    ]);
    await client.query(`
      UPDATE shop_identity_bindings SET expected_shop_name = $2,
        profile_fingerprint = $3, status = 'confirmed',
        confirmed_by = 'worker-masked-name-profile-recovery',
        confirmed_at = now(), updated_at = now()
      WHERE shop_id = $1`, [shopId, configuredShopName, detectedFingerprint]);
    await client.query(`
      UPDATE shop_runtime_state SET
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'pddIdentityBinding', jsonb_build_object(
            'actualShopName', $2::text,
            'bindingToken', $3::text,
            'boundAt', $4::text
          )
        ), updated_at = now()
      WHERE shop_id = $1`, [shopId, configuredShopName, bindingToken, identityBoundAt]);
    await client.query(`
      UPDATE shops SET onboarding_status = 'ready', onboarding_error = NULL,
        onboarding_completed_at = coalesce(onboarding_completed_at, now()), updated_at = now()
      WHERE id = $1`, [shopId]);
    await client.query(`
      INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
      VALUES ($1,'worker-masked-name-profile-recovery','shop-identity-masked-name-recovered',$2::jsonb)`, [
      shopId,
      JSON.stringify({
        configuredShopName,
        maskedDetectedShopName: detectedShopName,
        profileFingerprint: detectedFingerprint,
        loginRequestedAt: markerLoginRequestedAt || null,
      }),
    ]);
    await client.query('COMMIT');
    currentPddIdentityBindingToken = bindingToken;
    currentPddIdentityValidatedAt = detectedAt;
    currentPddIdentityConflict = null;
    currentPddIdentityMetadata = {
      actualShopName: configuredShopName,
      profileFingerprint: detectedFingerprint,
      identityStatus: 'confirmed-masked-name-recovered',
      dynamicShopBinding: true,
      identityBindingToken: bindingToken,
      identityBoundAt,
    };
    shop.expectedShopName = configuredShopName;
    return { ...currentPddIdentityMetadata };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const duplicateIdentityMessage = ({ actualShopName, conflictingShopId }) =>
  `检测到重复登录：当前浏览器登录的“${actualShopName || '未知店铺'}”已绑定到 ${conflictingShopId || '其他店铺'}，请重新登录正确店铺`;

async function persistDuplicatePddIdentity(client, {
  actualShopName,
  mallId = null,
  conflictingShopId,
  source,
  observedAt = null,
  externalOrderNumber = null,
  aftersaleNumber = null,
}) {
  const reason = duplicateIdentityMessage({ actualShopName, conflictingShopId });
  await client.query(`
    UPDATE shops SET onboarding_status = 'identity-mismatch', onboarding_error = $2,
      onboarding_completed_at = NULL, updated_at = now()
    WHERE id = $1`, [shopId, reason]);
  await client.query(`
    UPDATE shop_identity_bindings SET status = 'revoked', updated_at = now()
    WHERE shop_id = $1 AND status <> 'revoked'`, [shopId]);
  await client.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = $1', [shopId]);
  await client.query(`
    UPDATE shop_runtime_state SET
      metadata = coalesce(metadata, '{}'::jsonb) - 'pddIdentityBinding', updated_at = now()
    WHERE shop_id = $1`, [shopId]);
  await client.query(`
    INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
    VALUES ($1,'worker-page-detection','pdd-duplicate-shop-login',$2::jsonb)`, [
      shopId,
      JSON.stringify({ actualShopName, mallId, conflictingShopId, source, observedAt, externalOrderNumber, aftersaleNumber, reason }),
    ]);
  currentPddIdentityBindingToken = null;
  currentPddIdentityValidatedAt = null;
  currentPddIdentityConflict = {
    actualShopName: actualShopName || null,
    mallId: normalizePddMallId(mallId),
    conflictingShopId: conflictingShopId || null,
    source,
    observedAt,
    externalOrderNumber,
    aftersaleNumber,
    reason,
  };
  return currentPddIdentityConflict;
}

const identityMismatchMessage = ({ expectedShopName, actualShopName, expectedMallId, actualMallId }) => {
  const mallDetail = expectedMallId && actualMallId
    ? `（应为商家ID ${expectedMallId}，当前为 ${actualMallId}）` : '';
  const expectedLabel = Array.isArray(expectedShopName)
    ? expectedShopName.filter(Boolean).join(' / ')
    : expectedShopName;
  return `当前浏览器登录的“${actualShopName || '未知店铺'}”与配置“${expectedLabel || '未知店铺'}”不一致${mallDetail}，请重新登录正确店铺`;
};

async function persistPddIdentityMismatch(client, {
  expectedShopName,
  actualShopName,
  expectedMallId = null,
  actualMallId = null,
  source,
}) {
  const reason = identityMismatchMessage({ expectedShopName, actualShopName, expectedMallId, actualMallId });
  await client.query(`
    UPDATE shops SET onboarding_status = 'identity-mismatch', onboarding_error = $2,
      onboarding_completed_at = NULL, updated_at = now()
    WHERE id = $1`, [shopId, reason]);
  await client.query(`
    UPDATE shop_identity_bindings SET status = 'revoked', updated_at = now()
    WHERE shop_id = $1 AND status <> 'revoked'`, [shopId]);
  await client.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = $1', [shopId]);
  await client.query(`
    UPDATE shop_runtime_state SET
      metadata = coalesce(metadata, '{}'::jsonb) - 'pddIdentityBinding', updated_at = now()
    WHERE shop_id = $1`, [shopId]);
  await client.query(`
    INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
    VALUES ($1,'worker-page-detection','pdd-shop-identity-mismatch',$2::jsonb)`, [
    shopId,
    JSON.stringify({ expectedShopName, actualShopName, expectedMallId, actualMallId, source, reason }),
  ]);
  currentPddIdentityBindingToken = null;
  currentPddIdentityValidatedAt = null;
  currentPddIdentityConflict = {
    expectedShopName: expectedShopName || null,
    actualShopName: actualShopName || null,
    expectedMallId: normalizePddMallId(expectedMallId),
    mallId: normalizePddMallId(actualMallId),
    source,
    reason,
  };
  return currentPddIdentityConflict;
}

async function markDuplicatePddIdentityFromConflict(error) {
  const client = await pool.connect();
  let conflict;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pdd-workflow:dynamic-shop-binding'))");
    conflict = await persistDuplicatePddIdentity(client, {
      actualShopName: currentPddIdentityMetadata.actualShopName || shop.expectedShopName,
      conflictingShopId: error.conflictingShopId || null,
      source: error.code || 'cross-slot-active-business-record',
      externalOrderNumber: error.externalOrderNumber || null,
      aftersaleNumber: error.aftersaleNumber || null,
    });
    await client.query('COMMIT');
  } catch (persistError) {
    await client.query('ROLLBACK').catch(() => {});
    throw persistError;
  } finally {
    client.release();
  }
  await heartbeat('pdd-identity-duplicate', conflict);
  return conflict;
}

const isDuplicatePddSlotConflict = (error) => [
  'PDD_DUPLICATE_SHOP_ACTIVE_WORK_ORDER',
  'PDD_DUPLICATE_SHOP_ACTIVE_RETURN_REFUND',
].includes(error?.code);

async function transitionPersistentSlot(nextSlotKind, nextAssignmentKind) {
  if (!persistentSlotSession || !schedulerRepository) return false;
  if (slotKind === nextSlotKind && assignmentKind === nextAssignmentKind) return true;
  const transitioned = await schedulerRepository.transitionResidentSlot({
    shopId,
    slotId,
    leaseToken: slotLeaseToken,
    slotKind: nextSlotKind,
    assignmentKind: nextAssignmentKind,
    leaseExtensionMs: Math.max(sessionMaxMs, 15 * 60_000),
  });
  if (!transitioned) throw new Error(`Persistent slot lease was lost while switching ${shopId} to ${nextSlotKind}`);
  slotKind = nextSlotKind;
  assignmentKind = nextAssignmentKind;
  return true;
}

async function synchronizeDetectedPddShopIdentity(identity = {}) {
  const actualShopName = normalizeDetectedPddShopName(identity.actualShopName);
  const mallId = normalizePddMallId(identity.mallId);
  const maskedPddShopName = isMaskedDetectedPddShopName(actualShopName);
  if (actualShopName.length < 2 || actualShopName.length > 120 || maskedPddShopName) return false;
  if (shop.loginRequestedAt && String(identity.loginRequestedAt || '') !== shop.loginRequestedAt) return false;
  // A known identity mismatch is an operator-waiting state. The browser
  // observer can report the same wrong account on every poll; do not rewrite
  // the shop, delete bindings, or append another audit row until the account
  // actually changes (or an explicit reset command clears this conflict).
  const incomingExpectedMallId = normalizePddMallId(identity.expectedMallId || null);
  const conflictExpectedMallId = normalizePddMallId(currentPddIdentityConflict?.expectedMallId || null);
  const expectedMallIdMatches = !incomingExpectedMallId
    || !conflictExpectedMallId
    || incomingExpectedMallId === conflictExpectedMallId;
  if (currentPddIdentityConflict
    && pddIdentityMatches(
      shop.configuredPddIdentityNames,
      currentPddIdentityConflict.expectedShopName,
    )
    && canonicalDetectedPddShopName(currentPddIdentityConflict.actualShopName)
      === canonicalDetectedPddShopName(actualShopName)
    && normalizePddMallId(currentPddIdentityConflict.mallId) === mallId
    && expectedMallIdMatches) {
    return false;
  }
  const detectedAt = Date.parse(identity.detectedAt || '');
  if (!Number.isFinite(detectedAt) || detectedAt < runnerStartedAt) return false;
  const signature = JSON.stringify([
    actualShopName,
    normalizeDetectedPddShopName(identity.mallName) || null,
    mallId,
    identity.profileFingerprint || null,
    identity.loginRequestedAt || null,
  ]);
  currentPddIdentityMetadata = {
    actualShopName,
    mallId,
    mallName: normalizeDetectedPddShopName(identity.mallName) || null,
    profileFingerprint: identity.profileFingerprint || null,
    identityStatus: identity.status || null,
    dynamicShopBinding: dynamicPddShopBinding,
  };
  if (!dynamicPddShopBinding && signature === lastSynchronizedPddIdentity) return true;
  await heartbeat('pdd-identity-observed', {
    actualShopName,
    mallId,
    mallName: normalizeDetectedPddShopName(identity.mallName) || null,
    profileFingerprint: identity.profileFingerprint || null,
    identityStatus: identity.status || null,
    dynamicShopBinding: dynamicPddShopBinding,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pdd-workflow:dynamic-shop-binding'))");
    const current = await client.query(`
      SELECT shop.name, shop.expected_shop_name AS "expectedShopName",
        shop.display_slot AS "displaySlot",
        binding.mall_id AS "confirmedMallId",
        binding.profile_fingerprint AS "profileFingerprint",
        binding.status AS "bindingStatus",
        runtime.metadata->'pddIdentityBinding' AS "runtimeIdentityBinding"
      FROM shops shop
      LEFT JOIN shop_identity_bindings binding ON binding.shop_id = shop.id
      LEFT JOIN shop_runtime_state runtime ON runtime.shop_id = shop.id
      WHERE shop.id = $1 FOR UPDATE OF shop`, [shopId]);
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    const previousName = current.rows[0].name;
    const previousExpectedShopName = current.rows[0].expectedShopName;
    const previousRuntimeBinding = current.rows[0].runtimeIdentityBinding || {};
    const confirmedMallId = normalizePddMallId(current.rows[0].confirmedMallId);
    const confirmedFingerprint = String(current.rows[0].profileFingerprint || '').trim();
    const detectedFingerprint = String(identity.profileFingerprint || '').trim();
    const fingerprintMatches = !confirmedFingerprint || confirmedFingerprint === detectedFingerprint;
    // The display name may be a legacy OMS label, not a PDD login identity.
    const configuredNames = pddIdentityNameSet(previousExpectedShopName);
    const expectedCanonicalName = canonicalDetectedPddShopName(previousExpectedShopName);
    const nameMatches = !configuredNames.length
      || pddIdentityMatches(configuredNames, [
        actualShopName,
        identity.mallName,
        identity.headerShopName,
        identity.identityNames,
      ]);
    const confirmedMallMatches = Boolean(confirmedMallId && mallId && confirmedMallId === mallId);
    const correctedProfileMarker = !fingerprintMatches
      ? await readBrowserProfileMarker().catch(() => null) : null;
    const trustedCorrectedProfile = !fingerprintMatches
      && canTrustCorrectedPddProfile({
        shopId,
        bindingStatus: current.rows[0].bindingStatus,
        expectedShopName: previousExpectedShopName,
        confirmedMallId,
        confirmedFingerprint,
        observedShopName: actualShopName,
        observedMallId: mallId,
        observedFingerprint: detectedFingerprint,
        observedAt: identity.detectedAt,
        loginRequestedAt: shop.loginRequestedAt,
        marker: correctedProfileMarker,
      });
    if (!fingerprintMatches && !trustedCorrectedProfile) {
      await client.query('ROLLBACK');
      return false;
    }
    if (trustedCorrectedProfile) {
      const profileOwner = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM shop_identity_bindings other
          WHERE other.shop_id <> $1 AND other.profile_fingerprint = $2
        ) OR EXISTS (
          SELECT 1 FROM pdd_shop_runtime_bindings other
          WHERE other.shop_id <> $1
            AND (other.profile_fingerprint = $2 OR other.mall_id = $3)
        ) AS conflict`, [shopId, detectedFingerprint, mallId]);
      if (profileOwner.rows[0]?.conflict) {
        await client.query('ROLLBACK');
        return false;
      }
    }
    // PDD may show a verified merchant under a different display label
    // (主体名/店铺名). A previously confirmed merchant ID is stronger
    // identity evidence than the mutable label, so keep the shop runnable
    // when the IDs agree while still blocking a different merchant ID.
    const configuredNameMismatch = Boolean(
      configuredNames.length && !nameMatches && !confirmedMallMatches,
    );
    const confirmedMallMismatch = Boolean(confirmedMallId && mallId && confirmedMallId !== mallId);
    if (configuredNameMismatch || confirmedMallMismatch) {
      const conflict = await persistPddIdentityMismatch(client, {
        expectedShopName: configuredNames,
        actualShopName,
        expectedMallId: confirmedMallId,
        actualMallId: mallId,
        source: configuredNameMismatch ? 'configured-shop-name-mismatch' : 'confirmed-mall-id-mismatch',
      });
      await client.query('COMMIT');
      await heartbeat('pdd-identity-mismatch', { ...conflict, dynamicShopBinding: true });
      return false;
    }
    const identityKey = pddIdentityKey({ mallId, actualShopName });
    const previousMallId = normalizePddMallId(previousRuntimeBinding.mallId);
    const previousRuntimeIdentityMatches = mallId && previousMallId
      ? mallId === previousMallId
      : canonicalDetectedPddShopName(previousRuntimeBinding.actualShopName)
        === canonicalDetectedPddShopName(actualShopName);
    let identityBindingToken = previousRuntimeIdentityMatches && previousRuntimeBinding.bindingToken
      ? String(previousRuntimeBinding.bindingToken) : crypto.randomUUID();
    let identityBoundAt = previousRuntimeIdentityMatches && previousRuntimeBinding.boundAt
      ? String(previousRuntimeBinding.boundAt) : new Date().toISOString();
    if (dynamicPddShopBinding) {
      const owner = await client.query(`
        SELECT binding.shop_id, binding.binding_token, binding.bound_at
        FROM pdd_shop_runtime_bindings binding
        WHERE binding.identity_key = $1
          OR ($2::text IS NOT NULL AND binding.mall_id = $2)
        FOR UPDATE OF binding`, [identityKey, mallId]);
      const existingOwner = owner.rows[0] || null;
      if (existingOwner?.shop_id && existingOwner.shop_id !== shopId) {
        const conflict = await persistDuplicatePddIdentity(client, {
          actualShopName,
          mallId,
          conflictingShopId: existingOwner.shop_id,
          source: 'runtime-identity-binding',
        });
        await client.query('COMMIT');
        await heartbeat('pdd-identity-duplicate', { ...conflict, dynamicShopBinding: true });
        return false;
      }
      if (existingOwner?.shop_id === shopId) {
        identityBindingToken = String(existingOwner.binding_token);
        identityBoundAt = new Date(existingOwner.bound_at).toISOString();
      }
      await client.query('DELETE FROM pdd_shop_runtime_bindings WHERE shop_id = $1 AND identity_key <> $2', [shopId, identityKey]);
      await client.query(`
        INSERT INTO pdd_shop_runtime_bindings
          (identity_key, shop_id, actual_shop_name, mall_id, binding_token, profile_fingerprint,
           bound_at, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT (identity_key) DO UPDATE SET
          shop_id = EXCLUDED.shop_id,
          actual_shop_name = EXCLUDED.actual_shop_name,
          mall_id = EXCLUDED.mall_id,
          binding_token = EXCLUDED.binding_token,
          profile_fingerprint = EXCLUDED.profile_fingerprint,
          bound_at = EXCLUDED.bound_at,
          last_seen_at = now()`, [
        identityKey,
        shopId,
        actualShopName,
        mallId,
        identityBindingToken,
        identity.profileFingerprint || null,
        identityBoundAt,
      ]);
    }
    const previousBindingMatches = previousRuntimeBinding.bindingToken === identityBindingToken;
    const preserveConfiguredNames = pddIdentityNameSet(previousName, previousExpectedShopName).length > 1
      && nameMatches;
    const synchronizedDisplayName = preserveConfiguredNames ? previousName : actualShopName;
    const synchronizedExpectedName = preserveConfiguredNames ? previousExpectedShopName : actualShopName;
    const identityStateChanged = !previousBindingMatches
      || previousName !== synchronizedDisplayName
      || previousExpectedShopName !== synchronizedExpectedName;
    await client.query(`
      UPDATE shops SET name = $2, expected_shop_name = $3,
        onboarding_status = 'ready', onboarding_error = NULL,
        onboarding_completed_at = now(),
        updated_at = CASE
          WHEN name IS DISTINCT FROM $2 OR expected_shop_name IS DISTINCT FROM $3
            OR onboarding_status IS DISTINCT FROM 'ready' OR onboarding_error IS NOT NULL
          THEN now() ELSE updated_at END
      WHERE id = $1`, [shopId, synchronizedDisplayName, synchronizedExpectedName]);
    await client.query(`
      INSERT INTO shop_runtime_state (shop_id, status, metadata)
      VALUES ($1, 'idle', jsonb_build_object(
        'pddIdentityBinding', jsonb_build_object(
          'actualShopName', $2::text,
          'mallId', $3::text,
          'bindingToken', $4::text,
          'boundAt', $5::text
        ),
        'returnRefundScanCursor', jsonb_build_object('page', 1, 'itemOffset', 0)
      ))
      ON CONFLICT (shop_id) DO UPDATE SET
        metadata = coalesce(shop_runtime_state.metadata, '{}'::jsonb)
          || jsonb_build_object(
            'pddIdentityBinding', jsonb_build_object(
              'actualShopName', $2::text,
              'mallId', $3::text,
              'bindingToken', $4::text,
              'boundAt', $5::text
            )
          )
          || CASE WHEN $6::boolean THEN jsonb_build_object(
            'returnRefundScanCursor', jsonb_build_object('page', 1, 'itemOffset', 0),
            'returnRefundLastScan', '{}'::jsonb
          ) ELSE '{}'::jsonb END,
        updated_at = CASE WHEN $6::boolean THEN now() ELSE shop_runtime_state.updated_at END`, [
      shopId,
      actualShopName,
      mallId,
      identityBindingToken,
      identityBoundAt,
      !previousBindingMatches,
    ]);
    if (identity.profileFingerprint) {
      await client.query(`
        INSERT INTO shop_identity_bindings
          (shop_id, expected_shop_name, mall_id, profile_fingerprint, status, confirmed_by, confirmed_at, updated_at)
        VALUES ($1,$2,$3,$4,'confirmed','worker-page-detection',now(),now())
        ON CONFLICT (shop_id) DO UPDATE SET
          expected_shop_name = EXCLUDED.expected_shop_name,
          mall_id = EXCLUDED.mall_id,
          profile_fingerprint = EXCLUDED.profile_fingerprint,
          status = 'confirmed', confirmed_by = EXCLUDED.confirmed_by,
          confirmed_at = EXCLUDED.confirmed_at, updated_at = now()`,
      [shopId, actualShopName, mallId, identity.profileFingerprint]);
    }
    if (identityStateChanged) {
      await client.query(`
        INSERT INTO audit_events (shop_id, actor_id, event_type, payload)
        VALUES ($1,'worker-page-detection','shop-identity-synchronized',$2::jsonb)`, [
        shopId,
        JSON.stringify({
          previousName,
          previousExpectedShopName,
          actualShopName,
          mallId,
          dynamicShopBinding: dynamicPddShopBinding,
          source: identity.source || null,
          loginRequestedAt: identity.loginRequestedAt || null,
          correctedProfileVerified: trustedCorrectedProfile,
        }),
      ]);
    }
    await client.query('COMMIT');
    currentPddIdentityBindingToken = identityBindingToken;
    currentPddIdentityValidatedAt = detectedAt;
    currentPddIdentityConflict = null;
    currentPddIdentityMetadata = {
      ...currentPddIdentityMetadata,
      actualShopName,
      mallId,
      identityBindingToken,
      identityBoundAt,
    };
    if (persistentSlotSession && slotKind === 'login') {
      await transitionPersistentSlot('business', 'ordinary');
      await heartbeat('pdd-login-ready-business-resumed', { actualShopName });
    }
    const reboundOrders = await repository.bindLegacyPendingOrdersToIdentity({
      shopId,
      identityBindingToken,
      actualShopName,
      mallId,
    });
    if (reboundOrders.length) {
      await heartbeat('legacy-work-orders-identity-bound', {
        actualShopName,
        orderNumbers: reboundOrders.map((workOrder) => workOrder.external_order_number),
        count: reboundOrders.length,
      });
    }
    lastSynchronizedPddIdentity = signature;
    if (identityStateChanged) {
      console.log(`[shop-identity] ${shopId} synchronized to scanned shop: ${actualShopName}`);
    }
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensureDynamicPddShopBindingReady() {
  if (!dynamicPddShopBinding) return true;
  if (currentPddIdentityBindingToken
    && Number.isFinite(currentPddIdentityValidatedAt)
    && currentPddIdentityValidatedAt >= runnerStartedAt) return true;
  await ensureResidentWorkflowForReturnRefund();
  const deadline = Date.now() + identityBindingWaitMs;
  let identityRefreshRequested = false;
  while (Date.now() < deadline) {
    const resetCommand = await repository.claimPendingCommand({
      shopId,
      workerId,
      commandTypes: ['reset-pdd-login'],
    });
    if (resetCommand) {
      const applied = await applyIdleCommand(resetCommand);
      if (applied) {
        identityRefreshRequested = false;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
    }
    const progress = await readProgress();
    const identity = progress.pddShopIdentity || {};
    const detectedAt = Date.parse(identity.detectedAt || identity.checkedAt || '');
    const currentRunnerIdentity = Number.isFinite(detectedAt) && detectedAt >= runnerStartedAt;
    if (currentRunnerIdentity && identity.actualShopName) {
      const synchronized = await synchronizeDetectedPddShopIdentity(identity);
      if (synchronized) return true;
      const recovered = await recoverMaskedPddShopIdentityBinding(identity, progress.authHealth || {});
      if (recovered) {
        const reboundOrders = await repository.bindLegacyPendingOrdersToIdentity({
          shopId,
          identityBindingToken: currentPddIdentityBindingToken,
          actualShopName: recovered.actualShopName,
          mallId: recovered.mallId,
        });
        await heartbeat('pdd-identity-masked-name-recovered', {
          actualShopName: recovered.actualShopName,
          profileFingerprint: recovered.profileFingerprint,
          reboundOrderNumbers: reboundOrders.map((workOrder) => workOrder.external_order_number),
          reboundCount: reboundOrders.length,
        });
        return true;
      }
      if (currentPddIdentityConflict) {
        if (persistentSlotSession) await transitionPersistentSlot('login', 'login');
        const keepsIdentityCorrectionBrowserOpen = persistentSlotSession || residentBrowser;
        await heartbeat(slotKind === 'login' || keepsIdentityCorrectionBrowserOpen
          ? 'pdd-identity-duplicate-login-waiting'
          : 'pdd-identity-duplicate-exiting', {
          ...currentPddIdentityConflict,
          workflowStep: progress.step || null,
          authHealth: progress.authHealth || {},
        });
        if (!persistentSlotSession && !residentBrowser && assignmentKind !== 'login') {
          requestStop('pdd-identity-duplicate');
          await stopActiveChildGracefully(10_000);
          return false;
        }
        // The account is already known to be wrong. Repeated refreshes steal
        // the foreground and make it impossible for the owner to log out.
        // Wait for the explicit reset-pdd-login command instead.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      await heartbeat('pdd-identity-binding-waiting', {
        workflowStep: progress.step || null,
        authHealth: progress.authHealth || {},
      });
      return false;
    }
    if (!identityRefreshRequested && activeChildRunning()) {
      identityRefreshRequested = true;
      await heartbeat('pdd-identity-refresh-requested', {
        workflowStep: progress.step || null,
      });
      const identityRefreshHeartbeat = setInterval(() => heartbeat('pdd-identity-refresh-requested', {
        workflowStep: progress.step || null,
      }).catch((error) => console.error(`[worker-heartbeat] ${shopId}: ${error.message}`)), heartbeatIntervalMs);
      try {
        await sendRuntimeControl({ action: 'refresh-pdd-identity' }, 90_000);
      } catch (error) {
        await heartbeat('pdd-identity-refresh-failed', {
          workflowStep: progress.step || null,
          error: error.message,
        });
      } finally {
        clearInterval(identityRefreshHeartbeat);
      }
      continue;
    }
    await observeOnboardingProgress().catch((error) => {
      console.error(`[shop-onboarding] ${shopId}: ${error.message}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await heartbeat('pdd-identity-binding-waiting', {
    error: `Current PDD shop identity was not detected within ${Math.ceil(identityBindingWaitMs / 60_000)} minutes`,
  });
  return false;
}

async function observeOnboardingProgress() {
  let progress = {};
  try { progress = JSON.parse(await fsp.readFile(progressFile, 'utf8')); } catch { /* browser is still starting */ }
  const pddHealth = progress.authHealth?.pdd || {};
  const {
    system: authenticationSystem,
    health: authenticationHealth,
    manualLoginRequired,
    humanVerificationRequired,
    blocked: workflowAuthenticationBlocked,
  } = workflowAuthenticationState(progress);
  const identity = progress.pddShopIdentity || {};
  const identityObservedAt = Date.parse(identity.detectedAt || identity.checkedAt || '');
  const identityFromCurrentRunner = Number.isFinite(identityObservedAt) && identityObservedAt >= runnerStartedAt;
  const identityBelongsToCurrentLogin = !shop.loginRequestedAt
    || String(identity.loginRequestedAt || '') === shop.loginRequestedAt;
  let identitySynchronized = true;
  if (identity.status === 'detected' && identity.actualShopName) {
    identitySynchronized = await synchronizeDetectedPddShopIdentity(identity);
  }
  let onboardingStatus = null;
  let onboardingError = null;
  if (!identitySynchronized && currentPddIdentityConflict) {
    if (persistentSlotSession) await transitionPersistentSlot('login', 'login');
    onboardingStatus = 'waiting-login';
    onboardingError = currentPddIdentityConflict.reason;
  } else if (pddHealth.status === 'authenticated'
    && identityBelongsToCurrentLogin
    && (dynamicPddShopBinding
      ? Boolean(currentPddIdentityBindingToken)
      : identitySynchronized && identityFromCurrentRunner)) {
    onboardingStatus = 'ready';
  } else if ((manualLoginRequired && authenticationSystem === 'pdd')
    || pddHealth.status === 'expired') {
    onboardingStatus = 'waiting-login';
  } else if (pddHealth.status === 'verification-required'
    && (currentPddIdentityBindingToken || shopRow.onboarding_status === 'ready')) {
    onboardingStatus = 'ready';
  }
  let authenticationLeaseRecovery = null;
  const authenticationBlocked = ['waiting-login', 'identity-mismatch'].includes(onboardingStatus)
    || workflowAuthenticationBlocked;
  if (authenticationBlocked && !activeClaim) {
    authenticationLeaseRecovery = await repository.releaseExpiredOwnedClaimForAuthenticationBlock({
      shopId,
      workerId,
      system: authenticationSystem,
      observedStatus: manualLoginRequired
        ? 'manual-login-required'
        : humanVerificationRequired
          ? 'human-verification-required'
          : String(authenticationHealth.status || 'expired'),
    });
  }
  const observation = JSON.stringify({
    onboardingStatus,
    onboardingError,
    authenticationSystem,
    authenticationHealth,
    pddHealth,
    identity,
    step: progress.step,
  });
  const now = Date.now();
  if (observation === lastOnboardingObservation && now - lastOnboardingHeartbeatAt < 10_000) return;
  lastOnboardingObservation = observation;
  lastOnboardingHeartbeatAt = now;
  if (onboardingStatus) {
    await pool.query(`
      UPDATE shops SET onboarding_status = $2, onboarding_error = $3,
        onboarding_completed_at = CASE WHEN $2 = 'ready' THEN coalesce(onboarding_completed_at, now()) ELSE onboarding_completed_at END,
        updated_at = CASE WHEN onboarding_status IS DISTINCT FROM $2 OR onboarding_error IS DISTINCT FROM $3 THEN now() ELSE updated_at END
      WHERE id = $1`, [shopId, onboardingStatus, onboardingError]);
  }
  const onboardingWorkerState = humanVerificationRequired
    || authenticationHealth.status === 'verification-required'
    ? 'human-verification-required'
    : manualLoginRequired || authenticationHealth.status === 'expired'
      ? 'manual-login-required'
      : onboardingStatus === 'ready' ? 'queue-discovery' : onboardingStatus || 'browser-starting';
  await heartbeat(onboardingWorkerState, {
    onboardingStatus: onboardingStatus || shopRow.onboarding_status,
    authenticationSystem,
    authenticationStatus: authenticationHealth.status || null,
    authHealth: progress.authHealth || {},
    systemTabs: progress.systemTabs || {},
    workflowStep: progress.step || 'browser-starting',
    identityStatus: identity.status || null,
    actualShopName: identity.actualShopName || null,
    ...(authenticationLeaseRecovery?.released ? { authenticationLeaseRecovery } : {}),
  });
}

const finalizeStop = async () => {
  if (leaseTimer) clearInterval(leaseTimer);
  browserHealthMonitor.close();
  await stopActiveChildGracefully(90_000).catch(() => {});
  await pool.end().catch(() => {});
};
const requestStop = (signal) => {
  stopped = true;
  stopSignal = signal;
  const unresolvedClaimEffects = activeClaim?.has_unresolved_external_effects === true
    || activeEffectsForClaim().length > 0;
  if (!unresolvedClaimEffects && activeChild?.connected) {
    activeChild.send({ type: 'shutdown' }, () => {});
  }
};
process.once('SIGINT', () => requestStop('SIGINT'));
process.once('SIGTERM', () => requestStop('SIGTERM'));
process.on('message', (message) => {
  if (message?.type === 'shutdown') requestStop('supervisor-ipc');
});

const activeChildRunning = () => Boolean(activeChild
  && activeChild.exitCode === null
  && activeChild.signalCode === null
  && activeChild.connected);

const rejectWorkflowCommandsForChild = (child, error) => {
  for (const [requestId, pending] of workflowCommandRequests) {
    if (pending.child !== child) continue;
    workflowCommandRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  for (const [requestId, pending] of runtimeControlRequests) {
    if (pending.child !== child) continue;
    runtimeControlRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  for (const [requestId, deferred] of residentCommandDeferrals) {
    if (deferred.child !== child) continue;
    residentCommandDeferrals.delete(requestId);
    deferred.resolve({ status: 'child-exited', error });
  }
};

const handleWorkflowCommandResponse = (child, message) => {
  if (!['workflow-command-received', 'workflow-command-accepted'].includes(message?.type)
    || !message.requestId) return;
  const pending = workflowCommandRequests.get(message.requestId);
  const deferred = residentCommandDeferrals.get(message.requestId);
  if (!pending || pending.child !== child) {
    if (deferred?.child === child && message.type === 'workflow-command-accepted') {
      deferred.accepted = true;
      deferred.acceptedAt = new Date().toISOString();
      deferred.resolve({ status: 'accepted', requestId: message.requestId });
    }
    return;
  }
  if (message.type === 'workflow-command-received') {
    pending.receivedAt = new Date().toISOString();
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (workflowCommandRequests.get(message.requestId) !== pending) return;
      workflowCommandRequests.delete(message.requestId);
      const deferredCommand = {
        child,
        requestId: message.requestId,
        action: pending.action,
        receivedAt: pending.receivedAt,
        timedOutAt: new Date().toISOString(),
        accepted: false,
        acceptedAt: null,
        resolve: null,
      };
      deferredCommand.settlement = new Promise((resolve) => {
        deferredCommand.resolve = resolve;
      });
      residentCommandDeferrals.set(message.requestId, deferredCommand);
      const error = new Error(
        `常驻浏览器任务应用超时（已接收但 ${pending.applyTimeoutMs}ms 内未开始）`,
      );
      error.code = 'RESIDENT_COMMAND_APPLY_TIMEOUT';
      error.requestId = message.requestId;
      pending.reject(error);
    }, pending.applyTimeoutMs);
    pending.timer.unref?.();
    return;
  }
  workflowCommandRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  pending.resolve(message);
};

const residentCommandDelayErrorCodes = new Set([
  'RESIDENT_COMMAND_APPLY_TIMEOUT',
  'RESIDENT_COMMAND_BUSY_TIMEOUT',
]);

const isResidentCommandDelayError = (error) => (
  residentCommandDelayErrorCodes.has(String(error?.code || ''))
);

const waitForResidentCommandReady = async (child) => {
  const startedAt = Date.now();
  while (activeChildRunning() && activeChild === child) {
    const deferred = [...residentCommandDeferrals.values()]
      .find((entry) => entry.child === child);
    if (deferred) {
      if (!deferred.accepted) {
        await Promise.race([
          deferred.settlement,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        continue;
      }
      const progress = await readProgress().catch(() => ({}));
      if (progress.residentCommand?.requestId === deferred.requestId
        && progress.residentCommand?.status !== 'idle') {
        if (Date.now() - startedAt >= residentCommandReadyTimeoutMs) {
          const error = new Error(
            `常驻浏览器上一任务仍未完成（${residentCommandReadyTimeoutMs}ms）`,
          );
          error.code = 'RESIDENT_COMMAND_BUSY_TIMEOUT';
          error.requestId = deferred.requestId;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      residentCommandDeferrals.delete(deferred.requestId);
      continue;
    }

    const progress = await readProgress().catch(() => ({}));
    const residentCommand = progress.residentCommand || {};
    if (residentCommand.status !== 'active' || !residentCommand.requestId) return;
    if (Date.now() - startedAt >= residentCommandReadyTimeoutMs) {
      const error = new Error(
        `常驻浏览器上一任务仍未完成（${residentCommandReadyTimeoutMs}ms）`,
      );
      error.code = 'RESIDENT_COMMAND_BUSY_TIMEOUT';
      error.requestId = residentCommand.requestId;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('常驻浏览器子进程不可用');
};

const rejectBrowserProgressSnapshot = (reason) => {
  browserProgressSync.lastOutcome = 'rejected';
  browserProgressSync.lastRejectedAt = new Date().toISOString();
  browserProgressSync.lastRejectedReason = reason;
  return false;
};

async function checkpointBrowserProgress(progress, source) {
  browserProgressSync.lastAttemptAt = new Date().toISOString();
  browserProgressSync.lastAttemptSource = source;
  const checkpointClaim = activeClaim;
  if (!checkpointClaim) return rejectBrowserProgressSnapshot('no-active-claim');
  if (!progressBelongsToClaim(progress, checkpointClaim)) {
    return rejectBrowserProgressSnapshot('progress-identity-mismatch');
  }
  const serialized = JSON.stringify(progress);
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  if (hash === lastDatabaseCheckpointHash) {
    browserProgressSync.lastOutcome = 'up-to-date';
    browserProgressSync.lastSucceededAt = browserProgressSync.lastSucceededAt
      || new Date().toISOString();
    browserProgressSync.lastSucceededSourceUpdatedAt = progress.updatedAt || null;
    browserProgressSync.lastRejectedReason = null;
    browserProgressSync.lastError = null;
    return true;
  }
  const saved = await checkpointActiveClaim(progress, { force: true, claim: checkpointClaim });
  if (!saved) {
    const leaseStillValid = await repository.hasValidLease({
      shopId,
      workerId,
      workOrderId: checkpointClaim.id,
      leaseToken: checkpointClaim.leaseToken,
    });
    if (!leaseStillValid) {
      browserProgressSync.lastOutcome = 'lease-ended';
      browserProgressSync.lastRejectedReason = null;
      browserProgressSync.lastError = null;
      return false;
    }
    return rejectBrowserProgressSnapshot('database-rejected-stale-snapshot');
  }
  browserProgressSync.lastOutcome = 'checkpointed';
  browserProgressSync.lastSucceededAt = new Date().toISOString();
  browserProgressSync.lastSucceededSourceUpdatedAt = progress.updatedAt || null;
  browserProgressSync.lastRejectedReason = null;
  browserProgressSync.lastError = null;
  return true;
}

const scheduleBrowserProgressCheckpoint = () => {
  if (browserProgressCheckpointTimer || !pendingBrowserProgressSnapshot) return;
  browserProgressCheckpointTimer = setTimeout(() => {
    browserProgressCheckpointTimer = null;
    const pending = pendingBrowserProgressSnapshot;
    pendingBrowserProgressSnapshot = null;
    browserProgressCheckpointQueue = browserProgressCheckpointQueue
      .then(async () => {
        if (!pending
          || pending.child !== activeChild
          || !activeClaim
          || pending.assignmentId !== activeClaim.leaseToken
          || !progressBelongsToClaim(pending.progress, activeClaim)) {
          return rejectBrowserProgressSnapshot('queued-snapshot-fence-mismatch');
        }
        return checkpointBrowserProgress(pending.progress, 'browser-ipc');
      })
      .catch((error) => {
        browserProgressSync.lastOutcome = 'error';
        browserProgressSync.lastErrorAt = new Date().toISOString();
        browserProgressSync.lastError = error.message;
        console.error(`[browser-progress-sync][${shopId}] browser-ipc: ${error.message}`);
      })
      .finally(() => scheduleBrowserProgressCheckpoint());
  }, 100);
  browserProgressCheckpointTimer.unref?.();
};

const handleWorkflowProgressSnapshot = (child, message) => {
  if (message?.type !== 'workflow-progress-snapshot') return;
  if (!message.assignmentId && !activeClaim) return;
  browserProgressSync.lastReceivedAt = new Date().toISOString();
  browserProgressSync.lastReceivedSourceUpdatedAt = message.progress?.updatedAt || null;
  if (message.shopId !== shopId) return rejectBrowserProgressSnapshot('shop-mismatch');
  if (!message.assignmentId) return rejectBrowserProgressSnapshot('missing-assignment');
  if (!message.progress?.updatedAt) return rejectBrowserProgressSnapshot('missing-progress-timestamp');
  if (child !== activeChild) return rejectBrowserProgressSnapshot('inactive-browser-process');
  if (!activeClaim) return rejectBrowserProgressSnapshot('no-active-claim');
  if (message.assignmentId !== activeClaim.leaseToken) {
    return rejectBrowserProgressSnapshot('assignment-mismatch');
  }
  if (!progressBelongsToClaim(message.progress, activeClaim)) {
    return rejectBrowserProgressSnapshot('progress-identity-mismatch');
  }
  const pendingUpdatedAt = Date.parse(pendingBrowserProgressSnapshot?.progress?.updatedAt || '');
  const incomingUpdatedAt = Date.parse(message.progress.updatedAt);
  if (Number.isFinite(pendingUpdatedAt)
    && Number.isFinite(incomingUpdatedAt)
    && incomingUpdatedAt < pendingUpdatedAt) {
    return rejectBrowserProgressSnapshot('older-than-pending-snapshot');
  }
  pendingBrowserProgressSnapshot = {
    child,
    assignmentId: message.assignmentId,
    progress: message.progress,
  };
  scheduleBrowserProgressCheckpoint();
};

const sendWorkflowCommand = (payload, timeoutMs = 20_000) => {
  if (!activeChildRunning()) return Promise.reject(new Error('常驻浏览器子进程不可用'));
  const child = activeChild;
  const requestId = crypto.randomUUID();
  const applyTimeoutMs = Math.max(timeoutMs, residentCommandApplyTimeoutMs);
  return (async () => {
    await waitForResidentCommandReady(child);
    return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workflowCommandRequests.delete(requestId);
      const error = new Error('常驻浏览器任务接收超时');
      error.code = 'RESIDENT_COMMAND_RECEIVE_TIMEOUT';
      error.requestId = requestId;
      reject(error);
    }, timeoutMs);
    workflowCommandRequests.set(requestId, {
      child,
      action: payload.action || null,
      resolve,
      reject,
      timer,
      applyTimeoutMs,
      receivedAt: null,
    });
    child.send({ type: 'workflow-command', requestId, ...payload }, (error) => {
      if (!error) return;
      workflowCommandRequests.delete(requestId);
      clearTimeout(timer);
      reject(error);
    });
    });
  })();
};

const waitForActiveResidentReady = async () => {
  if (!activeChildRunning()) throw new Error('常驻浏览器子进程不可用');
  if (!activeChildReadyPromise) throw new Error('常驻浏览器缺少启动就绪状态');
  const readyPromise = activeChildReadyPromise;
  const settledReadyPromise = readyPromise.then(
    (value) => ({ ready: true, value, error: null }),
    (error) => ({ ready: true, value: null, error }),
  );
  while (activeChildRunning() && activeChildReadyPromise === readyPromise) {
    const result = await Promise.race([
      settledReadyPromise,
      new Promise((resolve) => setTimeout(() => resolve({ ready: false }), 1_000)),
    ]);
    if (result.ready) {
      if (result.error) throw result.error;
      return result.value;
    }
    await observeOnboardingProgress().catch((error) => {
      console.error(`[shop-onboarding] ${shopId}: ${error.message}`);
    });
  }
  return settledReadyPromise.then((result) => {
    if (result.error) throw result.error;
    return result.value;
  });
};

const refreshReturnRefundRuntimeSettings = async ({ force = false } = {}) => {
  if (returnRefundScanOnce || (!force && Date.now() - lastReturnRefundSettingsRefreshAt < 10_000)) return;
  lastReturnRefundSettingsRefreshAt = Date.now();
  const settings = await repository.getReturnRefundRuntimeSettings();
  if (typeof settings.scanEnabled === 'boolean') returnRefundScanEnabled = settings.scanEnabled;
  if (typeof settings.autoApproveEnabled === 'boolean') {
    returnRefundAutoApproveEnabled = settings.autoApproveEnabled;
  }
};

const returnRefundConfiguredForShop = () => returnRefundScanEnabled
  && shop.scenarioCodes.includes('return-refund');

const returnRefundScanDueNow = () => isReturnRefundScanDue({
  cursor: returnRefundCycleCursor,
  lastSuccessfulScanAt: lastReturnRefundScanAt,
  retryNotBefore: returnRefundScanRetryNotBefore,
  intervalMs: returnRefundScanIntervalMs,
});

const hydrateReturnRefundScanCursor = async () => {
  if (returnRefundScanCursorHydrated || !returnRefundConfiguredForShop()) return;
  const persistedCursor = await repository.getReturnRefundScanCursor(shopId);
  const cycleCompleted = persistedCursor.page === 1 && persistedCursor.itemOffset === 0;
  const persistedAt = Date.parse(String(persistedCursor.updatedAt || ''));
  lastReturnRefundScanAt = Number.isFinite(persistedAt) ? persistedAt : 0;
  returnRefundScanRetryNotBefore = Math.max(returnRefundScanRetryNotBefore,
    Date.parse(String(persistedCursor.retryNotBefore || '')) || 0,
    returnRefundVerificationCooldownUntil({
      scannedAt: persistedAt,
      verificationHandledCount: persistedCursor.verificationHandledCount,
      postVerificationMs: returnRefundPostVerificationCooldownMs,
    }));
  returnRefundCycleCursor = cycleCompleted
    ? null
    : { page: persistedCursor.page, itemOffset: persistedCursor.itemOffset,
      ...(persistedCursor.actionScope ? { actionScope: persistedCursor.actionScope } : {}) };
  if (!cycleCompleted) {
    returnRefundCycleTotals = { scannedItems: 0, persistedItems: 0, examinedItems: 0 };
    returnRefundCycleVisitedCursors = new Set();
    if (Number.isFinite(persistedAt)) {
      returnRefundScanRetryNotBefore = Math.max(returnRefundScanRetryNotBefore,
        persistedAt + returnRefundPartialScanCooldownMs({
          baseMs: returnRefundPartialBatchCooldownMs,
          postVerificationMs: returnRefundPostVerificationCooldownMs,
          verificationHandledCount: persistedCursor.verificationHandledCount,
        }));
    }
  }
  const startupScanNotBefore = returnRefundScanStartupCadence.anchorAt
    + returnRefundScanStartupDelayMs;
  if (mixedBusinessSlotSession && startupScanNotBefore > Date.now()) {
    returnRefundScanRetryNotBefore = Math.max(
      returnRefundScanRetryNotBefore,
      startupScanNotBefore,
    );
  }
  returnRefundScanCursorHydrated = true;
};

const deferClaimsAfterPddTabFailure = async (failure, source) => {
  if (!isPddTabUnavailableFailure(failure)) return false;
  pddTabUnavailableNotBefore = pddTabUnavailableRetryAt(
    Date.now(), pddTabUnavailableNotBefore,
  );
  await heartbeat('pdd-tab-unavailable-cooldown', {
    source,
    retryAfterAt: new Date(pddTabUnavailableNotBefore).toISOString(),
    externalActionsReplayed: false,
  }).catch((error) => console.error(`[pdd-tab-cooldown][${shopId}] ${error.message}`));
  return true;
};

const deferReturnRefundScanAfterFailure = async (error) => {
  if (isDuplicatePddSlotConflict(error)) throw error;
  await deferClaimsAfterPddTabFailure(error, 'return-refund-scan');
  rethrowReturnRefundScanProxyFailure(error);
  const retry = nextReturnRefundScanRetry({
    error,
    verificationRetryMs: returnRefundScanVerificationRetryMs,
    failureRetryMs: returnRefundScanFailureRetryMs,
  });
  returnRefundScanRetryNotBefore = retry.retryNotBefore;
  await repository.setReturnRefundScanRetry({
    shopId,
    retryNotBefore: retry.retryNotBefore,
    reason: error.code || error.result?.status || error.message,
  }).catch((persistError) => console.error(
    `[return-refund-scan-retry][${shopId}] ${persistError.message}`,
  ));
  await heartbeat(retry.verificationRequired
    ? 'human-verification-required'
    : retry.loginRequired ? 'manual-login-required' : 'return-refund-scan-failed', {
    error: error.message,
    dependencies: ['pdd', 'dashboard'],
    scanRetryAfterAt: new Date(retry.retryNotBefore).toISOString(),
    scanRetryDelayMs: retry.retryDelayMs,
    verificationRetryScheduled: retry.verificationRequired,
    loginRetryScheduled: retry.loginRequired,
  });
};

async function waitForReturnRefundOutput({
  requestId,
  mode,
  timeoutMs = returnRefundResultTimeoutMs,
  hardTimeoutMs = Math.max(returnRefundHardTimeoutMs, timeoutMs),
}) {
  let remainingMs = timeoutMs;
  let checkedAt = Date.now();
  let hardDeadline = checkedAt + hardTimeoutMs;
  let lastWaitHeartbeatAt = 0;
  let progressMarker = null;
  let lastProgress = {};
  const readTerminalOutput = async () => {
    let output = null;
    try {
      output = JSON.parse(await fsp.readFile(returnRefundOutputFile, 'utf8'));
    } catch { /* result is not ready yet */ }
    // A resident workflow writes `verification-timeout` before it releases
    // its command. Treat that result as terminal immediately. If it is left
    // out of this set, the worker keeps polling an already-idle command until
    // its own long timeout, leaving the shop looking permanently stuck.
    return output?.requestId === requestId && output.mode === mode
      && ['completed', 'verification-required', 'verification-timeout', 'login-required', 'rate-limited', 'retryable-error']
        .includes(output.status)
      ? output
      : null;
  };
  const settleOutput = (terminalOutput, progress) => {
    const residentCommandSettled = progress.residentCommand?.requestId === requestId
      && progress.residentCommand?.status === 'idle';
    if (terminalOutput && residentCommandSettled) {
      if (terminalOutput.status === 'completed') return terminalOutput;
      const error = new Error(terminalOutput.error || `Return-refund ${mode} interrupted: ${terminalOutput.status}`);
      error.code = terminalOutput.status === 'verification-timeout'
        ? 'HUMAN_VERIFICATION_TIMEOUT'
        : terminalOutput.status === 'verification-required'
          ? 'PDD_HUMAN_VERIFICATION_REQUIRED'
          : terminalOutput.status === 'login-required'
            ? 'PDD_LOGIN_REQUIRED'
            : `RETURN_REFUND_${String(terminalOutput.status).toUpperCase().replaceAll('-', '_')}`;
      error.result = terminalOutput;
      throw error;
    }
    return null;
  };
  while (remainingMs > 0 && Date.now() < hardDeadline) {
    if (!activeChildRunning()) throw new Error('常驻浏览器在退货退款任务期间退出');
    let terminalOutput = await readTerminalOutput();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const now = Date.now();
    const progress = await readProgress();
    lastProgress = progress;
    // The child may publish the result during the poll sleep, then report
    // idle. Do not turn that successful handoff into a timeout using the
    // earlier file read; keep the exact request and command-idle fences.
    if (!terminalOutput && progress.residentCommand?.requestId === requestId
      && progress.residentCommand?.status === 'idle') {
      terminalOutput = await readTerminalOutput();
    }
    const settledOutput = settleOutput(terminalOutput, progress);
    if (settledOutput) return settledOutput;
    let checkpointError = null;
    if (activeClaim) {
      try {
        await checkpointActiveClaim(progress);
      } catch (error) {
        checkpointError = error.message;
      }
    }
    const waitState = advanceReturnRefundWaitBudget({
      remainingMs,
      elapsedMs: now - checkedAt,
      timeoutMs,
      previousProgressMarker: progressMarker,
      progress,
      requestId,
    });
    remainingMs = waitState.remainingMs;
    progressMarker = waitState.progressMarker;
    if (now - lastWaitHeartbeatAt >= heartbeatIntervalMs) {
      const heartbeatState = waitState.verificationWaiting
        ? 'human-verification-required'
        : waitState.rateLimitWaiting ? 'rate-limited-waiting' : `return-refund-${mode}-running`;
      await heartbeat(heartbeatState, {
        authHealth: progress.authHealth || {},
        systemTabs: progress.systemTabs || {},
        workflowStep: progress.step || null,
        verificationLocation: progress.verificationLocation || null,
        dependencies: ['pdd', 'dashboard'],
        autoApproveEnabled: returnRefundAutoApproveEnabled,
        ...(checkpointError ? { checkpointError } : {}),
      });
      lastWaitHeartbeatAt = now;
    }
    checkedAt = now;
    // Check wall time after checkpoint/heartbeat I/O: those awaits can cross
    // the deadline while this exact resident command is still executing.
    if (mode === 'claim' && (remainingMs <= 0 || Date.now() >= hardDeadline)
      && returnRefundClaimCommandUnsettled({
        mode,
        requestId,
        progress,
        deferred: residentCommandDeferrals.get(requestId),
      })) {
      // The child received this exact command, or is still running it. A
      // timeout here would release the lease before the command has settled;
      // it could later click through the same refund. Keep the lease and the
      // resident browser alive while the normal heartbeat reports the wait.
      const settlementPollMs = Math.max(heartbeatIntervalMs, 30_000);
      remainingMs = Math.max(remainingMs, settlementPollMs);
      await heartbeat('return-refund-command-awaiting-settlement', {
        workOrderId: activeClaim?.id || null,
        commandRequestId: requestId,
        verificationWaiting: waitState.verificationWaiting,
        externalActionsReplayed: false,
      }).catch((error) => console.error(
        `[return-refund-command-awaiting-settlement][${shopId}] ${error.message}`,
      ));
      hardDeadline = Date.now() + settlementPollMs;
    }
  }
  const finalProgress = await readProgress().catch(() => lastProgress);
  // Checkpoint or heartbeat I/O can cross the deadline after the last poll.
  // An exact result from an idle command takes precedence over that timeout.
  const finalOutput = settleOutput(await readTerminalOutput(), finalProgress);
  if (finalOutput) return finalOutput;
  if (Date.now() >= hardDeadline) {
    throw createReturnRefundWaitTimeoutError({
      progress: finalProgress,
      mode,
      timeoutMs: hardTimeoutMs,
      hardLimit: true,
    });
  }
  throw createReturnRefundWaitTimeoutError({
    progress: finalProgress,
    mode,
    timeoutMs,
  });
}

async function ensureResidentWorkflowForReturnRefund() {
  if (!activeChildRunning()) startLegacyPlaywright(null, { discoverOnly: true });
  await waitForActiveResidentReady();
}

async function runReturnRefundScan() {
  if (!returnRefundConfiguredForShop()) return { skipped: true, reason: 'shop-not-enabled' };
  if (!returnRefundCycleCursor) {
    returnRefundCycleCursor = { page: 1, itemOffset: 0 };
    returnRefundCycleTotals = { scannedItems: 0, persistedItems: 0, examinedItems: 0 };
    returnRefundCycleVisitedCursors = new Set();
  }
  const scanCursor = returnRefundCycleCursor;
  const cursorKey = `${scanCursor.page}:${scanCursor.itemOffset}`;
  if (returnRefundCycleVisitedCursors.has(cursorKey)) {
    throw new Error(`退货退款全量扫描游标重复: ${cursorKey}`);
  }
  await fsp.rm(returnRefundOutputFile, { force: true }).catch(() => {});
  await ensureResidentWorkflowForReturnRefund();
  const batchDurationMs = mixedBusinessSlotSession
    ? returnRefundScanBatchDurationMs({
      baseDurationMs: returnRefundCombinedBatchMaxDurationMs,
      maxDurationMs: returnRefundScanMaxDurationMs,
      cursor: scanCursor,
    })
    : returnRefundScanMaxDurationMs;
  // This is a scheduling hint only. The browser must prove the exact aftersale
  // identity before it can skip a detail; a failed lookup scans normally.
  const [deferredRefunds, completedRefunds] = await Promise.all([
    repository.listFutureReturnRefundRechecks(
      shopId, Math.ceil((batchDurationMs + 5 * 60_000) / 1000),
    ).catch((error) => {
      console.warn(`[return-refund-future-rechecks][${shopId}] ${error.message}`);
      return [];
    }),
    repository.listConfirmedReturnRefundCompletions(shopId).catch((error) => {
      console.warn(`[return-refund-confirmed-completions][${shopId}] ${error.message}`);
      return [];
    }),
  ]);
  const accepted = await sendWorkflowCommand({
    action: 'refund-scan',
    maxItems: returnRefundOnly || returnRefundScanOnce
      ? returnRefundScanMaxItems
      : Math.min(returnRefundScanMaxItems, returnRefundCombinedBatchItems),
    // Read-only skips need no detail tab. Keep the same three-detail cap,
    // visible pace and duration while allowing up to twenty proved skips.
    maxKnownSkippedItems: mixedBusinessSlotSession ? 20 : 0,
    maxDurationMs: batchDurationMs,
    deferredRefunds,
    completedRefunds,
    ...(mixedBusinessSlotSession ? {
      verificationBudgetMs: returnRefundCombinedScanVerificationBudgetMs,
    } : {}),
    scanCursor,
  }, 4 * 60_000);
  const output = await waitForReturnRefundOutput({
    requestId: accepted.requestId,
    mode: 'scan',
    timeoutMs: returnRefundScanMaxDurationMs + 2 * 60_000,
  });
  const progress = await readProgress();
  const identity = progress.pddShopIdentity || {};
  const actualShopName = normalizeDetectedPddShopName(identity.actualShopName);
  const marker = await readBrowserProfileMarker().catch(() => null);
  const profileFingerprint = String(identity.profileFingerprint || '').trim();
  const markerFingerprint = String(marker?.profileFingerprint || '').trim();
  const profileMatches = Boolean(profileFingerprint && markerFingerprint && profileFingerprint === markerFingerprint);
  const expectedShopName = normalizeDetectedPddShopName(shop.expectedShopName);
  const configuredIdentityNames = shop.configuredPddIdentityNames || pddIdentityNameSet(expectedShopName);
    const maskedIdentityBound = isMaskedDetectedPddShopName(actualShopName)
    && Boolean(currentPddIdentityBindingToken)
    && profileMatches
    && pddIdentityMatches(configuredIdentityNames, currentPddIdentityMetadata?.actualShopName);
  const identitySynchronized = maskedIdentityBound || (actualShopName && profileMatches
    ? await synchronizeDetectedPddShopIdentity(identity)
    : false);
  if (!actualShopName
    || !profileMatches
    || !identitySynchronized
    || (!maskedIdentityBound && !pddIdentityMatches(
      configuredIdentityNames,
      [actualShopName, identity.mallName, identity.headerShopName, identity.identityNames],
    ))) {
    await heartbeat('return-refund-identity-mismatch', {
      expectedShopName,
      actualShopName: actualShopName || null,
      profileFingerprint: profileFingerprint || null,
      profileMatches,
      identitySynchronized,
      scannedItems: output.items?.length || 0,
      refundAutomation: 'skipped',
    });
    return { skipped: true, reason: 'identity-mismatch', actualShopName, expectedShopName };
  }

  const effectiveStartCursor = returnRefundScanEffectiveStartCursor(scanCursor, output.scan);
  const effectiveCursorKey = `${effectiveStartCursor.page}:${effectiveStartCursor.itemOffset}`;
  if (returnRefundCycleVisitedCursors.has(effectiveCursorKey)) {
    throw new Error(`退货退款全量扫描游标重复: ${effectiveCursorKey}`);
  }
  const batchPersisted = await repository.enqueueReturnRefunds({
    shopId,
    items: (output.items || []).map((item) => ({
      ...item,
      evidence: {
        ...(item.evidence || {}),
        detectedShopName: actualShopName,
        pddMallId: currentPddIdentityMetadata.mallId || null,
        pddIdentityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      },
    })),
    autoApproveEnabled: returnRefundAutoApproveEnabled,
  });
  const persistedCursor = await repository.setReturnRefundScanCursor({
    shopId,
    cursor: output.scan?.nextCursor || { page: 1, itemOffset: 0 },
    scan: output.scan || null,
  });
  returnRefundCycleTotals.scannedItems += output.items?.length || 0;
  returnRefundCycleTotals.persistedItems += batchPersisted.length;
  returnRefundCycleTotals.examinedItems += Number(output.scan?.examined || 0);
  const fullScanCompleted = persistedCursor.page === 1 && persistedCursor.itemOffset === 0;
  const totals = { ...returnRefundCycleTotals };
  if (!fullScanCompleted
    && persistedCursor.page === effectiveStartCursor.page
    && persistedCursor.itemOffset === effectiveStartCursor.itemOffset) {
    throw new Error(`Return-refund scan cursor did not advance: ${cursorKey}`);
  }
  // A verification or page failure must be able to retry the same durable
  // cursor. Mark it visited only after this batch has advanced successfully.
  returnRefundCycleVisitedCursors.add(effectiveCursorKey);
  if (slotSession) {
    await schedulerRepository.recordRefundCursor({
      shopId,
      leaseToken: slotLeaseToken,
      cursor: persistedCursor,
      fullScanCompleted,
      totals,
    });
  }
  await heartbeat(fullScanCompleted
    ? 'return-refund-scan-completed'
    : 'return-refund-scan-batch-completed', {
    actualShopName,
    scannedItems: output.items?.length || 0,
    persistedItems: batchPersisted.length,
    totalScannedItems: totals.scannedItems,
    totalPersistedItems: totals.persistedItems,
    totalExaminedItems: totals.examinedItems,
    scan: output.scan || null,
    nextScanCursor: persistedCursor,
    fullScanCompleted,
    autoApproveEnabled: returnRefundAutoApproveEnabled,
    dependencies: ['pdd', 'dashboard'],
  });
  returnRefundCycleCursor = fullScanCompleted ? null : persistedCursor;
  if (fullScanCompleted) {
    returnRefundScanRetryNotBefore = returnRefundVerificationCooldownUntil({
      scannedAt: Date.now(),
      verificationHandledCount: output.scan?.verificationHandledCount,
      postVerificationMs: returnRefundPostVerificationCooldownMs,
    });
    returnRefundCycleTotals = null;
    returnRefundCycleVisitedCursors = new Set();
    lastReturnRefundScanAt = Date.now();
  } else {
    // Yield the resident browser after each bounded batch. The cursor is
    // durable, so ordinary discovery and queued work can run before the next
    // refund batch resumes.
    returnRefundScanRetryNotBefore = Date.now() + returnRefundPartialScanCooldownMs({
      baseMs: returnRefundPartialBatchCooldownMs,
      postVerificationMs: returnRefundPostVerificationCooldownMs,
      verificationHandledCount: output.scan?.verificationHandledCount,
    });
    lastReturnRefundScanAt = Date.now();
  }
  return {
    output,
    persisted: batchPersisted,
    fullScanCompleted,
    totalScannedItems: totals.scannedItems,
    totalExaminedItems: totals.examinedItems,
  };
}

async function runReturnRefundValidation() {
  if (!returnRefundValidationDetailUrl
    || !returnRefundValidationOrderNumber
    || !returnRefundValidationAftersaleNumber) {
    throw new Error('退货退款定点验证缺少订单号、售后编号或详情地址');
  }
  await fsp.rm(returnRefundOutputFile, { force: true }).catch(() => {});
  await ensureResidentWorkflowForReturnRefund();
  const accepted = await sendWorkflowCommand({
    action: 'run-refund',
    orderNumber: returnRefundValidationOrderNumber,
    workOrderType: '退货退款',
    scenarioCode: 'return-refund',
    aftersaleNumber: returnRefundValidationAftersaleNumber,
    detailUrl: returnRefundValidationDetailUrl,
    autoApproveEnabled: false,
    externalEffectGuard: false,
  }, 4 * 60_000);
  const output = await waitForReturnRefundOutput({
    requestId: accepted.requestId,
    mode: 'claim',
    timeoutMs: returnRefundScanMaxDurationMs + 2 * 60_000,
  });
  await heartbeat('return-refund-validation-completed', {
    orderNumber: returnRefundValidationOrderNumber,
    aftersaleNumber: returnRefundValidationAftersaleNumber,
    outcome: output.result?.outcome || null,
    logisticsNodes: output.result?.facts?.logisticsTimeline?.length || 0,
    logisticsSource: output.result?.facts?.evidence?.returnLogisticsSource || null,
    autoApproveEnabled: false,
    persisted: false,
  });
  return output;
}

async function runReturnRefundClaim(claim) {
  const refund = await repository.getReturnRefundForClaim({ workOrderId: claim.id, shopId });
  if (!refund) {
    return repository[
      claim.heldRefundReadOnly ? 'finishHeldReturnRefundReadOnly' : 'finishReturnRefundClaim'
    ]({
      shopId,
      workOrderId: claim.id,
      leaseToken: claim.leaseToken,
      result: {
        outcome: 'page-error',
        riskLevel: 'high',
        reasons: ['数据库缺少与退款工单对应的售后记录'],
        facts: { orderNumber: claim.external_order_number },
        rules: {},
      },
    });
  }
  await fsp.rm(returnRefundOutputFile, { force: true }).catch(() => {});
  await ensureResidentWorkflowForReturnRefund();
  const autoPolicyManualReasonCodes = new Set([
    'return-refund-no-logistics-over-72-hours',
    'return-refund-latest-logistics-stale',
    'return-refund-direction-timeout',
  ]);
  const autoPolicyManualReasons = new Set([
    '首次发现超过72小时仍未产生有效退货物流',
    '当前时间距最新物流节点超过72小时',
    '物流首尾时间跨度超过72小时，任一节点仍未出现长沙或衡水冀州',
  ]);
  const autoPolicyReevaluation = refund.action_state === 'manual-review'
    && (
      autoPolicyManualReasonCodes.has(refund.active_manual_reason_code)
      || autoPolicyManualReasons.has(refund.manual_review_reason)
    );
  const readOnlyReview = claim.heldRefundReadOnly === true
    || (refund.action_state === 'manual-review' && !autoPolicyReevaluation);
  let accepted;
  try {
    accepted = await sendWorkflowCommand({
    action: 'run-refund',
    orderNumber: claim.external_order_number,
    assignmentId: claim.leaseToken,
    workOrderType: claim.work_order_type,
    scenarioCode: 'return-refund',
    aftersaleNumber: refund.aftersale_number,
    detailUrl: refund.detail_url,
    firstDiscoveredAt: refund.first_discovered_at instanceof Date
      ? refund.first_discovered_at.toISOString()
      : refund.first_discovered_at || null,
    existingEffectStatus: refund.effect_status,
    existingEffectReceipt: refund.effect_receipt,
    existingEffectError: refund.effect_error,
    existingEffectReservedAt: refund.effect_reserved_at instanceof Date
      ? refund.effect_reserved_at.toISOString()
      : refund.effect_reserved_at || null,
    autoApproveEnabled: readOnlyReview ? false : returnRefundAutoApproveEnabled,
    readOnlyReview,
    externalEffectGuard: true,
    }, 4 * 60_000);
  } catch (error) {
    if (error?.code !== 'RESIDENT_COMMAND_APPLY_TIMEOUT'
      || !error.requestId || !activeChildRunning()
      || !residentCommandDeferrals.has(error.requestId)) throw error;
    // A received command is still queued in the resident child. Continue
    // waiting for this exact request instead of misclassifying it as a page
    // failure and releasing a lease that the child may use later.
    accepted = { requestId: error.requestId };
    await heartbeat('return-refund-command-delayed', {
      workOrderId: claim.id,
      commandRequestId: accepted.requestId,
      browserKeptResident: true,
      externalActionsReplayed: false,
    }).catch((heartbeatError) => console.error(
      `[return-refund-command-delayed][${shopId}] ${heartbeatError.message}`,
    ));
  }
  const output = await waitForReturnRefundOutput({ requestId: accepted.requestId, mode: 'claim' });
  if (output.result?.outcome === 'page-error') {
    await deferClaimsAfterPddTabFailure(output.result, 'return-refund-claim');
  }
  pddSessionRunwayNotBefore = Math.max(
    pddSessionRunwayNotBefore,
    returnRefundSessionRunwayCooldownUntil(output.result),
  );
  const browserProxyNavigationFailure = output.result?.outcome === 'page-error'
    ? recordBrowserProxyNavigationFailure(
      output.result?.error || output.result?.reasons?.join('; ') || '',
    )
    : null;
  const finished = await repository[
    claim.heldRefundReadOnly ? 'finishHeldReturnRefundReadOnly' : 'finishReturnRefundClaim'
  ]({
    shopId,
    workOrderId: claim.id,
    leaseToken: claim.leaseToken,
    result: output.result,
  });
  if (!finished) throw new Error('退货退款处理完成，但数据库租约已失效');
  if (['auto-refunded', 'manual-completed'].includes(output.result?.outcome)) completedCount += 1;
  await heartbeat('return-refund-claim-finished', {
    orderNumber: claim.external_order_number,
    aftersaleNumber: refund.aftersale_number,
    outcome: output.result?.outcome,
    autoApproveEnabled: readOnlyReview ? false : returnRefundAutoApproveEnabled,
    readOnlyReview,
    heldRefundReadOnly: claim.heldRefundReadOnly === true,
    autoPolicyReevaluation,
    browserProxyNavigationFailure,
    ...(Date.now() < pddSessionRunwayNotBefore
      ? { pddSessionRunwayRetryAfterAt: new Date(pddSessionRunwayNotBefore).toISOString() }
      : {}),
  });
  return true;
}

const handleRuntimeControlResponse = (child, message) => {
  if (message?.type !== 'runtime-control-result' || !message.requestId) return;
  const pending = runtimeControlRequests.get(message.requestId);
  if (!pending || pending.child !== child) return;
  runtimeControlRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.ok) pending.resolve(message);
  else pending.reject(new Error(message.error || '业务页面刷新失败'));
};

const sendRuntimeControl = (payload, timeoutMs = 50_000) => {
  if (!activeChildRunning()) return Promise.reject(new Error('常驻浏览器子进程不可用'));
  const child = activeChild;
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runtimeControlRequests.delete(requestId);
      reject(new Error('业务页面刷新响应超时'));
    }, timeoutMs);
    runtimeControlRequests.set(requestId, { child, resolve, reject, timer });
    child.send({ type: 'runtime-control', requestId, ...payload }, (error) => {
      if (!error) return;
      runtimeControlRequests.delete(requestId);
      clearTimeout(timer);
      reject(error);
    });
  });
};

function startLegacyPlaywright(orderNumber, {
  discoverOnly = false,
  reconcileOnly = false,
  reconcileEffectTypes = [],
  assignmentId = null,
  claimWorkOrderType = null,
  claimScenarioCode = null,
  claimOrdinaryInstanceId = null,
  claimPlatformWorkOrderId = null,
  claimPlatformCaseKey = null,
  claimWorkOrderFirstDiscoveredAt = null,
  excludedPlatformCaseKeys = [],
  excludedOrdinaryCandidates = [],
} = {}) {
  const shopDataDir = path.join(dataRoot, 'shops', shopId);
  const childEnv = {
    ...process.env,
    WORKFLOW_SHOP_ID: shopId,
    WORKFLOW_SHOP_DISPLAY_SLOT: String(shop.displaySlot ?? 0),
    WORKFLOW_DATA_ROOT: dataRoot,
    WORKFLOW_DATA_DIR: shopDataDir,
    WORKFLOW_BROWSER_PROFILE: path.join(shopDataDir, 'browser-profile'),
    WORKFLOW_BROWSER_MODE: browserMode,
    WORKFLOW_FOREGROUND_MODE: slotKind === 'login' || assignmentKind === 'login'
      ? 'manual-only'
      : process.env.WORKFLOW_FOREGROUND_MODE || 'never',
    ...(orderNumber ? { PDD_ORDER_NUMBER: orderNumber } : {}),
    PDD_DISCOVER_ONLY: discoverOnly ? 'true' : 'false',
    PDD_RECONCILE_EXTERNAL_STATE: reconcileOnly ? 'true' : 'false',
    PDD_RECONCILE_EFFECT_TYPES: reconcileEffectTypes.join(','),
    WORKFLOW_DISCOVERY_KEEP_ALIVE: discoverOnly && residentBrowser ? 'true' : 'false',
    WORKFLOW_RESIDENT_COMMAND_MODE: residentBrowser ? 'true' : 'false',
    ...(assignmentId ? { WORKFLOW_ASSIGNMENT_ID: assignmentId } : {}),
    PDD_DISCOVERY_FILE: discoveryFile,
    PDD_RETURN_REFUND_FILE: returnRefundOutputFile,
    RETURN_REFUND_AUTO_APPROVE_ENABLED: returnRefundAutoApproveEnabled ? 'true' : 'false',
    RETURN_REFUND_VISIBLE_STEP_DELAY_MS: process.env.RETURN_REFUND_VISIBLE_STEP_DELAY_MS || '1200',
    PDD_EXCLUDED_PLATFORM_CASE_KEYS: excludedPlatformCaseKeys.join(','),
    PDD_EXCLUDED_ORDINARY_CANDIDATES: JSON.stringify(excludedOrdinaryCandidates),
    PDD_WORK_ORDER_TITLE: shop.workOrderTitle,
    PDD_SCENARIO_CODES: (shop.scenarioCodes || []).join(','),
    ...(orderNumber ? { PDD_WORK_ORDER_TYPE: claimWorkOrderType || shop.workOrderTitle } : {}),
    ...(orderNumber ? { PDD_SCENARIO_CODE: claimScenarioCode || '' } : {}),
    ...(orderNumber && claimOrdinaryInstanceId ? { PDD_ORDINARY_INSTANCE_ID: claimOrdinaryInstanceId } : {}),
    ...(orderNumber && claimPlatformWorkOrderId ? { PDD_PLATFORM_WORK_ORDER_ID: claimPlatformWorkOrderId } : {}),
    ...(orderNumber && claimPlatformCaseKey ? { PDD_PLATFORM_CASE_KEY: claimPlatformCaseKey } : {}),
    ...(orderNumber && claimWorkOrderFirstDiscoveredAt
      ? { PDD_WORK_ORDER_FIRST_DISCOVERED_AT: claimWorkOrderFirstDiscoveredAt } : {}),
    PDD_EXPECTED_SHOP_NAME: shop.expectedShopName,
    PDD_EXPECTED_MALL_ID: shop.expectedMallId || '',
    PDD_EXPECTED_SHOP_NAME_ALIASES: JSON.stringify(
      shop.configuredPddIdentityNames || pddIdentityNameSet(shop.expectedShopName),
    ),
    PDD_DYNAMIC_SHOP_BINDING: dynamicPddShopBinding ? 'true' : 'false',
    PDD_LOGIN_REQUESTED_AT: shop.loginRequestedAt,
    PDD_ACCOUNT: pddAccount,
    PDD_PASSWORD: pddPassword,
    ...(returnRefundPddOnly ? {} : {
      JEOMS_ACCOUNT: omsAccount,
      JEOMS_PASSWORD: omsPassword,
      TMS_ACCOUNT: tmsAccount,
      TMS_PASSWORD: tmsPassword,
      OMS_MODE: omsMode,
    }),
    PDD_LOGIN_MODE: process.env.PDD_LOGIN_MODE || 'manual',
    RETURN_REFUND_SCAN_ONCE: returnRefundScanOnce ? 'true' : 'false',
    RETURN_REFUND_ONLY: returnRefundOnly ? 'true' : 'false',
    WORKFLOW_EXTERNAL_EFFECT_GUARD: orderNumber ? 'true' : 'false',
  };
  if (!orderNumber) delete childEnv.PDD_ORDER_NUMBER;
  const child = spawn(process.execPath, [path.join(root, 'workflow.mjs')], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: false,
  });
  const childStartedAt = Date.now();
  let residentReadySettled = !discoverOnly || !residentBrowser;
  let resolveResidentReady;
  let rejectResidentReady;
  const residentReadyPromise = residentReadySettled
    ? Promise.resolve({ ready: true, immediate: true })
    : new Promise((resolve, reject) => {
      resolveResidentReady = resolve;
      rejectResidentReady = reject;
    });
  let residentReadyTimer = null;
  let residentReadyRemainingMs = residentReadyTimeoutMs;
  let residentReadyCheckedAt = childStartedAt;
  const scheduleResidentReadyTimeoutCheck = () => {
    if (residentReadySettled) return;
    residentReadyTimer = setTimeout(async () => {
      if (residentReadySettled) return;
      const now = Date.now();
      const elapsedMs = now - residentReadyCheckedAt;
      residentReadyCheckedAt = now;
      const progress = await readProgress().catch(() => ({}));
      const progressUpdatedAt = Date.parse(progress.updatedAt || '');
      const currentChildWaitsForHuman = Number.isFinite(progressUpdatedAt)
        && progressUpdatedAt >= childStartedAt
        && (
          ['human-verification-required', 'manual-login-required'].includes(progress.step)
          || ['detected', 'waiting-human', 'verification-required']
            .includes(progress.verificationLocation?.status)
          || ['expired', 'verification-required'].includes(progress.authHealth?.pdd?.status)
        );
      if (!currentChildWaitsForHuman) residentReadyRemainingMs -= elapsedMs;
      if (residentReadyRemainingMs <= 0) {
        residentReadySettled = true;
        rejectResidentReady(new Error(`常驻浏览器未在 ${residentReadyTimeoutMs}ms 内就绪`));
        return;
      }
      scheduleResidentReadyTimeoutCheck();
    }, 500);
    residentReadyTimer.unref?.();
  };
  scheduleResidentReadyTimeoutCheck();
  residentReadyPromise.catch(() => {});
  const childRunToken = crypto.randomUUID();
  childRunTokens.set(child, childRunToken);
  activeChild = child;
  activeChildReadyPromise = residentReadyPromise;
  browserHealthMonitor.attach(child);
  child.on('message', (message) => {
    browserHealthMonitor.record(child, message);
    if (message?.type === 'workflow-resident-ready' && !residentReadySettled) {
      residentWorkflowSourceSha256 = /^[0-9a-f]{64}$/u.test(String(message.sourceSha256 || ''))
        ? message.sourceSha256 : null;
      residentReturnRefundAdapterSha256 = /^[0-9a-f]{64}$/u.test(String(message.returnRefundAdapterSha256 || ''))
        ? message.returnRefundAdapterSha256 : null;
      residentReadySettled = true;
      if (residentReadyTimer) clearTimeout(residentReadyTimer);
      resolveResidentReady({ ready: true, child, message });
    }
    handleWorkflowProgressSnapshot(child, message);
    handleWorkflowCommandResponse(child, message);
    handleRuntimeControlResponse(child, message);
    handleExternalEffectRequest(child, message);
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', async (code, signal) => {
      if (!residentReadySettled) {
        residentReadySettled = true;
        if (residentReadyTimer) clearTimeout(residentReadyTimer);
        rejectResidentReady(new Error(`常驻浏览器在就绪前退出: ${code ?? signal ?? 'unknown'}`));
      }
      const browserHealthFailure = browserHealthFailures.get(child) || null;
      const effectiveCode = normalizeBrowserProcessExitCode({
        code,
        browserHealthFailure,
        disconnectedExitCode: browserDisconnectedExitCode,
      });
      browserHealthMonitor.detach(child);
      rejectWorkflowCommandsForChild(child, new Error('常驻浏览器子进程已退出: ' + (code ?? signal ?? 'unknown')));
      const strandedEffects = [...activeExternalEffects.entries()]
        .filter(([, effect]) => effect.childRunToken === childRunToken);
      for (const [effectId] of strandedEffects) activeExternalEffects.delete(effectId);
      await Promise.allSettled(strandedEffects.map(([effectId, effect]) => repository.completeExternalEffect({
          id: effectId,
          status: 'unknown',
          ordinaryInstanceId: effect.ordinaryInstanceId,
          error: {
            reason: 'browser-child-exited-before-effect-confirmation',
            code: effectiveCode ?? null,
            signal: signal || null,
            browserHealthFailure,
          },
        })));
      if (activeChild === child) {
        activeChild = null;
        residentWorkflowSourceSha256 = null;
        residentReturnRefundAdapterSha256 = null;
        activeChildExitPromise = null;
        activeChildReadyPromise = null;
      }
      resolve({ code: effectiveCode ?? null, signal: signal || null, browserHealthFailure });
      if (effectiveCode === browserDisconnectedExitCode && !stopped) {
        await heartbeat('browser-disconnected', {
          orderNumber: activeClaim?.external_order_number || null,
          recovery: 'immediate-shop-runner-restart',
          browserHealthFailure,
        }).catch(() => {});
        process.exit(browserDisconnectedExitCode);
      }
    });
  });
  activeChildExitPromise = exitPromise;
  return { child, exitPromise, readyPromise: residentReadyPromise };
}

async function startOrReusePlaywright(orderNumber, {
  reconcileOnly = false,
  reconcileEffectTypes = [],
  assignmentId = null,
  claimWorkOrderType = null,
  claimScenarioCode = null,
  claimOrdinaryInstanceId = null,
  claimPlatformWorkOrderId = null,
  claimPlatformCaseKey = null,
  claimWorkOrderFirstDiscoveredAt = null,
} = {}) {
  if (residentBrowser && activeChildRunning()) {
    try {
      const accepted = await sendWorkflowCommand({
        action: 'run-order',
        orderNumber,
        assignmentId,
        workOrderType: claimWorkOrderType,
        scenarioCode: claimScenarioCode,
        ordinaryInstanceId: claimOrdinaryInstanceId,
        platformWorkOrderId: claimPlatformWorkOrderId,
        platformCaseKey: claimPlatformCaseKey,
        workOrderFirstDiscoveredAt: claimWorkOrderFirstDiscoveredAt,
        reconcileOnly,
        reconcileEffectTypes,
        externalEffectGuard: !reconcileOnly,
      });
      return {
        child: activeChild, exitPromise: activeChildExitPromise, reused: true,
        commandRequestId: accepted.requestId,
      };
    } catch (error) {
      console.error('[resident-browser] ' + shopId + ' order reuse failed: ' + error.message);
      if (isResidentCommandDelayError(error) && activeChildRunning()) {
        await heartbeat('resident-command-delayed', {
          commandRequestId: error.requestId || null,
          commandErrorCode: error.code || null,
          browserKeptResident: true,
        }).catch(() => {});
        // The child may still be applying the command. Let the claim loop
        // observe its identity-bound progress instead of recycling the tab.
        return {
          child: activeChild,
          exitPromise: activeChildExitPromise,
          reused: true,
          commandDelayed: true,
          commandRequestId: error.code === 'RESIDENT_COMMAND_APPLY_TIMEOUT' ? error.requestId : null,
          commandErrorCode: error.code,
        };
      }
      await stopActiveChildGracefully();
      if (stopped) {
        return {
          child: null,
          exitPromise: Promise.resolve({ code: 0, signal: stopSignal || 'shutdown' }),
          reused: false,
          stopping: true,
        };
      }
    }
  } else {
    await stopActiveChildGracefully();
  }
  return startLegacyPlaywright(orderNumber, {
    reconcileOnly,
    reconcileEffectTypes,
    assignmentId,
    claimWorkOrderType,
    claimScenarioCode,
    claimOrdinaryInstanceId,
    claimPlatformWorkOrderId,
    claimPlatformCaseKey,
    claimWorkOrderFirstDiscoveredAt,
  });
}

async function handleExternalEffectRequest(child, message) {
  if (message?.type !== 'external-effect-request' || !message.requestId) return;
  const orderNumber = String(message.orderNumber || '').trim();
  const assignmentId = String(message.assignmentId || '').trim();
  const messageIdentity = ordinaryIdentityFromExternalEffectMessage(message);
  const childRunToken = childRunTokens.get(child) || null;
  const respond = (payload) => {
    if (child.connected) child.send({ type: 'external-effect-result', requestId: message.requestId, ...payload });
  };
  try {
    if (child !== activeChild
      || !activeClaim
      || activeClaim.external_order_number !== orderNumber
      || activeClaim.leaseToken !== assignmentId
      || (message.action === 'reserve' && activeLeaseLost)) {
      throw new Error('当前订单没有有效 PostgreSQL 租约，已拒绝外部操作');
    }
    if (!orderNumber || !effectTypes.has(message.effectType)) {
      throw new Error('外部操作参数与当前订单不一致');
    }
    const claimIdentity = ordinaryIdentityForClaim(activeClaim);
    const ordinaryClaim = canonicalScenarioCode(activeClaim.scenario_code) !== 'return-refund';
    if (ordinaryClaim) {
      const claimIdentityError = ordinaryIdentityValidationError(claimIdentity, { requireComplete: true });
      const messageIdentityError = ordinaryIdentityValidationError(messageIdentity, { requireComplete: true });
      if (claimIdentityError || messageIdentityError || !ordinaryIdentitiesMatch(claimIdentity, messageIdentity)) {
        throw new Error(`external-effect ordinary identity mismatch: ${claimIdentityError || messageIdentityError || 'stale browser assignment'}`);
      }
    }
    if (message.action === 'reserve') {
      const ownsLease = await repository.hasValidLease({
        shopId,
        workerId,
        workOrderId: activeClaim.id,
        leaseToken: activeClaim.leaseToken,
      });
      if (!ownsLease) {
        activeLeaseLost = {
          orderNumber,
          workOrderId: activeClaim.id,
          detectedAt: new Date().toISOString(),
          detectedBy: 'external-effect-guard',
        };
        throw new Error('当前订单的 PostgreSQL 租约已失效，已拒绝外部操作');
      }
      const reserved = await repository.reserveExternalEffect({
        shopId,
        workOrderId: activeClaim.id,
        effectType: message.effectType,
        idempotencyKey: message.idempotencyKey,
        requestHash: message.requestHash,
        ordinaryInstanceId: messageIdentity.ordinaryInstanceId,
        platformCaseKey: messageIdentity.platformCaseKey,
      });
      if (reserved.alreadySucceeded) {
        respond({
          ok: true,
          result: {
            guarded: true,
            alreadySucceeded: true,
            effectId: reserved.effect.id,
            status: reserved.effect.status,
            receipt: reserved.effect.receipt || null,
          },
        });
        return;
      }
      if (!reserved.reserved) {
        throw new Error(`外部操作已存在 ${reserved.effect?.status || 'unknown'} 记录，禁止重复执行`);
      }
      activeExternalEffects.set(reserved.effect.id, {
        effectType: message.effectType,
        orderNumber,
        assignmentId,
        ordinaryInstanceId: messageIdentity.ordinaryInstanceId,
        platformWorkOrderId: messageIdentity.platformWorkOrderId,
        platformCaseKey: messageIdentity.platformCaseKey,
        childRunToken,
        reservedAt: new Date().toISOString(),
      });
      if (slotSession) {
        await schedulerRepository.heartbeat({
          slotId,
          leaseToken: slotLeaseToken,
          externalEffectActive: true,
        });
      }
      respond({ ok: true, result: { guarded: true, effectId: reserved.effect.id } });
      return;
    }
    if (message.action === 'complete' && message.effectId) {
      const activeEffect = activeExternalEffects.get(message.effectId);
      if (!activeEffect
        || activeEffect.orderNumber !== orderNumber
        || activeEffect.assignmentId !== assignmentId
        || activeEffect.childRunToken !== childRunToken
        || activeEffect.ordinaryInstanceId !== messageIdentity.ordinaryInstanceId
        || activeEffect.platformWorkOrderId !== messageIdentity.platformWorkOrderId
        || activeEffect.platformCaseKey !== messageIdentity.platformCaseKey) {
        throw new Error('外部操作分配标识不一致，无法确认结果');
      }
      const completed = await repository.completeExternalEffect({
        id: message.effectId,
        status: message.status,
        receipt: message.receipt || null,
        error: message.error || null,
        ordinaryInstanceId: messageIdentity.ordinaryInstanceId,
      });
      if (!completed) throw new Error('外部操作记录已变化，无法确认结果');
      activeExternalEffects.delete(message.effectId);
      if (slotSession) {
        await schedulerRepository.heartbeat({
          slotId,
          leaseToken: slotLeaseToken,
          externalEffectActive: activeExternalEffects.size > 0,
        });
      }
      respond({ ok: true, result: { guarded: true, effectId: completed.id, status: completed.status } });
      return;
    }
    throw new Error('未知的外部操作幂等请求');
  } catch (error) {
    respond({ ok: false, error: error.message });
  }
}

async function stopActiveChildGracefully(timeoutMs = 20_000) {
  const child = activeChild;
  if (!child) return;
  browserHealthMonitor.detach(child);
  if (child.exitCode !== null || child.signalCode) return;
  const waitForExit = (waitMs) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve(true);
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), waitMs);
  });
  if (child.connected) child.send({ type: 'shutdown' });
  else child.kill('SIGTERM');
  let exited = await waitForExit(timeoutMs);
  if (!exited && child.exitCode === null) {
    child.kill('SIGTERM');
    exited = await waitForExit(5000);
  }
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForExit(2000);
  }
}

async function recoverDiscoveryFailure(error) {
  const retryAfterAt = new Date(Date.now() + discoveryRecoveryCooldownMs).toISOString();
  discoveryRetryNotBefore = Date.parse(retryAfterAt);
  // An IPC command that was received but delayed is not a browser failure.
  // Keep the resident context (and its current tab) alive; the command marker
  // above prevents the next turn from enqueueing a duplicate command.
  if (residentBrowser && activeChildRunning() && isResidentCommandDelayError(error)) {
    await heartbeat('resident-command-delayed', {
      commandRequestId: error.requestId || null,
      commandErrorCode: error.code || null,
      browserKeptResident: true,
      retryAfterAt,
    }).catch(() => {});
    return {
      mode: 'discovery',
      status: 'retryable-error',
      shopId,
      error: error.message,
      recovery: 'resident-command-kept-alive',
      retryAfterAt,
      failedAt: new Date().toISOString(),
    };
  }
  if (activeExternalEffects.size > 0) {
    throw new Error(
      `Refusing to recycle the discovery browser while ${activeExternalEffects.size} external effect(s) are active`,
      { cause: error },
    );
  }
  await stopActiveChildGracefully(10_000);
  return {
    mode: 'discovery',
    status: 'retryable-error',
    shopId,
    error: error.message,
    recovery: 'resident-browser-recycled',
    retryAfterAt,
    failedAt: new Date().toISOString(),
  };
}

async function restoreResidentBrowserDuringDiscoveryCooldown() {
  if (!residentBrowser
    || activeChildRunning()
    || Date.now() >= discoveryRetryNotBefore
    || activeExternalEffects.size > 0) return false;
  try {
    startLegacyPlaywright(null, { discoverOnly: true });
    await waitForActiveResidentReady();
    await heartbeat('resident-browser-recovered', {
      discovery: 'cooldown',
      retryAfterAt: new Date(discoveryRetryNotBefore).toISOString(),
    });
  } catch (error) {
    await stopActiveChildGracefully(10_000);
    discoveryRetryNotBefore = Date.now() + discoveryRecoveryCooldownMs;
    await heartbeat('resident-browser-recovery-deferred', {
      discovery: 'retryable-error',
      discoveryError: error.message,
      retryAfterAt: new Date(discoveryRetryNotBefore).toISOString(),
    }).catch(() => {});
  }
  return true;
}

function ensurePreClaimAuthenticationBrowser(authentication) {
  const healthStatus = String(authentication?.health?.status || '').trim().toLowerCase();
  const requiresVisiblePddRecovery = authentication?.system === 'pdd'
    && (authentication?.manualLoginRequired
      || authentication?.humanVerificationRequired
      || healthStatus === 'expired'
      || healthStatus === 'verification-required');
  if (!residentBrowser || !requiresVisiblePddRecovery) return { status: 'not-applicable' };
  if (activeChildRunning()) return { status: 'already-running' };
  if (activeExternalEffects.size > 0) {
    return { status: 'deferred-external-effects', activeExternalEffects: activeExternalEffects.size };
  }
  const now = Date.now();
  if (now < authenticationBrowserLaunchNotBefore) {
    return {
      status: 'cooldown',
      retryAfterAt: new Date(authenticationBrowserLaunchNotBefore).toISOString(),
    };
  }
  authenticationBrowserLaunchNotBefore = now + authenticationBrowserLaunchCooldownMs;
  startLegacyPlaywright(null, { discoverOnly: true });
  // Login and challenge pages intentionally withhold the resident-ready signal
  // until the operator or plugin clears them. Keep the browser alive without
  // waiting here so live-page observation can also clear stale database state.
  return {
    status: 'launched',
    retryAfterAt: new Date(authenticationBrowserLaunchNotBefore).toISOString(),
  };
}

async function ensurePreClaimVerificationBrowser(verification) {
  const verificationId = String(verification?.id || '').trim();
  const workOrderId = String(verification?.work_order_id || '').trim();
  const system = String(verification?.system_name || '').trim().toLowerCase();
  if (!residentBrowser || !verificationId || system !== 'pdd') {
    return { status: 'not-applicable' };
  }
  let browserStarted = false;
  if (!activeChildRunning()) {
    startLegacyPlaywright(null, { discoverOnly: true });
    browserStarted = true;
  }
  const residentReadyHeartbeat = setInterval(() => heartbeat(
    'human-verification-required',
    {
      verificationBrowserStartup: {
        status: 'waiting-resident-ready',
        verificationId,
        workOrderId: workOrderId || null,
      },
    },
  ).catch((error) => {
    console.error(`[worker-heartbeat] ${shopId}: ${error.message}`);
  }), heartbeatIntervalMs);
  try {
    await waitForActiveResidentReady();
  } catch (error) {
    await stopActiveChildGracefully(10_000);
    return { status: 'launch-failed', error: error.message };
  } finally {
    clearInterval(residentReadyHeartbeat);
  }
  // Shop-level discovery/refund challenges do not have a work order yet. The
  // resident startup itself restores the live PDD page and waits for the
  // challenge to clear; sending the work-order recovery command would invent
  // an identity that does not exist. Keep the browser alive and let the fresh
  // runtime observation reconcile the detached verification record.
  if (!workOrderId) {
    return {
      status: 'shop-verification-browser-restored',
      browserStarted,
      verificationId,
      workOrderId: null,
      recovery: 'resident-browser-live-page-reconciliation',
      externalActionsReplayed: false,
    };
  }
  const progress = await readProgress().catch(() => ({}));
  const recovery = progress.verificationRecovery || {};
  const residentCommand = progress.residentCommand || {};
  if (shouldReusePreClaimVerificationRecovery({
    recovery,
    residentCommand,
    progress,
    verificationId,
    workOrderId,
  })) {
    return {
      status: recovery.status || 'active',
      browserStarted,
      requestId: residentCommand.requestId || recovery.requestId || null,
    };
  }
  const recoveryKey = `${verificationId}:${activeChild?.pid || 'no-child'}`;
  const retryCooldownMs = preClaimVerificationRecoveryRetryCooldownMs({
    recovery,
    verificationId,
    workOrderId,
  });
  if (lastPreClaimVerificationBrowserRecovery?.key === recoveryKey
    && Date.now() - lastPreClaimVerificationBrowserRecovery.requestedAt < retryCooldownMs) {
    return {
      status: 'request-pending',
      browserStarted,
      retryAfterAt: new Date(lastPreClaimVerificationBrowserRecovery.requestedAt + retryCooldownMs)
        .toISOString(),
    };
  }
  let accepted;
  const recoveryCommandHeartbeat = setInterval(() => heartbeat(
    'human-verification-required',
    {
      verificationRecoveryCommand: {
        status: 'waiting-resident-command',
        verificationId,
        workOrderId,
        startedAt: new Date().toISOString(),
      },
    },
  ).catch((error) => {
    console.error(`[worker-heartbeat] ${shopId}: ${error.message}`);
  }), heartbeatIntervalMs);
  try {
    accepted = await sendWorkflowCommand({
      action: 'restore-verification',
      verificationId,
      workOrderId,
      orderNumber: verification.order_number || null,
      scenarioCode: verification.scenario_code || null,
      stage: verification.stage,
      url: verification.url,
      detectedAt: verification.detected_at,
      externalEffectGuard: false,
    });
  } catch (error) {
    if (!['RESIDENT_COMMAND_RECEIVE_TIMEOUT', 'RESIDENT_COMMAND_APPLY_TIMEOUT']
      .includes(error?.code)) throw error;
    lastPreClaimVerificationBrowserRecovery = {
      key: recoveryKey,
      requestedAt: Date.now(),
      requestId: error.requestId || null,
    };
    return {
      status: error.code === 'RESIDENT_COMMAND_APPLY_TIMEOUT'
        ? 'request-received-delayed'
        : 'request-retry-deferred',
      browserStarted,
      requestId: error.requestId || null,
      error: error.message,
    };
  } finally {
    clearInterval(recoveryCommandHeartbeat);
  }
  lastPreClaimVerificationBrowserRecovery = {
    key: recoveryKey,
    requestedAt: Date.now(),
    requestId: accepted.requestId,
  };
  return {
    status: 'requested',
    browserStarted,
    requestId: accepted.requestId,
  };
}

function clearActiveClaim() {
  if (leaseTimer) clearInterval(leaseTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  leaseTimer = null;
  heartbeatTimer = null;
  activeClaim = null;
  activeLeaseLost = null;
}

async function readProgress() {
  try { return JSON.parse(await fsp.readFile(progressFile, 'utf8')); } catch { return {}; }
}

async function writeProgressAtomic(progress) {
  await writeTextAtomic(progressFile, `${JSON.stringify(progress, null, 2)}\n`);
}

const verificationGateFingerprint = (verification, progress = {}) => JSON.stringify([
  String(verification.system_name || progress.verificationLocation?.system || 'pdd'),
  String(verification.url || progress.verificationLocation?.url || progress.currentUrl || ''),
  String(progress.verificationLocation?.pageRole || ''),
  String(verification.frame_url || progress.verificationLocation?.frameUrl || ''),
  String(verification.selector || progress.verificationLocation?.selector || ''),
]);

const verificationGateIsLogin = (verification, progress = {}) => {
  const system = String(verification.system_name || '').trim().toLowerCase();
  if (system !== 'pdd') return false;
  return /(?:login|登录)/iu.test([
    verification.stage,
    verification.url,
    progress.step,
    progress.systemLogin?.stage,
  ].filter(Boolean).join(' '));
};

async function persistTimedOutVerificationGateRelease(verification, release, timedOutAt) {
  const current = await readProgress().catch(() => ({}));
  const currentLocation = current.verificationLocation;
  if (currentLocation?.id && String(currentLocation.id) !== String(verification.id)) {
    return { checkpointUpdated: false, reason: 'newer-verification-active' };
  }
  const system = String(verification.system_name || currentLocation?.system || 'pdd').toLowerCase();
  const loginRequired = verificationGateIsLogin(verification, current);
  const authHealth = { ...(current.authHealth || {}) };
  if (!loginRequired && authHealth[system]?.status === 'verification-required') {
    authHealth[system] = {
      ...authHealth[system],
      status: 'unknown',
      stage: null,
      source: 'worker-verification-timeout-release',
      evidence: 'database-gate-expired-plugin-surface-retained',
      checkedAt: timedOutAt,
    };
  }
  const fingerprint = verificationGateFingerprint(verification, current);
  const surface = currentLocation
    ? { ...currentLocation, status: 'plugin-owned-timeout' }
    : {
        id: verification.id,
        system,
        stage: verification.stage || null,
        url: verification.url || null,
        frameUrl: verification.frame_url || null,
        selector: verification.selector || null,
        detectedAt: verification.detected_at || null,
        status: 'plugin-owned-timeout',
      };
  const nextProgress = {
    ...current,
    step: loginRequired ? 'manual-login-required' : 'verification-timeout-closed',
    verificationStage: loginRequired
      ? current.verificationStage || verification.stage || null
      : null,
    verificationLocation: null,
    verificationFocus: loginRequired ? {
      ...(current.verificationFocus || {}),
      status: 'released-timeout',
      stage: verification.stage || current.verificationStage || null,
      ownerShopId: shopId,
      releasedAt: timedOutAt,
      pluginOwned: true,
    } : null,
    verificationRecovery: null,
    verificationTimeout: {
      ...(current.verificationTimeout || {}),
      status: 'closed',
      system,
      stage: verification.stage || null,
      timeoutMs: verificationGateTimeoutMs,
      verificationId: verification.id,
      fingerprint,
      detectedAt: verification.detected_at || null,
      timedOutAt,
      suppressUntil: new Date(
        Date.parse(timedOutAt) + verificationGatePostTimeoutSuppressionMs,
      ).toISOString(),
      releaseReason: 'verification-timeout-release',
      pluginOwned: true,
      surface,
      externalActionsReplayed: false,
    },
    verificationRecheck: {
      ...(current.verificationRecheck || {}),
      trigger: 'verification-timeout-release',
      status: 'closed',
      verificationId: verification.id,
      requestedAt: timedOutAt,
      completedAt: timedOutAt,
      externalActionsReplayed: false,
    },
    authHealth,
    manualReview: null,
    error: null,
    updatedAt: timedOutAt,
  };
  await writeProgressAtomic(nextProgress);
  return {
    checkpointUpdated: true,
    loginRequired,
    step: nextProgress.step,
    verificationId: verification.id,
    requeued: Boolean(release?.requeued),
  };
}

async function expireTimedOutPreClaimVerificationGates({ source } = {}) {
  if (!verificationGateTimeoutReleaseEnabled) return [];
  const releases = [];
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const active = await queryLatestActiveVerification();
    const verification = active.rows[0] || null;
    if (!verification) break;
    const detectedAtMs = Date.parse(String(verification.detected_at || ''));
    const now = Date.now();
    if (!Number.isFinite(detectedAtMs) || now - detectedAtMs < verificationGateTimeoutMs) break;
    const timedOutAt = new Date(now).toISOString();
    const release = await repository.expireTimedOutVerificationGate({
      shopId,
      verificationId: verification.id,
      workOrderId: verification.work_order_id || null,
      detectedAt: verification.detected_at,
      timeoutAt: timedOutAt,
      timeoutMs: verificationGateTimeoutMs,
      nextAttemptAt: new Date(now + 15_000),
    });
    if (!release?.verificationResolved) {
      if (release) releases.push({ ...release, source: source || 'pre-claim' });
      break;
    }
    const checkpoint = await persistTimedOutVerificationGateRelease(
      verification,
      release,
      timedOutAt,
    );
    releases.push({ ...release, ...checkpoint, source: source || 'pre-claim' });
  }
  return releases;
}

const checkpointStateFor = (progress = {}) => JSON.stringify({
  step: progress.step || null,
  verificationId: progress.verificationLocation?.id || null,
  verificationStatus: progress.verificationLocation?.status || null,
});

function withConfirmedPddRemark(progress = {}) {
  const observation = progress.externalStateReconciliation;
  if (observation?.state !== 'confirmed'
    || observation.effectType !== 'pdd-note'
    || !observation.orderNumber) return progress;
  const existing = progress.pddOrderRemark;
  if (existing?.status === 'saved'
    && existing.orderNumber === observation.orderNumber) return progress;
  return {
    ...progress,
    pddOrderRemark: {
      ...existing,
      shopId: progress.shopId || shopId,
      orderNumber: observation.orderNumber,
      text: observation.remarkText || existing?.text || null,
      color: observation.colorLabel || existing?.color || null,
      status: 'saved',
      detailMode: observation.detailMode || 'reconciled',
      alreadySucceeded: true,
      savedAt: observation.observedAt || new Date().toISOString(),
      reconciliationMethod: observation.confirmationMethod || 'read-only-reconciliation',
    },
  };
}

async function hydrateClaimProgress(claim, { clearExternalStateReconciliation = false } = {}) {
  const current = await readProgress();
  if (current.orderNumber) {
    await fsp.mkdir(checkpointBackupDir, { recursive: true, mode: 0o700 });
    const safeOrder = String(current.orderNumber).replace(/[^0-9A-Za-z_-]/g, '_');
    const safeInstance = String(
      current.platformWorkOrderId || current.ordinaryInstanceId || 'legacy',
    ).replace(/[^0-9A-Za-z_-]/g, '_');
    const backup = path.join(checkpointBackupDir, `${safeOrder}-${safeInstance}.json`);
    const temporary = `${backup}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, backup);
  }
  const workOrderPayload = claim.payload && typeof claim.payload === 'object' && !Array.isArray(claim.payload)
    ? claim.payload
    : {};
  const workOrderPayloadIsAuthoritative = Boolean(
    workOrderPayload.mismatchedExistingTmsDecisionRecovery
      || workOrderPayload.mismatchedExistingTmsDecisionRecoveryReapplied
      || workOrderPayload.tmsPostalCarrierAliasRecovery
      || workOrderPayload.interceptProgressFollowupRecovery
      || workOrderPayload.consumerNegotiationFollowupRecovery
      || workOrderPayload.refreshedRequestedOrderAbsenceRecovery,
  );
  const browserCheckpoint = claim.browser_checkpoint
    && typeof claim.browser_checkpoint === 'object'
    && !Array.isArray(claim.browser_checkpoint)
    && progressBelongsToClaim(claim.browser_checkpoint, claim)
    ? claim.browser_checkpoint
    : null;
  const browserCheckpointUpdatedAt = Date.parse(
    browserCheckpoint?.updatedAt || claim.browser_checkpoint_updated_at || '',
  );
  const workOrderPayloadUpdatedAt = Date.parse(workOrderPayload.updatedAt || '');
  const payload = !workOrderPayloadIsAuthoritative && browserCheckpoint
    && Number.isFinite(browserCheckpointUpdatedAt)
    && (!Number.isFinite(workOrderPayloadUpdatedAt)
      || browserCheckpointUpdatedAt >= workOrderPayloadUpdatedAt)
    ? { ...workOrderPayload, ...browserCheckpoint }
    : workOrderPayload;
  const ordinaryIdentity = ordinaryIdentityForClaim(claim);
  const localLogisticsWait = logisticsWaitBelongsToClaim(current, claim)
    && current.residentCommand?.status === 'idle';
  const sameClaim = progressBelongsToClaim(current, claim) || localLogisticsWait;
  const localAssignmentId = String(current.residentCommand?.assignmentId || '').trim() || null;
  const localAssignmentMatchesClaim = !localAssignmentId || localAssignmentId === claim.leaseToken;
  const authoritativeRecoveryPayload = Boolean(
    payload.mismatchedExistingTmsDecisionRecovery
      || payload.mismatchedExistingTmsDecisionRecoveryReapplied
      || payload.tmsPostalCarrierAliasRecovery
      || payload.interceptProgressFollowupRecovery
      || payload.consumerNegotiationFollowupRecovery
      || payload.refreshedRequestedOrderAbsenceRecovery,
  );
  const currentIsNewer = !authoritativeRecoveryPayload && sameClaim && localAssignmentMatchesClaim
    && Date.parse(current.updatedAt || 0) >= Date.parse(payload.updatedAt || 0);
  const businessProgress = currentIsNewer || localLogisticsWait
    ? { ...payload, ...current }
    : { ...payload };
  // The event stream is allowed to emit lightweight snapshots that omit
  // durable operation results. Rehydrate a confirmed TMS record from its
  // instance-owned table so a later retry cannot mistake an existing ticket
  // for a new one and submit it again.
  const persistedTmsWorkOrder = claim.persisted_tms_work_order?.payload
    && typeof claim.persisted_tms_work_order.payload === 'object'
    && !Array.isArray(claim.persisted_tms_work_order.payload)
    ? claim.persisted_tms_work_order.payload
    : null;
  const persistedExternalTicketId = String(
    claim.persisted_tms_work_order?.external_ticket_id || '',
  ).trim();
  const persistedTicketId = String(persistedTmsWorkOrder?.ticketId || '').trim()
    || (/^L/i.test(persistedExternalTicketId) ? '' : persistedExternalTicketId);
  const persistedTicketNo = String(persistedTmsWorkOrder?.ticketNo || '').trim()
    || (/^L/i.test(persistedExternalTicketId) ? persistedExternalTicketId : '');
  const hasTmsWorkOrderField = Object.prototype.hasOwnProperty.call(businessProgress, 'tmsWorkOrder');
  const recoveredTmsWorkOrder = !hasTmsWorkOrderField && persistedTmsWorkOrder
    ? {
        ...persistedTmsWorkOrder,
        orderNumber: persistedTmsWorkOrder.orderNumber || claim.external_order_number,
        shopId: persistedTmsWorkOrder.shopId || shopId,
        status: persistedTmsWorkOrder.status || claim.persisted_tms_work_order.status || 'created',
        ticketId: persistedTicketId || null,
        ticketNo: persistedTicketNo || null,
        createdAt: persistedTmsWorkOrder.createdAt
          || claim.persisted_tms_work_order.created_at
          || new Date().toISOString(),
        recoveredFromDatabaseRecord: true,
        recoveredAt: new Date().toISOString(),
      }
    : null;
  const verifiedDetailUrl = verifiedPddDetailUrlForOrdinaryIdentity(ordinaryIdentity);
  const runtimeFields = {};
  for (const key of ['systemTabs', 'authHealth', 'browserMode', 'workflowDataDir', 'pageCrashRecovery']) {
    if (current[key] !== undefined) runtimeFields[key] = current[key];
  }
  const hydratedAt = new Date().toISOString();
  let hydrated = {
    ...businessProgress,
    ...runtimeFields,
    shopId,
    orderNumber: claim.external_order_number,
    workOrderType: claim.work_order_type || businessProgress.workOrderType || shop.workOrderTitle,
    scenarioCode: claim.scenario_code || businessProgress.scenarioCode || null,
    ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
    platformWorkOrderId: ordinaryIdentity.platformWorkOrderId,
    platformCaseKey: ordinaryIdentity.platformCaseKey,
    workOrderFirstDiscoveredAt: ordinaryFirstDiscoveredAtForClaim(claim)
      || businessProgress.workOrderFirstDiscoveredAt
      || null,
    detailUrl: businessProgress.detailUrl || verifiedDetailUrl || null,
    ...(recoveredTmsWorkOrder ? { tmsWorkOrder: recoveredTmsWorkOrder } : {}),
    targetWorkOrderTitle: shop.workOrderTitle,
    checkpointSource: authoritativeRecoveryPayload ? 'postgres-authoritative-recovery'
      : localLogisticsWait ? 'local-logistics-wait'
      : currentIsNewer ? 'local-current-order' : 'postgres-work-order-payload',
    hydratedAt,
    residentCommand: localLogisticsWait ? current.residentCommand : {
        action: 'run-order',
        assignmentId: claim.leaseToken,
        status: 'pending',
        queuedAt: hydratedAt,
      },
    updatedAt: hydratedAt,
  };
  hydrated = withConfirmedPddRemark(hydrated);
  if (clearExternalStateReconciliation
    && workOrderPayload.externalStateReconciliationTarget?.protectedReadOnly === true) {
    // A newer local browser snapshot may belong to the same old case but
    // predate this guarded recovery. The durable one-attempt limit wins.
    hydrated.externalStateReconciliationTarget =
      workOrderPayload.externalStateReconciliationTarget;
    hydrated.pddResolutionSubmission = workOrderPayload.pddResolutionSubmission;
  }
  if (clearExternalStateReconciliation) delete hydrated.externalStateReconciliation;
  if (workOrderPayload.ordinaryListCompletionReadOnlyRecovery?.protectedReadOnly === true) {
    hydrated.ordinaryListCompletionReadOnlyRecovery = workOrderPayload.ordinaryListCompletionReadOnlyRecovery;
  }
  await writeProgressAtomic(hydrated);
  lastCheckpointHash = crypto.createHash('sha256').update(JSON.stringify(hydrated)).digest('hex');
  lastCheckpointAt = Date.now();
  lastCheckpointState = checkpointStateFor(hydrated);
  return hydrated;
}

async function checkpointActiveClaim(progress, { force = false, claim = activeClaim } = {}) {
  if (!claim || !progress?.orderNumber) return false;
  if (!progressBelongsToClaim(progress, claim)) return false;
  const serialized = JSON.stringify(progress);
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  const checkpointState = checkpointStateFor(progress);
  if (hash === lastCheckpointHash && hash === lastDatabaseCheckpointHash) return false;
  if (!force && checkpointState === lastCheckpointState && Date.now() - lastCheckpointAt < 10_000) return false;
  const checkpointRequest = {
    shopId,
    workOrderId: claim.id,
    leaseToken: claim.leaseToken,
    ordinaryInstanceId: ordinaryIdentityForClaim(claim).ordinaryInstanceId,
    currentStep: progress.step || null,
    payload: progress,
  };
  const saved = await retryPostgresCheckpoint(
    () => repository.checkpointClaimed(checkpointRequest),
    {
      onRetry: ({ attempt, maxAttempts, code, delayMs }) => {
        console.warn(
          `[checkpoint-retry][${shopId}] PostgreSQL ${code}; `
          + `retry ${attempt}/${maxAttempts} after ${delayMs}ms`,
        );
      },
    },
  );
  if (saved) {
    lastCheckpointHash = hash;
    lastDatabaseCheckpointHash = hash;
    lastCheckpointAt = Date.now();
    lastCheckpointState = checkpointState;
  }
  return saved;
}

function logisticsWaitReleaseForClaim(progress, claim, hydratedAtMs) {
  const wait = progress?.logisticsWait;
  if (!logisticsWaitBelongsToClaim(progress, claim)
    || !isDeferredWaitProgress(progress)
    || wait?.orderNumber !== claim.external_order_number) return null;
  if (residentBrowser && progress.residentCommand?.status !== 'idle') return null;
  const progressUpdatedAtMs = Date.parse(progress.updatedAt || '');
  if (!Number.isFinite(progressUpdatedAtMs) || progressUpdatedAtMs <= hydratedAtMs) return null;
  const retryAfterMs = Date.parse(wait.retryAfterAt || '');
  if (Number.isFinite(retryAfterMs) && retryAfterMs <= Date.now()) return null;
  const nextAttemptAt = new Date(Number.isFinite(retryAfterMs)
    ? retryAfterMs
    : Date.now() + discoveryIntervalMs);
  const ordinaryIdentity = ordinaryIdentityForClaim(claim);
  return {
    currentStep: progress.step,
    nextAttemptAt,
    payload: {
      ...progress,
      orderNumber: claim.external_order_number,
      workOrderType: claim.work_order_type || progress.workOrderType || null,
      scenarioCode: claim.scenario_code || progress.scenarioCode || null,
      ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
      platformWorkOrderId: ordinaryIdentity.platformWorkOrderId,
      platformCaseKey: ordinaryIdentity.platformCaseKey,
      logisticsWait: {
        ...wait,
        orderNumber: claim.external_order_number,
        workOrderType: claim.work_order_type || wait.workOrderType || null,
        scenarioCode: claim.scenario_code || wait.scenarioCode || null,
        ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        platformWorkOrderId: ordinaryIdentity.platformWorkOrderId,
        platformCaseKey: ordinaryIdentity.platformCaseKey,
      },
    },
  };
}

async function finishLogisticsWaitClaim(claim, logisticsRelease) {
  const currentStep = isDeferredWaitProgress({ step: logisticsRelease.currentStep })
    ? logisticsRelease.currentStep
    : 'logistics-waiting-released';
  let nextAttemptAt = logisticsRelease.nextAttemptAt;
  let payload = logisticsRelease.payload;
  if (claim.scenario_code === 'abnormal-network-warning'
    && payload.logisticsWait?.waitKind === 'logistics'
    && ['awaiting-pdd-shipment', 'pdd-shipment-rechecked'].includes(
      payload.abnormalNetworkShipmentWait?.status,
    )) {
    // Count only resolved challenges on this exact ordinary instance. If the
    // read fails, keep the existing retry schedule rather than delaying work
    // based on incomplete evidence.
    const recentResolvedVerifications = await repository
      .countRecentResolvedPddVerificationsForWorkOrder({
        shopId,
        workOrderId: claim.id,
        ordinaryInstanceId: ordinaryIdentityForClaim(claim).ordinaryInstanceId,
        stage: 'wait-shipping-analysis',
        since: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      }).catch((error) => {
        console.warn(`[abnormal-unshipped-verification] ${shopId}: ${error.message}`);
        return 0;
      });
    const delayed = abnormalUnshippedVerificationRetryAt({
      scenarioCode: claim.scenario_code,
      waitKind: payload.logisticsWait.waitKind,
      shipmentWaitStatus: payload.abnormalNetworkShipmentWait.status,
      recentResolvedVerifications,
      existingRetryAt: nextAttemptAt.toISOString(),
    });
    if (delayed) {
      nextAttemptAt = delayed;
      payload = {
        ...payload,
        logisticsWait: {
          ...payload.logisticsWait,
          retryAfterAt: delayed.toISOString(),
          verificationBackoff: {
            reason: 'repeated-pdd-verification-while-unshipped',
            recentResolvedVerifications,
            checkedAt: new Date().toISOString(),
          },
        },
      };
    }
  }
  const finished = await repository.finishClaimed({
    shopId,
    workOrderId: claim.id,
    leaseToken: claim.leaseToken,
    ordinaryInstanceId: ordinaryIdentityForClaim(claim).ordinaryInstanceId,
    status: 'retry-ready',
    currentStep,
    nextAttemptAt,
    payload,
  });
  const heartbeatStage = currentStep === 'consumer-response-waiting-released'
    ? (finished ? 'consumer-response-wait-released' : 'consumer-response-wait-lease-lost')
    : (finished ? 'logistics-wait-released' : 'logistics-wait-lease-lost');
  await heartbeat(heartbeatStage, {
    orderNumber: claim.external_order_number,
    workOrderType: claim.work_order_type,
    nextAttemptAt: nextAttemptAt.toISOString(),
  });
  return finished;
}

const completedForOrder = (progress, orderNumber) => Boolean(
  progress.lastCompletedOrder?.orderNumber === orderNumber
  || progress.completionArchive?.orderNumber === orderNumber
  || (progress.pddResolutionSubmission?.status === 'succeeded' && progress.pddResolutionSubmission.orderNumber === orderNumber),
);

const completedForClaim = (progress, claim) => (
  (progressBelongsToClaim(progress, claim) || completedProgressBelongsToClaim(progress, claim))
  && completedForOrder(progress, claim.external_order_number)
);

const retryableBrowserFailure = (progress = {}) => {
  const reason = String(progress.error?.message || progress.error || progress.manualReview?.reason || '');
  return /Chromium context is unavailable|Target page, context or browser has been closed|Target\.createTarget|Failed to open a new tab|browserContext\.(?:newPage|waitForEvent)/i.test(reason)
    ? reason
    : null;
};

const retryableTransientWorkflowFailure = (progress = {}) => {
  const reason = String(progress.error?.message || progress.error || progress.manualReview?.reason || '');
  if (detectBrowserProxyNavigationFailure(reason)) return reason;
  // A proxy/browser can return an HTTP error while reloading a read-only PDD
  // page. It is safe to retry only through the bounded path below because no
  // external submission has started at this point.
  if (/^page\.reload:[\s\S]*net::ERR_HTTP_RESPONSE_CODE_FAILURE/iu.test(reason)) return reason;
  // Derived PDD detail recovery can briefly land on Chrome's error document;
  // keep the order retryable instead of converting this transient navigation
  // miss into a permanent manual pause.
  if (/BROWSER_NAVIGATION_TEMPORARILY_UNAVAILABLE[\s\S]*open-derived-pdd-detail-resume[\s\S]*chrome-error:\/\/chromewebdata/iu.test(reason)) return reason;
  // Windows may hold the diagnostic screenshot for a short time while the
  // TMS page is being replaced. The screenshot is evidence only and has no
  // external side effect, so a bounded retry is safe.
  if (/EBUSY:[\s\S]*tms-logistics-work-orders[\\/]?.*\.png/iu.test(reason)) return reason;
  if (/^pdd 标签页不可用$/u.test(reason)) return reason;
  if (/^locator\.screenshot: Timeout [0-9.]+ms exceeded[\s\S]*taking element screenshot/iu.test(reason)) return reason;
  if (/locator\.innerText: Timeout \d+ms exceeded[\s\S]*waiting for locator\(['"]body['"]\)/iu.test(reason)) return reason;
  if (/RESIDENT_COMMAND_IDENTITY_MISMATCH/u.test(reason)) return reason;
  if (progress.tmsCreatedRowVisibility?.status === 'retry-ready'
    && /TMS_CREATED_ROW_NOT_VISIBLE/u.test(reason)) return reason;
  if (isRetryableCreatedTmsFilterFailure(progress, reason)) return reason;
  if (progress.systemLogin?.system === 'oms'
    && progress.systemLogin?.status === 'retry-ready'
    && /OMS automatic login recovery (?:yielded the shared session|deferred for this shop profile)/u.test(reason)) return reason;
  if (progress.systemLogin?.system === 'tms'
    && progress.systemLogin?.status === 'retry-ready'
    && /TMS automatic login recovery deferred for this shop profile/u.test(reason)) return reason;
  if (/OMS 生成配货单后未确认订单状态已越过配货阶段/u.test(reason)) return reason;
  if (/^(?:OMS 补发页面.*快递责任补发.*|OMS 补发业务类型“快递责任补发”选择后未保持|OMS 补发页面未找到按钮: 下一步)$/u.test(reason)) return reason;
  if (/OMS_QUERY_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  if (/PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  if (/PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  if (/PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  if (/PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  // PDD can briefly render an incomplete status selector after the list
  // reloads. No external action has happened at this point, so keep the
  // claim on the bounded transient retry path instead of leaving it paused.
  if (/PDD_PENDING_LIST_FILTER_UNCONFIRMED|^拼多多工单状态筛选未找到(?:全部|待处理)选项，停止本轮查询$/u.test(reason)) return reason;
  // PDD logistics tabs can remain selected while their panel is still being
  // rendered.  The workflow already performs a bounded in-tab refresh; keep
  // the resulting render miss on the retry queue instead of converting it to
  // a permanent/manual pause.  Match both logistics directions and the
  // older "tab not found after refresh" wording emitted by previous flows.
  if (/^拼多多“(?:发货物流|退货物流)”在刷新后仍未完成渲染$/u.test(reason)) return reason;
  if (/^拼多多刷新并等待 \d+ 毫秒后仍未找到“(?:发货物流|退货物流)”标签/u.test(reason)) return reason;
  if (/^拼多多.*(?:物流|物流标签).*刷新后.*(?:仍未完成渲染|仍未找到)/u.test(reason)) return reason;
  // List discovery can fail before a claim has persisted its current PDD
  // URL.  The error text itself is an explicit PDD render timeout, so it is
  // safe to retry without requiring URL state that does not exist yet.
  if (/^拼多多.*刷新后等待 \d+ 毫秒仍未出现有效结果$/u.test(reason)) return reason;
  // The feedback form is a transient PDD UI surface.  A missing entry,
  // dialog, or confirmation control must be retried through the bounded
  // safe-transient recovery path before the work order is left for review.
  if (/^(?:好人好事工单未找到“反馈”入口|点击反馈后“问题反馈”弹窗未出现|问题反馈弹窗未找到“确认提交”按钮)$/u.test(reason)) {
    return reason;
  }
  if (/TMS_NAVIGATION_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  if (/TMS_TICKET_FILTER_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  if (/OMS_(?:WAREHOUSE|ORDER_STATUS|ANALYSIS)_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  if (/PDD_(?:LOGISTICS_ANALYSIS|DETAIL|ORDER_IDENTITY)_TEMPORARILY_UNAVAILABLE/u.test(reason)) return reason;
  const currentUrl = String(progress.currentUrl || '');
  const omsUrl = String(progress.systemTabs?.oms?.url || '');
  const pddUrl = String(progress.systemTabs?.pdd?.url || '');
  const tmsUrl = String(progress.systemTabs?.tms?.url || '');
  if ([currentUrl, omsUrl].some((url) => url.includes('jeoms.com'))
    && /locator\.(?:click|waitFor): Timeout/u.test(reason)) return reason;
  if ([currentUrl, pddUrl].some((url) => url.includes('mms.pinduoduo.com'))
    && (
      /拼多多工单列表未找到订单号查询框/u.test(reason)
      || /拼多多订单详情未在限定时间内完成渲染/u.test(reason)
      || /拼多多普通工单详情订单号渲染刷新后等待 \d+ 毫秒仍未出现有效结果/u.test(reason)
      || /拼多多普通工单详情恢复(?:列表|查询)渲染刷新后等待 \d+ 毫秒仍未出现有效结果/u.test(reason)
      || /拼多多普通工单第\d+页渲染刷新后等待 \d+ 毫秒仍未出现有效结果/u.test(reason)
      || /拼多多普通工单完结查询渲染刷新后等待 \d+ 毫秒仍未出现有效结果/u.test(reason)
      || /拼多多指定普通工单查询渲染刷新后等待 \d+ 毫秒仍未出现有效结果/u.test(reason)
      || /拼多多[^\r\n]*刷新后等待 \d+ 毫秒仍未出现有效结果/u.test(reason)
      || /普通工单详情订单号不一致: 期望 \d+(?:-\d+)+，实际 未读取到/u.test(reason)
      || /阶段: pdd-resolution-detail-loading[\s\S]*页面仍在加载或内容为空/u.test(reason)
      || /page\.(?:waitForURL|goto|reload): Timeout \d+ms exceeded/u.test(reason)
      || /(?:HTTP|response status)\s*(?:502|503|504)\b/iu.test(reason)
      || /locator\.fill: Timeout[\s\S]*请输入订单编号/u.test(reason)
      || /locator\.innerText: Timeout \d+ms exceeded[\s\S]*(?:订单编号|订单号)/u.test(reason)
      || (/locator\.waitFor: Timeout/u.test(reason)
        && /(?:getByText[\s\S]*(?:订单编号|订单号)|locator\(['"]body['"]\))/u.test(reason))
    )) return reason;
  if ([currentUrl, tmsUrl].some((url) => /tms\./i.test(url))
    && /locator\.waitFor: Timeout[\s\S]*\.filter-panel/u.test(reason)) return reason;
  if (progress.tmsAttachmentTransfer?.status === 'failed'
    && progress.tmsAttachmentTransfer?.orderNumber === progress.orderNumber
    && (
      /page\.waitForResponse: Timeout \d+ms exceeded while waiting for event ["']response["']/u.test(reason)
      || /TMS_ATTACHMENT_UPLOAD_TEMPORARILY_UNAVAILABLE/u.test(reason)
    )) {
    return reason;
  }
  return null;
};

async function reconcileCompletedDatabaseOrder() {
  const progress = await readProgress();
  const completionMarker = progress.lastCompletedOrder || progress.completionArchive || {};
  const orderNumber = completionMarker.orderNumber;
  if (!orderNumber || !completedForOrder(progress, orderNumber)) return false;
  const snapshot = await repository.getQueueSnapshot(shopId);
  if (!snapshot.processing) return false;
  const reconciled = await repository.reconcileCompleted({
    shopId,
    externalOrderNumber: orderNumber,
    ordinaryInstanceId: progress.ordinaryInstanceId || completionMarker.ordinaryInstanceId || null,
    platformCaseKey: progress.platformCaseKey || completionMarker.platformCaseKey || null,
    currentStep: progress.step || 'full-business-flow-complete',
    payload: progress,
  });
  if (reconciled) await heartbeat('reconciled-completed', { orderNumber });
  return reconciled;
}

async function runExternalStateReconciliation(command) {
  const workOrder = await repository.getWorkOrderForReconciliation({
    workOrderId: command.work_order_id,
    shopId,
  });
  if (!workOrder) throw new Error('work-order-not-found');
  const ordinaryIdentity = ordinaryIdentityForClaim(workOrder);
  if (command.current_ordinary_instance_id
    && String(command.current_ordinary_instance_id) !== String(ordinaryIdentity.ordinaryInstanceId || '')) {
    throw new Error('external-state-reconciliation-ordinary-instance-mismatch');
  }
  const reconciliationTarget = workOrder.pdd_submit_reconciliation_target || null;
  const reconciliationClaim = reconciliationTarget
    ? {
        ...workOrder,
        payload: {
          ...(workOrder.payload || {}),
          externalStateReconciliationTarget: reconciliationTarget,
          pddResolutionSubmission: workOrder.payload?.pddResolutionSubmission || {
            shopId,
            orderNumber: workOrder.external_order_number,
            status: 'submitted-unconfirmed',
            submitAttemptCount: Number(reconciliationTarget.submitAttemptCount || 1),
            maximumAutomaticSubmitAttempts: Number(
              reconciliationTarget.maximumAutomaticSubmitAttempts || 2
            ),
            effectId: reconciliationTarget.effectId,
            idempotencyKey: reconciliationTarget.idempotencyKey,
          },
        },
      }
    : workOrder;
  await hydrateClaimProgress(reconciliationClaim, { clearExternalStateReconciliation: true });
  await heartbeat('external-state-reconciling', {
    orderNumber: workOrder.external_order_number,
    workOrderId: workOrder.id,
  });
  const reconciliationHeartbeatTimer = setInterval(() => heartbeat('external-state-reconciling', {
    orderNumber: workOrder.external_order_number,
    workOrderId: workOrder.id,
  }).catch((error) => console.error(`[worker-heartbeat] ${shopId}: ${error.message}`)), heartbeatIntervalMs);
  let result;
  let progress;
  // Hydration writes the last durable snapshot before the resident command starts.
  // Do not checkpoint that same snapshot back as if it came from this reconciliation.
  try {
    let checkpointedProgressAt = (await readProgress()).updatedAt || null;
    const reconciliationStartedAtMs = Date.parse(checkpointedProgressAt || '') || Date.now();
    const run = await startOrReusePlaywright(workOrder.external_order_number, {
      reconcileOnly: true,
      reconcileEffectTypes: workOrder.payload?.ordinaryListCompletionReadOnlyRecovery?.protectedReadOnly === true
        ? ['pdd-list-completion-proof'] : workOrder.unknown_effect_types || [],
      claimWorkOrderType: workOrder.work_order_type,
      claimScenarioCode: workOrder.scenario_code,
      claimOrdinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
      claimPlatformWorkOrderId: ordinaryIdentity.platformWorkOrderId,
      claimPlatformCaseKey: ordinaryIdentity.platformCaseKey,
      claimWorkOrderFirstDiscoveredAt: ordinaryFirstDiscoveredAtForClaim(workOrder),
    });
    if (run.commandErrorCode === 'RESIDENT_COMMAND_BUSY_TIMEOUT') {
      throw new Error('external-state-reconciliation-command-not-started:resident-browser-busy');
    }
    while (!result) {
      progress = await readProgress();
      const progressMatchesInstance = progressBelongsToClaim(progress, workOrder);
      if (progressMatchesInstance
        && progress.updatedAt
        && progress.updatedAt !== checkpointedProgressAt) {
        await repository.checkpointExternalStateReconciliation({
          workOrderId: workOrder.id,
          shopId,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
          currentStep: progress.step || 'external-state-reconciling',
          payload: progress,
        });
        checkpointedProgressAt = progress.updatedAt;
      }
      if (progressMatchesInstance && progress.externalStateReconciliation?.state) {
        if (residentBrowser) {
          result = { code: 0, signal: 'reconciliation-observed' };
        } else {
          await stopActiveChildGracefully(5000);
          result = await Promise.race([
            run.exitPromise,
            new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'reconciliation-observed' }), 1000)),
          ]);
        }
        break;
      }
      const terminalOutcome = residentBrowser && progressMatchesInstance
        ? residentReconciliationTerminalOutcome({
            progress, commandRequestId: run.commandRequestId,
            startedAtMs: reconciliationStartedAtMs, reused: run.reused === true,
          })
        : null;
      if (terminalOutcome) {
        if (terminalOutcome === 'verification-required') {
          const error = new Error('HumanVerificationRequired: 拼多多只读回查遇到人工验证');
          error.code = 'HUMAN_VERIFICATION_REQUIRED';
          throw error;
        }
        result = { code: 1, signal: `reconciliation-command-${terminalOutcome}` };
        break;
      }
      result = await Promise.race([
        run.exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
    }
  } finally {
    clearInterval(reconciliationHeartbeatTimer);
  }
  progress ||= await readProgress();
  if (!progressBelongsToClaim(progress, workOrder)) {
    throw new Error('external-state-reconciliation-stale-browser-progress');
  }
  const observation = progress.externalStateReconciliation;
  if (!observation?.state) {
    const progressError = typeof progress.error === 'string'
      ? progress.error
      : progress.error?.message;
    throw new Error(progressError
      || `external-state-reconciliation-failed:${result.code ?? result.signal ?? 'unknown'}`);
  }
  const updated = await repository.completeExternalStateReconciliation({
    workOrderId: workOrder.id,
    shopId,
    ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
    observation,
    payload: progress,
  });
  if (!updated) throw new Error('work-order-not-found');
  await heartbeat(observation.state === 'confirmed'
    ? 'external-state-confirmed'
    : observation.state === 'not-applied'
      ? 'external-state-not-applied'
      : 'external-state-unresolved', {
    orderNumber: workOrder.external_order_number,
    workOrderId: workOrder.id,
    confirmationMethod: observation.confirmationMethod || null,
  });
  return observation;
}

async function validateIdleCommandOrdinaryIdentity(command) {
  if (!command.work_order_id) return null;
  const result = await pool.query(`
    SELECT work_order.id, work_order.scenario_code, work_order.current_ordinary_instance_id,
      instance.platform_case_id AS platform_work_order_id, instance.platform_case_key
    FROM work_orders work_order
    LEFT JOIN ordinary_work_order_instances instance
      ON instance.id = work_order.current_ordinary_instance_id
    WHERE work_order.id = $1::uuid AND work_order.shop_id = $2`, [command.work_order_id, shopId]);
  if (!result.rowCount) throw new Error('command work order is missing or belongs to another shop');
  const workOrder = result.rows[0];
  if (canonicalScenarioCode(workOrder.scenario_code) === 'return-refund') return null;
  const expectedIdentity = ordinaryIdentityForClaim(workOrder);
  if (!expectedIdentity.ordinaryInstanceId) {
    throw new Error('current ordinary work order has no instance identity');
  }
  const expectedIdentityError = ordinaryIdentityValidationError(expectedIdentity);
  const commandIdentityError = commandIdentityValidationError(command, expectedIdentity);
  if (expectedIdentityError || commandIdentityError) {
    throw new Error(`operator-command ordinary identity mismatch: ${expectedIdentityError || commandIdentityError}`);
  }
  return expectedIdentity;
}

async function applyIdleCommand(command) {
  const reason = String(command.payload?.reason || '').trim() || `operator command: ${command.command_type}`;
  try {
    if (command.command_type === 'reset-pdd-login') {
      const reset = await sendRuntimeControl({ action: 'reset-pdd-login' }, 90_000);
      currentPddIdentityBindingToken = null;
      currentPddIdentityValidatedAt = 0;
      currentPddIdentityConflict = null;
      lastSynchronizedPddIdentity = null;
      await repository.acknowledgeCommand({
        commandId: command.id,
        result: {
          applied: true,
          system: 'pdd',
          status: 'login-required',
          url: reset.url || null,
          workerId,
        },
      });
      await heartbeat('pdd-login-reset-completed', {
        authenticationSystem: 'pdd',
        authenticationStatus: 'expired',
        reason,
      });
      return true;
    }
    if (command.command_type === 'focus-system-login') {
      const system = String(command.payload?.system || '').trim().toLowerCase();
      if (!['oms', 'tms'].includes(system)) throw new Error(`不支持的系统登录入口: ${system || 'unknown'}`);
      const focused = await sendRuntimeControl({ action: 'focus-system-login', system }, 60_000);
      await repository.acknowledgeCommand({
        commandId: command.id,
        result: { applied: true, system, url: focused.url || null, workerId },
      });
      await heartbeat('manual-login-focused', {
        authenticationSystem: system,
        authenticationStatus: focused.authenticationStatus || null,
      });
      return true;
    }
    if (command.command_type === 'pause-shop' || command.command_type === 'resume-shop') {
      const paused = command.command_type === 'pause-shop';
      await repository.setShopOperatorPaused({ shopId, paused, workerId });
      await repository.acknowledgeCommand({
        commandId: command.id,
        result: { applied: true, shopPaused: paused, workerId },
      });
      await heartbeat(paused ? 'operator-paused' : 'operator-resumed');
      return true;
    }
    const transitions = {
      'manual-complete': ['archived', 'operator-manual-complete'],
      'skip-order': ['paused', 'operator-skipped'],
      'refresh-next-order': ['paused', 'operator-refreshed-next-order'],
      'retry-stage': ['retry-ready', 'operator-retry-requested'],
      'resume-auto': ['retry-ready', 'operator-resume-requested'],
      'verification-recheck': ['retry-ready', 'verification-recheck-requested'],
    };
    const transition = transitions[command.command_type];
    if (!transition || !command.work_order_id) throw new Error('命令缺少可处理的工单');
    await validateIdleCommandOrdinaryIdentity(command);
    const changed = await repository.transitionWorkOrderByCommand({
      workOrderId: command.work_order_id,
      shopId,
      ordinaryInstanceId: command.ordinary_instance_id || null,
      status: transition[0],
      currentStep: transition[1],
      reason: transition[0] === 'paused' ? reason : null,
    });
    if (!changed) throw new Error('工单正在处理或状态已变化，未执行命令');
    await repository.acknowledgeCommand({
      commandId: command.id,
      result: { applied: true, workOrderId: command.work_order_id, status: transition[0], workerId },
    });
    return true;
  } catch (error) {
    await repository.acknowledgeCommand({
      commandId: command.id,
      status: 'failed',
      result: { applied: false, error: error.message, workerId },
    }).catch(() => {});
    return false;
  }
}

async function handoffActiveClaim({
  claim,
  progress,
  reason,
  command = null,
  retryOnStart = false,
  refreshPage = false,
}) {
  const effectWaitDeadline = Date.now() + 30_000;
  while (activeEffectsForClaim(claim).length > 0
    && Date.now() < effectWaitDeadline
    && activeChildRunning()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const remainingClaimEffects = activeEffectsForClaim(claim);
  let refreshResult = { status: refreshPage ? 'not-attempted' : 'not-requested' };
  if (refreshPage && remainingClaimEffects.length === 0) {
    try {
      const refreshed = await sendRuntimeControl({ action: 'refresh-active-page' });
      refreshResult = {
        status: 'refreshed',
        system: refreshed.system || null,
        previousUrl: refreshed.previousUrl || null,
        url: refreshed.url || null,
        refreshedAt: refreshed.refreshedAt || new Date().toISOString(),
      };
    } catch (error) {
      refreshResult = { status: 'failed', error: error.message, failedAt: new Date().toISOString() };
    }
  } else if (refreshPage) {
    refreshResult = {
      status: 'skipped-active-external-effect',
      activeEffects: remainingClaimEffects.map(([, effect]) => effect),
      skippedAt: new Date().toISOString(),
    };
  }

  await stopActiveChildGracefully();
  const observedProgress = await readProgress();
  const latestProgress = progressBelongsToClaim(observedProgress, claim) ? observedProgress : {};
  const currentStep = retryOnStart ? 'system-shutdown-drained' : 'operator-refreshed-next-order';
  const handoffProgress = {
    ...progress,
    ...latestProgress,
    step: currentStep,
    runtimeStatus: retryOnStart ? 'retry-ready' : 'paused',
    verificationStage: null,
    verificationLocation: null,
    manualReview: retryOnStart ? null : {
      required: true,
      stage: currentStep,
      reason,
    },
    operatorHandoff: {
      commandId: command?.id || null,
      commandType: command?.command_type || (retryOnStart ? 'system-shutdown' : 'refresh-next-order'),
      reason,
      refresh: refreshResult,
      requestedAt: command?.requested_at || null,
      completedAt: new Date().toISOString(),
    },
    loopState: {
      ...(latestProgress.loopState || progress.loopState || {}),
      status: retryOnStart ? 'shutdown-drained' : 'operator-handoff',
      currentOrderNumber: null,
      nextPollAt: null,
    },
    error: null,
  };
  await writeProgressAtomic(handoffProgress);
  const handedOff = await repository.handoffClaimed({
    shopId,
    workOrderId: claim.id,
    leaseToken: claim.leaseToken,
    ordinaryInstanceId: ordinaryIdentityForClaim(claim).ordinaryInstanceId,
    currentStep,
    payload: handoffProgress,
    reason,
    retryOnStart,
  });
  if (!handedOff) throw new Error('工单租约已失效，无法切换到下一单');
  deferDiscoveryForOperatorCommand();
  await heartbeat(retryOnStart ? 'shutdown-drained' : 'operator-next-order', {
    orderNumber: claim.external_order_number,
    workOrderId: claim.id,
    status: handedOff.status,
    unknownExternalEffects: handedOff.unknownExternalEffects,
    refreshStatus: refreshResult.status,
  });
  return { ...handedOff, refresh: refreshResult };
}

async function applyActiveCommand(command, claim, progress) {
  const shopCommand = ['pause-shop', 'resume-shop', 'focus-system-login', 'reset-pdd-login'].includes(command.command_type);
  if (!shopCommand && String(command.work_order_id || '') !== String(claim.id || '')) {
    await repository.acknowledgeCommand({
      commandId: command.id,
      status: 'failed',
      result: { applied: false, error: '命令工单与当前处理工单不一致', workerId },
    });
    return { stop: false };
  }
  if (!shopCommand && canonicalScenarioCode(claim.scenario_code) !== 'return-refund') {
    const claimIdentity = ordinaryIdentityForClaim(claim);
    const claimIdentityError = !claimIdentity.ordinaryInstanceId
      ? 'current ordinary work order has no instance identity'
      : ordinaryIdentityValidationError(claimIdentity);
    const commandIdentityError = commandIdentityValidationError(command, claimIdentity);
    if (claimIdentityError || commandIdentityError) {
      await repository.acknowledgeCommand({
        commandId: command.id,
        status: 'failed',
        result: {
          applied: false,
          error: `operator-command ordinary identity mismatch: ${claimIdentityError || commandIdentityError}`,
          workerId,
        },
      });
      return { stop: false };
    }
  }
  if (command.command_type === 'reset-pdd-login') {
    await applyIdleCommand(command);
    return { stop: false };
  }
  if (command.command_type === 'focus-system-login') {
    const system = String(command.payload?.system || '').trim().toLowerCase();
    try {
      if (!['oms', 'tms'].includes(system)) throw new Error(`不支持的系统登录入口: ${system || 'unknown'}`);
      const focused = await sendRuntimeControl({ action: 'focus-system-login', system }, 60_000);
      await repository.acknowledgeCommand({
        commandId: command.id,
        result: { applied: true, system, url: focused.url || null, workerId },
      });
      await heartbeat('manual-login-focused', {
        authenticationSystem: system,
        authenticationStatus: focused.authenticationStatus || null,
      });
    } catch (error) {
      await repository.acknowledgeCommand({
        commandId: command.id,
        status: 'failed',
        result: { applied: false, system, error: error.message, workerId },
      }).catch(() => {});
    }
    return { stop: false };
  }
  if (command.command_type === 'verification-recheck') {
    const resolved = progress.step !== 'human-verification-required'
      && progress.step !== 'manual-login-required';
    await repository.acknowledgeCommand({
      commandId: command.id,
      result: { applied: true, resolved, observedStep: progress.step || null, workerId },
    });
    return { stop: false };
  }
  if (command.command_type === 'refresh-next-order') {
    const reason = String(command.payload?.reason || '').trim() || '所有者要求刷新当前页面并处理下一单';
    const handedOff = await handoffActiveClaim({
      claim,
      progress,
      reason,
      command,
      refreshPage: true,
    });
    await repository.acknowledgeCommand({
      commandId: command.id,
      result: {
        applied: true,
        workOrderId: claim.id,
        status: handedOff.status,
        unknownExternalEffects: handedOff.unknownExternalEffects,
        refresh: handedOff.refresh,
        workerId,
      },
    });
    return { stop: true };
  }
  if (command.command_type === 'force-clear-verification'
    && progress.step !== 'human-verification-required') {
    await repository.acknowledgeCommand({
      commandId: command.id,
      status: 'failed',
      result: {
        applied: false,
        error: `当前阶段不是等待验证码: ${progress.step || 'unknown'}`,
        workerId,
      },
    });
    return { stop: false };
  }
  if (command.command_type === 'force-clear-verification' && activeEffectsForClaim(claim).length > 0) {
    throw new Error('当前存在正在执行的外部操作，禁止强制解除验证');
  }
  const reason = String(command.payload?.reason || '').trim() || `operator command: ${command.command_type}`;
  const outcomes = {
    'pause-shop': ['paused', 'operator-paused'],
    'manual-complete': ['archived', 'operator-manual-complete'],
    'skip-order': ['paused', 'operator-skipped'],
    'retry-stage': ['retry-ready', 'operator-retry-requested'],
    'resume-auto': ['retry-ready', 'operator-resume-requested'],
    'force-clear-verification': ['retry-ready', 'operator-verification-force-cleared'],
  };
  if (command.command_type === 'resume-shop') {
    await repository.setShopOperatorPaused({ shopId, paused: false, workerId });
    await repository.acknowledgeCommand({ commandId: command.id, result: { applied: true, shopPaused: false, workerId } });
    return { stop: false };
  }
  const outcome = outcomes[command.command_type];
  if (!outcome) {
    await repository.acknowledgeCommand({ commandId: command.id, status: 'failed', result: { applied: false, error: '不支持的命令', workerId } });
    return { stop: false };
  }
  await stopActiveChildGracefully();
  const latestProgress = await readProgress();
  const clearsVerification = command.command_type === 'force-clear-verification'
    || (['retry-stage', 'resume-auto'].includes(command.command_type)
      && latestProgress.step === 'human-verification-required');
  const nextProgress = withConfirmedPddRemark({
    ...latestProgress,
    step: outcome[1],
    runtimeStatus: outcome[0],
    ...(clearsVerification ? {
      verificationStage: null,
      verificationLocation: null,
      verificationRecovery: null,
      verificationRecheck: {
        trigger: command.command_type === 'force-clear-verification' ? 'owner-force-clear' : 'owner-retry',
        status: 'cleared',
        requestedAt: command.requested_at || null,
        completedAt: new Date().toISOString(),
      },
      manualReview: null,
      error: null,
    } : {}),
    operatorCommand: { id: command.id, type: command.command_type, reason },
    updatedAt: new Date().toISOString(),
  });
  await writeProgressAtomic(nextProgress);
  const finished = await repository.finishClaimed({
    shopId,
    workOrderId: claim.id,
    leaseToken: claim.leaseToken,
    ordinaryInstanceId: ordinaryIdentityForClaim(claim).ordinaryInstanceId,
    status: outcome[0],
    currentStep: outcome[1],
    payload: nextProgress,
    error: outcome[0] === 'paused' ? new Error(reason) : null,
    nextAttemptAt: outcome[0] === 'retry-ready' ? new Date() : null,
  });
  if (!finished) throw new Error('工单租约已失效，未应用命令');
  deferDiscoveryForOperatorCommand();
  if (command.command_type === 'pause-shop') {
    await repository.setShopOperatorPaused({ shopId, paused: true, workerId });
  }
  await repository.acknowledgeCommand({
    commandId: command.id,
    result: { applied: true, workOrderId: claim.id, status: outcome[0], workerId },
  });
  return { stop: true };
}

async function processOne() {
  await refreshReturnRefundRuntimeSettings();
  // Reconcile stale verification rows before the authentication gate. A
  // completed work order or a row written against the wrong system must not
  // prevent the worker from reaching the normal discovery/refund loop.
  const misboundVerificationRecovery = await repository.resolveMisboundVerificationLocations({ shopId })
    .catch((error) => {
      console.error(`[verification-reconciliation][${shopId}] ${error.message}`);
      return [];
    });
  const terminalWorkOrderVerificationRecovery = await repository.resolveTerminalWorkOrderVerifications({ shopId })
    .catch((error) => {
      console.error(`[terminal-verification-reconciliation][${shopId}] ${error.message}`);
      return [];
    });
  const terminalReturnRefundVerificationRecovery = await repository.resolveTerminalReturnRefundVerifications({ shopId })
    .catch((error) => {
      console.error(`[terminal-return-refund-reconciliation][${shopId}] ${error.message}`);
      return [];
    });
  // A completed CAPTCHA can be persisted before the resident command or
  // worker heartbeat reaches the requeue path. Reconcile that exact
  // resolved-with-no-active-gate state before authentication and claiming so
  // the shop does not remain idle on a stale verification step.
  const resolvedVerificationWorkOrderRecovery = await repository
    .requeueResolvedVerificationWorkOrders({ shopId })
    .catch((error) => {
      console.error(`[resolved-verification-reconciliation][${shopId}] ${error.message}`);
      return [];
    });
  const readOnlyReconciliationVerificationRecovery = verificationGateTimeoutReleaseEnabled
    ? await repository
      .resolveReadOnlyReconciliationVerificationGates({
        shopId,
        minimumAgeMs: verificationGateTimeoutMs,
      })
      .catch((error) => {
        console.error(`[read-only-reconciliation-verification][${shopId}] ${error.message}`);
        return [];
      })
    : [];
  if (readOnlyReconciliationVerificationRecovery.length) {
    await heartbeat('verification-timeout-released-read-only-reconciliation', {
      releases: readOnlyReconciliationVerificationRecovery,
      externalActionsReplayed: false,
    });
  }
  if (resolvedVerificationWorkOrderRecovery.length) {
    await heartbeat('resolved-verification-work-orders-requeued', {
      workOrders: resolvedVerificationWorkOrderRecovery,
      externalActionsReplayed: false,
    });
  }
  const timedOutVerificationGateRecovery = await expireTimedOutPreClaimVerificationGates({
    source: 'before-authentication-gate',
  }).catch((error) => {
    console.error(`[verification-timeout-release][${shopId}] ${error.message}`);
    return [];
  });
  const releasedTimedOutVerificationGates = timedOutVerificationGateRecovery
    .filter((release) => release.verificationResolved);
  if (releasedTimedOutVerificationGates.length) {
    await heartbeat('verification-timeout-released-before-authentication', {
      releases: releasedTimedOutVerificationGates.map((release) => ({
        verificationId: release.verificationId,
        workOrderId: release.workOrderId || null,
        requeued: Boolean(release.requeued),
        checkpointUpdated: Boolean(release.checkpointUpdated),
        loginRequired: Boolean(release.loginRequired),
        pluginSurfaceRetained: true,
      })),
      externalActionsReplayed: false,
    });
  }
  const progressBeforeAuthentication = await readProgress().catch(() => ({}));
  // PDD is the only universal pre-claim dependency. OMS/TMS authentication is
  // validated immediately before a scenario uses it, so one expired OMS
  // profile must not stop PDD discovery or return/refund work for the shop.
  const authentication = workflowAuthenticationState(progressBeforeAuthentication, {
    requiredSystems: ['pdd'],
  });
  if (authentication.blocked) {
    const preAuthenticationVerification = await queryLatestActiveVerification();
    const verification = preAuthenticationVerification.rows[0] || null;
    if (authentication.system === 'pdd'
      && (authentication.humanVerificationRequired
        || authentication.health.status === 'verification-required')
      && verification
      && String(verification.system_name || '').trim().toLowerCase() === 'pdd') {
      const verificationBrowserRecovery = await ensurePreClaimVerificationBrowser(verification);
      // A challenge can be detected by the resident observer after the
      // previous claim's lease has expired.  This branch returns before
      // observeOnboardingProgress(), so release the stale claim here as well;
      // otherwise the shop remains in `processing` and no new work can be
      // claimed while the operator is completing the challenge.
      const authenticationLeaseRecovery = !activeClaim
        ? await repository.releaseExpiredOwnedClaimForAuthenticationBlock({
          shopId,
          workerId,
          system: authentication.system,
          observedStatus: 'human-verification-required',
        })
        : null;
      await heartbeat('human-verification-required', {
        preAuthenticationVerificationGate: {
          verificationId: verification.id,
          workOrderId: verification.work_order_id,
          system: verification.system_name,
          stage: verification.stage,
          detectedAt: verification.detected_at,
        },
        verificationBrowserRecovery,
        ...(authenticationLeaseRecovery?.released ? { authenticationLeaseRecovery } : {}),
        recoveryBeforeAuthenticationGate: true,
        ...(timedOutVerificationGateRecovery.length
          ? { timedOutVerificationGateRecovery }
          : {}),
        externalActionsReplayed: false,
      });
      return false;
    }
    ensurePreClaimAuthenticationBrowser(authentication);
    await observeOnboardingProgress();
    return false;
  }
  if (!await ensureDynamicPddShopBindingReady()) return false;
  if (misboundVerificationRecovery.length
    || terminalWorkOrderVerificationRecovery.length
    || terminalReturnRefundVerificationRecovery.length) {
    await heartbeat('verification-reconciled-before-authentication', {
      misboundVerifications: misboundVerificationRecovery.map((verification) => ({
        verificationId: verification.id,
        workOrderId: verification.work_order_id,
        systemName: verification.system_name,
        stage: verification.stage,
        url: verification.url,
        resolvedAt: verification.resolved_at,
      })),
      terminalWorkOrderVerifications: terminalWorkOrderVerificationRecovery.map((verification) => ({
        verificationId: verification.id,
        workOrderId: verification.work_order_id,
        stage: verification.stage,
        detectedAt: verification.detected_at,
        resolvedAt: verification.resolved_at,
      })),
      resolvedVerifications: terminalReturnRefundVerificationRecovery.map((verification) => ({
        verificationId: verification.id,
        workOrderId: verification.work_order_id,
        stage: verification.stage,
        detectedAt: verification.detected_at,
        resolvedAt: verification.resolved_at,
      })),
      externalActionsReplayed: false,
    });
  }
  const preClaimVerificationRecovery = await recoverDetachedClearedReturnRefundVerification();
  let activeVerification = await queryLatestActiveVerification();
  let stalePreClaimVerificationRecovery = null;
  let staleBoundPreClaimVerificationRecovery = null;
  if (activeVerification.rowCount) {
    const observedProgress = await readProgress().catch(() => ({}));
    const restoredPreClaimVerificationRecovery = await resolveRestoredPreClaimVerification(
      activeVerification.rows[0],
      observedProgress,
    );
    if (restoredPreClaimVerificationRecovery?.verificationResolved) {
      await heartbeat('pre-claim-pdd-verification-browser-recovered', {
        restoredPreClaimVerificationRecovery,
        externalActionsReplayed: false,
      });
      activeVerification = await queryLatestActiveVerification();
    }
  }
  if (activeVerification.rowCount) {
    const observedProgress = await readProgress().catch(() => ({}));
    const staleGate = classifyStalePreClaimVerificationGate({
      persistedVerification: activeVerification.rows[0],
      progress: observedProgress,
    });
    if (staleGate) {
      try {
        stalePreClaimVerificationRecovery =
          await repository.resolveStaleDetachedPddVerificationGate({
            shopId,
            ...staleGate,
          });
      } catch (error) {
        console.error(`[pre-claim-verification-recovery][${shopId}] ${error.message}`);
        stalePreClaimVerificationRecovery = { error: error.message };
      }
      if (stalePreClaimVerificationRecovery?.verificationResolved) {
        await heartbeat('stale-detached-pdd-verification-reconciled', {
          stalePreClaimVerificationRecovery,
          externalActionsReplayed: false,
        });
        activeVerification = await queryLatestActiveVerification();
      }
    }
  }
  if (activeVerification.rowCount) {
    const observedProgress = await readProgress().catch(() => ({}));
    const staleBoundGate = classifyStaleBoundPreClaimVerificationGate({
      persistedVerification: activeVerification.rows[0],
      progress: observedProgress,
    });
    if (staleBoundGate) {
      try {
        staleBoundPreClaimVerificationRecovery =
          await repository.resolveStaleBoundPddVerificationGate({
            shopId,
            ...staleBoundGate,
          });
        if (!staleBoundPreClaimVerificationRecovery?.verificationResolved
          && currentPddIdentityBindingToken) {
          staleBoundPreClaimVerificationRecovery =
            await repository.resolveStaleBoundOrdinaryPddVerificationGate({
              shopId,
              identityBindingToken: currentPddIdentityBindingToken,
              ...staleBoundGate,
            });
        }
      } catch (error) {
        console.error(`[pre-claim-bound-verification-recovery][${shopId}] ${error.message}`);
        staleBoundPreClaimVerificationRecovery = { error: error.message };
      }
      if (staleBoundPreClaimVerificationRecovery?.verificationResolved) {
        await heartbeat('stale-bound-pdd-verification-reconciled', {
          staleBoundPreClaimVerificationRecovery,
          externalActionsReplayed: false,
        });
        activeVerification = await queryLatestActiveVerification();
      }
    }
  }
  if (activeVerification.rowCount) {
    const verification = activeVerification.rows[0];
    const verificationBrowserRecovery = await ensurePreClaimVerificationBrowser(verification);
    await heartbeat('human-verification-required', {
      preClaimVerificationGate: {
        verificationId: verification.id,
        workOrderId: verification.work_order_id || null,
        system: verification.system_name,
        stage: verification.stage,
        detectedAt: verification.detected_at,
      },
      verificationBrowserRecovery,
      ...(preClaimVerificationRecovery
        ? { detachedVerificationRecovery: preClaimVerificationRecovery }
        : {}),
      ...(stalePreClaimVerificationRecovery
        ? { stalePreClaimVerificationRecovery }
        : {}),
      ...(staleBoundPreClaimVerificationRecovery
        ? { staleBoundPreClaimVerificationRecovery }
        : {}),
      ...(terminalReturnRefundVerificationRecovery.length
        ? { terminalReturnRefundVerificationRecovery }
        : {}),
    });
    return false;
  }
  await hydrateReturnRefundScanCursor();
  const recoveredMisboundPddEvidencePauses = returnRefundOnly || directRefundExecutionSession
    || !currentPddIdentityBindingToken
    || !currentPddIdentityMetadata.actualShopName
    ? []
    : await repository.recoverSafeMisboundPddEvidencePauses({
      shopId,
      identityBindingToken: currentPddIdentityBindingToken,
      actualShopName: currentPddIdentityMetadata.actualShopName,
      mallId: currentPddIdentityMetadata.mallId || null,
    });
  if (recoveredMisboundPddEvidencePauses.length) {
    await heartbeat('misbound-pdd-evidence-read-only-reconciliation-recovered', {
      orders: recoveredMisboundPddEvidencePauses.map((item) => item.external_order_number),
      previousShopIds: [...new Set(
        recoveredMisboundPddEvidencePauses.map((item) => item.previous_shop_id),
      )],
      strategy: 'exact-identity-relocation-then-read-only-pdd-detail',
      externalActionsReplayed: false,
    });
  }
  if (persistentSlotSession && assignmentKind === 'verification') {
    await transitionPersistentSlot('business', 'ordinary');
    await heartbeat('verification-cleared-business-resumed');
  }
  if (dynamicPddShopBinding) {
    const released = await repository.releaseOwnedLeaseForIdentityBinding({
      shopId,
      workerId,
      identityBindingToken: currentPddIdentityBindingToken,
    });
    if (released.released) {
      startupLeaseRecoveryPending = false;
      await heartbeat('stale-shop-lease-released', released);
    }
  }
  if (returnRefundScanOnce) {
    if (returnRefundScanOnceCompleted) return false;
    try {
      if (!returnRefundConfiguredForShop()) {
        await heartbeat('return-refund-scan-once-skipped', { reason: 'shop-not-enabled' });
        return false;
      }
      await heartbeat('return-refund-scan-once-starting', {
        dependencies: ['pdd', 'dashboard'],
        autoApproveEnabled: false,
        validation: Boolean(returnRefundValidationDetailUrl),
      });
      if (returnRefundValidationDetailUrl) await runReturnRefundValidation();
      else await runReturnRefundScan();
      return true;
    } finally {
      returnRefundScanOnceCompleted = true;
    }
  }
  if (!returnRefundOnly && !directRefundExecutionSession) await reconcileCompletedDatabaseOrder();
  const transientRecoveryProgress = returnRefundOnly || directRefundExecutionSession
    ? {}
    : await readProgress().catch(() => progressBeforeAuthentication);
  const authenticatedSystems = ['pdd', 'oms', 'tms'].filter(
    (system) => transientRecoveryProgress.authHealth?.[system]?.status === 'authenticated',
  );
  const recoveredSafeTransientPauses = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverSafeTransientOrdinaryPauses({
      shopId,
      authenticatedSystems,
      maxTransientAttempts: maxTransientWorkflowRecoveryAttempts,
    });
  if (recoveredSafeTransientPauses.length) {
    await heartbeat('ordinary-safe-transient-pause-recovered', {
      orders: recoveredSafeTransientPauses.map((item) => item.external_order_number),
      strategies: [...new Set(recoveredSafeTransientPauses.map((item) => item.strategy))],
      authenticatedSystems,
      externalActionsReplayed: false,
    });
  }
  const recoveredRemarkFailures = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverSafePddRemarkFailures({ shopId });
  if (recoveredRemarkFailures.length) {
    await heartbeat('pdd-order-remark-auto-recovered', {
      orders: recoveredRemarkFailures.map((item) => item.external_order_number),
    });
  }
  const recoveredPddDetailPauses = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverSafePddDetailPauses({
      shopId,
      pddAuthenticated: authenticatedSystems.includes('pdd'),
    });
  if (recoveredPddDetailPauses.length) {
    await heartbeat('ordinary-safe-pdd-detail-auto-recovered', {
      orders: recoveredPddDetailPauses.map((item) => item.external_order_number),
      strategy: 'fresh-exact-order-query',
    });
  }
  const recoveredPostResultFollowups = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverProactiveLogisticsPostResultFollowups({ shopId });
  if (recoveredPostResultFollowups.length) {
    await heartbeat('ordinary-post-result-followup-auto-recovered', {
      orders: recoveredPostResultFollowups.map((item) => item.external_order_number),
      strategy: 'resume-separately-guarded-followup-no-result-resubmit',
    });
  }
  const recoveredTerminalOmsManualAllocationPauses = returnRefundOnly || directRefundExecutionSession
    || !currentPddIdentityBindingToken
    ? []
    : await repository.recoverTerminalOmsManualAllocationPauses({
      shopId,
      identityBindingToken: currentPddIdentityBindingToken,
    });
  if (recoveredTerminalOmsManualAllocationPauses.length) {
    await heartbeat('terminal-oms-manual-allocation-auto-recovered', {
      orders: recoveredTerminalOmsManualAllocationPauses.map((item) => item.external_order_number),
      strategy: 'skip-impossible-manual-allocation-and-report-terminal-order',
    });
  }
  const recoveredConsumerNegotiationFollowups = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverConsumerNegotiationFollowups({ shopId });
  if (recoveredConsumerNegotiationFollowups.length) {
    await heartbeat('consumer-negotiation-followup-auto-recovered', {
      orders: recoveredConsumerNegotiationFollowups.map((item) => item.external_order_number),
      strategy: 'resume-pdd-followup-without-oms-or-tms-replay',
    });
  }
  const recoveredUnconfirmedSubmissions = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverSafeUnconfirmedPddSubmissions({
      shopId,
      pddAuthenticated: authenticatedSystems.includes('pdd'),
    });
  if (recoveredUnconfirmedSubmissions.length) {
    await heartbeat('unconfirmed-pdd-submit-reconciliation-recovered', {
      orders: recoveredUnconfirmedSubmissions.map((item) => item.external_order_number),
      strategy: 'read-only-pdd-state-reconciliation-no-resubmit',
    });
  }
  const orphanedReservedEffects = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverOrphanedReservedExternalEffects({ shopId });
  if (orphanedReservedEffects.length) {
    await heartbeat('orphaned-reserved-effects-recovered', {
      orders: [...new Set(orphanedReservedEffects.map((item) => item.externalOrderNumber))],
      effectTypes: [...new Set(orphanedReservedEffects.map((item) => item.effectType))],
      strategy: 'read-only-reconciliation-no-resubmit',
    });
  }
  const orphanedProcessingClaims = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverOrphanedProcessingClaims({
      shopId,
      minimumAgeMs: 5 * 60_000,
    }).catch((error) => {
      console.error(`[orphaned-processing-recovery][${shopId}] ${error.message}`);
      return [];
    });
  const orphanedRefundClaims = await repository.recoverOrphanedReturnRefundClaims({
    shopId,
    identityBindingToken: currentPddIdentityBindingToken,
  });
  if (orphanedRefundClaims.length) {
    await heartbeat('orphaned-return-refund-claims-recovered', {
      orders: orphanedRefundClaims.map((item) => item.externalOrderNumber),
      externalActionsReplayed: false,
    });
  }
  if (orphanedProcessingClaims.length) {
    await heartbeat('orphaned-processing-claims-recovered', {
      orders: orphanedProcessingClaims.map((item) => item.externalOrderNumber),
      strategies: [...new Set(orphanedProcessingClaims.map((item) => (
        item.unresolvedExternalEffects
          ? 'read-only-reconciliation-no-resubmit'
          : 'retry-ready-without-external-effects'
      )))],
      externalActionsReplayed: false,
    });
  }
  const staleExternalStateReconciliations = returnRefundOnly || directRefundExecutionSession
    ? []
    : await repository.recoverStaleExternalStateReconciliations({
      shopId,
      minimumAgeMs: 10 * 60_000,
    }).catch((error) => {
      console.error(`[stale-external-reconciliation-recovery][${shopId}] ${error.message}`);
      return [];
    });
  if (staleExternalStateReconciliations.length) {
    await heartbeat('stale-external-state-reconciliation-released', {
      orders: staleExternalStateReconciliations.map((item) => item.externalOrderNumber),
      strategy: 'read-only-reconciliation-no-resubmit',
      externalActionsReplayed: false,
    });
  }
  const idleCommand = await repository.claimPendingCommand({ shopId, workerId });
  if (idleCommand) {
    await applyIdleCommand(idleCommand);
    return true;
  }
  if (!returnRefundOnly && await repository.isShopOperatorPaused(shopId)) {
    await heartbeat('operator-paused');
    return false;
  }
  // A resident Chromium process can stay alive briefly after its PDD anchor
  // tab closes. Let the browser health monitor recover it before taking more
  // orders, instead of turning every queued refund into a page error.
  if (Date.now() < Math.max(pddTabUnavailableNotBefore, pddSessionRunwayNotBefore)) return false;
  // After a resolved CAPTCHA, give this shop five minutes before opening
  // another order. Verification and lease reconciliation run above;
  // an in-flight claim finishes before this next claim boundary. Other shops
  // continue normally. Persisted history survives a worker restart.
  if (!activeClaim && !(await hasRecoverableStartupLease())
    && await shouldCoolDownPddAfterVerification()) return false;
  const ordinaryScenarioCodes = shop.scenarioCodes
    .map((scenarioCode) => canonicalScenarioCode(scenarioCode))
    .filter((scenarioCode) => scenarioCode && scenarioCode !== 'return-refund');
  const claimEligibleOrdinary = () => repository.claimNext({
    shopId,
    workerId,
    leaseSeconds,
    recoverOwnedLease: startupLeaseRecoveryPending,
    scenarioCodes: ordinaryScenarioCodes,
    identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
  });
  const heartbeatOrdinaryQueueState = async (metadata = {}, eligibility = null) => {
    const ordinaryEligibility = eligibility || await repository.getOrdinaryQueueEligibility({
      shopId,
      identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      scenarioCodes: ordinaryScenarioCodes,
    });
    const queue = await repository.getQueueSnapshot(shopId);
    const state = ordinaryEligibility.active_claim > 0 || ordinaryEligibility.claimable > 0
      ? 'queue-claim-blocked'
      : ordinaryEligibility.identity_blocked > 0
        ? 'queue-identity-blocked'
        : queue.scheduled > 0
          ? 'queue-waiting'
          : queue.held > 0
            ? 'queue-recovery-held'
            : 'queue-empty';
    await heartbeat(state, {
      queue,
      ordinaryEligibility,
      ...metadata,
    });
  };
  const processExternalStateReconciliation = async () => {
    const staleReconciliations = await repository.recoverStaleExternalStateReconciliations({
      shopId,
      minimumAgeMs: 10 * 60_000,
    });
    if (staleReconciliations.length) {
      await heartbeat('stale-external-state-reconciliation-released', {
        orders: staleReconciliations.map((item) => item.externalOrderNumber),
        strategy: 'read-only-reconciliation-no-resubmit',
        externalActionsReplayed: false,
      });
    }
    const reconciliation = await repository.claimNextExternalStateReconciliation({
      shopId,
      retryAfterMs: externalStateRetryMs,
      retryWindowMs: externalStateRetryWindowMs,
      maxAttempts: externalStateMaxAttempts,
    });
    if (!reconciliation) return false;
    processedClaimsSinceExternalStateReconciliationCheck = 0;
    try {
      await runExternalStateReconciliation({
        work_order_id: reconciliation.id,
        current_ordinary_instance_id: reconciliation.current_ordinary_instance_id || null,
      });
    } catch (error) {
      const latestProgress = await readProgress().catch(() => ({}));
      const verificationRequired = error?.code === 'HUMAN_VERIFICATION_REQUIRED'
        || latestProgress.step === 'human-verification-required'
        || /(?:HumanVerificationRequired|检测到人工验证|需要人工验证)/iu.test(
          String(error?.message || error || ''),
        );
      if (verificationRequired) {
        await repository.deferExternalStateReconciliationForVerification({
          workOrderId: reconciliation.id,
          shopId,
          ordinaryInstanceId: reconciliation.current_ordinary_instance_id || null,
          reason: error?.message || '拼多多只读回查遇到人工验证',
        });
        await heartbeat('external-state-reconciliation-verification-required', {
          orderNumber: reconciliation.external_order_number,
          workOrderId: reconciliation.id,
          retryAfterMs: externalStateRetryMs,
        });
        return true;
      }
      await repository.failExternalStateReconciliation({
        workOrderId: reconciliation.id,
        shopId,
        ordinaryInstanceId: reconciliation.current_ordinary_instance_id || null,
        error,
      });
      await heartbeat('external-state-reconciliation-failed', {
        orderNumber: reconciliation.external_order_number,
        workOrderId: reconciliation.id,
        error: error.message,
      });
    }
    return true;
  };
  const externalStateReconciliationAllowed = !returnRefundOnly
    && !directRefundExecutionSession
    && assignmentKind !== 'verification';
  const externalStateReconciliationDue = () => (
    !externalStateReconciliationCheckedSinceStartup
    || processedClaimsSinceExternalStateReconciliationCheck >= externalStateFairnessClaims
  );
  const processDueExternalStateReconciliation = async () => {
    const ordinaryEligibility = await repository.getOrdinaryQueueEligibility({
      shopId,
      identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      scenarioCodes: ordinaryScenarioCodes,
    });
    if (ordinaryEligibility.active_claim > 0) return false;
    const processed = await processExternalStateReconciliation();
    externalStateReconciliationCheckedSinceStartup = true;
    processedClaimsSinceExternalStateReconciliationCheck = 0;
    return processed;
  };
  if (externalStateReconciliationAllowed
    && !startupLeaseRecoveryPending
    && externalStateReconciliationDue()
    && await processDueExternalStateReconciliation()) {
    return true;
  }
  if (!startupLeaseRecoveryPending) {
    try { if (await collectDueChatCase({ requestedOnly: true })) return true; }
    catch (error) { console.error(`[requested-chat-collection][${shopId}] ${error.message}`); }
  }
  let claim = null;
  // New refunds are absent from the durable claim queue until the list is
  // visited. An unfinished scan must therefore receive its own bounded
  // opportunity; draining existing ordinary/refund claims cannot finish it.
  if (mixedBusinessSlotSession
    && !boundedSlotSession
    && !persistentSlotSession
    && !returnRefundOnly
    && !directRefundExecutionSession
    && !startupLeaseRecoveryPending
    && !activeClaim
    && shouldResumePartialReturnRefundScan({
      configured: returnRefundConfiguredForShop(),
      scanDue: returnRefundScanDueNow(),
      cursor: returnRefundCycleCursor,
      lastBatchAt: lastReturnRefundScanAt,
    })) {
    const scanRuntime = await pool.query(`
      SELECT status = 'idle' AND lease_token IS NULL
        AND current_work_order_id IS NULL AS idle
      FROM shop_runtime_state WHERE shop_id = $1
    `, [shopId]);
    if (scanRuntime.rows[0]?.idle === true) {
      try {
        await runReturnRefundScan();
        returnRefundDirectClaimsSinceScan = 0;
        return true;
      } catch (error) {
        await deferReturnRefundScanAfterFailure(error);
        return false;
      }
    }
  }
  // Draining ordinary work applies to starting a new refund scan, not to
  // starving refunds already in the durable queue. Offer one known refund
  // after the configured ordinary batch or ten minutes of ordinary retries.
  // The repository retains identity, due-time and uncertain-effect guards.
  if (mixedBusinessSlotSession
    && !boundedSlotSession
    && !returnRefundOnly
    && !directRefundExecutionSession
    && !startupLeaseRecoveryPending
    && returnRefundConfiguredForShop()
    && (ordinaryOpportunitySinceRefundTurn
      || Date.now() - lastKnownRefundOpportunityAt >= 10 * 60_000)) {
    lastKnownRefundOpportunityAt = Date.now();
    claim = await repository.claimNext({
      shopId,
      workerId,
      leaseSeconds,
      recoverOwnedLease: false,
      scenarioCodes: ['return-refund'],
      identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
    });
    if (claim) returnRefundDirectClaimsSinceScan += 1;
  }
  if (mixedBusinessSlotSession
    && !claim
    && !returnRefundOnly
    && !directRefundExecutionSession
    && !startupLeaseRecoveryPending
    && !ordinaryOpportunitySinceRefundTurn) {
    claim = await claimEligibleOrdinary();
  }
  if (mixedBusinessSlotSession
    && !claim
    && drainOrdinaryQueueBeforeRefund
    && !returnRefundOnly
    && !directRefundExecutionSession
    && !startupLeaseRecoveryPending
    && ordinaryOpportunitySinceRefundTurn) {
    // After the known-refund opportunity, prefer queued ordinary work over
    // starting a new refund browser scan.
    claim = await claimEligibleOrdinary();
  }
  if (mixedBusinessSlotSession
    && !claim
    && !persistentSlotSession
    && !returnRefundOnly
    && !directRefundExecutionSession
    && !startupLeaseRecoveryPending) {
    const refundScanDue = returnRefundScanDueNow();
    const scanBeforeDirectClaim = shouldPrioritizeReturnRefundScan({
      configured: returnRefundConfiguredForShop(),
      scanDue: refundScanDue,
      boundedSession: boundedSlotSession,
      assignmentKind,
      directClaimsSinceScan: returnRefundDirectClaimsSinceScan,
      directClaimsBeforeScan: returnRefundDirectClaimsBeforeScan,
      lastSuccessfulScanAt: lastReturnRefundScanAt,
      forceIntervalMs: returnRefundScanForceIntervalMs,
    });
    if (scanBeforeDirectClaim) {
      try {
        await runReturnRefundScan();
        returnRefundDirectClaimsSinceScan = 0;
      } catch (error) {
        await deferReturnRefundScanAfterFailure(error);
      }
    }
    claim = await repository.claimNext({
      shopId,
      workerId,
      leaseSeconds,
      recoverOwnedLease: false,
      scenarioCodes: ['return-refund'],
      identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      unresolvedEffectsOnly: true,
    });
    if (claim) returnRefundDirectClaimsSinceScan += 1;
  }
  if (!claim
    && mixedBusinessSlotSession
    && !persistentSlotSession
    && !returnRefundOnly
    && !startupLeaseRecoveryPending
    && ordinaryOpportunitySinceRefundTurn) {
    const refundScanDue = returnRefundScanDueNow();
    const scanBeforeDirectClaim = shouldPrioritizeReturnRefundScan({
      configured: returnRefundConfiguredForShop(),
      scanDue: refundScanDue,
      boundedSession: boundedSlotSession,
      assignmentKind,
      directClaimsSinceScan: returnRefundDirectClaimsSinceScan,
      directClaimsBeforeScan: returnRefundDirectClaimsBeforeScan,
      lastSuccessfulScanAt: lastReturnRefundScanAt,
      forceIntervalMs: returnRefundScanForceIntervalMs,
    });
    if (scanBeforeDirectClaim) {
      try {
        await runReturnRefundScan();
        returnRefundDirectClaimsSinceScan = 0;
      } catch (error) {
        await deferReturnRefundScanAfterFailure(error);
      }
    }
    claim = await repository.claimNext({
      shopId,
      workerId,
      leaseSeconds,
      recoverOwnedLease: false,
      scenarioCodes: ['return-refund'],
      identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
    });
    if (claim) returnRefundDirectClaimsSinceScan += 1;
    if (!claim && returnRefundConfiguredForShop() && refundScanDue && !scanBeforeDirectClaim) {
      try {
        await runReturnRefundScan();
        returnRefundDirectClaimsSinceScan = 0;
      } catch (error) {
        await deferReturnRefundScanAfterFailure(error);
      }
      claim = await repository.claimNext({
        shopId,
        workerId,
        leaseSeconds,
        recoverOwnedLease: false,
        scenarioCodes: ['return-refund'],
        identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      });
      if (claim) returnRefundDirectClaimsSinceScan += 1;
    }
    ordinaryOpportunitySinceRefundTurn = false;
  }
  if (!claim) {
    claim = returnRefundOnly || directRefundExecutionSession
      ? await repository.claimNext({
        shopId,
        workerId,
        leaseSeconds,
        recoverOwnedLease: startupLeaseRecoveryPending,
        scenarioCodes: ['return-refund'],
        allowOperatorPaused: returnRefundOnly,
        identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      })
      : await claimEligibleOrdinary();
  }
  if (claim && !returnRefundOnly && !directRefundExecutionSession) {
    processedClaimsSinceExternalStateReconciliationCheck += 1;
  }
  const completedStartupLeaseRecoveryAttempt = startupLeaseRecoveryPending;
  startupLeaseRecoveryPending = false;
  if (!claim
    && completedStartupLeaseRecoveryAttempt
    && externalStateReconciliationAllowed
    && externalStateReconciliationDue()
    && await processDueExternalStateReconciliation()) {
    return true;
  }
  if (!claim && returnRefundConfiguredForShop()) {
    claim = await repository.claimHeldReturnRefundReadOnly({
      shopId,
      workerId,
      leaseSeconds,
      identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
    });
  }
  if (!claim) {
    // Chat-analysis collection is independent of the refund-only execution
    // path.  Run it while the shop has no active claim so requested chat cases
    // can be collected even when the resident worker is dedicated to refunds.
    try { if (await collectDueChatCase()) return false; }
    catch { /* Chat collection must never stop refund/ordinary processing. */ }
    if (returnRefundOnly || directRefundExecutionSession) {
      const queue = await repository.getQueueSnapshot(shopId);
      const state = queue.scheduled > 0
        ? 'return-refund-queue-waiting'
        : queue.held > 0
          ? 'return-refund-queue-recovery-held'
          : 'return-refund-queue-empty';
      await heartbeat(state, {
        queue,
        dependencies: ['pdd', 'dashboard'],
        autoApproveEnabled: returnRefundAutoApproveEnabled,
        assignmentKind: assignmentKind || null,
      });
      return false;
    }
    const ordinaryEligibility = await repository.getOrdinaryQueueEligibility({
      shopId,
      identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      scenarioCodes: ordinaryScenarioCodes,
    });
    if (ordinaryEligibility.active_claim > 0) {
      await heartbeatOrdinaryQueueState({
        discovery: 'deferred-until-active-lease-expires',
        activeClaimExpiresAt: ordinaryEligibility.active_claim_expires_at || null,
      }, ordinaryEligibility);
      return false;
    }
    if (ordinaryEligibility.claimable > 0) {
      await heartbeatOrdinaryQueueState({
        discovery: 'deferred-until-claim-block-clears',
      }, ordinaryEligibility);
      return false;
    }
    if (await processExternalStateReconciliation()) return true;
    if (Date.now() < operatorCommandGraceUntil) {
      await heartbeatOrdinaryQueueState({
        discovery: 'operator-command-grace',
        commandGraceUntil: new Date(operatorCommandGraceUntil).toISOString(),
      });
      return false;
    }
    if (await restoreResidentBrowserDuringDiscoveryCooldown()) return false;
    // Cloud inference runs independently in the API service.
    let discoveryStatus = 'throttled';
    if (Date.now() >= discoveryRetryNotBefore
      && (!activeChild || Date.now() - lastDiscoveryAt >= discoveryIntervalMs)) {
      lastDiscoveryAt = Date.now();
      const excludedPlatformCaseKeys = await listDiscoveryExcludedPlatformCaseKeys();
      const excludedOrdinaryCandidates = await listDiscoveryExcludedOrdinaryCandidates();
      let discovery;
      try {
        discovery = await discoverPendingOrder(
          excludedPlatformCaseKeys,
          excludedOrdinaryCandidates,
        );
      } catch (error) {
        discovery = await recoverDiscoveryFailure(error);
      }
      discoveryStatus = discovery?.status || 'none';
      const discoveryRetryAt = discovery?.retryAfterAt || null;
      if (slotSession) {
        await schedulerRepository.recordOrdinaryScan({
          shopId,
          leaseToken: slotLeaseToken,
          outcome: discoveryStatus,
          retryAt: discoveryRetryAt,
        });
      }
      if (['verification-required', 'login-required', 'rate-limited', 'retryable-error']
        .includes(discoveryStatus)) {
        const parsedRetryAt = Date.parse(discoveryRetryAt || '');
        const retryAt = Number.isFinite(parsedRetryAt)
          ? parsedRetryAt
          : Date.now() + (discoveryStatus === 'retryable-error'
            ? discoveryRecoveryCooldownMs
            : 10 * 60_000);
        lastDiscoveryAt = Math.max(lastDiscoveryAt, retryAt - discoveryIntervalMs);
        if (discoveryStatus === 'retryable-error') discoveryRetryNotBefore = retryAt;
      } else {
        discoveryRetryNotBefore = 0;
      }
      if (discovery?.status === 'discovered' && discovery.orderNumber) {
        let queued;
        try {
          queued = await repository.enqueueDiscovered({
            shopId,
            externalOrderNumber: discovery.orderNumber,
            workOrderType: discovery.workOrderType || shop.workOrderTitle,
            scenarioCode: canonicalScenarioCode(discovery.scenarioCode || 'in-transit-refund'),
            platformWorkOrderId: discovery.platformWorkOrderId || null,
            platformCaseKey: discovery.platformCaseKey || null,
            payload: {
              detailUrl: discovery.detailUrl || null,
              platformWorkOrderId: discovery.platformWorkOrderId || null,
              platformCaseKey: discovery.platformCaseKey || null,
              ordinaryIdentityStatus: discovery.identityStatus || null,
              workOrderCreatedAt: discovery.workOrderCreatedAt || null,
              detectedShopName: currentPddIdentityMetadata.actualShopName || null,
              shopNameSnapshot: currentPddIdentityMetadata.actualShopName || null,
              pddMallId: currentPddIdentityMetadata.mallId || null,
              pddIdentityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
            },
          });
        } catch (error) {
          const rejectedDiscoveryCodes = new Set([
            'PDD_PLATFORM_CASE_IDENTITY_INVALID',
            'PDD_CROSS_SHOP_IDENTITY_UNVERIFIED',
            'PDD_CROSS_SHOP_REDISCOVERY_UNSAFE',
          ]);
          if (!rejectedDiscoveryCodes.has(error?.code)) throw error;
          await heartbeat('pdd-discovery-identity-rejected', {
            orderNumber: discovery.orderNumber,
            platformCaseKey: discovery.platformCaseKey || null,
            detailUrl: discovery.detailUrl || null,
            code: error.code,
            error: error.message,
            recovery: error.code === 'PDD_PLATFORM_CASE_IDENTITY_INVALID'
              ? 'invalid-discovery-row-skipped'
              : 'cross-shop-rediscovery-held',
          });
          ordinaryOpportunitySinceRefundTurn = true;
          return true;
        }
        await heartbeat('pdd-discovered', {
          orderNumber: discovery.orderNumber,
          inserted: queued.inserted,
          excludedPlatformCaseCount: excludedPlatformCaseKeys.length,
          excludedOrdinaryCandidateCount: excludedOrdinaryCandidates.length,
          platformCaseKey: discovery.platformCaseKey || null,
        });
        // A successful discovery proves the pending list has more useful work.
        // After this order finishes, scan again immediately so a visible
        // backlog is not drained at one order per discovery interval. An empty
        // or failed scan still keeps the normal cooldown above.
        lastDiscoveryAt = 0;
        // The discovered row is already durable and claimable. Keep this cycle
        // on ordinary work so it is processed immediately instead of yielding
        // to a refund turn and another poll delay.
        ordinaryOpportunitySinceRefundTurn = false;
      }
      if (['verification-required', 'login-required', 'rate-limited', 'retryable-error']
        .includes(discoveryStatus)) {
        await heartbeatOrdinaryQueueState({
          discovery: discoveryStatus,
          discoveryError: discovery?.error || null,
          retryAfterAt: discovery?.retryAfterAt || null,
        });
        if (discoveryStatus !== 'retryable-error') return false;
      }
    }
    // A browser scan can run long enough for a scheduled ordinary retry to
    // become due. Recheck the database before falling through to refund work.
    claim = await claimEligibleOrdinary();
    const refundScanDue = boundedSlotSession
      ? assignmentKind === 'refund-scan'
      : returnRefundScanDueNow();
    const scanBeforeDirectClaim = shouldPrioritizeReturnRefundScan({
      configured: returnRefundConfiguredForShop(),
      scanDue: refundScanDue,
      boundedSession: boundedSlotSession,
      assignmentKind,
      directClaimsSinceScan: returnRefundDirectClaimsSinceScan,
      directClaimsBeforeScan: returnRefundDirectClaimsBeforeScan,
      lastSuccessfulScanAt: lastReturnRefundScanAt,
      forceIntervalMs: returnRefundScanForceIntervalMs,
    });
    if (!claim && !scanBeforeDirectClaim) {
      claim = await repository.claimNext({
        shopId,
        workerId,
        leaseSeconds,
        recoverOwnedLease: startupLeaseRecoveryPending,
        scenarioCodes: ['return-refund'],
        identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
      });
      if (claim) returnRefundDirectClaimsSinceScan += 1;
    }
    if (!claim && returnRefundConfiguredForShop() && refundScanDue) {
      try {
        await runReturnRefundScan();
        returnRefundDirectClaimsSinceScan = 0;
      } catch (error) {
        await deferReturnRefundScanAfterFailure(error);
      }
      // The refund scan itself can also cross an ordinary retry deadline.
      claim = await claimEligibleOrdinary();
      if (!claim) {
        claim = await repository.claimNext({
          shopId,
          workerId,
          leaseSeconds,
          recoverOwnedLease: startupLeaseRecoveryPending,
          scenarioCodes: ['return-refund'],
          identityBindingToken: dynamicPddShopBinding ? currentPddIdentityBindingToken : null,
        });
        if (claim) returnRefundDirectClaimsSinceScan += 1;
      }
    }
    if (claim) {
      startupLeaseRecoveryPending = false;
    } else {
      await heartbeatOrdinaryQueueState({ discovery: discoveryStatus });
      return false;
    }
  }
  lastProcessedScenarioCode = canonicalScenarioCode(claim.scenario_code);
  // Claims can come from the pre-discovery refund turn, ordinary queue, or
  // post-discovery refund fallback. Resident shops process a short ordinary
  // batch before yielding to refund work; any refund claim resets that batch.
  if (lastProcessedScenarioCode === 'return-refund') {
    lastKnownRefundOpportunityAt = Date.now();
    ordinaryClaimsSinceRefundTurn = 0;
    ordinaryOpportunitySinceRefundTurn = false;
  } else {
    ordinaryClaimsSinceRefundTurn += 1;
    ordinaryOpportunitySinceRefundTurn = ordinaryClaimsSinceRefundTurn >= ordinaryClaimsBeforeRefund;
  }
  activeClaim = claim;
  activeLeaseLost = null;
  lastDatabaseCheckpointHash = null;
  Object.assign(browserProgressSync, {
    lastReceivedAt: null,
    lastReceivedSourceUpdatedAt: null,
    lastAttemptAt: null,
    lastAttemptSource: null,
    lastOutcome: null,
    lastSucceededAt: null,
    lastSucceededSourceUpdatedAt: null,
    lastRejectedAt: null,
    lastRejectedReason: null,
    lastErrorAt: null,
    lastError: null,
  });
  const hydratedProgress = await hydrateClaimProgress(claim);
  const claimHydratedAtMs = Date.parse(hydratedProgress.hydratedAt);
  if (!claim.heldRefundReadOnly
    && hydratedProgress.checkpointSource === 'local-logistics-wait') {
    const recoveredLogisticsRelease = logisticsWaitReleaseForClaim(hydratedProgress, claim, 0);
    if (recoveredLogisticsRelease) {
      await finishLogisticsWaitClaim(claim, recoveredLogisticsRelease);
      clearActiveClaim();
      return true;
    }
  }
  leaseTimer = setInterval(async () => {
    try {
      const renewed = await repository.renewLease({ shopId, workerId, leaseToken: claim.leaseToken, leaseSeconds });
      if (activeClaim?.leaseToken !== claim.leaseToken) return;
      if (!renewed && !activeLeaseLost) {
        activeLeaseLost = {
          orderNumber: claim.external_order_number,
          workOrderId: claim.id,
          detectedAt: new Date().toISOString(),
        };
        await heartbeat('lease-lost', activeLeaseLost);
      }
    } catch (error) {
      await heartbeat('lease-renew-error', { orderNumber: claim.external_order_number, error: error.message });
    }
  }, leaseRenewMs);
  heartbeatTimer = setInterval(() => heartbeat('processing', {
    orderNumber: claim.external_order_number,
    workOrderId: claim.id,
  }).catch((error) => console.error(`[worker-heartbeat] ${shopId}: ${error.message}`)), heartbeatIntervalMs);
  await heartbeat(claim.recoveredLease ? 'recovered-claim' : 'claimed', {
    orderNumber: claim.external_order_number,
    workOrderId: claim.id,
  });
  if (canonicalScenarioCode(claim.scenario_code) === 'return-refund') {
    try {
      await runReturnRefundClaim(claim);
      return true;
    } catch (error) {
      await deferClaimsAfterPddTabFailure(error, 'return-refund-claim-error');
      const failedRefund = await repository.getReturnRefundForClaim({
        workOrderId: claim.id,
        shopId,
      }).catch(() => null);
      const failureResult = classifyReturnRefundUnexpectedFailure(error, {
        externalEffectStarted: ['reserved', 'unknown'].includes(failedRefund?.effect_status),
      });
      const browserProxyNavigationFailure = recordBrowserProxyNavigationFailure(error);
      await repository[
        claim.heldRefundReadOnly ? 'finishHeldReturnRefundReadOnly' : 'finishReturnRefundClaim'
      ]({
        shopId,
        workOrderId: claim.id,
        leaseToken: claim.leaseToken,
        result: {
          ...failureResult,
          facts: { orderNumber: claim.external_order_number },
        },
      }).catch(() => {});
      await heartbeat('return-refund-claim-failed', {
        orderNumber: claim.external_order_number,
        workOrderId: claim.id,
        error: error.message,
        browserProxyNavigationFailure,
      });
      return true;
    } finally {
      clearActiveClaim();
    }
  }
  const ordinaryIdentity = ordinaryIdentityForClaim(claim);
  const run = await startOrReusePlaywright(claim.external_order_number, {
    assignmentId: claim.leaseToken,
    claimWorkOrderType: claim.work_order_type,
    claimScenarioCode: claim.scenario_code,
    claimOrdinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
    claimPlatformWorkOrderId: ordinaryIdentity.platformWorkOrderId,
    claimPlatformCaseKey: ordinaryIdentity.platformCaseKey,
    claimWorkOrderFirstDiscoveredAt: ordinaryFirstDiscoveredAtForClaim(claim),
  });
  const inspectInterruptedVerification = async (progress, reason) => {
    let persistedVerification = null;
    if (!progress.verificationLocation && isHumanVerificationInterruptionReason(reason)) {
      const freshSinceMs = Number.isFinite(claimHydratedAtMs)
        ? claimHydratedAtMs - 5_000
        : Date.now() - 10 * 60_000;
      const result = await pool.query(`
        SELECT id, stage, status, detected_at, resolved_at
        FROM verification_locations
        WHERE shop_id = $1 AND work_order_id = $2
          AND ($3::uuid IS NULL OR ordinary_instance_id = $3::uuid)
          AND detected_at >= to_timestamp($4::double precision / 1000.0)
        ORDER BY detected_at DESC
        LIMIT 1`, [shopId, claim.id, ordinaryIdentity.ordinaryInstanceId, freshSinceMs]);
      persistedVerification = result.rows[0] || null;
    }
    return classifyInterruptedVerification({
      progress,
      reason,
      persistedVerification,
      claimHydratedAtMs,
    });
  };
  const finishVerificationRetry = async (progress, reason, interruption = { state: 'waiting' }) => {
    const challengeResolved = interruption.state === 'resolved';
    const challengeTimedOut = interruption.state === 'timeout'
      || progress.verificationTimeout?.status === 'closed';
    const previousCount = Math.max(0, Number(progress.verificationRecovery?.count || 0));
    const count = challengeResolved ? 0 : previousCount + 1;
    const retryDelayMs = challengeResolved
      ? 1_000
      : verificationRetryDelaysMs[Math.min(count - 1, verificationRetryDelaysMs.length - 1)];
    const requestedAt = new Date().toISOString();
    const retryAt = new Date(Date.now() + retryDelayMs);
    const retryStep = challengeResolved
      ? 'verification-cleared-retry-ready'
      : challengeTimedOut
        ? 'verification-timeout-retry-ready'
        : 'human-verification-required';
    const retryPayload = {
      ...progress,
      step: retryStep,
      error: null,
      manualReview: null,
      ...(challengeResolved || challengeTimedOut ? {
        verificationStage: null,
        verificationLocation: null,
        verificationFocus: null,
        verificationRecovery: null,
      } : {
        verificationFocus: null,
        verificationRecovery: {
          count,
          retryDelayMs,
          retryAt: retryAt.toISOString(),
          lastReason: reason,
          requestedAt,
        },
      }),
      verificationRecheck: {
        ...(progress.verificationRecheck || {}),
        trigger: challengeResolved
          ? 'automatic-resume-after-plugin-verification'
          : challengeTimedOut
            ? 'verification-timeout-close'
            : 'automatic-recovery-after-interrupted-verification',
        status: challengeTimedOut ? 'closed' : 'retry-ready',
        verificationState: interruption.state,
        verificationSource: interruption.source || null,
        verificationId: interruption.verificationId || progress.verificationLocation?.id || null,
        requestedAt,
        ...(challengeResolved || challengeTimedOut
          ? { completedAt: interruption.resolvedAt || requestedAt }
          : {}),
      },
      updatedAt: requestedAt,
    };
    const finished = await repository.finishClaimed({
      shopId,
      workOrderId: claim.id,
      leaseToken: claim.leaseToken,
      ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
      status: 'retry-ready',
      currentStep: retryStep,
      payload: retryPayload,
      nextAttemptAt: retryAt,
    });
    const heartbeatState = challengeResolved
      ? 'verification-cleared-retry-ready'
      : challengeTimedOut
        ? 'verification-timeout-retry-ready'
        : 'verification-retry-ready';
    await heartbeat(finished ? heartbeatState : 'verification-retry-lease-lost', {
      orderNumber: claim.external_order_number,
      retryAt: retryAt.toISOString(),
      retryDelayMs,
      recoveryAttempt: count,
      verificationState: interruption.state,
      verificationSource: interruption.source || null,
      verificationId: interruption.verificationId || progress.verificationLocation?.id || null,
      reason,
    });
    return finished;
  };
  const finishLoginRetry = async (progress, reason, interruption) => {
    const loginRecovered = interruption.state === 'resolved';
    const requestedAt = new Date().toISOString();
    const retryDelayMs = loginRecovered ? 1_000 : returnRefundVerificationRetryMs;
    const retryAt = new Date(Date.now() + retryDelayMs);
    const retryStep = loginRecovered
      ? 'authentication-cleared-retry-ready'
      : 'manual-login-required';
    const retryPayload = {
      ...progress,
      step: retryStep,
      error: null,
      manualReview: null,
      ...(loginRecovered ? {
        verificationStage: null,
        systemLogin: null,
      } : {}),
      loginRecovery: {
        status: loginRecovered ? 'recovered' : 'waiting-login',
        system: interruption.system || 'pdd',
        stage: interruption.stage || 'pinduoduo-login',
        source: interruption.source || 'resident-command',
        reason,
        retryDelayMs,
        retryAt: retryAt.toISOString(),
        requestedAt,
        ...(loginRecovered ? { recoveredAt: interruption.resolvedAt || requestedAt } : {}),
      },
      updatedAt: requestedAt,
    };
    const finished = await repository.finishClaimed({
      shopId,
      workOrderId: claim.id,
      leaseToken: claim.leaseToken,
      ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
      status: 'retry-ready',
      currentStep: retryStep,
      payload: retryPayload,
      nextAttemptAt: retryAt,
    });
    await heartbeat(finished
      ? (loginRecovered ? 'login-cleared-retry-ready' : 'login-required-retry-ready')
      : 'login-retry-lease-lost', {
      orderNumber: claim.external_order_number,
      system: interruption.system || 'pdd',
      retryAt: retryAt.toISOString(),
      retryDelayMs,
      loginState: interruption.state,
      loginSource: interruption.source || null,
      reason,
    });
    return finished;
  };
  let completedReported = false;
  let result = null;
  while (!result) {
    const progress = await readProgress();
    const progressMatchesInstance = progressBelongsToClaim(progress, claim);
    const completedProgressMatchesInstance = completedForClaim(progress, claim);
    if (activeLeaseLost) {
      const effectDeadline = Date.now() + 30_000;
      while (activeEffectsForClaim(claim, run.child).length > 0
        && Date.now() < effectDeadline
        && activeChildRunning()) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await stopActiveChildGracefully();
      for (const [effectId, effect] of activeEffectsForClaim(claim, run.child)) {
        await repository.completeExternalEffect({
          id: effectId,
          status: 'unknown',
          ordinaryInstanceId: effect.ordinaryInstanceId,
          error: {
            reason: 'lease-lost-before-effect-confirmation',
            detectedAt: activeLeaseLost.detectedAt,
          },
        }).catch(() => {});
        activeExternalEffects.delete(effectId);
      }
      await heartbeat('lease-lost-fenced', activeLeaseLost).catch(() => {});
      clearActiveClaim();
      return true;
    }
    if (stopped) {
      while (activeEffectsForClaim(claim, run.child).length > 0 && activeChildRunning()) {
        if (slotSession) {
          await schedulerRepository.heartbeat({
            slotId,
            leaseToken: slotLeaseToken,
            externalEffectActive: true,
          }).catch(() => false);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await stopActiveChildGracefully(90_000);
      for (const [effectId, effect] of activeEffectsForClaim(claim, run.child)) {
        await repository.completeExternalEffect({
          id: effectId,
          status: 'unknown',
          ordinaryInstanceId: effect.ordinaryInstanceId,
          error: {
            reason: 'system-safe-stop-before-effect-confirmation',
            detectedAt: new Date().toISOString(),
          },
        }).catch(() => {});
        activeExternalEffects.delete(effectId);
      }
      await handoffActiveClaim({
        claim,
        progress: progressMatchesInstance ? progress : hydratedProgress,
        reason: `系统安全停止 (${stopSignal || 'shutdown'})`,
        retryOnStart: true,
      });
      clearActiveClaim();
      return true;
    }
    if (!progressMatchesInstance && !completedProgressMatchesInstance) {
      result = await Promise.race([
        run.exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      continue;
    }
    const clearedResidentVerification = residentBrowser
      ? classifyClearedResidentVerification({
        progress,
        leaseToken: claim.leaseToken,
        claimHydratedAtMs,
      })
      : null;
    if (clearedResidentVerification
      && activeEffectsForClaim(claim, run.child).length === 0) {
      await finishVerificationRetry(
        progress,
        '拼多多验证已解除，重新排队继续当前工单',
        clearedResidentVerification,
      );
      clearActiveClaim();
      return true;
    }
    const residentLoginInterruption = residentBrowser
      ? classifyResidentLoginInterruption({
        progress,
        leaseToken: claim.leaseToken,
        claimHydratedAtMs,
      })
      : null;
    if (residentLoginInterruption
      && activeEffectsForClaim(claim, run.child).length === 0) {
      await finishLoginRetry(
        progress,
        residentLoginInterruption.state === 'resolved'
          ? '拼多多登录已恢复，重新排队继续当前工单'
          : '拼多多登录状态不可用，释放工单租约等待重新登录',
        residentLoginInterruption,
      );
      clearActiveClaim();
      return true;
    }
    const waitingResidentVerification = residentBrowser
      ? classifyWaitingResidentVerification({
        progress,
        leaseToken: claim.leaseToken,
        claimHydratedAtMs,
      })
      : null;
    if (waitingResidentVerification
      && activeEffectsForClaim(claim, run.child).length === 0) {
      await finishVerificationRetry(
        progress,
        '常驻浏览器验证码命令已结束，释放工单租约等待人工验证',
        waitingResidentVerification,
      );
      clearActiveClaim();
      return true;
    }
    const logisticsRelease = logisticsWaitReleaseForClaim(progress, claim, claimHydratedAtMs);
    if (logisticsRelease) {
      if (!residentBrowser) await stopActiveChildGracefully();
      await finishLogisticsWaitClaim(claim, logisticsRelease);
      clearActiveClaim();
      return true;
    }
    const businessUpdatedAtMs = Date.parse(progress.businessUpdatedAt || progress.updatedAt || '');
    const workflowStep = String(progress.step || '');
    const stallExemption = workflowStallExemption(progress);
    // A recovered checkpoint can carry an old business timestamp until the
    // newly assigned browser command publishes its first progress snapshot.
    const workflowStalled = residentBrowser
      && progress.residentCommand?.status === 'active'
      && Number.isFinite(businessUpdatedAtMs)
      && Number.isFinite(claimHydratedAtMs)
      && Date.now() - claimHydratedAtMs >= workflowStallTimeoutMs
      && Date.now() - businessUpdatedAtMs >= workflowStallTimeoutMs
      && !stallExemption;
    if (workflowStalled && activeEffectsForClaim(claim, run.child).length === 0) {
      const unresolvedExternalEffects = claim.has_unresolved_external_effects === true
        || await repository.hasUnresolvedExternalEffects({
          workOrderId: claim.id,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        });
      if (!unresolvedExternalEffects) {
        await heartbeat('stale-runtime-recovery', {
          orderNumber: claim.external_order_number,
          workOrderId: claim.id,
          workflowStep,
          businessUpdatedAt: progress.businessUpdatedAt || progress.updatedAt || null,
          stallTimeoutMs: workflowStallTimeoutMs,
        });
        await stopActiveChildGracefully();
        const retryAt = new Date(Date.now() + 15_000);
        const retryPayload = {
          ...progress,
          step: 'stale-runtime-retry-ready',
          error: null,
          manualReview: null,
          runtimeRecovery: {
            reason: 'business-progress-stalled-without-external-effects',
            previousStep: workflowStep || null,
            businessUpdatedAt: progress.businessUpdatedAt || progress.updatedAt || null,
            detectedAt: new Date().toISOString(),
            retryAt: retryAt.toISOString(),
          },
          updatedAt: new Date().toISOString(),
        };
        const finished = await repository.finishClaimed({
          shopId,
          workOrderId: claim.id,
          leaseToken: claim.leaseToken,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
          status: 'retry-ready',
          currentStep: 'stale-runtime-retry-ready',
          payload: retryPayload,
          nextAttemptAt: retryAt,
        });
        await heartbeat(finished ? 'stale-runtime-retry-ready' : 'stale-runtime-lease-lost', {
          orderNumber: claim.external_order_number,
          retryAt: retryAt.toISOString(),
          previousStep: workflowStep || null,
        });
        clearActiveClaim();
        return true;
      }
    }
    await checkpointActiveClaim(progress).catch((error) => heartbeat('checkpoint-error', {
      orderNumber: claim.external_order_number,
      error: error.message,
    }));
    const residentAssignmentIdle = !residentBrowser || progress.residentCommand?.status === 'idle';
    const residentCompletionReady = !residentBrowser
      || (residentAssignmentIdle && (
        progress.lastCompletedOrder?.orderNumber === claim.external_order_number
        || progress.completionArchive?.orderNumber === claim.external_order_number
      ));
    if (!completedReported
      && residentCompletionReady
      && completedForClaim(progress, claim)) {
      completedReported = true;
      await repository.finishClaimed({
        shopId,
        workOrderId: claim.id,
        leaseToken: claim.leaseToken,
        ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        status: 'archived',
        currentStep: progress.step || 'full-business-flow-complete',
        payload: progress,
      });
      completedCount += 1;
      await heartbeat('completed', { orderNumber: claim.external_order_number, workflowStep: progress.step, residentBrowser });
      if (!residentBrowser) await stopActiveChildGracefully();
      clearActiveClaim();
      return true;
    }
    // A resident workflow keeps its browser process alive after a command
    // finishes. Rate-limit and retryable failures therefore do not resolve
    // run.exitPromise; release the fenced work-order lease explicitly so the
    // shop can schedule the next attempt without recycling its browser.
    const residentRetryRelease = residentBrowser && residentAssignmentIdle
      ? classifyResidentCommandRetryRelease({
        progress,
        claim,
        claimHydratedAtMs,
        defaultRetryMs: transientWorkflowRetryMs,
      })
      : null;
    if (residentRetryRelease && activeEffectsForClaim(claim, run.child).length === 0) {
      const unresolvedExternalEffects = claim.has_unresolved_external_effects === true
        || await repository.hasUnresolvedExternalEffects({
          workOrderId: claim.id,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        });
      if (!unresolvedExternalEffects) {
        const finished = await repository.finishClaimed({
          shopId,
          workOrderId: claim.id,
          leaseToken: claim.leaseToken,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
          status: 'retry-ready',
          currentStep: residentRetryRelease.currentStep,
          payload: residentRetryRelease.payload,
          nextAttemptAt: residentRetryRelease.nextAttemptAt,
        });
        await heartbeat(finished ? 'resident-command-retry-ready' : 'resident-command-retry-lease-lost', {
          orderNumber: claim.external_order_number,
          outcome: residentRetryRelease.outcome,
          previousStep: residentRetryRelease.previousStep,
          retryAt: residentRetryRelease.nextAttemptAt.toISOString(),
          retryDelayMs: residentRetryRelease.retryDelayMs,
          browserKeptResident: true,
        });
        clearActiveClaim();
        return true;
      }
      await heartbeat('resident-command-retry-deferred-external-effects', {
        orderNumber: claim.external_order_number,
        outcome: residentRetryRelease.outcome,
        activeExternalEffects: activeExternalEffects.size,
      });
    }
    const recoveredResidentPause = residentBrowser && progressMatchesInstance
      ? classifyResidentTerminalPauseAfterSessionRecovery({
          progress,
          claim,
          claimHydratedAtMs,
          commandRequestId: run.commandRequestId,
        })
      : null;
    if (recoveredResidentPause
      && activeEffectsForClaim(claim, run.child).length === 0
      && !await repository.hasUnresolvedExternalEffects({
        workOrderId: claim.id,
        ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
      })) {
      const finished = await repository.finishClaimed({
        shopId,
        workOrderId: claim.id,
        leaseToken: claim.leaseToken,
        ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        status: 'paused',
        currentStep: recoveredResidentPause.outcome,
        payload: recoveredResidentPause.payload,
        error: new Error(recoveredResidentPause.reason),
      });
      await heartbeat(finished ? 'resident-terminal-pause-recovered' : 'resident-terminal-pause-lease-lost', {
        orderNumber: claim.external_order_number,
        outcome: recoveredResidentPause.outcome,
        browserKeptResident: true,
      });
      clearActiveClaim();
      return true;
    }
    const progressUpdatedAtMs = Date.parse(progress.updatedAt || '');
    const terminalProgress = Number.isFinite(progressUpdatedAtMs)
      && progressUpdatedAtMs > claimHydratedAtMs
      && /^(manual-review-blocked|flow-paused)$/.test(String(progress.step || ''));
    if (terminalProgress) {
      const reason = progress.manualReview?.reason
        || progress.error?.message
        || (typeof progress.error === 'string' ? progress.error : null)
        || '工作流已进入人工复核暂停状态';
      const interruptedHumanVerification = activeEffectsForClaim(claim, run.child).length === 0
        ? await inspectInterruptedVerification(progress, reason)
        : null;
      if (interruptedHumanVerification) {
        if (!residentBrowser) await stopActiveChildGracefully();
        await finishVerificationRetry(progress, reason, interruptedHumanVerification);
        clearActiveClaim();
        return true;
      }
      const unresolvedExternalEffects = activeEffectsForClaim(claim, run.child).length > 0
        || claim.has_unresolved_external_effects === true
        || await repository.hasUnresolvedExternalEffects({
          workOrderId: claim.id,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        });
      const browserFailure = retryableBrowserFailure(progress);
      const browserRecoveryCount = Number(progress.browserRecovery?.count || 0);
      if (browserFailure
        && !unresolvedExternalEffects
        && browserRecoveryCount < maxBrowserRecoveryAttempts) {
        await stopActiveChildGracefully();
        const retryAt = new Date(Date.now() + Math.min(60_000, 5000 * (2 ** browserRecoveryCount)));
        const retryPayload = {
          ...progress,
          step: 'browser-retry-ready',
          error: null,
          manualReview: null,
          browserRecovery: {
            count: browserRecoveryCount + 1,
            lastReason: browserFailure,
            retryAt: retryAt.toISOString(),
          },
        };
        const finished = await repository.finishClaimed({
          shopId,
          workOrderId: claim.id,
          leaseToken: claim.leaseToken,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
          status: 'retry-ready',
          currentStep: 'browser-retry-ready',
          payload: retryPayload,
          nextAttemptAt: retryAt,
        });
        await heartbeat(finished ? 'browser-retry-ready' : 'browser-retry-lease-lost', {
          orderNumber: claim.external_order_number,
          retryAt: retryAt.toISOString(),
          recoveryAttempt: browserRecoveryCount + 1,
          reason: browserFailure,
        });
        clearActiveClaim();
        return true;
      }
      const browserProxyNavigationFailure = recordBrowserProxyNavigationFailure(reason);
      const transientFailure = retryableTransientWorkflowFailure(progress);
      const transientRecoveryCount = Number(progress.transientWorkflowRecovery?.count || 0);
      if (transientFailure
        && !unresolvedExternalEffects
        && transientRecoveryCount < maxTransientWorkflowRecoveryAttempts) {
        if (!residentBrowser) await stopActiveChildGracefully();
        const requestedRetryMs = Number(
          progress.transientWorkflowFailure?.retryAfterMs
          ?? progress.tmsCreatedRowVisibility?.retryAfterMs,
        );
        const fastTransientFailure = /OMS_QUERY_TEMPORARILY_UNAVAILABLE|OMS_(?:WAREHOUSE|ORDER_STATUS|ANALYSIS)_TEMPORARILY_UNAVAILABLE|OMS 补发(?:页面|业务类型)|PDD_(?:LOGISTICS_ANALYSIS|DETAIL|ORDER_IDENTITY)_TEMPORARILY_UNAVAILABLE|PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE|PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE|PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE|PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE|PDD_PENDING_LIST_FILTER_UNCONFIRMED|拼多多工单状态筛选未找到(?:全部|待处理)选项，停止本轮查询|TMS_(?:ATTACHMENT_UPLOAD|NAVIGATION)_TEMPORARILY_UNAVAILABLE|BROWSER_NAVIGATION_TEMPORARILY_UNAVAILABLE|^page\.reload:[\s\S]*net::ERR_HTTP_RESPONSE_CODE_FAILURE|EBUSY:[\s\S]*tms-logistics-work-orders|^pdd 标签页不可用$|^locator\.screenshot: Timeout [0-9.]+ms exceeded[\s\S]*taking element screenshot/iu
          .test(transientFailure)
          || /locator\.innerText: Timeout \d+ms exceeded[\s\S]*waiting for locator\(['"]body['"]\)/iu.test(transientFailure)
          || /page\.(?:waitForURL|goto|reload): Timeout \d+ms exceeded/u.test(transientFailure)
          || /拼多多[^\r\n]*刷新后等待 \d+ 毫秒仍未出现有效结果/u.test(transientFailure)
          || /^拼多多“(?:发货物流|退货物流)”在刷新后仍未完成渲染$/u.test(transientFailure)
          || /^拼多多刷新并等待 \d+ 毫秒后仍未找到“(?:发货物流|退货物流)”标签/u.test(transientFailure)
          || /^拼多多[^\r\n]*(?:物流|物流标签)[^\r\n]*刷新后[^\r\n]*(?:仍未完成渲染|仍未找到)/u.test(transientFailure)
          || /BROWSER_NAVIGATION_TEMPORARILY_UNAVAILABLE|^page\.reload:[\s\S]*net::ERR_HTTP_RESPONSE_CODE_FAILURE|EBUSY:[\s\S]*tms-logistics-work-orders/iu.test(transientFailure);
        const retryLimitMs = /TMS_TICKET_FILTER_TEMPORARILY_UNAVAILABLE/u.test(transientFailure)
          ? tmsFilterTransientRetryMs : transientWorkflowRetryMs;
        const retryDelayMs = Number.isFinite(requestedRetryMs)
          && requestedRetryMs > 0
          ? Math.max(30_000, Math.min(retryLimitMs, requestedRetryMs))
          : fastTransientFailure ? fastTransientWorkflowRetryMs : transientWorkflowRetryMs;
        const retryAt = new Date(Date.now() + retryDelayMs);
        const retryPayload = {
          ...progress,
          step: 'transient-workflow-retry-ready',
          error: null,
          manualReview: null,
          transientWorkflowRecovery: {
            count: transientRecoveryCount + 1,
            maxAttempts: maxTransientWorkflowRecoveryAttempts,
            lastReason: transientFailure,
            retryAt: retryAt.toISOString(),
          },
          updatedAt: new Date().toISOString(),
        };
        const finished = await repository.finishClaimed({
          shopId,
          workOrderId: claim.id,
          leaseToken: claim.leaseToken,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
          status: 'retry-ready',
          currentStep: 'transient-workflow-retry-ready',
          payload: retryPayload,
          nextAttemptAt: retryAt,
        });
        await heartbeat(finished ? 'transient-workflow-retry-ready' : 'transient-workflow-retry-lease-lost', {
          orderNumber: claim.external_order_number,
          retryAt: retryAt.toISOString(),
          recoveryAttempt: transientRecoveryCount + 1,
          reason: transientFailure,
          browserProxyNavigationFailure,
        });
        clearActiveClaim();
        return true;
      }
      if (!residentAssignmentIdle) {
        if (browserFailure) await stopActiveChildGracefully();
        else {
          result = await Promise.race([
            run.exitPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 500)),
          ]);
          continue;
        }
      }
      if (!residentBrowser) await stopActiveChildGracefully();
      const finished = await repository.finishClaimed({
        shopId,
        workOrderId: claim.id,
        leaseToken: claim.leaseToken,
        ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        status: 'paused',
        currentStep: progress.step,
        payload: progress,
        error: new Error(reason),
      });
      await heartbeat(finished ? 'manual-review-paused' : 'manual-review-lease-lost', {
        orderNumber: claim.external_order_number,
        workflowStep: progress.step,
        reason,
      });
      deferDiscoveryForOperatorCommand();
      clearActiveClaim();
      return true;
    }
    const command = await repository.claimPendingCommand({
      shopId,
      workerId,
      activeWorkOrderId: claim.id,
      commandTypes: [
        'focus-system-login',
        'reset-pdd-login',
        'verification-recheck',
        'refresh-next-order',
        'retry-stage',
        'resume-auto',
        'force-clear-verification',
      ],
    });
    if (command) {
      try {
        const applied = await applyActiveCommand(command, claim, progress);
        if (applied.stop) {
          clearActiveClaim();
          return true;
        }
      } catch (error) {
        await repository.acknowledgeCommand({
          commandId: command.id,
          status: 'failed',
          result: { applied: false, error: error.message, workerId },
        }).catch(() => {});
      }
    }
    result = await Promise.race([
      run.exitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
  }
  if (result.code === browserDisconnectedExitCode) {
    await heartbeat('browser-disconnected', {
      orderNumber: claim.external_order_number,
      recovery: 'container-restart-with-owned-lease',
    }).catch(() => {});
    process.exit(browserDisconnectedExitCode);
  }
  try {
    const progress = await readProgress();
    if (!progressBelongsToClaim(progress, claim) && !completedForClaim(progress, claim)) {
      await handoffActiveClaim({
        claim,
        progress: hydratedProgress,
        reason: 'Playwright workflow exited with stale ordinary-instance progress',
        retryOnStart: true,
      });
      return true;
    }
    const logisticsRelease = logisticsWaitReleaseForClaim(progress, claim, claimHydratedAtMs);
    if (logisticsRelease) {
      await finishLogisticsWaitClaim(claim, logisticsRelease);
      return true;
    }
    await checkpointActiveClaim(progress, { force: true }).catch(() => {});
    const verificationExitReason = progress.manualReview?.reason
      || progress.error?.message
      || (typeof progress.error === 'string' ? progress.error : null)
      || '验证码等待中断';
    const interruptedHumanVerification = activeEffectsForClaim(claim, run.child).length === 0
      ? await inspectInterruptedVerification(progress, verificationExitReason)
      : null;
    if (interruptedHumanVerification) {
      await finishVerificationRetry(progress, verificationExitReason, interruptedHumanVerification);
      return true;
    }
    const omsLoginYieldAfterExit = progress.systemLogin?.system === 'oms'
      && progress.systemLogin?.status === 'retry-ready'
      && ['expired', 'verification-required'].includes(progress.authHealth?.oms?.status)
      && activeEffectsForClaim(claim, run.child).length === 0
      && !claim.has_unresolved_external_effects
      && !await repository.hasAnyExternalEffects({
        workOrderId: claim.id,
        ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
      });
    if (omsLoginYieldAfterExit) {
      const retryAt = new Date(Date.now() + transientWorkflowRetryMs);
      const retriedAt = new Date().toISOString();
      const retryPayload = {
        ...progress,
        step: 'oms-login-required-retry-ready',
        error: null,
        manualReview: null,
        omsLoginYieldRecovery: {
          status: 'retry-ready',
          strategy: 'preserve-per-shop-profile-and-yield-claim',
          childExitCode: result.code ?? null,
          childExitSignal: result.signal ?? null,
          retryAt: retryAt.toISOString(),
          recoveredAt: retriedAt,
          externalActionsReplayed: false,
        },
        updatedAt: retriedAt,
      };
      const finished = await repository.finishClaimed({
        shopId,
        workOrderId: claim.id,
        leaseToken: claim.leaseToken,
        ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        status: 'retry-ready',
        currentStep: 'oms-login-required-retry-ready',
        payload: retryPayload,
        nextAttemptAt: retryAt,
      });
      await heartbeat(finished ? 'oms-login-claim-yielded' : 'oms-login-yield-lease-lost', {
        orderNumber: claim.external_order_number,
        retryAt: retryAt.toISOString(),
        omsMode,
        externalActionsReplayed: false,
      });
      return true;
    }
    const completed = completedForClaim(progress, claim) && (
      progress.step === 'full-business-flow-complete'
      || progress.step === 'requested-order-complete'
      || progress.completionArchive?.status
    );
    const unexpectedWorkflowExit = !completed
      && (result.code !== 0 || Boolean(result.signal));
    if (unexpectedWorkflowExit) {
      const unresolvedExternalEffects = activeEffectsForClaim(claim, run.child).length > 0
        || claim.has_unresolved_external_effects === true
        || await repository.hasUnresolvedExternalEffects({
          workOrderId: claim.id,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
        });
      const transientRecoveryCount = Number(progress.transientWorkflowRecovery?.count || 0);
      if (!unresolvedExternalEffects
        && transientRecoveryCount < maxTransientWorkflowRecoveryAttempts) {
        const retryAt = new Date(Date.now() + fastTransientWorkflowRetryMs);
        const exitReason = result.signal
          ? `Playwright workflow exited with signal ${result.signal}`
          : `Playwright workflow exited with code ${result.code}`;
        const retryPayload = {
          ...progress,
          step: 'transient-workflow-retry-ready',
          error: null,
          manualReview: null,
          transientWorkflowRecovery: {
            count: transientRecoveryCount + 1,
            maxAttempts: maxTransientWorkflowRecoveryAttempts,
            lastReason: exitReason,
            retryAt: retryAt.toISOString(),
            childExitCode: result.code ?? null,
            childExitSignal: result.signal || null,
          },
          updatedAt: new Date().toISOString(),
        };
        const finished = await repository.finishClaimed({
          shopId,
          workOrderId: claim.id,
          leaseToken: claim.leaseToken,
          ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
          status: 'retry-ready',
          currentStep: 'transient-workflow-retry-ready',
          payload: retryPayload,
          nextAttemptAt: retryAt,
        });
        await heartbeat(finished
          ? 'transient-workflow-exit-retry-ready'
          : 'transient-workflow-exit-retry-lease-lost', {
          orderNumber: claim.external_order_number,
          retryAt: retryAt.toISOString(),
          recoveryAttempt: transientRecoveryCount + 1,
          reason: exitReason,
          externalActionsReplayed: false,
        });
        return true;
      }
    }
    if (!completed && result.code === 0) {
      await handoffActiveClaim({
        claim,
        progress,
        reason: 'Playwright workflow exited cleanly before the claimed order completed',
        retryOnStart: true,
      });
      return true;
    }
    const status = completed ? 'archived' : 'failed';
    await repository.finishClaimed({
      shopId,
      workOrderId: claim.id,
      leaseToken: claim.leaseToken,
      ordinaryInstanceId: ordinaryIdentity.ordinaryInstanceId,
      status,
      currentStep: progress.step || 'workflow-exited',
      payload: progress,
      error: completed ? null : new Error(`Playwright workflow exited with code ${result.code || result.signal}`),
    });
    if (completed) completedCount += 1;
    await heartbeat(completed ? 'completed' : 'paused', { orderNumber: claim.external_order_number, workflowStep: progress.step });
    return true;
  } finally {
    clearActiveClaim();
  }
}

const restoredPddIdentity = await restoreConfirmedPddShopIdentityBinding();
if (restoredPddIdentity) {
  const reboundOrders = await repository.bindLegacyPendingOrdersToIdentity({
    shopId,
    identityBindingToken: currentPddIdentityBindingToken,
    actualShopName: restoredPddIdentity.actualShopName,
    mallId: restoredPddIdentity.mallId,
  });
  await heartbeat('pdd-identity-binding-restored', {
    actualShopName: restoredPddIdentity.actualShopName,
    profileFingerprint: restoredPddIdentity.profileFingerprint,
    reboundOrderNumbers: reboundOrders.map((workOrder) => workOrder.external_order_number),
    reboundCount: reboundOrders.length,
  });
}
await pool.query(`
  UPDATE shops SET onboarding_status = 'initializing', onboarding_error = NULL, updated_at = now()
  WHERE id = $1 AND onboarding_status IN ('waiting-login', 'error')`, [shopId]);
await refreshReturnRefundRuntimeSettings({ force: true });
await heartbeat('starting', {
  maxOrders: maxOrders || null,
  browserMode,
  residentBrowser,
  continuous: (!slotSession || persistentSlotSession) && maxOrders === 0,
  schedulerMode,
  slotId: slotId || null,
  assignmentKind: assignmentKind || null,
  sessionDeadline: boundedSlotSession ? new Date(sessionDeadline).toISOString() : null,
});
const sessionTimer = boundedSlotSession ? setTimeout(() => requestStop('slot-session-limit'), sessionMaxMs) : null;
sessionTimer?.unref?.();
let boundedRefundFairnessContinuationUsed = false;
let boundedDirectRefundClaimsProcessed = 0;
let residentDirectRefundClaimsProcessed = 0;
while (!stopped
  && (!returnRefundScanOnceCompleted || returnRefundKeepBrowserOpen)
  && (maxOrders === 0 || completedCount < maxOrders)) {
  let processedWork = false;
  try {
    const circuitOpenUntilMs = Date.parse(String(browserProxyNavigationCircuit?.openUntil || ''));
    if (Number.isFinite(circuitOpenUntilMs) && circuitOpenUntilMs > Date.now()) {
      browserProxyNavigationRecoveryPending = true;
      const retryAt = new Date(circuitOpenUntilMs).toISOString();
      await heartbeat('browser-proxy-unavailable', {
        browserProxyHealth: {
          ok: false,
          enabled: true,
          required: Boolean(browserProxyConfig?.runtime?.required),
          errorCode: 'BROWSER_PROXY_NAVIGATION_CIRCUIT_OPEN',
          navigationFailureCircuit: browserProxyNavigationCircuit,
          retryAt,
        },
      });
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(browserProxyRetryMs, Math.max(1_000, circuitOpenUntilMs - Date.now())),
      ));
      continue;
    }
    if (Number.isFinite(circuitOpenUntilMs)
      && !browserProxyNavigationCircuit?.recoveryProbeStartedAt) {
      browserProxyNavigationCircuit = {
        ...browserProxyNavigationCircuit,
        recoveryProbeStartedAt: new Date().toISOString(),
      };
      browserProxyHealth = null;
      browserProxyNextProbeAt = 0;
    }
    const proxyHealth = await inspectConfiguredBrowserProxy();
    if (!proxyHealth.ok) {
      browserProxyWasUnavailable = true;
      const retryAt = new Date(Date.now() + browserProxyRetryMs).toISOString();
      await heartbeat('browser-proxy-unavailable', {
        browserProxyHealth: { ...proxyHealth, retryAt },
      });
      await new Promise((resolve) => setTimeout(resolve, browserProxyRetryMs));
      continue;
    }
    if (browserProxyWasUnavailable) {
      browserProxyWasUnavailable = false;
      await heartbeat('browser-proxy-recovered', { browserProxyHealth: proxyHealth });
    }
    lastProcessedScenarioCode = null;
    browserProxyNavigationFailureObservedThisTurn = false;
    processedWork = await processOne();
    if (processedWork) {
      const browserProxyNavigationRecovered = browserProxyNavigationRecoveryPending
        && !browserProxyNavigationFailureObservedThisTurn;
      resetBrowserProxyNavigationFailuresAfterSuccess();
      if (browserProxyNavigationRecovered) {
        browserProxyNavigationRecoveryPending = false;
        await heartbeat('browser-proxy-recovered', {
          browserProxyHealth: proxyHealth,
          recoveryEvidence: 'successful-business-turn-after-navigation-cooldown',
        });
      }
    }
  } catch (error) {
    const browserProxyNavigationFailure = recordBrowserProxyNavigationFailure(error);
    if (browserProxyNavigationFailure && !activeClaim) {
      if (browserProxyNavigationFailure.opened) browserProxyNavigationRecoveryPending = true;
      await heartbeat(browserProxyNavigationFailure.opened
        ? 'browser-proxy-unavailable'
        : 'retry-ready', {
        browserProxyNavigationFailure,
        error: error.message,
      });
      continue;
    }
    if (!isDuplicatePddSlotConflict(error)) throw error;
    await markDuplicatePddIdentityFromConflict(error);
    if (persistentSlotSession) {
      await transitionPersistentSlot('login', 'login');
      await heartbeat('pdd-identity-duplicate-login-waiting', currentPddIdentityConflict || {});
    } else {
      requestStop('pdd-duplicate-shop-active-record');
      await stopActiveChildGracefully(10_000);
    }
  }
  if (stopped) break;
  // A scheduler session yields only after processOne has reached a repository
  // or browser-command boundary, so external submissions are never cut off.
  if (boundedSlotSession) {
    const sessionProgress = await readProgress().catch(() => ({}));
    const verificationStillWaiting = sessionProgress.step === 'human-verification-required'
      || ['detected', 'waiting-human', 'verification-required']
        .includes(sessionProgress.verificationLocation?.status);
    if (assignmentKind === 'verification' && verificationStillWaiting) {
      throw new Error('verification-focus-timeout');
    }
    if (directRefundExecutionSession && processedWork) {
      boundedDirectRefundClaimsProcessed += 1;
      if (boundedDirectRefundClaimsProcessed < returnRefundCombinedBatchItems) continue;
    }
    if (mixedBusinessSlotSession
      && !boundedRefundFairnessContinuationUsed
      && !startupLeaseRecoveryPending
      && ordinaryOpportunitySinceRefundTurn) {
      boundedRefundFairnessContinuationUsed = true;
      continue;
    }
    break;
  }
  if (persistentSlotSession
    && processedWork
    && lastProcessedScenarioCode === 'return-refund') {
    residentDirectRefundClaimsProcessed += 1;
    if (residentDirectRefundClaimsProcessed < returnRefundCombinedBatchItems) continue;
  }
  residentDirectRefundClaimsProcessed = 0;
  if (maxOrders > 0 && completedCount >= maxOrders) break;
  const nextPollDelay = residentBrowser && (!activeChild || Date.now() < operatorCommandGraceUntil)
    ? 1000
    : pollMs;
  await new Promise((resolve) => setTimeout(resolve, nextPollDelay));
}
if (sessionTimer) clearTimeout(sessionTimer);
await heartbeat('worker-finished', { completedCount, maxOrders: maxOrders || null });
await finalizeStop();
// The supervisor IPC listener otherwise keeps a fully drained runner alive
// until its shutdown deadline, delaying a safe configuration reload.
if (process.connected) process.disconnect();
